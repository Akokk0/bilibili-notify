import type { LocaleReader } from "../extensions/loader.js";

/**
 * 把语言 store 接成装载器要的「当前语言」读口(ADR-0037 决策 1:出字那一刻读)。
 *
 * 收的是两个函数而不是 store 本身:取字调用的守卫(`scripts/__tests__/i18n-call-sites.test.mjs`)不许把
 * 单例当值递,入口写 `{ current: () => i18n.state().locale, subscribe: (fn) => i18n.subscribe(fn) }`。
 *
 * `onChange` 只在语言**真变了**时叫:store 在口吻变了时也会通知订阅者,而拓展不吃口吻(决策 15)。
 * 基线按订阅那一刻的语言算,每个订阅各记各的。
 */
export function localeReaderOf(store: {
	current: () => string;
	subscribe: (listener: () => void) => () => void;
}): LocaleReader {
	return {
		current: store.current,
		onChange: (fn) => {
			let last = store.current();
			const off = store.subscribe(() => {
				const now = store.current();
				if (now === last) return;
				last = now;
				fn();
			});
			return { dispose: off };
		},
	};
}
