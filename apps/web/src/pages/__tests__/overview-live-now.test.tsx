// @vitest-environment jsdom
/**
 * 概览页「正在直播」按快照里的订阅 id 对订阅(ADR-0019 决策 50)。
 *
 * 同一个 UP 配了几条订阅时,按 uid 对就只能随手挑一条(今天是后出现的覆盖前面的);
 * 快照带着的 `subscriptionId` 说的才是这间直播间是替哪一条开的。
 */

import type { ExtensionEntryView, SourceEntry } from "@bilibili-notify/contract";
import { colorFromSeed } from "@bilibili-notify/internal";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../i18n";
import type { LiveListeningEntry } from "../../services/overview";
import {
	DEFAULT_FEATURE_FLAGS,
	type FeatureFlagValues,
	makeEmptySubscription,
	type Subscription,
} from "../../types/domain";
import { LiveNowPanel } from "../Overview";
import { makeSource } from "../rules/__tests__/fixtures";

beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "maid" });
});
afterEach(cleanup);

/** 在播快照里一行 B 站订阅的(`uid` 是外部 id)。 */
function biliLive(
	subscriptionId: string,
	uid: string,
	over: Partial<LiveListeningEntry> = {},
): LiveListeningEntry {
	return {
		subscriptionId,
		identity: { sourceKey: "bilibili", externalId: uid },
		isLive: true,
		...over,
	};
}

/** 在播快照里一行抖音拓展订阅的(外部 id 同 {@link extSub})。 */
function douyinLive(
	subscriptionId: string,
	over: Partial<LiveListeningEntry> = {},
): LiveListeningEntry {
	return {
		subscriptionId,
		identity: { sourceKey: "douyin", externalId: "sec-1" },
		isLive: true,
		...over,
	};
}

/** 一条 B 站订阅,资料缓存里的名字就是面板上显示的名字。 */
function biliSub(id: string, uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "bilibili", externalId: uid }),
		id,
		cachedProfile: { name, refreshedAt: "2026-09-23T00:00:00Z" },
	};
}

describe("正在直播 · 房间对到哪条订阅", () => {
	it("同 uid 几条订阅都在 → 显示快照里那条订阅的名字", () => {
		const live = [biliLive("s-own", "u1", { title: "在播标题" })];
		const subs = [
			biliSub("s-first", "u1", "先出现的那条"),
			biliSub("s-own", "u1", "快照里那条"),
			biliSub("s-last", "u1", "后出现的那条"),
		];
		render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel live={live} subs={subs} sources={[makeSource()]} />
			</MemoryRouter>,
		);
		expect(screen.getByText("快照里那条")).toBeTruthy();
		expect(screen.queryByText("先出现的那条")).toBeNull();
		expect(screen.queryByText("后出现的那条")).toBeNull();
	});
});

/** 一条拓展订阅,资料缓存里的名字与头像就是面板上画的那两样。 */
function extSub(id: string, name: string): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "douyin", externalId: "sec-1" }),
		id,
		cachedProfile: {
			name,
			avatar: `${"d".repeat(64)}.png`,
			refreshedAt: "2026-09-23T00:00:00Z",
		},
	};
}

/** 装着的抖音订阅源。 */
const DOUYIN: ExtensionEntryView = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 1,
	provides: ["subscription"],
};

/** 来源表里抖音那一行:平台徽章的名字与颜色照它(取自清单)。 */
const DOUYIN_SOURCE: SourceEntry = {
	status: "running",
	key: "douyin",
	descriptor: {
		label: "抖音",
		shortLabel: "抖",
		color: "#161823",
		supportedFeatures: ["post", "liveStart", "liveStreaming", "liveEnd"],
	},
};

