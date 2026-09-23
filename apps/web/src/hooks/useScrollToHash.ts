import { type RefObject, useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * 跟着目标滚多久。上面几节都是本机 API,一般几百毫秒就撑开完了;首次冷启动慢一些,
 * 留到 1.2s。到点就撒手 —— 再往后还动的多半是用户自己在操作,不该跟。
 */
const CHASE_MS = 1_200;

/**
 * 带着 `hash` 跳过来(「去更新」→ `/system#update`、「去拓展市场」→ `/extensions#marketplace`)时,
 * 把 `anchorRef` 那一节滚进视口。锚点自己要挂 `scrollMarginTop: BELOW_HEADER_TOP`,不然标题会被
 * 吸顶的顶栏盖住。
 *
 * 滚一次不够。目标前面还排着**各自异步**的分区,它们比目标晚撑开,把它往下顶 —— 而
 * `scrollIntoView` 只在调用那一刻算一次落点,不会跟着元素走,于是人停在目标**上方**。所以滚完还得
 * 跟一会儿:页面高度一变就重滚,直到 CHASE_MS 到点。同一次平滑滚动被重发会就地改道,不会一顿一顿。
 * 人自己动手滚了就立刻收手 —— 别跟用户抢滚动条。
 *
 * 时间窗之外还得盯着**目标自己**从骨架换成整块:冷启动慢的时候那一下就发生在窗口关掉之后,而撑开
 * 最狠的正是它。所以 `loaded` 也是重触发条件 —— 到齐多晚都补一次,顺便重开一个窗口。再点一次
 * 同一个链接(同 hash、新的 `location.key`)也再滚一次。
 */
export function useScrollToHash(
	hash: string,
	anchorRef: RefObject<HTMLElement | null>,
	loaded: boolean,
): void {
	const location = useLocation();
	const wanted = location.hash === hash;
	// biome-ignore lint/correctness/useExhaustiveDependencies: location.key 与 loaded 是刻意的重触发条件 —— 再点一次同一个链接(同 hash)与数据到齐各要再滚一次
	useEffect(() => {
		if (!wanted) return;
		const scroll = () => anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
		scroll();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(scroll);
		ro.observe(document.body);
		const stop = () => ro.disconnect();
		const timer = setTimeout(stop, CHASE_MS);
		window.addEventListener("wheel", stop, { passive: true });
		window.addEventListener("touchstart", stop, { passive: true });
		return () => {
			clearTimeout(timer);
			window.removeEventListener("wheel", stop);
			window.removeEventListener("touchstart", stop);
			ro.disconnect();
		};
	}, [location.key, wanted, loaded]);
}
