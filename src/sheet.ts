/**
 * 把一單的書寫回結帳 Google Sheet。
 *
 * 對應的 Apps Script 在 `apps_script/checkout_append.gs`——兩邊是一份合約，
 * 改了 payload 形狀就要一起改。
 */

const URL_KEY = 'bookScanCheckout_webAppUrl';
const SECRET_KEY = 'bookScanCheckout_secret';

export interface OrderItem {
	isbn: string;
	title: string;
	/** 單價（一本的定價）。金額由試算表的公式 數量 × 單價 自己算。 */
	price: number;
	quantity: number;
	/**
	 * 這一本自己的備註，取代整單的備註寫在它那一列。只有跟整單不同時才帶，
	 * 例如手動輸入的書要多標「進貨無此書」——標在整單會把查得到的書也標上。
	 */
	note?: string;
}

/**
 * 這個前端需要的 Apps Script 版本。.gs 每次改 payload 就把它的 API_VERSION 加一，
 * 這裡跟著改。部署的還是舊版時，新欄位會被默默忽略（例如數量都記成 1 本），
 * 所以版本不夠就當成錯誤回報，不假裝成功。
 */
const BASE_API_VERSION = 2;
/** item.note 是版本 3 才有的。只有用到時才要求版本 3，其他訂單在版本 2 照樣能送。 */
const ITEM_NOTE_API_VERSION = 3;
/** 版本 4 起不寫 A 欄（訂單編號由試算表公式算）。更舊的版本會寫值，蓋掉那一列的公式。 */
const NO_ORDER_ID_API_VERSION = 4;

/** 付款方式。字串要跟試算表 M 欄的下拉選項一字不差（「台灣 Pay」有空格）。 */
export const PAYMENT_OPTIONS = ['現金', '轉帳', '刷卡', '台灣 Pay', '文化幣'] as const;
export type PaymentMethod = (typeof PAYMENT_OPTIONS)[number];

/** 整單共用的資料。購買日期不在這裡：由 Apps Script 在寫入時產生。訂單編號由試算表公式算。 */
export interface OrderInfo {
	name: string;
	carrier: string;
	payment: PaymentMethod;
	note: string;
}

export type SubmitOutcome =
	| { status: 'ok'; rows: number[]; date: string; warnings: string[] }
	| { status: 'unconfirmed' }
	| { status: 'error'; message: string };

function read(key: string): string {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value.trim());
	} catch {
		/* 存不了就只能每次重填，不影響送單本身 */
	}
}

export const getWebAppUrl = () => read(URL_KEY);
export const getSecret = () => read(SECRET_KEY);

/**
 * 去掉貼上時夾帶的空白、換行與看不見的字元（零寬空白、BOM）。這些字元肉眼看不到，
 * 但會讓密鑰跟 Apps Script 裡的不一樣，每一單都「密鑰不符」。
 */
export function cleanSecret(raw: string): string {
	return raw.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '');
}

/** 給人對照用：「24 個字，最後四個字是 ab12」。跟 testConnection() 的紀錄印法相同。 */
export function describeSecret(secret: string): string {
	return secret ? `${secret.length} 個字，最後四個字是「${secret.slice(-4)}」` : '（沒有填）';
}

const SECRET_MISMATCH_HELP =
	'密鑰不符：這台裝置設定的密鑰，跟 Apps Script 裡的 SHARED_SECRET 不一樣。' +
	'最常見是有人重新貼過 Apps Script、重填了不同的密鑰。請按右上角 ⚙️ 對照「密鑰長度與最後四個字」，' +
	'改成一致後按「測試連線」。';

function explain(message: string): string {
	return message === '密鑰不符' ? SECRET_MISMATCH_HELP : message;
}

/**
 * 網址與密鑰都只存在這台裝置的 localStorage，不進 repo、不進 bundle。
 *
 * ⚠️ 這兩個值合起來就是寫入這張試算表的全部憑證。端點部署成「任何人可存取」，
 * 所以它們等同密碼——不要貼進 repo、截圖或訊息裡。
 */
export function saveSettings(url: string, secret: string): void {
	write(URL_KEY, url);
	write(SECRET_KEY, cleanSecret(secret));
}

export type ConnectionResult = { ok: boolean; message: string };

/**
 * 設定頁的「測試連線」：呼叫 doGet（唯讀，不寫任何東西）。
 *
 * 不要叫店員直接用瀏覽器打開 …/exec 測：那樣沒帶密鑰，一定顯示「密鑰不符」；
 * 手機瀏覽器同時登入多個 Google 帳號時還會一直重新導向。fetch 跨網域預設不帶
 * Google 的登入 cookie，所以不會有這個問題。
 */
