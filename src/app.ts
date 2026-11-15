import { ScannerService, ScanTarget } from './scanner.js';
import { UIUtils } from './utils.js';
import { Catalog, CatalogBook, normalizeISBN } from './catalog.js';
import { calculateTotals, OrderLine, OrderTotals } from './pricing.js';
import { getWebAppUrl, getSecret, saveSettings, submitOrder, OrderItem, OrderInfo, SubmitOutcome, PAYMENT_OPTIONS, PaymentMethod } from './sheet.js';
import { CoverPhoto, nameCoverFile, saveCoversToDevice } from './coverPhoto.js';

/** 表單上的一列書。查詢前只有店員輸入的內容。 */
interface BookRow {
	id: number;
	isbn: string;
	title: string;
	/** 查詢後的候選書；null 表示還沒查過 */
	candidates: CatalogBook[] | null;
	/** 選中的候選 index；只有一本候選時自動選 0 */
	selected: number | null;
	/** 同一本買幾本，預設 1 */
	quantity: number;
	/**
	 * 書目裡查不到時，店長手動補的資料。可能是漏入庫的商品，照樣要能賣、要能記帳，
	 * 所以不排除，而是讓店長把書名、定價、新舊填完整。查得到的書是 undefined。
	 */
	manual?: ManualEntry;
}

interface ManualEntry {
	isbn: string;
	title: string;
	/** 保留輸入框的原始字串，驗證在 manualBook() 做 */
	price: string;
	used: boolean;
}

const MAX_MANUAL_PRICE = 100000;

/** 手動資料填完整了才回傳一本書；書名與正整數定價是必填。 */
function manualBook(m: ManualEntry | undefined): CatalogBook | null {
	if (!m) return null;
	const title = m.title.trim();
	const price = Number(m.price);
	if (!title || !Number.isInteger(price) || price < 1 || price > MAX_MANUAL_PRICE) return null;
	return {
		isbn: normalizeISBN(m.isbn),
		title,
		author: '',
		price,
		condition: `${m.used ? '舊書' : '新書'}・手動`,
		isUsed: m.used
	};
}

const MAX_QUANTITY = 99;

/** 店員輸入的數量轉成 1–99 的整數；空白或亂打都退回 1。 */
const clampQuantity = (raw: unknown): number => {
	const n = Math.floor(Number(raw));
	return Number.isFinite(n) ? Math.min(MAX_QUANTITY, Math.max(1, n)) : 1;
};

type ScanInto = { kind: 'carrier' } | { kind: 'isbn'; rowId: number };

const money = (n: number) => `NT$ ${n.toLocaleString('en-US')}`;

/**
 * 有送購物金時，自動寫進備註的那一段，例如「贈300元購書金編號」。
 * 購書金的編號由店長之後在試算表裡接在「編號」後面補上，所以這段一定放在備註的
 * **最後面**——店員自己寫的備註在前、用「；」隔開，店長點進格子直接在結尾打編號就好。
 */
const creditNote = (credit: number) => (credit > 0 ? `贈${credit}元購書金編號` : '');
const composeNote = (credit: number, typed: string) =>
	[typed.trim(), creditNote(credit)].filter(Boolean).join('；');

class CheckoutApp {
	private scanner = new ScannerService();
	private catalog = new Catalog();

	private rows: BookRow[] = [];
	private nextRowId = 1;
	private scanInto: ScanInto | null = null;

	/** 每本書的封面照，以 BookRow.id 為 key。只在記憶體裡，開始下一單就清掉。 */
	private photos = new Map<number, CoverPhoto>();
	/** 正在幫哪一本拍（共用一個 file input，所以要記住是誰按的） */
	private photoFor: number | null = null;
	/**
	 * 送出中。按下確認送出後要先等分享選單（存封面）才開始寫入，那段時間送出鍵還沒
	 * 停用，連點會變成兩次寫入試算表——同一單記兩筆。用旗標擋，不靠按鈕狀態：
	 * saveAllPhotos 結束時會重畫明細，把按鈕狀態重設回來。
	 */
	private submitting = false;
	/**
	 * 店員已經被提醒過漏拍封面、選擇照樣送出。不用 confirm() 對話框問：對話框停留
	 * 超過 iOS 的手勢時限（約一秒），接著要叫的分享選單（存封面）就會被拒絕。
	 * 改成第一次按送出時只提醒，再按一次才送——第二次是新的點擊，分享選單照常能叫。
	 */
	private missingPhotosAcknowledged = false;

