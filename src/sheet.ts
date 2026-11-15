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

/** 付款方式。字串要跟試算表 M 欄的下拉選項一字不差（「台灣 Pay」有空格）。 */
export const PAYMENT_OPTIONS = ['現金', '轉帳', '刷卡', '台灣 Pay', '文化幣'] as const;
export type PaymentMethod = (typeof PAYMENT_OPTIONS)[number];

/** 整單共用的資料。訂單編號與購買日期不在這裡：由 Apps Script 在寫入時產生。 */
export interface OrderInfo {
	name: string;
	carrier: string;
	payment: PaymentMethod;
	note: string;
}

export type SubmitOutcome =
	| { status: 'ok'; rows: number[]; orderId: string; date: string }
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
 * 網址與密鑰都只存在這台裝置的 localStorage，不進 repo、不進 bundle。
 *
 * ⚠️ 這兩個值合起來就是寫入這張試算表的全部憑證。端點部署成「任何人可存取」，
 * 所以它們等同密碼——不要貼進 repo、截圖或訊息裡。
 */
export function saveSettings(url: string, secret: string): void {
	write(URL_KEY, url);
	write(SECRET_KEY, secret);
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
	const required = items.some(i => i.note !== undefined) ? ITEM_NOTE_API_VERSION : BASE_API_VERSION;

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
		let parsed: { status?: string; rows?: number[]; orderId?: string; date?: string; apiVersion?: number; message?: string };
		try {
			parsed = JSON.parse(text);
		} catch {
			// 讀得到內容但不是預期的 JSON——通常是 Apps Script 回了登入或錯誤頁面
			return { status: 'error', message: 'Apps Script 回傳的不是預期內容，請確認部署的「誰可以存取」設為「任何人」' };
		}

		if (parsed.status === 'ok' && Array.isArray(parsed.rows)) {
			if (!parsed.orderId || (parsed.apiVersion ?? 1) < required) {
				return {
					status: 'error',
					message: `書已寫入第 ${parsed.rows.join('、')} 列，但 Apps Script 不是最新版，訂單編號、日期、付款方式、備註或數量可能沒有寫對。請到試算表手動補上，並重新部署 checkout_append.gs。不要再送一次，會重複記帳。`
				};
			}
			return { status: 'ok', rows: parsed.rows, orderId: parsed.orderId, date: parsed.date ?? '' };
		}

		return { status: 'error', message: parsed.message || '寫入失敗（原因不明）' };
	} catch {
		// 走到這裡多半是 CORS 把回應擋掉了，不代表沒送出去。
		// 用 no-cors 再送一次會重複寫入，所以不重送——改成誠實回報無法確認。
		return { status: 'unconfirmed' };
	}
}
