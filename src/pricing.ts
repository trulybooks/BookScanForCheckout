import { CatalogBook } from './catalog.js';

/**
 * 舊書購物金級距。
 *
 * 規則（店主確認）：
 * - 門檻看的是「整單舊書小計」，不是單本，也不含新書。
 * - 只取最高的一級，不累加；600 就是上限，花再多也是 300。
 * - 這是「送購物金」，不是折扣——應付總額完全不受影響。
 *
 * 由大到小排列，第一個達標的就是答案。
 */
const CREDIT_TIERS: ReadonlyArray<{ threshold: number; credit: number }> = [
	{ threshold: 600, credit: 300 },
	{ threshold: 300, credit: 100 }
];

/** 一單裡的一種書：同一本買幾本。 */
export interface OrderLine {
	book: CatalogBook;
	quantity: number;
}

export interface OrderTotals {
	/** 應付總額：全部書的定價加總，購物金不在這裡扣 */
	total: number;
	/** 舊書小計，決定購物金級距 */
	usedSubtotal: number;
	/** 新書小計，純粹顯示用 */
	newSubtotal: number;
	/** 這一單送出的購物金 */
	credit: number;
	/** 再花多少舊書可以升到下一級；已達上限時為 null */
	toNextTier: { needed: number; credit: number } | null;
}

export function calculateTotals(lines: OrderLine[]): OrderTotals {
	let usedSubtotal = 0;
	let newSubtotal = 0;

	// 同一本舊書買兩本，兩本都算進舊書小計，購物金門檻也跟著算
	for (const { book, quantity } of lines) {
		const amount = book.price * quantity;
		if (book.isUsed) {
			usedSubtotal += amount;
		} else {
			newSubtotal += amount;
		}
	}

	const tier = CREDIT_TIERS.find(t => usedSubtotal >= t.threshold);
	const credit = tier ? tier.credit : 0;

	// 還沒到頂時，算出離下一級差多少——結帳時可以順口告訴客人
	let toNextTier: OrderTotals['toNextTier'] = null;
	const next = [...CREDIT_TIERS].reverse().find(t => usedSubtotal < t.threshold);
	if (next) {
		toNextTier = { needed: next.threshold - usedSubtotal, credit: next.credit };
	}

	return {
		total: usedSubtotal + newSubtotal,
		usedSubtotal,
		newSubtotal,
		credit,
		toNextTier
	};
}