	constructor() {
		this.bindEvents();
		this.fillPaymentOptions();
		this.addRow();
		this.loadCatalog();
	}

	private fillPaymentOptions(): void {
		const select = document.getElementById('input-payment') as HTMLSelectElement | null;
		if (!select) return;
		for (const option of PAYMENT_OPTIONS) {
			select.add(new Option(option, option));
		}
	}

	// ======================== 書目 ========================

	private async loadCatalog(): Promise<void> {
		const status = document.getElementById('catalog-status');
		try {
			await this.catalog.load();
			if (status) status.textContent = `書目 ${this.catalog.size} 筆・已更新`;
		} catch (error) {
			console.error(error);
			if (status) status.textContent = '書目載入失敗，請檢查網路後重新整理';
			UIUtils.showToast('書目載入失敗，無法查詢定價', 5000);
		}
	}

	// ======================== 表單 ========================

	private addRow(): void {
		this.rows.push({ id: this.nextRowId++, isbn: '', title: '', candidates: null, selected: null, quantity: 1 });
		this.renderRows();
	}

	private removeRow(id: number): void {
		// 至少留一列，否則畫面會整個空掉、沒有東西可以填
		if (this.rows.length === 1) {
			this.rows[0].isbn = '';
			this.rows[0].title = '';
		} else {
			this.rows = this.rows.filter(r => r.id !== id);
		}
		this.renderRows();
	}

	private renderRows(): void {
		const container = document.getElementById('book-rows');
		const count = document.getElementById('book-count');
		if (!container) return;

		if (count) count.textContent = `${this.rows.length} 本`;

		container.innerHTML = this.rows.map((row, i) => `
			<div class="book-row" data-id="${row.id}">
				<div class="book-row-head">
					<span class="book-row-no">${i + 1}</span>
					<button class="book-row-remove" data-remove="${row.id}" aria-label="移除第 ${i + 1} 本">✕</button>
				</div>
				<div class="field-with-btn">
					<input type="text" class="input-text" data-field="isbn" data-id="${row.id}"
						inputmode="numeric" autocomplete="off" placeholder="ISBN"
						value="${UIUtils.escapeAttr(row.isbn)}">
					<button class="btn-scan" data-scan="${row.id}" aria-label="掃描第 ${i + 1} 本的 ISBN">📷</button>
				</div>
				<input type="text" class="input-text" data-field="title" data-id="${row.id}"
					autocomplete="off" placeholder="書名（可只填部分）"
					value="${UIUtils.escapeAttr(row.title)}">
			</div>
		`).join('');

		container.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(input => {
			input.addEventListener('input', () => {
				const row = this.rows.find(r => r.id === Number(input.dataset.id));
				if (!row) return;
				if (input.dataset.field === 'isbn') row.isbn = input.value;
				else row.title = input.value;
			});
		});

		container.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(btn => {
			btn.addEventListener('click', () => this.removeRow(Number(btn.dataset.remove)));
		});

		container.querySelectorAll<HTMLButtonElement>('[data-scan]').forEach(btn => {
			btn.addEventListener('click', () => {
				this.openScanner({ kind: 'isbn', rowId: Number(btn.dataset.scan) });
			});
		});
	}

	private showFormError(message: string): void {
		const box = document.getElementById('form-error');
		if (!box) return;
		box.textContent = message;
		box.classList.remove('hidden');
	}

	private clearFormError(): void {
		document.getElementById('form-error')?.classList.add('hidden');
	}

	// ======================== 查詢 ========================

