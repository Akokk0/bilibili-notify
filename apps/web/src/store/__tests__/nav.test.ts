// @vitest-environment jsdom

/**
 * 导航偏好的落盘 —— 存 localStorage,不进配置文件。
 *
 * 只钉两件事:脏值不能把导航画瞎(这份名单是能手改的),以及 localStorage 整个抛
 * 异常时页面照样活着 —— 隐私模式和某些内嵌 WebView 里 `getItem` / `setItem`
 * **都会抛**,一个记不住的偏好不该让整个 dashboard 打不开。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ALWAYS_VISIBLE_PATH, NAV_ITEMS } from "../../config/nav";
import { NAV_HIDDEN_KEY, readHiddenNav, readNavOrder, useNavStore, writeHiddenNav } from "../nav";

beforeEach(() => {
	localStorage.clear();
	useNavStore.setState({ hidden: [], order: [] });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("readHiddenNav", () => {
	it("没存过 → 空名单,也就是全都显示", () => {
		expect(readHiddenNav()).toEqual([]);
	});

	it("存过就读回来", () => {
		writeHiddenNav(["/logs", "/stats"]);
		expect(readHiddenNav()).toEqual(["/logs", "/stats"]);
	});

	it("不是 JSON → 当没存过,而不是崩在启动路径上", () => {
		localStorage.setItem(NAV_HIDDEN_KEY, "{不是 json");
		expect(readHiddenNav()).toEqual([]);
	});

	it("是 JSON 但不是字符串数组 → 同样当没存过", () => {
		localStorage.setItem(NAV_HIDDEN_KEY, JSON.stringify({ logs: true }));
		expect(readHiddenNav()).toEqual([]);
		localStorage.setItem(NAV_HIDDEN_KEY, JSON.stringify([1, 2, 3]));
		expect(readHiddenNav()).toEqual([]);
	});

	it("「系统」混进名单也读不出来 —— 手改 localStorage 同样锁不死自己", () => {
		localStorage.setItem(NAV_HIDDEN_KEY, JSON.stringify([ALWAYS_VISIBLE_PATH, "/logs"]));
		expect(readHiddenNav()).toEqual(["/logs"]);
	});

	it("localStorage 读就抛 → 回空名单,页面照常起来", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		expect(readHiddenNav()).toEqual([]);
	});
});

describe("writeHiddenNav", () => {
	it("localStorage 写就抛 → 咽掉,本次会话内仍然生效", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceeded");
		});
		expect(() => writeHiddenNav(["/logs"])).not.toThrow();
	});
});

describe("useNavStore", () => {
	it("toggle 一次藏起来,再一次拿回来", () => {
		useNavStore.getState().toggle("/logs");
		expect(useNavStore.getState().hidden).toEqual(["/logs"]);
		useNavStore.getState().toggle("/logs");
		expect(useNavStore.getState().hidden).toEqual([]);
	});

	it("toggle 完立刻落盘 —— 刷新之后还在", () => {
		useNavStore.getState().toggle("/stats");
		expect(readHiddenNav()).toEqual(["/stats"]);
	});

	it("toggle「系统」是空操作,存储也不该被动过", () => {
		useNavStore.getState().toggle(ALWAYS_VISIBLE_PATH);
		expect(useNavStore.getState().hidden).toEqual([]);
		expect(localStorage.getItem(NAV_HIDDEN_KEY)).toBeNull();
	});

	it("showAll 一键恢复 —— 藏多了想反悔时不必一个个点回来", () => {
		useNavStore.setState({ hidden: ["/logs", "/stats", "/about"] });
		useNavStore.getState().showAll();
		expect(useNavStore.getState().hidden).toEqual([]);
		expect(readHiddenNav()).toEqual([]);
	});
});

describe("useNavStore — 排序", () => {
	const DEFAULT_ORDER = NAV_ITEMS.map((i) => i.to);

	it("一次都没排过时拖一下,存下来的是**完整**顺序", () => {
		// 存着的名单一开始是空的。若拿它去 indexOf 找位置,永远是 -1 ——
		// 一拖就成了空操作,主人会以为拖拽根本没做。
		useNavStore.getState().reorder("/logs", "/");
		const order = readNavOrder();
		expect(order).toHaveLength(DEFAULT_ORDER.length);
		expect(order[0]).toBe("/logs");
		expect(new Set(order)).toEqual(new Set(DEFAULT_ORDER));
	});

	it("挪到别人位置上 —— 前后相对次序照常", () => {
		useNavStore.getState().reorder("/about", "/");
		const order = useNavStore.getState().order;
		expect(order[0]).toBe("/about");
		expect(order[1]).toBe("/");
	});

	it("拖到自己身上 → 顺序不变", () => {
		useNavStore.getState().reorder("/logs", "/logs");
		expect(useNavStore.getState().order).toEqual(DEFAULT_ORDER);
	});

	it("「系统」也能挪 —— 藏不掉不等于钉死在原地", () => {
		useNavStore.getState().reorder(ALWAYS_VISIBLE_PATH, "/");
		expect(useNavStore.getState().order[0]).toBe(ALWAYS_VISIBLE_PATH);
	});

	it("resetOrder 清空存储,回到代码里那份", () => {
		useNavStore.getState().reorder("/about", "/");
		useNavStore.getState().resetOrder();
		expect(useNavStore.getState().order).toEqual([]);
		expect(readNavOrder()).toEqual([]);
	});

	it("排序与隐藏各存各的 —— 拖一下不该把藏起来的抖出来", () => {
		useNavStore.getState().toggle("/logs");
		useNavStore.getState().reorder("/about", "/");
		expect(useNavStore.getState().hidden).toEqual(["/logs"]);
		expect(readHiddenNav()).toEqual(["/logs"]);
	});
});
