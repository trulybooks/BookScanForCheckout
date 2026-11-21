/**
 * 寫入失敗（或無法確認）時，把這一單畫成一張圖片，讓店員存進相簿，資料才不會跟著
 * 這一頁一起消失。
 *
 * 網頁沒辦法替整個畫面截圖，所以是自己用 canvas 把結帳資料畫出來。不用 html2canvas
 * 之類的套件：要畫的只有文字，自己畫比較小，也不會漏掉畫面外（要捲動才看得到）的書。
 *
 * 存的方式跟封面一樣走分享選單（儲存影像），所以一樣要由點擊直接觸發：寫入失敗是在
 * 網路請求之後才知道，那時已經沒有使用者手勢，iOS 不讓自動叫分享選單。完成頁會放
 * 一個按鈕，另外直接顯示這張圖，長按也能「加入照片」。
 */

import type { OrderLine, OrderTotals } from './pricing.js';
import type { OrderInfo } from './sheet.js';

const WIDTH = 1080;
const PAD = 64;
const FONT = '"PingFang TC", "Noto Sans TC", "Heiti TC", "Microsoft JhengHei", sans-serif';

// 跟網站同一組顏色（styles.css 開頭的變數），不另外發明
const BG = '#F9F7F2';
const TEXT = '#4A403A';
const MUTED = '#8C7B6C';
const RULE = '#E5E0D8';
const ALERT = '#9C4A3F';

const money = (n: number) => `NT$ ${n.toLocaleString('en-US')}`;
const pad2 = (n: number) => String(n).padStart(2, '0');

interface Line {
	text: string;
	size: number;
	color?: string;
	bold?: boolean;
	/** 這一行之前多空的距離 */
	gap?: number;
	rule?: boolean;
}

/** 中文沒有空白可以斷，一個字一個字量，超過寬度就換行。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const out: string[] = [];
	for (const paragraph of text.split('\n')) {
		let line = '';
		for (const ch of paragraph) {
			if (line && ctx.measureText(line + ch).width > maxWidth) {
				out.push(line);
				line = ch;
			} else {
				line += ch;
			}
		}
		out.push(line);
	}
	return out;
}

export interface ReceiptInput {
	order: OrderInfo;
	lines: OrderLine[];
	totals: OrderTotals;
	/** 為什麼要存這張圖：錯誤訊息或「無法確認」 */
	reason: string;
	at?: Date;
}

export function receiptLines({ order, lines, totals, reason, at = new Date() }: ReceiptInput): Line[] {
	const stamp = `${at.getFullYear()}/${pad2(at.getMonth() + 1)}/${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
	const out: Line[] = [
		{ text: '真的書店・結帳資料（沒有確定寫入試算表）', size: 40, bold: true },
		{ text: `結帳時間 ${stamp}`, size: 30, color: MUTED, gap: 8 },
		{ text: reason, size: 28, color: ALERT, gap: 16 },
		{ text: '', size: 0, rule: true, gap: 24 },
		{ text: `購買人：${order.name}`, size: 32, gap: 24 },
		...(order.carrier ? [{ text: `發票載具：${order.carrier}`, size: 32 }] : []),
		{ text: `付款方式：${order.payment}`, size: 32 },
		...(order.note ? [{ text: `備註：${order.note}`, size: 32 }] : []),
		{ text: '', size: 0, rule: true, gap: 24 }
	];

	lines.forEach(({ book, quantity }, i) => {
		out.push({ text: `${i + 1}. ${book.title || '（沒有書名）'}`, size: 32, bold: true, gap: i === 0 ? 24 : 20 });
		const detail = [
			book.isbn ? `ISBN ${book.isbn}` : 'ISBN（沒有）',
			book.condition || '未註記',
			`${money(book.price)} × ${quantity} = ${money(book.price * quantity)}`
		].join('　');
		out.push({ text: detail, size: 28, color: MUTED });
	});

	out.push(
		{ text: '', size: 0, rule: true, gap: 28 },
		{ text: `共 ${lines.reduce((n, l) => n + l.quantity, 0)} 本　應付總額 ${money(totals.total)}`, size: 36, bold: true, gap: 24 },
		{ text: `贈送購物金 ${money(totals.credit)}`, size: 32 },
		{ text: '請到試算表確認這一單有沒有寫進去，沒有的話照這張圖手動補上。', size: 26, color: MUTED, gap: 28 }
	);
	return out;
}

/** 畫成 PNG 檔。檔名帶時間，在相簿裡跟封面照放在一起也認得出來。 */
export async function renderReceipt(input: ReceiptInput): Promise<File> {
	const at = input.at ?? new Date();
	const lines = receiptLines({ ...input, at });

	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('這個瀏覽器不能畫圖');
	const maxWidth = WIDTH - PAD * 2;
	const setFont = (l: Line) => { ctx.font = `${l.bold ? '600 ' : ''}${l.size}px ${FONT}`; };

	// 先量出總高度，才能決定 canvas 多高（改尺寸會清掉內容，所以分兩趟）
	const laid: { line: Line; rows: string[] }[] = [];
	let height = PAD;
	for (const line of lines) {
		height += line.gap ?? 0;
		if (line.rule) {
			laid.push({ line, rows: [] });
			height += 2;
			continue;
		}
		setFont(line);
		const rows = wrap(ctx, line.text, maxWidth);
		laid.push({ line, rows });
		height += rows.length * Math.round(line.size * 1.5);
	}
	height += PAD;

	canvas.width = WIDTH;
	canvas.height = height;
	ctx.fillStyle = BG;
	ctx.fillRect(0, 0, WIDTH, height);
	ctx.textBaseline = 'top';

	let y = PAD;
	for (const { line, rows } of laid) {
		y += line.gap ?? 0;
		if (line.rule) {
			ctx.fillStyle = RULE;
			ctx.fillRect(PAD, y, maxWidth, 2);
			y += 2;
			continue;
		}
		setFont(line);
		ctx.fillStyle = line.color ?? TEXT;
		for (const row of rows) {
			ctx.fillText(row, PAD, y + Math.round(line.size * 0.2));
			y += Math.round(line.size * 1.5);
		}
	}

	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
	if (!blob) throw new Error('圖片產生失敗');
	const name = `checkout_${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}.png`;
	return new File([blob], name, { type: 'image/png' });
}
