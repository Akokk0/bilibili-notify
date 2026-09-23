import { useSyncExternalStore } from "react";

/**
 * 「现在」—— 给「N 分钟前」这类相对时间用,**每分钟让用到它的组件重画一次**。
 *
 * 相对时间只在渲染那一刻算一次的话,页面开着不动,它就一直停在「刚刚」。这里是**全面板共用的
 * 一个节拍**:第一个用它的组件挂上时起一个定时器,最后一个卸掉时清掉 —— 页上几十行时间也只有
 * 一个 `setInterval`,而一处时间都没有的页一个都不起。
 *
 * 页面藏在后台(`document.hidden`)时停走:没人看的时候重画是白费;回到前台当场补一拍再接着走,
 * 不让主人切回来先看见一眼过期的值。
 *
 * 返回的是**渲染这一刻**的 `Date.now()`,不是上一拍的时刻:组件因为别的原因重画时拿到的照样是
 * 准的;节拍只负责「没人碰它时也至少每分钟重画一次」。
 */
export function useMinuteClock(): number {
	useSyncExternalStore(subscribe, getBeat);
	return Date.now();
}

const TICK_MS = 60_000;

const listeners = new Set<() => void>();
/** 第几拍 —— 只拿来让 React 知道「变了、该重画」。 */
let beat = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function getBeat(): number {
	return beat;
}

function tick() {
	beat += 1;
	for (const listener of listeners) listener();
}

function start() {
	if (timer === undefined) timer = setInterval(tick, TICK_MS);
}

function stop() {
	if (timer !== undefined) {
		clearInterval(timer);
		timer = undefined;
	}
}

function onVisibilityChange() {
	if (document.hidden) {
		stop();
		return;
	}
	tick();
	start();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		document.addEventListener("visibilitychange", onVisibilityChange);
		if (!document.hidden) start();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stop();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		}
	};
}