describe("正在直播 · 拓展订阅的在播(ADR-0019 决策 12)", () => {
	const thirtyMinutesAgo = () => new Date(Date.now() - 30 * 60_000 - 5_000).toISOString();

	function renderPanel(
		live: LiveListeningEntry[],
		subs: Subscription[],
		extensions?: ExtensionEntryView[],
	) {
		return render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel
					live={live}
					subs={subs}
					sources={[
						makeSource(),
						...(extensions?.flatMap((one) => (one.id === DOUYIN.id ? [DOUYIN_SOURCE] : [])) ?? []),
					]}
					extensions={extensions}
				/>
			</MemoryRouter>,
		);
	}

	it("名字照订阅、平台徽章照清单、标题 / 分区 / 累计观看都画出来;头像是那条订阅的;不写开播多久", () => {
		const { container } = renderPanel(
			[
				douyinLive("s-dy", {
					title: "抖音这一场",
					category: "聊天",
					startedAt: thirtyMinutesAgo(),
					totalViewers: 12_345,
				}),
			],
			[extSub("s-dy", "抖音乙")],
			[DOUYIN],
		);
		expect(screen.getByText("抖音乙")).toBeTruthy();
		expect(screen.getByText("抖")).toBeTruthy();
		expect(screen.getByText("抖音这一场")).toBeTruthy();
		expect(screen.getByText("聊天")).toBeTruthy();
		// 那一列与 B 站行同一个口径:本场累计观看(决策 75)。
		expect(screen.getByText("1.2万")).toBeTruthy();
		// 面板只列正在播的,「开播」是多余的 —— 主人 09-23 定的,B 站行与拓展行都不写。
		expect(screen.queryByText(/开播/)).toBeNull();
		expect(screen.queryByText(/UID/)).toBeNull();
		expect(container.querySelector(`img[src="/api/images/${"d".repeat(64)}.png"]`)).not.toBeNull();
	});

	it("订阅列表与拓展列表都还没回来:名字写拓展 id 加外部 id、徽章退拓展 id,不写「UID undefined」", () => {
		renderPanel([douyinLive("s-dy")], []);
		expect(screen.getByText("douyin · sec-1")).toBeTruthy();
		expect(screen.getByText("douyin")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
		expect(screen.queryByText(/undefined/)).toBeNull();
		expect(screen.getByText("（未读取到房间标题）")).toBeTruthy();
	});

	it("拓展没报累计观看:那一列是「—」", () => {
		renderPanel([douyinLive("s-dy")], [extSub("s-dy", "抖音乙")], [DOUYIN]);
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("与 B 站房间并排:各画各的,B 站那行照旧", () => {
		renderPanel(
			[biliLive("s-bili", "u1", { totalViewers: 3456 }), douyinLive("s-dy")],
			[biliSub("s-bili", "u1", "B 站甲"), extSub("s-dy", "抖音乙")],
			[DOUYIN],
		);
		expect(screen.getByText("B 站甲")).toBeTruthy();
		expect(screen.getByText("3456")).toBeTruthy();
		expect(screen.getByText("抖音乙")).toBeTruthy();
		expect(screen.getByText("● 2 人在播")).toBeTruthy();
	});

	/**
	 * ㉒d:B 站行的人数从「B 站排好的字串」改成精确数,与拓展行同走 `formatViewers`(`formatCount`)。
	 * 一套写法:万以上排成「1.2万」、万以下原样不加千分位、0 是真数写「0」、没有数写「—」。
	 * 验红:把 B 站那一行改回直接画 `r.totalViewers`,头两条红(画出 87334 / 渲染不出数字);去掉 `formatViewers`
	 * 里的 `undefined` 判断,「—」那条红。
	 */
	it("B 站行与拓展行同一套排法:精确数排成「1.2万」,万以下原样,0 写「0」,没有数写「—」", () => {
		renderPanel(
			[
				biliLive("s-a", "u1", { totalViewers: 87_334 }),
				biliLive("s-b", "u2", { totalViewers: 9_999 }),
				biliLive("s-c", "u3", { totalViewers: 0 }),
				biliLive("s-d", "u4"),
				douyinLive("s-dy", { totalViewers: 87_334 }),
			],
			[
				biliSub("s-a", "u1", "甲"),
				biliSub("s-b", "u2", "乙"),
				biliSub("s-c", "u3", "丙"),
				biliSub("s-d", "u4", "丁"),
				extSub("s-dy", "抖音戊"),
			],
			[DOUYIN],
		);
		// 同样的 87334:B 站行与拓展行画出同样的字。
		expect(screen.getAllByText("8.7万")).toHaveLength(2);
		expect(screen.getByText("9999")).toBeTruthy();
		expect(screen.getByText("0")).toBeTruthy();
		expect(screen.getAllByText("—")).toHaveLength(1);
	});
});

describe("正在直播 · 名字兜底与颜色", () => {
	function renderPanel(live: LiveListeningEntry[], subs: Subscription[]) {
		return render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel live={live} subs={subs} sources={[makeSource()]} />
			</MemoryRouter>,
		);
	}

	it("B 站身份对不上订阅(订阅列表还没回来):名字写「UID x」,不写 undefined", () => {
		renderPanel([biliLive("s-1", "12345")], []);
		expect(screen.getByText("UID 12345")).toBeTruthy();
		expect(screen.queryByText(/undefined/)).toBeNull();
	});

	// 颜色跟着人走:B 站身份的颜色就是 `colorFromSeed(uid)`(改成身份读法之前的算法),不因换读法而变。
	// 验红:把取色改成别的种子(如订阅 id),这条红。
	it("B 站身份的颜色与按 uid 取色一致(订阅对得上与对不上都是)", () => {
		const { container } = renderPanel(
			[biliLive("s-a", "u1"), biliLive("s-b", "u2")],
			[biliSub("s-a", "u1", "甲")],
		);
		// jsdom 把行内样式里的 #rrggbb 规范成 rgb(r, g, b)。
		const asRgb = (hex: string) =>
			`rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
		const links = container.querySelectorAll("a");
		expect(links[0]?.getAttribute("style")).toContain(asRgb(colorFromSeed("u1")));
		expect(links[1]?.getAttribute("style")).toContain(asRgb(colorFromSeed("u2")));
	});
});

/**
 * 提示按启用中的订阅逐项统计,所有来源共用同一个直播判定,同身份的不同订阅不合并。
 * 折好的直播类开关一把都没开,且特别关注条件也不成立的才算。「开着」只看开关、不看有没有推送目标(ADR-0027 决策 1)。
 */
describe("正在直播 · 没开直播推送的提示", () => {
	function renderEmpty(
		subs: Subscription[],
		globalFeatures: FeatureFlagValues = DEFAULT_FEATURE_FLAGS,
	) {
		render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel live={[]} subs={subs} globalFeatures={globalFeatures} />
			</MemoryRouter>,
		);
	}

	/** 把直播类的主开关全关掉(出厂是开着开播与下播的)。 */
	const liveOff = (sub: Subscription): Subscription => ({
		...sub,
		overrides: {
			...sub.overrides,
			features: {
				liveStart: false,
				liveStreaming: false,
				liveEnd: false,
				membership: false,
				superchat: false,
			},
		},
	});

	it("启用着且直播开关全关的订阅计数;已开直播的拓展订阅与停用项不数", () => {
		renderEmpty([
			liveOff(biliSub("s-1", "u1", "甲")),
			liveOff(biliSub("s-2", "u2", "乙")),
			{ ...liveOff(biliSub("s-off", "u3", "丙")), enabled: false },
			extSub("s-ext", "抖音丁"),
		]);
		expect(screen.getByText(/有 2 项启用中的订阅没开直播监听/)).toBeTruthy();
	});

	// 4-35 刻画:仍按订阅项数,不能改成同身份的人数;停用的那项始终不算。
	it("纯 B 站同身份的两项关闭订阅分别计数,另一项停用订阅不数", () => {
		renderEmpty([
			liveOff(biliSub("s-first", "shared", "同身份甲")),
			liveOff(biliSub("s-second", "shared", "同身份乙")),
			{ ...liveOff(biliSub("s-disabled", "shared", "停用项")), enabled: false },
		]);
		const link = screen.getByRole("link", { name: /直播/ });
		expect(link.textContent?.match(/\d+/)?.[0]).toBe("2");
		expect(link.getAttribute("href")).toBe("/subs");
	});

	it("已有在播记录时不展示关闭监听的订阅计数", () => {
		render(
			<MemoryRouter initialEntries={["/"]}>
				<LiveNowPanel
					live={[biliLive("s-live", "u-live", { title: "这一场正在播" })]}
					subs={[
						biliSub("s-live", "u-live", "在播项"),
						liveOff(biliSub("s-off", "u-off", "关闭项")),
					]}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("这一场正在播")).toBeTruthy();
		expect(screen.queryByRole("link", { name: /没开直播|未开启直播/ })).toBeNull();
	});

	it.each(["viewerChat", "viewerEnter"] as const)(
		"主开关全关且 %s 开着,名单只有另一种特性时仍计数",
		(kind) => {
			const sub = liveOff(biliSub("s-mismatch", "u1", "特别关注不对应"));
			sub.overrides = { ...sub.overrides, features: { ...sub.overrides.features, [kind]: true } };
			sub.specialViewers = [
				{ id: "2", features: [kind === "viewerChat" ? "viewerEnter" : "viewerChat"] },
			];
			renderEmpty([sub]);
			const link = screen.getByRole("link", { name: /直播/ });
			expect(link.textContent?.match(/\d+/)?.[0]).toBe("1");
		},
	);

	it("混来源相同外部 id 与同身份不同订阅逐项计数,不漏拓展也不合并身份", () => {
		const first = liveOff(extSub("s-ext-first", "拓展甲"));
		first.identity = { sourceKey: "douyin", externalId: "shared" };
		const second = { ...first, id: "s-ext-second" };
		const other = liveOff(extSub("s-other", "另一来源"));
		other.identity = { sourceKey: "acme.other", externalId: "shared" };
		renderEmpty([
			liveOff(biliSub("s-bili", "shared", "B 站项")),
			first,
			second,
			other,
			{ ...liveOff(extSub("s-disabled", "停用拓展项")), enabled: false },
			biliSub("s-bili-on", "u-on", "开着的 B 站项"),
			extSub("s-ext-on", "开着的拓展项"),
		]);
		const link = screen.getByRole("link", { name: /直播/ });
		// 期望来自四项启用且全关的订阅;同 id/身份不折叠,其余三项不计。
		expect(link.textContent?.match(/\d+/)?.[0]).toBe("4");
		expect(screen.getAllByRole("link", { name: /直播/ })).toHaveLength(1);
		expect(link.getAttribute("href")).toBe("/subs");
	});

	it.each(["unknown", "disabled", "failed"] as const)(
		"来源状态为 %s 且拓展有多个口时仍逐订阅计数,不依赖来源就绪或口数量",
		(status) => {
			render(
				<MemoryRouter initialEntries={["/"]}>
					<LiveNowPanel
						live={[]}
						subs={[liveOff(extSub("s-a", "甲")), liveOff(extSub("s-b", "乙"))]}
						globalFeatures={DEFAULT_FEATURE_FLAGS}
						sources={[{ ...DOUYIN_SOURCE, status }]}
						extensions={[{ ...DOUYIN, provides: ["push", "subscription"] }]}
					/>
				</MemoryRouter>,
			);
			expect(screen.getByRole("link", { name: /直播/ }).textContent?.match(/\d+/)?.[0]).toBe("2");
		},
	);

	it.each(["bilibili", "douyin", "acme.other"])(
		"%s 的全局关与订阅覆盖开同样折叠,即使没有推送目标也不误算",
		(sourceKey) => {
			const inherited = makeEmptySubscription({ sourceKey, externalId: "inherited" });
			const own = makeEmptySubscription({ sourceKey, externalId: "own" });
			own.overrides = { features: { liveStart: true } };
			renderEmpty([inherited, own], { ...DEFAULT_FEATURE_FLAGS, liveStart: false, liveEnd: false });
			expect(screen.getByRole("link", { name: /直播/ }).textContent?.match(/\d+/)?.[0]).toBe("1");
		},
	);

	it.each(["liveStart", "liveStreaming", "liveEnd", "membership", "superchat"] as const)(
		"拓展订阅只开主开关 %s 时也不算关闭监听",
		(feature) => {
			const sub = liveOff(extSub("s-on", "单开关"));
			sub.overrides.features = { ...sub.overrides.features, [feature]: true };
			renderEmpty([sub]);
			expect(screen.queryByRole("link", { name: /没开直播|未开启直播/ })).toBeNull();
		},
	);

	it("全部停用是已知零但并非没有订阅,不显示关闭计数或添加空态", () => {
		renderEmpty([{ ...liveOff(extSub("s-off", "停用项")), enabled: false }]);
		expect(screen.queryByRole("link", { name: /没开直播|未开启直播|还没有订阅/ })).toBeNull();
	});

	it("切换口吻会更新计数提示,标题和人数标签保持平实", () => {
		renderEmpty([liveOff(extSub("s-off", "关闭项"))]);
		expect(
			screen.getByRole("link", { name: "主人，有 1 项启用中的订阅没开直播监听，去订阅页看看吧 →" }),
		).toBeTruthy();
		act(() => i18n.set({ voice: "plain" }));
		expect(screen.getByRole("link", { name: "有 1 项启用中的订阅未开启直播监听 →" })).toBeTruthy();
		expect(screen.getByText("当前没有在播记录")).toBeTruthy();
		expect(screen.getByText("正在直播")).toBeTruthy();
		expect(screen.getByText("● 0 人在播")).toBeTruthy();
	});

	it("继承全局出厂开关(开播 / 下播开着)的订阅不数,哪怕一个推送目标都没配", () => {
		const sub = biliSub("s-1", "u1", "甲");
		expect(sub.routing.liveStart).toEqual([]);
		renderEmpty([sub, extSub("s-ext", "抖音丁")]);
		expect(screen.queryByText(/没开直播监听/)).toBeNull();
	});

	it("开关关着的订阅照数,哪怕路由里还留着目标", () => {
		const routed = liveOff(biliSub("s-1", "u1", "甲"));
		routed.routing.liveStart = ["t-1"];
		renderEmpty([routed]);
		expect(screen.getByText(/有 1 项启用中的订阅没开直播监听/)).toBeTruthy();
	});

	// ⑬d 起周期「正在直播」有自己的特性,只开了它的订阅也会被监听,不该被算进「不会被监听」。
	it("只开了周期「正在直播」(liveStreaming)的 B 站订阅也不数", () => {
		const sub = liveOff(biliSub("s-1", "u1", "甲"));
		sub.overrides = {
			...sub.overrides,
			features: { ...sub.overrides.features, liveStreaming: true },
		};
		renderEmpty([sub]);
		expect(screen.queryByText(/没开直播监听/)).toBeNull();
	});

	// 与服务端 `needsLiveMonitor` 同一个判定:特别关注是「开关 ∧ 名单上有人带它」(3b-16)。
	it.each(["viewerChat", "viewerEnter"] as const)(
		"主开关全关、名单上有人带 %s、但这把特别开关关着的订阅照数",
		(kind) => {
			const sub = liveOff(biliSub("s-1", "u1", "甲"));
			sub.specialViewers = [{ id: "2", features: [kind] }];
			renderEmpty([sub]);
			expect(screen.getByText(/有 1 项启用中的订阅没开直播监听/)).toBeTruthy();
		},
	);

	it.each(["viewerChat", "viewerEnter"] as const)(
		"主开关全关、%s 开着且名单上有人带它的订阅不数",
		(kind) => {
			const sub = liveOff(biliSub("s-1", "u1", "甲"));
			sub.overrides = { ...sub.overrides, features: { ...sub.overrides.features, [kind]: true } };
			sub.specialViewers = [{ id: "2", features: [kind] }];
			renderEmpty([sub]);
			expect(screen.queryByText(/没开直播监听/)).toBeNull();
		},
	);

	it("全局把直播开关都关了:没覆盖的订阅数,自己开了的不数", () => {
		const off = { ...DEFAULT_FEATURE_FLAGS, liveStart: false, liveEnd: false };
		const own = liveOff(biliSub("s-own", "u2", "乙"));
		own.overrides = { ...own.overrides, features: { liveStart: true } };
		renderEmpty([biliSub("s-1", "u1", "甲"), own], off);
		expect(screen.getByText(/有 1 项启用中的订阅没开直播监听/)).toBeTruthy();
	});
});
