/**
 * 書封拍照：店主要留存賣出的書的封面，照片只需要留在這支手機裡。
 *
 * 不上傳、不壓縮、不處理照片——拍完就交給系統存。限制要知道：
 * - 網頁開不了 iOS 內建的「相機」App。`<input capture>` 會直接跳出系統的拍照畫面，
 *   是最接近的作法。
 * - 用 input 拍的照片**不會**自動進相簿（只是一個交給網頁的檔案），網頁也沒辦法
 *   默默寫進相簿。所以拍完要再按一下「存到相簿」，透過分享選單的「儲存影像」存。
 *   navigator.share 必須由使用者的點擊觸發，不能在拍完的 change 事件裡自動叫——
 *   那時候已經沒有使用者手勢，iOS 會拒絕。
 * - 不支援分享檔案的瀏覽器（例如電腦）退回成下載。
 */

export interface CoverPhoto {
	file: File;
	/** 給縮圖用的 object URL，換掉或清空時要 revoke */
	url: string;
	saved: boolean;
}

/** 檔名：ISBN_日期-時間，方便之後在相簿或檔案裡對得上是哪一本。 */
export function nameCoverFile(raw: File, isbn: string): File {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const ext = raw.type === 'image/png' ? 'png' : raw.type === 'image/heic' ? 'heic' : 'jpg';
	const base = (isbn || 'book').replace(/[^0-9A-Za-z-]/g, '') || 'book';
	return new File([raw], `${base}_${stamp}.${ext}`, { type: raw.type || 'image/jpeg' });
}

export type SaveOutcome = 'saved' | 'cancelled' | 'downloaded';

/** 一定要在使用者點擊的 handler 裡呼叫。 */
export async function saveCoverToDevice(file: File): Promise<SaveOutcome> {
	if (navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file] });
			return 'saved';
		} catch (error) {
			if ((error as DOMException).name === 'AbortError') return 'cancelled';
			throw error;
		}
	}

	const a = document.createElement('a');
	a.href = URL.createObjectURL(file);
	a.download = file.name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
	return 'downloaded';
}
