// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import {
	DEFAULT_FEATURE_FLAGS,
	FEATURE_KEYS,
	makeEmptySubscription,
	type Subscription,
} from "../../../types/domain";
import {
	SUBSCRIPTION_CARD_MIN_HEIGHT,
	SubscriptionCard,
	type SubscriptionCardProps,
} from "../SubscriptionCard";
import { type SubscriptionPlatform, subscriptionPlatformOf } from "../subscription-source";

/**
 * 卡片的菜单触发接线:桌面右键(onContextMenu,阻止浏览器原生菜单)、触屏长按,都
 * 转成 onRequestMenu(坐标),由父层据此在该坐标弹 SubscriptionCardMenu。
 */
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
afterEach(cleanup);

function props(overrides: Partial<SubscriptionCardProps> = {}): SubscriptionCardProps {
	return {
		sub: makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
		selected: false,
		onClick: vi.fn(),
		onToggleSelect: vi.fn(),
		onToggleEnabled: vi.fn(),
		togglePending: false,
		onRequestMenu: vi.fn(),
		platform: subscriptionPlatformOf({ sourceKey: "bilibili" }, [
			{
				key: "bilibili",
				status: "running",
				descriptor: { label: "B 站", externalIdNoun: "UID", supportedFeatures: FEATURE_KEYS },
			},
		]),
		...overrides,
	};
}

describe("SubscriptionCard 描述符身份", () => {
	it("非B来源显示声明身份标签并保留外部ID原文", () => {
		const sub = makeEmptySubscription({ sourceKey: "library", externalId: "0012" });
		const platform = subscriptionPlatformOf(sub.identity, [
			{
				key: "library",
				status: "running",
				descriptor: { label: "Library", externalIdNoun: "Account", supportedFeatures: [] },
			},
		]);
		const { getAllByText } = render(<SubscriptionCard {...props({ sub, platform })} />);
		expect(getAllByText("Account 0012").length).toBeGreaterThanOrEqual(1);
	});
});

describe("SubscriptionCard 菜单触发", () => {
	it("右键卡片 → onRequestMenu(带触发点坐标)", () => {
		const onRequestMenu = vi.fn();
		const { container } = render(<SubscriptionCard {...props({ onRequestMenu })} />);

		fireEvent.contextMenu(container.firstChild as Element, { clientX: 111, clientY: 222 });

		expect(onRequestMenu).toHaveBeenCalledWith({ x: 111, y: 222 });
	});

	it("长按卡片满 500ms → onRequestMenu(带触发点坐标)", () => {
		vi.useFakeTimers();
		try {
			const onRequestMenu = vi.fn();
			const { container } = render(<SubscriptionCard {...props({ onRequestMenu })} />);

			// jsdom 的 PointerEvent 不透传 clientX/clientY,手动构造事件注入坐标。
			fireEvent(
				container.firstChild as Element,
				Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 50, clientY: 60 }),
			);
			act(() => vi.advanceTimersByTime(500));

			expect(onRequestMenu).toHaveBeenCalledWith({ x: 50, y: 60 });
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * 挂在订阅上的问题(服务端从问题表 join 来):每条一个红字提示,正文是问题的 message;
 * 不看来源、不看 code —— 拓展订阅一样出。没有问题就什么都不出。
 */
describe("SubscriptionCard 订阅上的问题", () => {
	const PROBLEM = {
		reporter: "douyin",
		about: { subscriptionId: "s" },
		code: "anything_at_all",
		message: "这位主播的直播间读不到",
		since: "2026-10-01T00:00:00.000Z",
	};

	it("拓展订阅带一条问题 → 出红字,正文是 message", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" }),
			problems: [PROBLEM],
		};
		const { getByText } = render(<SubscriptionCard {...props({ sub })} />);

		expect(getByText(/直播间读不到/)).toBeTruthy();
	});

	it("每条问题各出一个", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			problems: [PROBLEM, { ...PROBLEM, code: "second", message: "第二件事" }],
		};
		const { getByText } = render(<SubscriptionCard {...props({ sub })} />);

		expect(getByText(/直播间读不到/)).toBeTruthy();
		expect(getByText(/第二件事/)).toBeTruthy();
	});

	it("关注失败(follow_failed)也走通用问题:出红字,正文是 message", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			problems: [
				{
					...PROBLEM,
					reporter: "bilibili",
					code: "follow_failed",
					message: "未关注该 UP —— 收不到动态（对方已将你拉黑）",
				},
			],
		};
		const { getByText } = render(<SubscriptionCard {...props({ sub })} />);

		expect(getByText("未关注该 UP —— 收不到动态（对方已将你拉黑）")).toBeTruthy();
	});

	it("没有问题 → 不出", () => {
		const sub = makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" });
		const { queryByText } = render(<SubscriptionCard {...props({ sub })} />);

		expect(queryByText(/直播间读不到/)).toBeNull();
	});
});