	private handleLookup(): void {
		this.clearFormError();

		// 購買人資訊改到確認畫面、看完書與金額之後才填，這裡只檢查書。
		// 兩欄都空的列當成沒填，直接略過，不要因此擋住整單
		const filled = this.rows.filter(r => r.isbn.trim() !== '' || r.title.trim() !== '');
		if (filled.length === 0) {
			this.showFormError('至少要填一本書的 ISBN 或書名。');
			return;
		}

		if (!this.catalog.isLoaded) {
			this.showFormError('書目還沒載入完成，請稍候再試。');
			return;
		}

		for (const row of filled) {
			row.candidates = this.catalog.find(row.isbn, row.title);
			// 只有一本候選就先選好，店員不必多點一次
			row.selected = row.candidates.length === 1 ? 0 : null;
			// 查不到就改成手動填。回去修改再查一次時，保留已經填過的定價等資料
			row.manual = row.candidates.length === 0
				? (row.manual ?? { isbn: row.isbn.trim(), title: row.title.trim(), price: '', used: false })
				: undefined;
		}

		this.rows = filled;
		this.missingPhotosAcknowledged = false;
		document.getElementById('review-error')?.classList.add('hidden');
		this.renderReview();
		this.switchView('view-review');
	}

	// ======================== 確認 ========================

	/** 目前已選定的書，用來算錢。 */
	private selectedLines(): OrderLine[] {
		return this.rows
			.map(r => ({ book: this.rowBook(r), quantity: r.quantity }))
			.filter((l): l is OrderLine => l.book !== null);
	}

	/** 這一列要賣的書：查到的選中那本，或店長手動填完整的資料。 */
	private rowBook(r: BookRow): CatalogBook | null {
		if (r.manual) return manualBook(r.manual);
		return r.candidates && r.selected !== null ? r.candidates[r.selected] : null;
	}

