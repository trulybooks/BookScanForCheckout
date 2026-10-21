/**
 * 把一單的書寫回結帳 Google Sheet。
 *
 * 對應的 Apps Script 在 `apps_script/checkout_append.gs`——兩邊是一份合約，
 * 改了 payload 形狀就要一起改。
 */

const SETTINGS_KEY = 'bookScanCheckout_webAppUrl';

export interface OrderItem {
	isbn: string;
	title: string;
	price: number;
}

export type SubmitOutcome =
	| { status: 'ok'; rows: number[] }
	| { status: 'unconfirmed' }
	| { status: 'error'; message: string };

export function getWebAppUrl(): string {
	try {
		return localStorage.getItem(SETTINGS_KEY) ?? '';
	} catch {
		return '';
	}
}

export function saveWebAppUrl(url: string): void {
	try {
		localStorage.setItem(SETTINGS_KEY, url.trim());
	} catch {
		/* 存不了就只能每次重填，不影響送單本身 */
	}
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
	name: string,
	items: OrderItem[]
): Promise<SubmitOutcome> {
	const body = JSON.stringify({ name, items });

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
		let parsed: { status?: string; rows?: number[]; message?: string };
		try {
			parsed = JSON.parse(text);
		} catch {
			// 讀得到內容但不是預期的 JSON——通常是 Apps Script 回了登入或錯誤頁面
			return { status: 'error', message: 'Apps Script 回傳的不是預期內容，請確認部署的「誰可以存取」設為「任何人」' };
		}

		if (parsed.status === 'ok' && Array.isArray(parsed.rows)) {
			return { status: 'ok', rows: parsed.rows };
		}

		return { status: 'error', message: parsed.message || '寫入失敗（原因不明）' };
	} catch {
		// 走到這裡多半是 CORS 把回應擋掉了，不代表沒送出去。
		// 用 no-cors 再送一次會重複寫入，所以不重送——改成誠實回報無法確認。
		return { status: 'unconfirmed' };
	}
}
