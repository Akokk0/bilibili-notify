/**
 * 顶部导航「显哪几个」的偏好。
 *
 * 存 localStorage 而不是配置文件:这是「我这台机器上想看见什么」,与实例怎么跑无关
 * —— 同主题、聊天玻璃片透明度那一档。判定逻辑住在 `config/nav.ts`,这里只管状态
 * 与落盘。
 */

import { create } from "zustand";
import { canHideNav, moveNavPath, NAV_ITEMS, orderedNav } from "../config/nav";

export const NAV_HIDDEN_KEY = "bn.nav.hidden";
export const NAV_ORDER_KEY = "bn.nav.order";

/**
 * localStorage 在隐私模式 / 某些内嵌 WebView 里读写**都会抛**,所以一律包 try ——
 * 一个记不住的偏好不该让整个 dashboard 打不开。同 `store/aiChat.ts` 的口径。
 */
/** 读一份字符串数组;读不到 / 不是 JSON / 不是字符串数组一律当没存过。 */
function readPathList(key: string): string[] {
	let raw: string | null;
	try {
		raw = localStorage.getItem(key);
	} catch {
		return [];
	}
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// 逐项校验:这份名单是能手改的,一个数字混进去就会让下游的 Set 判等永远不命中。
		return parsed.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

function writePathList(key: string, list: readonly string[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {
		// 存不住就算了,本次会话内仍然生效。
	}
}

/** 藏起来的路径。滤掉「系统」—— 手改 localStorage 同样不该能把自己锁死。 */
export function readHiddenNav(): string[] {
	return readPathList(NAV_HIDDEN_KEY).filter(canHideNav);
}

export function writeHiddenNav(hidden: readonly string[]): void {
	writePathList(NAV_HIDDEN_KEY, hidden);
}

/** 主人拖出来的顺序。合法性交给 `orderedNav`(它忽略不认识的、去重、补末尾)。 */
export function readNavOrder(): string[] {
	return readPathList(NAV_ORDER_KEY);
}

export function writeNavOrder(order: readonly string[]): void {
	writePathList(NAV_ORDER_KEY, order);
}

export interface NavState {
	/** 藏起来的路径。**存隐藏集合**的理由见 `config/nav.ts#visibleNav`。 */
	hidden: string[];
	/** 主人拖出来的顺序。空 = 还没排过,用代码里那份。 */
	order: string[];
	/** 藏 / 取回一项。「系统」是空操作。 */
	toggle: (to: string) => void;
	/** 一键全部显示 —— 藏多了想反悔时不必一个个点回来。 */
	showAll: () => void;
	/** 把 `from` 拖到 `to` 现在的位置上。 */
	reorder: (from: string, to: string) => void;
	/** 顺序恢复成代码里那份。 */
	resetOrder: () => void;
}

export const useNavStore = create<NavState>((set, get) => ({
	hidden: readHiddenNav(),
	order: readNavOrder(),

	toggle: (to) => {
		if (!canHideNav(to)) return;
		const cur = get().hidden;
		const next = cur.includes(to) ? cur.filter((x) => x !== to) : [...cur, to];
		writeHiddenNav(next);
		set({ hidden: next });
	},

	showAll: () => {
		writeHiddenNav([]);
		set({ hidden: [] });
	},

	reorder: (from, to) => {
		// 基于**解析后**的完整顺序来挪,而不是存着的那份半截名单:后者可能只提了
		// 一两项(甚至是空的),`indexOf` 直接找不着,一拖就成了空操作。
		const cur = orderedNav(NAV_ITEMS, get().order).map((i) => i.to);
		const next = moveNavPath(cur, from, to);
		writeNavOrder(next);
		set({ order: next });
	},

	resetOrder: () => {
		writeNavOrder([]);
		set({ order: [] });
	},
}));