	private renderReview(): void {
		const list = document.getElementById('review-list');
		if (!list) return;

		list.innerHTML = this.rows.map((row, i) => {
			const typed = [row.isbn.trim(), row.title.trim()].filter(Boolean).join('　');

			if (row.manual) {
				const m = row.manual;
				return `
					<div class="review-item review-item--manual">
						<span class="review-no">${i + 1}</span>
						<div class="review-body">
							<p class="review-typed">${UIUtils.escapeHtml(typed)}</p>
							<p class="review-note review-note--warn">書目裡查不到（可能還沒入庫），請手動填寫</p>
							<div class="manual-grid">
								<label class="field manual-wide">
									<span class="field-label">書名 ＊</span>
									<input type="text" class="input-text" data-manual="title" data-row="${row.id}"
										value="${UIUtils.escapeAttr(m.title)}" required autocomplete="off">
								</label>
								<label class="field manual-wide">
									<span class="field-label">ISBN</span>
									<input type="text" class="input-text" data-manual="isbn" data-row="${row.id}"
										value="${UIUtils.escapeAttr(m.isbn)}" inputmode="numeric" autocomplete="off" placeholder="可留空">
								</label>
								<label class="field">
									<span class="field-label">定價 ＊</span>
									<input type="number" class="input-text" data-manual="price" data-row="${row.id}"
										value="${UIUtils.escapeAttr(m.price)}" required min="1" max="${MAX_MANUAL_PRICE}" step="1"
										inputmode="numeric" placeholder="NT$">
								</label>
								<div class="field">
									<span class="field-label">新舊</span>
									<div class="seg">
										<label class="seg-opt"><input type="radio" name="cond-${row.id}" value="new" data-manual="used" data-row="${row.id}" ${m.used ? '' : 'checked'}><span>新書</span></label>
										<label class="seg-opt"><input type="radio" name="cond-${row.id}" value="used" data-manual="used" data-row="${row.id}" ${m.used ? 'checked' : ''}><span>舊書</span></label>
									</div>
								</div>
							</div>
							${this.qtyBlock(row, i)}
							${this.photoBlock(row)}
						</div>
					</div>`;
			}

			if (!row.candidates || row.candidates.length === 0) return '';

			const needsPick = row.candidates.length > 1 && row.selected === null;

			const options = row.candidates.map((book, ci) => `
				<label class="candidate${row.selected === ci ? ' candidate--on' : ''}">
					<input type="radio" name="row-${row.id}" value="${ci}" data-pick="${row.id}"
						${row.selected === ci ? 'checked' : ''}>
					<span class="candidate-main">
						<span class="candidate-title">${UIUtils.escapeHtml(book.title)}</span>
						<span class="candidate-meta">${UIUtils.escapeHtml(book.author || '—')}　${UIUtils.escapeHtml(book.isbn)}</span>
					</span>
					<span class="candidate-side">
						<span class="tag${book.isUsed ? ' tag--used' : ''}">${UIUtils.escapeHtml(book.condition || '未註記')}</span>
						<span class="candidate-price">${money(book.price)}</span>
					</span>
				</label>`).join('');

			return `
				<div class="review-item">
					<span class="review-no">${i + 1}</span>
					<div class="review-body">
						<p class="review-typed">${UIUtils.escapeHtml(typed)}</p>
						${row.candidates.length > 1
							? `<p class="review-note${needsPick ? ' review-note--warn' : ''}">找到 ${row.candidates.length} 本相符，請選一本${needsPick ? '（尚未選擇）' : ''}</p>`
							: ''}
						<div class="candidates">${options}</div>
						${this.qtyBlock(row, i)}
						${this.photoBlock(row)}
					</div>
				</div>`;
		}).join('');

		list.querySelectorAll<HTMLButtonElement>('[data-photo]').forEach(btn => {
			btn.addEventListener('click', () => this.takePhoto(Number(btn.dataset.photo)));
		});

		list.querySelectorAll<HTMLInputElement>('input[data-manual]').forEach(input => {
			const row = this.rows.find(r => r.id === Number(input.dataset.row));
			if (!row?.manual) return;
			const m = row.manual;
			const field = input.dataset.manual;
			const update = () => {
				if (field === 'used') {
					if (input.checked) m.used = input.value === 'used';
				} else if (field === 'title' || field === 'isbn' || field === 'price') {
					m[field] = input.value;
				}
				this.renderTotals();
			};
			input.addEventListener(field === 'used' ? 'change' : 'input', update);
		});

		list.querySelectorAll<HTMLButtonElement>('[data-qty-step]').forEach(btn => {
			btn.addEventListener('click', () => {
				const row = this.rows.find(r => r.id === Number(btn.dataset.row));
				if (!row) return;
				row.quantity = clampQuantity(row.quantity + Number(btn.dataset.qtyStep));
				this.renderReview();
			});
		});
		list.querySelectorAll<HTMLInputElement>('input[data-qty]').forEach(input => {
			const row = this.rows.find(r => r.id === Number(input.dataset.qty));
			if (!row) return;
			// 打字時只更新金額、不重畫明細，不然游標會跳走；離開欄位時再把值整理成 1–99
			input.addEventListener('input', () => {
				if (input.value.trim() === '') return;
				row.quantity = clampQuantity(input.value);
				this.renderTotals();
			});
			input.addEventListener('change', () => {
				row.quantity = clampQuantity(input.value);
				this.renderReview();
			});
		});
		list.querySelectorAll<HTMLInputElement>('input[data-pick]').forEach(input => {
			input.addEventListener('change', () => {
				const row = this.rows.find(r => r.id === Number(input.dataset.pick));
				if (!row) return;
				row.selected = Number(input.value);
				this.renderReview();
			});
		});

		this.renderTotals();
	}

	private qtyBlock(row: BookRow, i: number): string {
		return `
			<div class="qty">
				<span class="qty-label">數量</span>
				<button class="qty-btn" data-qty-step="-1" data-row="${row.id}" aria-label="減一本" ${row.quantity <= 1 ? 'disabled' : ''}>−</button>
				<input type="number" class="qty-input" data-qty="${row.id}" value="${row.quantity}"
					min="1" max="${MAX_QUANTITY}" inputmode="numeric" aria-label="第 ${i + 1} 本的數量">
				<button class="qty-btn" data-qty-step="1" data-row="${row.id}" aria-label="加一本" ${row.quantity >= MAX_QUANTITY ? 'disabled' : ''}>＋</button>
			</div>`;
	}

