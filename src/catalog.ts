/**
 * 書目資料來自官網 all-books 的同一份 Google Sheet（`python_script/script_all_books_list.py`
 * 也是讀這張表）。直接在瀏覽器抓 CSV export——這個網址會回 `access-control-allow-origin: *`，
 * 所以跨來源讀得到，不需要像顧客端掃描器那樣另外做 build-time 清單，資料永遠是最新的。
 */
const CATALOG_CSV_URL =
	'https://docs.google.com/spreadsheets/d/1d00beUA9eEkhIkQDfdOvBVv0UbUvVfe2y8mziMEICzA/export?format=csv&gid=0';

/** 書目裡的一本書。只取結帳會用到的欄位。 */
export interface CatalogBook {
	isbn: string;
	title: string;
	author: string;
	price: number;
	/** 原始的「現場書籍狀態」，顯示用 */
	condition: string;
	/** 只有「舊書」算舊書。無書／非賣／借出／空白一律當新書處理（店主確認過）。 */
	isUsed: boolean;
}

/**
 * RFC 4180 CSV 解析。
 *
 * 不能用 split(',')：書目表的「簡介」欄含有逗號與換行，整列會被切爛。
 * 這裡逐字處理引號狀態，並把 "" 還原成一個雙引號。
 */
export function parseCSV(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;

	// 統一換行，避免 \r\n 在欄位值尾端留下 \r
	const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];

		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += ch;
		}
	}

	// 最後一列若沒有結尾換行也要收進來
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

/** 去掉 ISBN 裡的連字號與空白，讓掃到的、手打的、表裡的都能比對。 */
export function normalizeISBN(raw: string): string {
	return (raw || '').replace(/[-\s]/g, '').trim();
}

/** 書名比對用：去空白、轉小寫，讓「13 67」與「1367」之類的差異不影響搜尋。 */
function normalizeTitle(raw: string): string {
	return (raw || '').replace(/\s+/g, '').toLowerCase();
}

function toRecords(rows: string[][]): CatalogBook[] {
	if (rows.length === 0) return [];

	const header = rows[0].map(h => h.trim());
	const col = (name: string) => header.indexOf(name);

	const iTitle = col('書名');
	const iIsbn = col('ISBN');
	const iAuthor = col('作者');
	const iPrice = col('定價');
	const iCondition = col('現場書籍狀態');

	// 欄位是店主在 Google Sheet 裡手動維護的，改名了要讓它大聲壞掉，
	// 不要安靜地算出一張每本都 0 元的帳單。
	const missing = [
		['書名', iTitle], ['ISBN', iIsbn], ['定價', iPrice], ['現場書籍狀態', iCondition]
	].filter(([, i]) => (i as number) === -1).map(([n]) => n);

	if (missing.length > 0) {
		throw new Error(`書目表少了這些欄位：${missing.join('、')}`);
	}

	const books: CatalogBook[] = [];

	for (let r = 1; r < rows.length; r++) {
		const row = rows[r];
		const isbn = normalizeISBN(row[iIsbn] ?? '');
		const title = (row[iTitle] ?? '').trim();

		// 沒有 ISBN 也沒有書名的列（公式列、空白列）不是書
		if (!isbn && !title) continue;

		const rawPrice = (row[iPrice] ?? '').trim().replace(/,/g, '');
		const price = Number(rawPrice);
		const condition = (row[iCondition] ?? '').trim();

		books.push({
			isbn,
			title,
			author: iAuthor === -1 ? '' : (row[iAuthor] ?? '').trim(),
			price: Number.isFinite(price) ? price : 0,
			condition,
			isUsed: condition === '舊書'
		});
	}

	return books;
}

/**
 * 載入後常駐記憶體的書目。968 筆、CSV 約 394KB，整份放著查最單純，
 * 不需要索引結構。
 */
export class Catalog {
	private books: CatalogBook[] = [];
	private loaded = false;

	static fromCSV(text: string): Catalog {
		const catalog = new Catalog();
		catalog.books = toRecords(parseCSV(text));
		catalog.loaded = true;
		return catalog;
	}

	async load(): Promise<void> {
		// 加上時間戳避免拿到瀏覽器或 Google 的舊快取——店主可能剛改完定價就要結帳
		const res = await fetch(`${CATALOG_CSV_URL}&_=${Date.now()}`);
		if (!res.ok) {
			throw new Error(`書目載入失敗（HTTP ${res.status}）`);
		}
		this.books = toRecords(parseCSV(await res.text()));
		this.loaded = true;
	}

	get size(): number {
		return this.books.length;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}

	/**
	 * 用 ISBN 與／或書名找候選書。
	 *
	 * 兩個都給時取聯集而不是交集：店員可能掃到 ISBN 又順手打了書名，兩者不一致
	 * （打錯、或表裡書名不同）時不該什麼都找不到。
	 *
	 * ISBN 是精確比對但仍可能多筆——書目表裡有 3 個 ISBN 重複。
	 * 書名是 partial match，所以本來就會多筆。
	 */
	find(isbnInput: string, titleInput: string): CatalogBook[] {
		const isbn = normalizeISBN(isbnInput);
		const title = normalizeTitle(titleInput);
		const hits: CatalogBook[] = [];

		for (const book of this.books) {
			const byIsbn = isbn !== '' && book.isbn === isbn;
			const byTitle = title !== '' && normalizeTitle(book.title).includes(title);
			if (byIsbn || byTitle) hits.push(book);
		}

		// ISBN 命中的排前面：那是精確比對，比書名的模糊比對可信
		if (isbn !== '') {
			hits.sort((a, b) => Number(b.isbn === isbn) - Number(a.isbn === isbn));
		}

		return hits;
	}
}