/**
 * 卡片标签(ADR-0034):按登记表顺序显示全部已知标签;没挂标签就什么都不写。
 * 订阅上只记 id,所以显示名称不会因为标签改名而过期。
 */
const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const CHAT = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };

describe("SubscriptionCard 标签角标", () => {
	it("shows all known tags in registry order without changing subscription tagIds", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			tagIds: [CHAT.id, GAME.id],
		};
		const { getByRole } = render(<SubscriptionCard {...props({ sub, tags: [GAME, CHAT] })} />);
		expect(
			within(getByRole("list", { name: "订阅标签" }))
				.getAllByRole("listitem")
				.map((n) => n.textContent),
		).toEqual(["游戏", "杂谈"]);
		expect(sub.tagIds).toEqual([CHAT.id, GAME.id]);
	});

	it("没挂标签 → 什么都不写:没有「标签:」,更没有「默认」", () => {
		const { queryByText, container } = render(
			<SubscriptionCard {...props({ tags: [GAME, CHAT] })} />,
		);

		expect(queryByText(/标签：/)).toBeNull();
		expect(container.textContent).not.toContain("默认");
		// 旧文案不许残留。
		expect(container.textContent).not.toContain("分组");
	});

	it("没挂标签时「更新于」不带悬空的分隔点", () => {
		const { container } = render(<SubscriptionCard {...props({ tags: [GAME] })} />);

		expect(container.textContent).toContain("更新于");
		expect(container.textContent).not.toContain("· 更新于");
	});

	it("keeps the update time separate from label pills", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			tagIds: [GAME.id],
		};
		const { container } = render(<SubscriptionCard {...props({ sub, tags: [GAME] })} />);

		expect(container.textContent).toContain("游戏");
		expect(container.textContent).toContain("更新于");
		expect(container.textContent).not.toContain("· 更新于");
	});

	it("标签表没读到 / 表里查不到那个 id → 当没挂,什么都不写(两张表各自重取,一时对不上不许崩)", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			tagIds: [GAME.id],
		};

		const noTable = render(<SubscriptionCard {...props({ sub })} />);
		expect(noTable.queryByText(/标签：/)).toBeNull();
		noTable.unmount();

		const stale = render(<SubscriptionCard {...props({ sub, tags: [CHAT] })} />);
		expect(stale.queryByText(/标签：/)).toBeNull();
	});
});

/**
 * grid 同一行的高度由**最高的那张卡**决定。UP 卡从前没有自己的最小高度,一直是
 * 末尾那张「添加 UP 主」卡(min-h-55)在替整行撑着 —— 于是一切到标签筛选(添加卡
 * 按设计不出现),整排 UP 卡当场矮 21px。真机实测 220 → 199(2026-08-21 主人指出)。
 */
describe("SubscriptionCard 的高度不靠邻居撑着", () => {
	it("根节点自带最小高度,且与「添加 UP 主」卡是同一个常量", () => {
		const { container } = render(<SubscriptionCard {...props()} />);
		expect((container.firstElementChild as HTMLElement).className).toContain(
			SUBSCRIPTION_CARD_MIN_HEIGHT,
		);
	});
});

/**
 * 拓展订阅(ADR-0019 决策 9)那一行:没有 uid —— 不出「UID …」、不出「未关注」(关注是 B 站
 * 的事);名字按「资料缓存 → 主人起的名字 → 外部 id」取,总得认得出是哪一个。
 */
function makeExtSub(over: Partial<Subscription> = {}): Subscription {
	return {
		...makeEmptySubscription({ sourceKey: "douyin", externalId: "MS4wLjAB-sec" }),
		...over,
	};
}

describe("SubscriptionCard × 拓展订阅", () => {
	it("没有 uid 那一行,名字回落到外部 id", () => {
		const { queryByText, getAllByText } = render(
			<SubscriptionCard
				{...props({
					sub: makeExtSub(),
					platform: subscriptionPlatformOf({ sourceKey: "douyin" }, undefined),
				})}
			/>,
		);
		expect(queryByText(/UID/)).toBeNull();
		expect(getAllByText("douyin · MS4wLjAB-sec").length).toBeGreaterThan(0);
	});

	it("有资料缓存用资料缓存里的名字", () => {
		const cached = makeExtSub({
			cachedProfile: { name: "资料里的名字", followers: 1, refreshedAt: "t" },
		});
		const { getAllByText } = render(<SubscriptionCard {...props({ sub: cached })} />);
		expect(getAllByText("资料里的名字").length).toBeGreaterThan(0);
	});
});