	private renderTotals(): void {
		const box = document.getElementById('totals');
		const submit = document.getElementById('btn-submit') as HTMLButtonElement | null;
		if (!box) return;

		const lines = this.selectedLines();
		const t = calculateTotals(lines);

		const pending = this.rows.filter(r => !r.manual && r.candidates && r.candidates.length > 1 && r.selected === null).length;
		const incomplete = this.rows.filter(r => r.manual && !manualBook(r.manual)).length;

		box.innerHTML = `
			<div class="total-line"><span>新書小計</span><span>${money(t.newSubtotal)}</span></div>
			<div class="total-line"><span>舊書小計</span><span>${money(t.usedSubtotal)}</span></div>
			<div class="total-line total-line--main"><span>應付總額</span><span>${money(t.total)}</span></div>
			<div class="credit">
				<span class="credit-label">贈送購物金</span>
				<span class="credit-value" id="credit-value">${money(t.credit)}</span>
			</div>
			${t.toNextTier
				? `<p class="credit-hint">舊書再買 ${money(t.toNextTier.needed)} 可拿 ${money(t.toNextTier.credit)} 購物金</p>`
				: (t.credit > 0 ? `<p class="credit-hint">已達最高級距</p>` : '')}
			${incomplete > 0 ? `<p class="credit-hint credit-hint--warn">有 ${incomplete} 本手動資料還沒填完，未計入</p>` : ''}`;

		const hint = document.getElementById('note-auto');
		if (hint) {
			hint.textContent = t.credit > 0 ? `送出時會自動在備註最後加上「${creditNote(t.credit)}」，編號請店長在試算表補上` : '';
			hint.classList.toggle('hidden', t.credit === 0);
		}

		if (submit) {
			submit.disabled = pending > 0 || incomplete > 0 || lines.length === 0;
			// 有拍封面時，按鈕直接寫明「送出並存」：按一次就會先存照片再送單
			const photosToSave = this.unsavedPhotoCount();
			const save = photosToSave > 0 ? `並存 ${photosToSave} 張封面` : '';
			const warned = this.missingPhotosAcknowledged && this.rowsMissingPhoto().length > 0;
			submit.textContent = pending > 0
				? `還有 ${pending} 本未選擇`
				: incomplete > 0 ? `還有 ${incomplete} 本資料未填完`
				: warned ? `仍要送出${save}` : save ? `送出${save}` : '確認送出';
		}
	}

	// ======================== 送出 ========================

	private async handleSubmit(): Promise<void> {
		const lines = this.selectedLines();
		if (lines.length === 0) return;

		const name = (document.getElementById('input-name') as HTMLInputElement)?.value.trim() ?? '';
		const payment = (document.getElementById('input-payment') as HTMLSelectElement)?.value ?? '';
		const reviewError = document.getElementById('review-error');
		const missing = [!name && '購買人姓名', !payment && '付款方式'].filter(Boolean);
		if (missing.length > 0) {
			if (reviewError) {
				reviewError.textContent = `請填寫${missing.join('、')}。`;
				reviewError.classList.remove('hidden');
			}
			document.getElementById(!name ? 'input-name' : 'input-payment')?.focus();
			return;
		}
		reviewError?.classList.add('hidden');

		const noPhoto = this.rowsMissingPhoto();
		if (noPhoto.length > 0 && !this.missingPhotosAcknowledged) {
			this.missingPhotosAcknowledged = true;
			if (reviewError) {
				reviewError.textContent = `第 ${noPhoto.join('、')} 本還沒拍封面。要補拍就按那本書的「拍封面」；不拍的話，再按一次送出。`;
				reviewError.classList.remove('hidden');
			}
			this.renderTotals();
			return;
		}

		const order: OrderInfo = {
			name,
			carrier: (document.getElementById('input-carrier') as HTMLInputElement)?.value.trim() ?? '',
			payment: payment as PaymentMethod,
			note: composeNote(
				calculateTotals(lines).credit,
				(document.getElementById('input-note') as HTMLTextAreaElement)?.value ?? ''
			)
		};

		if (this.submitting) return;
		this.submitting = true;
		try {
			await this.submitOrderFlow(lines, order);
		} finally {
			this.submitting = false;
		}
	}

