/**
 * Simple UI utility functions
 */
export class UIUtils {
	/**
	 * Show a toast notification
	 */
	static showToast(message: string, duration: number = 3000): void {
		const toast = document.getElementById('toast');
		if (!toast) return;

		toast.textContent = message;
		toast.classList.add('active');

		setTimeout(() => {
			toast.classList.remove('active');
		}, duration);
	}

	/**
	 * Show a modal
	 */
	static showModal(modalId: string): void {
		document.getElementById(modalId)?.classList.add('active');
	}

	/**
	 * Hide a modal. 不清空輸入框——設定裡的 Web App 網址要留著，
	 * 下次打開還看得到目前設定的值。
	 */
	static hideModal(modalId: string): void {
		document.getElementById(modalId)?.classList.remove('active');
	}

	/**
	 * 文字節點用的跳脫。書名與作者來自店主維護的 Google Sheet，
	 * 不是可信的 HTML，一律跳脫後再放進 innerHTML。
	 */
	static escapeHtml(text: string): string {
		const div = document.createElement('div');
		div.textContent = text ?? '';
		return div.innerHTML;
	}

	/**
	 * 屬性值用的跳脫。escapeHtml 不會處理引號，直接塞進 value="…" 會被書名裡的
	 * 雙引號提前關掉屬性，後面的內容就跑出來變成標記了。
	 */
	static escapeAttr(text: string): string {
		return (text ?? '')
			.replace(/&/g, '&amp;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
}
