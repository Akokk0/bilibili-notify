import type { MouseEvent } from "react";
import { getDesktopToken } from "../services/desktop-token";

/**
 * 外链跳转 —— dashboard 同一份代码跑在两种壳里:
 * - 浏览器:`<a target="_blank">` 原生即可,新标签页打开。
 * - 桌面壳(Tauri):webview 不会自己处理 `target="_blank"`(点了没反应,本次修复的
 *   bug)。改成「同窗口导航到外链」,由桌面壳 Rust 侧的 `on_navigation` 拦截外部
 *   http(s) URL、交系统浏览器打开并取消 webview 内导航(dashboard 原地不动)。
 *
 * 为什么不用 IPC(`window.__TAURI__` / opener 插件):dashboard 从本机 server
 * `http://127.0.0.1:port` 加载,是 Tauri 眼里的「远程源」,远程源的 JS API 注入不可
 * 靠;而 `on_navigation` 在 Rust 侧拦截,与页面源无关、最稳。
 *
 * 桌面端判定走 `getDesktopToken()`(token 由启动器塞在 URL hash 里,首次加载即缓存
 * 到 sessionStorage),远程页一样拿得到,比探测 `__TAURI__` 可靠。
 */

/** 是否运行在桌面壳(独立端 Tauri)内。 */
export function isDesktop(): boolean {
	return getDesktopToken() != null;
}

/**
 * 打开外链。桌面壳:同窗口导航(交 Rust on_navigation 拦截到系统浏览器);浏览器:
 * 新标签页打开。
 */
export function openExternal(url: string): void {
	if (isDesktop()) {
		window.location.assign(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * `<a>` 的 onClick:桌面壳里拦截默认导航、改走 `openExternal`;浏览器里放行原生
 * `target="_blank"`。修饰键(新标签/下载等)、非左键、已 preventDefault 的事件都不
 * 拦截,保持原生语义。
 */
export function externalLinkClick(
	href: string | undefined,
): (e: MouseEvent<HTMLAnchorElement>) => void {
	return (e) => {
		if (!href || !isDesktop()) return;
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
			return;
		}
		e.preventDefault();
		openExternal(href);
	};
}
