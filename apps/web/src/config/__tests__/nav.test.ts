/**
 * 顶部导航的「显哪几个」—— 纯逻辑那一半。
 *
 * BN 的功能面比很多人用得上的宽,导航条一排十来项。这里让主人自己挑要看见哪些,
 * 藏起来的只是**入口**:路由一个没动,URL 直达照常打得开,灵动岛的跳转、外链、
 * 收藏夹也就都还活着。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	ALWAYS_VISIBLE_PATH,
	canHideNav,
	moveNavPath,
	NAV_ITEMS,
	orderedNav,
	resolveNav,
	visibleNav,
} from "../nav";

/** 一份缩小版导航表,免得每加一个页面就要回来改断言。 */
const ALL = [
	{ to: "/", label: "概览" },
	{ to: "/subs", label: "订阅 UP 主" },
	{ to: "/logs", label: "日志" },
	{ to: ALWAYS_VISIBLE_PATH, label: "系统" },
];

describe("visibleNav", () => {
	it("什么都没藏 → 原样全给,连顺序都不动", () => {
		expect(visibleNav(ALL, [])).toEqual(ALL);
	});

	it("藏掉的就不出现了", () => {
		expect(visibleNav(ALL, ["/logs", "/subs"]).map((i) => i.to)).toEqual([
			"/",
			ALWAYS_VISIBLE_PATH,
		]);
	});

	it("「系统」藏不掉 —— 那是唯一能把别的改回来的地方,藏了就锁死了", () => {
		expect(visibleNav(ALL, [ALWAYS_VISIBLE_PATH]).map((i) => i.to)).toContain(ALWAYS_VISIBLE_PATH);
	});

	it("全藏光也还剩「系统」,导航条不会变成空的", () => {
		expect(
			visibleNav(
				ALL,
				ALL.map((i) => i.to),
			).map((i) => i.to),
		).toEqual([ALWAYS_VISIBLE_PATH]);
	});

	it("认不出的路径一概忽略 —— localStorage 是能手改的,别让脏值把导航画瞎", () => {
		expect(visibleNav(ALL, ["/nonexistent", "/logs"]).map((i) => i.to)).toEqual([
			"/",
			"/subs",
			ALWAYS_VISIBLE_PATH,
		]);
	});

	it("**存的是隐藏集合**,所以日后新加的页面默认就看得见", () => {
		// 反过来存「显示白名单」的话,老主人的名单里没有新页面 —— 新功能上线即隐身,
		// 而他根本不知道有这么一页,也就永远不会去打开它。
		const hidden = ["/logs"];
		const withNewPage = [...ALL, { to: "/brand-new", label: "新页面" }];
		expect(visibleNav(withNewPage, hidden).map((i) => i.to)).toContain("/brand-new");
	});
});

describe("orderedNav", () => {
	const paths = (items: readonly { to: string }[]) => items.map((i) => i.to);

	it("没排过 → 原样,顺序就是代码里那份", () => {
		expect(paths(orderedNav(ALL, []))).toEqual(paths(ALL));
	});

	it("排过就按排的来", () => {
		expect(paths(orderedNav(ALL, ["/logs", "/", ALWAYS_VISIBLE_PATH, "/subs"]))).toEqual([
			"/logs",
			"/",
			ALWAYS_VISIBLE_PATH,
			"/subs",
		]);
	});

	it("**没提到的项追加在末尾** —— 日后新加的页面不会因为不在名单里就消失", () => {
		// 这条和 visibleNav 存隐藏集合是同一个道理:名单是主人**当时**排的,
		// 不该让它决定往后所有页面的生死。
		expect(paths(orderedNav(ALL, ["/logs"]))).toEqual(["/logs", "/", "/subs", ALWAYS_VISIBLE_PATH]);
	});

	it("认不出的路径一概忽略 —— 页面删了,名单里那一条不该留个空位", () => {
		expect(paths(orderedNav(ALL, ["/gone", "/logs"]))).toEqual([
			"/logs",
			"/",
			"/subs",
			ALWAYS_VISIBLE_PATH,
		]);
	});

	it("名单里出现重复也只算一次 —— localStorage 是能手改的", () => {
		expect(paths(orderedNav(ALL, ["/logs", "/logs", "/"]))).toEqual([
			"/logs",
			"/",
			"/subs",
			ALWAYS_VISIBLE_PATH,
		]);
	});
});

describe("moveNavPath", () => {
	const cur = ["/", "/subs", "/logs", ALWAYS_VISIBLE_PATH];

	it("往后拖", () => {
		expect(moveNavPath(cur, "/", "/logs")).toEqual(["/subs", "/logs", "/", ALWAYS_VISIBLE_PATH]);
	});

	it("往前拖", () => {
		expect(moveNavPath(cur, ALWAYS_VISIBLE_PATH, "/subs")).toEqual([
			"/",
			ALWAYS_VISIBLE_PATH,
			"/subs",
			"/logs",
		]);
	});

	it("拖到自己身上 → 原样,不白存一次", () => {
		expect(moveNavPath(cur, "/subs", "/subs")).toEqual(cur);
	});

	it("拖一个不在表里的 → 原样,不炸也不乱序", () => {
		expect(moveNavPath(cur, "/gone", "/subs")).toEqual(cur);
		expect(moveNavPath(cur, "/subs", "/gone")).toEqual(cur);
	});
});

describe("resolveNav — 排序与隐藏一起算", () => {
	it("先排序再过滤 —— 藏掉的那项不该在最终顺序里留空位", () => {
		const out = resolveNav(ALL, { order: ["/logs", "/subs"], hidden: ["/subs"] });
		expect(out.map((i) => i.to)).toEqual(["/logs", "/", ALWAYS_VISIBLE_PATH]);
	});

	it("两样都没设 → 就是代码里那份", () => {
		expect(resolveNav(ALL, { order: [], hidden: [] })).toEqual(ALL);
	});

	it("藏了又排了「系统」→ 位置听排序的,但依旧藏不掉", () => {
		const out = resolveNav(ALL, {
			order: [ALWAYS_VISIBLE_PATH, "/"],
			hidden: [ALWAYS_VISIBLE_PATH, "/subs", "/logs"],
		});
		expect(out.map((i) => i.to)).toEqual([ALWAYS_VISIBLE_PATH, "/"]);
	});
});

describe("canHideNav", () => {
	it("「系统」不可藏", () => {
		expect(canHideNav(ALWAYS_VISIBLE_PATH)).toBe(false);
	});

	it("其余都可以藏,概览也不例外 —— 它只是首页,藏的是入口不是路由", () => {
		for (const item of NAV_ITEMS.filter((i) => i.to !== ALWAYS_VISIBLE_PATH)) {
			expect(canHideNav(item.to)).toBe(true);
		}
	});
});

describe("NAV_ITEMS", () => {
	it("路径不重复 —— 重了的话勾选框会连动,藏一个灭俩", () => {
		const paths = NAV_ITEMS.map((i) => i.to);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("「系统」真的在表里,否则 ALWAYS_VISIBLE_PATH 就是个指不着的常量", () => {
		expect(NAV_ITEMS.some((i) => i.to === ALWAYS_VISIBLE_PATH)).toBe(true);
	});
});