export async function testConnection(webAppUrl: string, secret: string): Promise<ConnectionResult> {
	if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(webAppUrl)) {
		return { ok: false, message: '網址格式不對，應該是 https://script.google.com/…/exec（結尾是 /exec，不是 /dev 或 /edit）。' };
	}
	if (!secret) return { ok: false, message: '還沒有填密鑰。' };

	let parsed: { status?: string; message?: string; apiVersion?: number; nextRow?: number };
	try {
		const res = await fetch(`${webAppUrl}?secret=${encodeURIComponent(secret)}`, { redirect: 'follow' });
		if (!res.ok) return { ok: false, message: `伺服器回應 HTTP ${res.status}，網址可能是舊的部署或打錯了。` };
		parsed = JSON.parse(await res.text());
	} catch {
		return {
			ok: false,
			message: '連不上 Apps Script，或回來的不是預期內容。請確認網址是最新的部署作業，而且「誰可以存取」設為「任何人」（不是「任何擁有 Google 帳戶的使用者」）。'
		};
	}

	if (parsed.status !== 'ok') return { ok: false, message: explain(parsed.message || '原因不明') };
	const version = parsed.apiVersion ?? 1;
	if (version < NO_ORDER_ID_API_VERSION) {
		return { ok: false, message: `網址和密鑰都對，但 Apps Script 是版本 ${version}，還會寫 A 欄訂單編號、蓋掉你的公式。請貼上最新的 checkout_append.gs 並部署「新版本」。` };
	}
	return { ok: true, message: `連線正常：網址和密鑰都對，Apps Script 版本 ${version}，下一單會寫在第 ${parsed.nextRow} 列。` };
}

/**
 * 送出一單。
 *
 * 用 text/plain 而不是 application/json：application/json 會觸發 CORS 預檢
 * （OPTIONS），而 Apps Script Web App 不處理預檢，請求直接失敗。text/plain 屬於
 * 「簡單請求」，不會有預檢。body 仍然是 JSON 字串，Apps Script 那端照樣 JSON.parse。
 *
 * 先試 cors 讀回應：Apps Script 會轉址到 script.googleusercontent.com，那個網域
 * 有送 `Access-Control-Allow-Origin: *`，所以通常讀得到，可以真的確認寫入成功。
 * 這對結帳很重要——賣出去卻沒記到帳是不能接受的。
 * 萬一環境不允許而擋下來，退回 no-cors 把單送出去，但誠實回報「無法確認」，
 * 讓店員自己去看試算表，而不是假裝成功。
 */
export async function submitOrder(
	webAppUrl: string,
	secret: string,
	order: OrderInfo,
	items: OrderItem[]
): Promise<SubmitOutcome> {
	const body = JSON.stringify({ secret, ...order, items });
	const usesItemNote = items.some(i => i.note !== undefined);

	try {
		const res = await fetch(webAppUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain;charset=utf-8' },
			body,
			redirect: 'follow'
		});

		if (!res.ok) {
			return { status: 'error', message: `伺服器回應 HTTP ${res.status}` };
		}

		const text = await res.text();
		let parsed: { status?: string; rows?: number[]; date?: string; apiVersion?: number; message?: string };
		try {
			parsed = JSON.parse(text);
		} catch {
			// 讀得到內容但不是預期的 JSON——通常是 Apps Script 回了登入或錯誤頁面
			return { status: 'error', message: 'Apps Script 回傳的不是預期內容，請確認部署的「誰可以存取」設為「任何人」' };
		}

		if (parsed.status === 'ok' && Array.isArray(parsed.rows)) {
			const version = parsed.apiVersion ?? 1;
			const rowList = parsed.rows.join('、');
			if (version < BASE_API_VERSION) {
				return {
					status: 'error',
					message: `書已寫入第 ${rowList} 列，但 Apps Script 不是最新版，日期、付款方式、備註或數量可能沒有寫對。請到試算表手動補上，並重新部署 checkout_append.gs。不要再送一次，會重複記帳。`
				};
			}
			// 版本 2、3 寫的書、數量、價錢、付款都是對的，只是少了某些東西或多寫了 A 欄。
			// 單已經寫入，當成功（報錯只會讓人以為沒存、再送一次），另外提醒要補的地方。
			const warnings: string[] = [];
			if (usesItemNote && version < ITEM_NOTE_API_VERSION) {
				warnings.push(`Apps Script 還是舊版，手動輸入的書那一列沒有標上「進貨無此書」，請到試算表第 ${rowList} 列的備註手動補上。`);
			}
			if (version < NO_ORDER_ID_API_VERSION) {
				warnings.push(`Apps Script 還是舊版，在第 ${rowList} 列的 A 欄寫了訂單編號，如果那裡原本有公式已經被蓋掉，請補回去。`);
			}
			if (warnings.length) warnings.push('請貼上最新的 checkout_append.gs 並部署「新版本」。這一單已經寫入，不要再送一次。');
			return { status: 'ok', rows: parsed.rows, date: parsed.date ?? '', warnings };
		}

		return { status: 'error', message: explain(parsed.message || '寫入失敗（原因不明）') };
	} catch {
		// 走到這裡多半是 CORS 把回應擋掉了，不代表沒送出去。
		// 用 no-cors 再送一次會重複寫入，所以不重送——改成誠實回報無法確認。
		return { status: 'unconfirmed' };
	}
}
