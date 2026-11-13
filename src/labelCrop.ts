/**
 * 找出條碼「白色標籤」的範圍，讓解碼器在只框住標籤的子區域上再試一次。
 *
 * 為什麼需要：EAN-13 兩側規定要留大約 7–11 個模組寬的空白（quiet zone），zxing
 * 會檢查。有些書把條碼印在小小的白色標籤上，標籤緊貼著條碼（只剩 2 個模組左右），
 * 外面就是彩色封面——例如 掃描失敗的條碼/isbn_fail.jpg 那本綠色封面的繪本，ISBN
 * 9786263615250。綠色的亮度剛好在黑白中間，zxing 把它當成暗色，於是「沒有空白區」
 * 而拒讀。實測只要裁切的左右邊剛好落在標籤邊緣就讀得到（zxing 把影像邊界視為合格的
 * 空白區），多留 6px 綠色就又讀不到。
 *
 * 只在一般解碼失敗時才用，所以原本就掃得到的書不受影響。試過的其他作法與結果：
 * - 換灰階算法（取最大通道、只取綠通道）：綠色還是不夠白，無效。
 * - 對比曲線把中間調推成白：裁好的條碼有效，但在實際大小的影格上無效，而且會讀出
 *   校驗碼合法的錯誤號碼（1412116467681），結帳會因此查到錯的書。不能用。
 * 這個作法不改任何像素，只決定裁切範圍，在 300 張劣化的合成條碼上 0 次誤讀。
 *
 * 作法：一列一列掃，標籤由「亮的底」與「暗的條」組成；一段非亮像素若夠長而且平均
 * 偏中間調（彩色封面），就是背景、標籤到此為止。用整段平均而不是逐點門檻，背景的
 * 雜訊點才不會被當成黑條；細條模糊後雖然也是中間調，但很短，不會被誤判成背景。
 * 取各列的中位數當左右邊界。
 */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export function findLabelSpan(img: ImageData): Rect | null {
	const { data, width: w, height: h } = img;
	const lum = (x: number, y: number): number => {
		const i = (y * w + x) * 4;
		return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
	};

	// 「亮」的門檻跟著畫面走：取稀疏取樣亮度的第 95 百分位的 80%
	const sample: number[] = [];
	for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) sample.push(lum(x, y));
	sample.sort((a, b) => a - b);
	const bright = sample[Math.floor(sample.length * 0.95)] * 0.8;
	if (bright < 60) return null;

	const maxGap = Math.max(8, Math.round(w * 0.06)); // 標籤內最寬的黑條
	const minLen = Math.round(w * 0.25); // 標籤至少要這麼寬
	const midLimit = Math.max(6, Math.round(w * 0.015)); // 中間調連續這麼長＝背景
	const isBackground = (len: number, sum: number): boolean =>
		len > maxGap || (len >= midLimit && sum / len > bright * 0.45);

	const lefts: number[] = [];
	const rights: number[] = [];
	const ys: number[] = [];

	for (let y = 0; y < h; y += 4) {
		let start = -1;
		let last = -1;
		let transitions = 0;
		let prevBright = false;
		let runLen = 0;
		let runSum = 0;
		let best: [number, number] | null = null;

		const close = (): void => {
			// 至少 20 次明暗交替才像條碼，排除白色文字、空白頁之類
			if (start >= 0 && last - start >= minLen && transitions >= 20 && (!best || last - start > best[1] - best[0])) {
				best = [start, last];
			}
			start = -1;
			transitions = 0;
		};

		for (let x = 0; x < w; x++) {
			const v = lum(x, y);
			if (v >= bright) {
				if (start >= 0 && runLen > 0 && isBackground(runLen, runSum)) close();
				if (start < 0) start = x;
				if (!prevBright) transitions++;
				prevBright = true;
				last = x;
				runLen = 0;
				runSum = 0;
			} else {
				if (prevBright) transitions++;
				prevBright = false;
				runLen++;
				runSum += v;
			}
		}
		close();

		if (best) {
			lefts.push(best[0]);
			rights.push(best[1]);
			ys.push(y);
		}
	}

	if (ys.length < 3) return null;
	const median = (a: number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1];
	const x0 = median(lefts);
	const x1 = median(rights);
	const y0 = Math.min(...ys);
	const y1 = Math.max(...ys);
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