/**
 * 拓展订阅那张卡的平台(ADR-0019 决策 5 / 10 / 41):徽章说是哪个平台的;特性胶囊只列那个源报得
 * 出的,「动态」按平台的叫法走;拓展没在场时整张置灰、写明「××拓展没在跑」。
 */
const DOUYIN: SubscriptionPlatform = {
	label: "抖音",
	shortLabel: "抖音",
	color: "#161823",
	postNoun: "作品",
	features: ["post", "liveStart"],
	supportedExtras: [],
	status: "running",
	showBadge: true,
	absent: false,
};

describe("SubscriptionCard × 订阅源的平台", () => {
	it("平台徽章 + 只列这个源报得出的特性,「动态」叫「作品」", () => {
		// 连 B 站独有的 SC 也显式开着 —— 照样不许露面,那是一个永远不会响的开关。
		const sub = makeExtSub({ overrides: { features: { superchat: true } } });
		const { getByText, getByRole, queryByText } = render(
			<SubscriptionCard {...props({ sub, platform: DOUYIN })} />,
		);
		expect(getByRole("img", { name: "抖音" })).toBeTruthy();
		expect(getByText("作品")).toBeTruthy();
		expect(getByText("开播")).toBeTruthy();
		expect(queryByText("动态")).toBeNull();
		expect(queryByText("下播")).toBeNull();
		expect(queryByText("SC")).toBeNull();
	});

	it("拓展不在场 → 置灰并写明「抖音来源未安装」", () => {
		const { getByText, container } = render(
			<SubscriptionCard {...props({ sub: makeExtSub(), platform: { ...DOUYIN, absent: true } })} />,
		);
		expect(getByText("抖音来源未安装")).toBeTruthy();
		expect((container.firstElementChild as HTMLElement).className).toContain("grayscale");
	});

	it("拓展列表没回来(absent 不知道)→ 不下结论", () => {
		const { queryByText, container } = render(
			<SubscriptionCard
				{...props({ sub: makeExtSub(), platform: { ...DOUYIN, absent: undefined } })}
			/>,
		);
		expect(queryByText(/拓展没在跑/)).toBeNull();
		expect((container.firstElementChild as HTMLElement).className).not.toContain("grayscale");
	});

	it("没给平台 → 也不列 B 站独有的特性", () => {
		const sub = makeExtSub({ overrides: { features: { membership: true } } });
		const { queryByText } = render(
			<SubscriptionCard
				{...props({ sub, platform: subscriptionPlatformOf(sub.identity, undefined) })}
			/>,
		);
		expect(queryByText("动态")).toBeNull();
		expect(queryByText("上舰")).toBeNull();
	});
});

/** B 站订阅的身份行:「UID xxx」读的是订阅的身份(外部 id 就是 uid)。 */
describe("SubscriptionCard × B 站订阅的身份行", () => {
	it("写「UID xxx」", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			cachedProfile: { name: "UP甲", followers: 1, refreshedAt: "t" },
		};
		const { getByText } = render(<SubscriptionCard {...props({ sub })} />);
		expect(getByText("UID 100")).toBeTruthy();
	});
});

/**
 * 订阅功能开关的胶囊。⑬d 起周期「正在直播」是自己的特性(`liveStreaming`),开着时卡片上多一枚「直播中」。
 * 基线是真正的全局特性(调用方给),缺省才是出厂值 —— 全局「周期开」的订阅卡片上也要看得到。
 */
describe("SubscriptionCard 特性胶囊 · 直播中", () => {
	it("出厂关着 → 没有「直播中」胶囊;订阅自己打开 → 有", () => {
		const base = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		expect(render(<SubscriptionCard {...props({ sub: base })} />).queryByText("直播中")).toBeNull();
		cleanup();
		const on = { ...base, overrides: { features: { liveStreaming: true } } };
		expect(render(<SubscriptionCard {...props({ sub: on })} />).getByText("直播中")).toBeTruthy();
	});

	it("全局基线是开的 → 继承的订阅也有;订阅自己关了就没有", () => {
		const globalFeatures = { ...DEFAULT_FEATURE_FLAGS, liveStreaming: true };
		const base = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		expect(
			render(<SubscriptionCard {...props({ sub: base, globalFeatures })} />).getByText("直播中"),
		).toBeTruthy();
		cleanup();
		const off = { ...base, overrides: { features: { liveStreaming: false } } };
		expect(
			render(<SubscriptionCard {...props({ sub: off, globalFeatures })} />).queryByText("直播中"),
		).toBeNull();
	});
});