	private async submitOrderFlow(lines: OrderLine[], order: OrderInfo): Promise<void> {
		// 先把這一單的封面一次存進相簿，再送出。順序不能反：分享選單只能在點擊後馬上叫，
		// 等完寫入試算表的網路請求，iOS 就不讓叫了。取消或失敗都照樣送單，完成頁可以補存。
		await this.saveAllPhotos();

		const totals = calculateTotals(lines);
		const items: OrderItem[] = lines.map(({ book, quantity }) => ({
			isbn: book.isbn,
			title: book.title,
			price: book.price,
			quantity
		}));

		const submit = document.getElementById('btn-submit') as HTMLButtonElement | null;
		if (submit) {
			submit.disabled = true;
			submit.textContent = '寫入中…';
		}

		const url = getWebAppUrl();
		const secret = getSecret();
		const outcome: SubmitOutcome = url
			? await submitOrder(url, secret, order, items)
			: { status: 'error', message: '尚未設定 Apps Script 網址，這一單沒有寫進試算表。' };

		this.renderResult(order, lines, totals, outcome);
		this.switchView('view-result');

		if (submit) {
			submit.disabled = false;
			submit.textContent = '確認送出';
		}
	}

	private renderResult(
		order: OrderInfo,
		lines: OrderLine[],
		totals: OrderTotals,
		outcome: SubmitOutcome
	): void {
		const title = document.getElementById('result-title');
		const body = document.getElementById('result-body');
		if (!body) return;

		const banner =
			outcome.status === 'ok'
				? `<div class="banner banner--ok" id="write-banner">已寫入試算表第 ${outcome.rows.join('、')} 列</div>`
				: outcome.status === 'unconfirmed'
					? `<div class="banner banner--warn" id="write-banner">單已送出，但瀏覽器讀不到回應，<b>無法確認是否寫入</b>。請到試算表確認後再關閉這一頁。</div>`
					: `<div class="banner banner--err" id="write-banner">沒有寫入試算表：${UIUtils.escapeHtml(outcome.message)}</div>`;

		if (title) title.textContent = outcome.status === 'ok' ? '結帳完成' : '結帳完成（請確認寫入）';

		body.innerHTML = `
			${banner}
			<div class="result-meta">
				${outcome.status === 'ok' ? `
					<div><span>訂單編號</span><b id="result-order-id">${UIUtils.escapeHtml(outcome.orderId)}</b></div>
					<div><span>購買日期</span><b>${UIUtils.escapeHtml(outcome.date)}</b></div>` : ''}
				<div><span>購買人</span><b>${UIUtils.escapeHtml(order.name)}</b></div>
				${order.carrier ? `<div><span>發票載具</span><b>${UIUtils.escapeHtml(order.carrier)}</b></div>` : ''}
				<div><span>付款方式</span><b>${UIUtils.escapeHtml(order.payment)}</b></div>
				${order.note ? `<div><span>備註</span><b>${UIUtils.escapeHtml(order.note)}</b></div>` : ''}
			</div>
			<ul class="result-books">
				${lines.map(({ book: b, quantity }) => `
					<li>
						<span class="result-book-title">${UIUtils.escapeHtml(b.title)}${quantity > 1 ? ` <b class="result-qty">×${quantity}</b>` : ''}</span>
						<span class="tag${b.isUsed ? ' tag--used' : ''}">${UIUtils.escapeHtml(b.condition || '未註記')}</span>
						<span class="result-book-price">${money(b.price * quantity)}</span>
					</li>`).join('')}
			</ul>
			<div class="totals">
				<div class="total-line total-line--main"><span>應付總額</span><span id="result-total">${money(totals.total)}</span></div>
				<div class="credit"><span class="credit-label">贈送購物金</span><span class="credit-value" id="result-credit">${money(totals.credit)}</span></div>
			</div>
			<div id="result-photos"></div>`;
		this.renderResultPhotos();
	}

	private resetOrder(): void {
		const unsaved = this.unsavedPhotoCount();
		if (unsaved > 0 && !confirm(`有 ${unsaved} 張封面還沒存到相簿，開始下一單就會清掉。確定嗎？`)) return;
		this.clearPhotos();
		this.missingPhotosAcknowledged = false;

		this.rows = [];
		this.nextRowId = 1;
		this.addRow();
		(document.getElementById('input-name') as HTMLInputElement).value = '';
		(document.getElementById('input-carrier') as HTMLInputElement).value = '';
		(document.getElementById('input-payment') as HTMLSelectElement).value = '';
		(document.getElementById('input-note') as HTMLTextAreaElement).value = '';
		this.clearFormError();
		document.getElementById('review-error')?.classList.add('hidden');
		this.switchView('view-form');
	}

