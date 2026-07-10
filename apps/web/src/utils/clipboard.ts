/**
 * 把文本写进系统剪贴板。安全上下文(https / localhost)走异步 Clipboard API;
 * 非安全上下文(局域网 IP + http)下 `navigator.clipboard` 不存在,回退到
 * textarea + execCommand;两条路都走不通返回 false，由调用方 toast 提示手动复制。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
	if (clip?.writeText) {
		try {
			await clip.writeText(text);
			return true;
		} catch {
			// 权限被拒 / 焦点丢失等 → 落到兜底再试一次
		}
	}
	return legacyCopy(text);
}

/** 非安全上下文兜底:塞进离屏 textarea 选中后 execCommand("copy")。 */
function legacyCopy(text: string): boolean {
	if (typeof document === "undefined") return false;
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	const ok = document.execCommand("copy");
	document.body.removeChild(ta);
	return ok;
}
