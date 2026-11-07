import { api } from "./api";

/** 用同一鉴权门读取原文件，失败不创建下载链接；临时URL随后释放。 */
export async function downloadResource(path: string, name: string): Promise<void> {
	saveResourceFile(await api.blob(path), name);
}

export function saveResourceFile(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob),
		link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