	// ======================== 書封拍照 ========================

	private photoBlock(row: BookRow): string {
		const photo = this.photos.get(row.id);
		if (!photo) {
			return `
				<div class="photo-row">
					<button class="btn-photo" data-photo="${row.id}">📸 拍封面</button>
					<span class="photo-note photo-note--warn">⚠️ 還沒拍封面</span>
				</div>`;
		}
		return `
			<div class="photo-row">
				<img class="photo-thumb" src="${photo.url}" alt="第 ${row.id} 本的封面">
				<span class="photo-note">${photo.saved ? '✓ 已存到相簿' : '送出時一起存'}</span>
				<button class="btn-photo btn-photo--ghost" data-photo="${row.id}">重拍</button>
			</div>`;
	}

	private takePhoto(rowId: number): void {
		const input = document.getElementById('input-cover') as HTMLInputElement | null;
		if (!input) return;
		this.photoFor = rowId;
		input.value = ''; // 同一本重拍也要觸發 change
		input.click();
	}

	private handlePhotoTaken(file: File | undefined): void {
		const rowId = this.photoFor;
		this.photoFor = null;
		if (!file || rowId === null) return;

		const row = this.rows.find(r => r.id === rowId);
		const book = row ? this.rowBook(row) : null;
		const named = nameCoverFile(file, book?.isbn || row?.manual?.isbn.trim() || row?.isbn.trim() || '');

		const old = this.photos.get(rowId);
		if (old) URL.revokeObjectURL(old.url);
		this.photos.set(rowId, { file: named, url: URL.createObjectURL(named), saved: false });
		if (this.rowsMissingPhoto().length === 0) {
			this.missingPhotosAcknowledged = false;
			document.getElementById('review-error')?.classList.add('hidden');
		}
		this.renderReview();
	}

	/** 把還沒存的封面一次交給系統存。必須由點擊直接呼叫。 */
	private async saveAllPhotos(): Promise<void> {
		const pending = [...this.photos.values()].filter(p => !p.saved);
		if (pending.length === 0) return;
		try {
			const outcome = await saveCoversToDevice(pending.map(p => p.file));
			if (outcome === 'cancelled') return;
			pending.forEach(p => { p.saved = true; });
			if (outcome === 'downloaded') UIUtils.showToast(`已下載 ${pending.length} 張封面`, 2000);
		} catch (error) {
			console.error(error);
			UIUtils.showToast('封面沒有存成功，完成頁可以再存一次', 3000);
		} finally {
			this.renderReview();
			this.renderResultPhotos();
		}
	}

	/**
	 * 完成畫面上列出還沒存的封面，就地存。不讓店員回到明細去存：那裡有「確認送出」，
	 * 回去再按一次就會重複寫入試算表。
	 */
	private renderResultPhotos(): void {
		const box = document.getElementById('result-photos');
		if (!box) return;
		const unsaved = this.rows.filter(r => this.photos.get(r.id) && !this.photos.get(r.id)!.saved);
		if (unsaved.length === 0) {
			box.innerHTML = '';
			return;
		}
		box.innerHTML = `
			<div class="banner banner--warn">有 ${unsaved.length} 張封面還沒存到相簿，開始下一單就會清掉。</div>
			<div class="photo-row">
				${unsaved.map(r => `<img class="photo-thumb" src="${this.photos.get(r.id)!.url}" alt="封面">`).join('')}
			</div>
			<button id="btn-save-all-photos" class="btn btn-secondary btn-large">存全部 ${unsaved.length} 張封面</button>`;
		document.getElementById('btn-save-all-photos')?.addEventListener('click', () => this.saveAllPhotos());
	}

	/** 會賣出（查得到書）卻還沒拍封面的書，回傳畫面上的序號（從 1 起算）。 */
	private rowsMissingPhoto(): number[] {
		return this.rows
			.map((r, i) => ({ r, no: i + 1 }))
			.filter(({ r }) => (r.manual || (r.candidates && r.candidates.length > 0)) && !this.photos.has(r.id))
			.map(({ no }) => no);
	}

