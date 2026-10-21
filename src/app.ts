import { ScannerService, ScanTarget } from './scanner.js';
import { UIUtils } from './utils.js';
import { Catalog, CatalogBook, normalizeISBN } from './catalog.js';
import { calculateTotals, OrderTotals } from './pricing.js';
import { getWebAppUrl, getSecret, saveSettings, submitOrder, OrderItem, SubmitOutcome } from './sheet.js';

/** 表單上的一列書。查詢前只有店員輸入的內容。 */
interface BookRow {
	id: number;
	isbn: string;
	title: string;
	/** 查詢後的候選書；null 表示還沒查過 */
	candidates: CatalogBook[] | null;
	/** 選中的候選 index；只有一本候選時自動選 0 */
	selected: number | null;
}

type ScanInto = { kind: 'carrier' } | { kind: 'isbn'; rowId: number };

const money = (n: number) => `NT$ ${n.toLocaleString('en-US')}`;

class CheckoutApp {
	private scanner = new ScannerService();
	private catalog = new Catalog();

	private rows: BookRow[] = [];
	private nextRowId = 1;
	private scanInto: ScanInto | null = null;

	constructor() {
		this.bindEvents();
		this.addRow();
		this.loadCatalog();
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
		this.rows.push({ id: this.nextRowId++, isbn: '', title: '', candidates: null, selected: null });
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

		const name = (document.getElementById('input-name') as HTMLInputElement)?.value.trim() ?? '';
		if (!name) {
			this.showFormError('請填寫購買人姓名。');
			return;
		}

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
		}

		this.rows = filled;
		this.renderReview();
		this.switchView('view-review');
	}

	// ======================== 確認 ========================

	/** 目前已選定的書，用來算錢。 */
	private selectedBooks(): CatalogBook[] {
		return this.rows
			.map(r => (r.candidates && r.selected !== null ? r.candidates[r.selected] : null))
			.filter((b): b is CatalogBook => b !== null);
	}

	private renderReview(): void {
		const list = document.getElementById('review-list');
		if (!list) return;

		list.innerHTML = this.rows.map((row, i) => {
			const typed = [row.isbn.trim(), row.title.trim()].filter(Boolean).join('　');

			if (!row.candidates || row.candidates.length === 0) {
				return `
					<div class="review-item review-item--missing">
						<span class="review-no">${i + 1}</span>
						<div class="review-body">
							<p class="review-typed">${UIUtils.escapeHtml(typed)}</p>
							<p class="review-note review-note--warn">書目裡查不到，這一筆不會計入金額，也不會寫進試算表。</p>
						</div>
					</div>`;
			}

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
					</div>
				</div>`;
		}).join('');

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

	private renderTotals(): void {
		const box = document.getElementById('totals');
		const submit = document.getElementById('btn-submit') as HTMLButtonElement | null;
		if (!box) return;

		const books = this.selectedBooks();
		const t = calculateTotals(books);

		const pending = this.rows.filter(r => r.candidates && r.candidates.length > 1 && r.selected === null).length;
		const missing = this.rows.filter(r => r.candidates && r.candidates.length === 0).length;

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
			${missing > 0 ? `<p class="credit-hint credit-hint--warn">有 ${missing} 筆查不到，未計入</p>` : ''}`;

		if (submit) {
			submit.disabled = pending > 0 || books.length === 0;
			submit.textContent = pending > 0 ? `還有 ${pending} 本未選擇` : '確認送出';
		}
	}

	// ======================== 送出 ========================

	private async handleSubmit(): Promise<void> {
		const books = this.selectedBooks();
		if (books.length === 0) return;

		const name = (document.getElementById('input-name') as HTMLInputElement)?.value.trim() ?? '';
		const carrier = (document.getElementById('input-carrier') as HTMLInputElement)?.value.trim() ?? '';
		const totals = calculateTotals(books);
		const items: OrderItem[] = books.map(b => ({ isbn: b.isbn, title: b.title, price: b.price }));

		const submit = document.getElementById('btn-submit') as HTMLButtonElement | null;
		if (submit) {
			submit.disabled = true;
			submit.textContent = '寫入中…';
		}

		const url = getWebAppUrl();
		const secret = getSecret();
		const outcome: SubmitOutcome = url
			? await submitOrder(url, secret, name, items)
			: { status: 'error', message: '尚未設定 Apps Script 網址，這一單沒有寫進試算表。' };

		this.renderResult(name, carrier, books, totals, outcome);
		this.switchView('view-result');

		if (submit) {
			submit.disabled = false;
			submit.textContent = '確認送出';
		}
	}

	private renderResult(
		name: string,
		carrier: string,
		books: CatalogBook[],
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
				<div><span>購買人</span><b>${UIUtils.escapeHtml(name)}</b></div>
				${carrier ? `<div><span>發票載具</span><b>${UIUtils.escapeHtml(carrier)}</b></div>` : ''}
			</div>
			<ul class="result-books">
				${books.map(b => `
					<li>
						<span class="result-book-title">${UIUtils.escapeHtml(b.title)}</span>
						<span class="tag${b.isUsed ? ' tag--used' : ''}">${UIUtils.escapeHtml(b.condition || '未註記')}</span>
						<span class="result-book-price">${money(b.price)}</span>
					</li>`).join('')}
			</ul>
			<div class="totals">
				<div class="total-line total-line--main"><span>應付總額</span><span id="result-total">${money(totals.total)}</span></div>
				<div class="credit"><span class="credit-label">贈送購物金</span><span class="credit-value" id="result-credit">${money(totals.credit)}</span></div>
			</div>`;
	}

	private resetOrder(): void {
		this.rows = [];
		this.nextRowId = 1;
		this.addRow();
		(document.getElementById('input-name') as HTMLInputElement).value = '';
		(document.getElementById('input-carrier') as HTMLInputElement).value = '';
		this.clearFormError();
		this.switchView('view-form');
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
			this.setScanStatus(target === 'carrier' ? '對準載具條碼' : '對準書背的條碼');
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