	private unsavedPhotoCount(): number {
		let n = 0;
		this.photos.forEach(p => { if (!p.saved) n++; });
		return n;
	}

	private clearPhotos(): void {
		this.photos.forEach(p => URL.revokeObjectURL(p.url));
		this.photos.clear();
	}

	// ======================== 掃描 ========================

	private async openScanner(into: ScanInto): Promise<void> {
		this.scanInto = into;
		const target: ScanTarget = into.kind === 'carrier' ? 'carrier' : 'isbn';

		const heading = document.getElementById('scan-title');
		if (heading) {
			heading.textContent = target === 'carrier' ? '掃描發票載具條碼' : '掃描 ISBN 條碼';
		}
		this.setScanStatus('正在開啟相機…');
		document.getElementById('scan-overlay')?.classList.remove('hidden');

		try {
			await this.scanner.startScanner('reader', (code) => this.handleScanned(code), target);
			this.setScanStatus(target === 'carrier' ? '對準載具條碼，手機離遠一點才對得到焦' : '對準書背的條碼');
		} catch (error) {
			console.error(error);
			this.setScanStatus((error as Error).message);
		}
	}

	private handleScanned(code: string): void {
		const into = this.scanInto;
		if (!into) return;

		if (into.kind === 'carrier') {
			const value = code.trim().toUpperCase();
			const input = document.getElementById('input-carrier') as HTMLInputElement | null;
			if (input) input.value = value;
			this.closeScanner();
			UIUtils.showToast(`已帶入載具 ${value}`, 2000);
			return;
		}

		const value = normalizeISBN(code);
		const row = this.rows.find(r => r.id === into.rowId);
		if (row) {
			row.isbn = value;
			this.renderRows();
		}
		this.closeScanner();
		UIUtils.showToast(`已帶入 ${value}`, 2000);
	}

	private closeScanner(): void {
		this.scanner.stopScanner();
		document.getElementById('scan-overlay')?.classList.add('hidden');
		this.scanInto = null;
	}

	private setScanStatus(message: string): void {
		const el = document.getElementById('scan-status');
		if (el) el.textContent = message;
	}

	// ======================== 共用 ========================

	private switchView(id: string): void {
		document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
		document.getElementById(id)?.classList.add('active');
		window.scrollTo(0, 0);
	}

	private bindEvents(): void {
		document.getElementById('btn-add-book')?.addEventListener('click', () => this.addRow());
		document.getElementById('btn-lookup')?.addEventListener('click', () => this.handleLookup());
		document.getElementById('btn-back-form')?.addEventListener('click', () => this.switchView('view-form'));
		document.getElementById('btn-submit')?.addEventListener('click', () => this.handleSubmit());
		document.getElementById('btn-new-order')?.addEventListener('click', () => this.resetOrder());

		document.getElementById('input-cover')?.addEventListener('change', (e) => {
			this.handlePhotoTaken((e.target as HTMLInputElement).files?.[0]);
		});

		document.getElementById('btn-scan-carrier')?.addEventListener('click', () => {
			this.openScanner({ kind: 'carrier' });
		});

		document.getElementById('btn-close-scan')?.addEventListener('click', () => this.closeScanner());
		document.getElementById('btn-cancel-scan')?.addEventListener('click', () => this.closeScanner());

		document.getElementById('btn-settings')?.addEventListener('click', () => {
			(document.getElementById('input-webapp-url') as HTMLInputElement).value = getWebAppUrl();
			(document.getElementById('input-secret') as HTMLInputElement).value = getSecret();
			UIUtils.showModal('modal-settings');
		});

		document.getElementById('btn-cancel-settings')?.addEventListener('click', () => {
			UIUtils.hideModal('modal-settings');
		});

		document.getElementById('btn-save-settings')?.addEventListener('click', () => {
			const url = (document.getElementById('input-webapp-url') as HTMLInputElement).value.trim();
			const secret = (document.getElementById('input-secret') as HTMLInputElement).value.trim();
			saveSettings(url, secret);
			UIUtils.hideModal('modal-settings');
			UIUtils.showToast('設定已儲存');
		});
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => new CheckoutApp());
} else {
	new CheckoutApp();
}
