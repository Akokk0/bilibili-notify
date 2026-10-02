// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import type { SubscriptionPlatform } from "../subscription-source";
import { UP_CARD_MIN_H, UpCard, type UpCardProps } from "../UpCard";

/**
 * 卡片的菜单触发接线:桌面右键(onContextMenu,阻止浏览器原生菜单)、触屏长按,都
 * 转成 onRequestMenu(坐标),由父层据此在该坐标弹 UpCardMenu。
 */
afterEach(cleanup);

function props(overrides: Partial<UpCardProps> = {}): UpCardProps {
	return {
		sub: makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
		selected: false,
		onClick: vi.fn(),
		onToggleSelect: vi.fn(),
		onToggleEnabled: vi.fn(),
		togglePending: false,
		onRequestMenu: vi.fn(),
		...overrides,
	};
}

describe("UpCard 菜单触发", () => {
	it("右键卡片 → onRequestMenu(带触发点坐标)", () => {
		const onRequestMenu = vi.fn();
		const { container } = render(<UpCard {...props({ onRequestMenu })} />);

		fireEvent.contextMenu(container.firstChild as Element, { clientX: 111, clientY: 222 });

		expect(onRequestMenu).toHaveBeenCalledWith({ x: 111, y: 222 });
	});

	it("长按卡片满 500ms → onRequestMenu(带触发点坐标)", () => {
		vi.useFakeTimers();
		try {
			const onRequestMenu = vi.fn();
			const { container } = render(<UpCard {...props({ onRequestMenu })} />);

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
 * 「未关注」警告。
 *
 * 动态走 feed/all(关注流)—— 没关注该 UP 就一条动态都收不到。这不是提示,是**故障**:
 * 订阅卡片看着一切正常,实际什么都推不出来。所以要显眼、要一直在,而不是创建时弹个
 * toast 就消失。
 */
describe("UpCard 未关注警告", () => {
	it("followed=false → 显眼告知「收不到动态」,并带上原因", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			followed: false,
			followError: "对方已将你拉黑",
		};
		const { getByText } = render(<UpCard {...props({ sub })} />);

		expect(getByText(/收不到动态/)).toBeTruthy();
		expect(getByText(/拉黑/)).toBeTruthy();
	});

	it("followed=true → 什么都不显示", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			followed: true,
		};
		const { queryByText } = render(<UpCard {...props({ sub })} />);

		expect(queryByText(/收不到动态/)).toBeNull();
	});

	it("followed=undefined(老数据/服务端没检查过)→ 不显示,别凭空吓人", () => {
		const { queryByText } = render(<UpCard {...props()} />);

		expect(queryByText(/收不到动态/)).toBeNull();
	});
});

/**
 * 卡片角标(ADR-0034):写**第一个标签的名字**,名字按 id 到标签表里查;没挂标签就什么都不写 —— 不再写
 * 「默认」。订阅上只记 id,所以角标不会因为标签改名而过期。
 */
const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const CHAT = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };

describe("UpCard 标签角标", () => {
	it("挂了标签 → 写第一个标签的名字(按订阅上 id 的顺序,不是表的顺序),不写第二个", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			tagIds: [CHAT.id, GAME.id],
		};
		const { getByText, queryByText } = render(<UpCard {...props({ sub, tags: [GAME, CHAT] })} />);

		expect(getByText("标签：").textContent).toBe("标签：杂谈");
		expect(queryByText("游戏")).toBeNull();
	});

	it("没挂标签 → 什么都不写:没有「标签:」,更没有「默认」", () => {
		const { queryByText, container } = render(<UpCard {...props({ tags: [GAME, CHAT] })} />);

		expect(queryByText(/标签：/)).toBeNull();
		expect(container.textContent).not.toContain("默认");
		// 旧文案不许残留。
		expect(container.textContent).not.toContain("分组");
	});

	it("没挂标签时「更新于」不带悬空的分隔点", () => {
		const { container } = render(<UpCard {...props({ tags: [GAME] })} />);

		expect(container.textContent).toContain("更新于");
		expect(container.textContent).not.toContain("· 更新于");
	});

	it("挂了标签时「更新于」前有分隔点", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			tagIds: [GAME.id],
		};
		const { container } = render(<UpCard {...props({ sub, tags: [GAME] })} />);

		expect(container.textContent).toContain("标签：游戏· 更新于");
	});

	it("标签表没读到 / 表里查不到那个 id → 当没挂,什么都不写(两张表各自重取,一时对不上不许崩)", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			tagIds: [GAME.id],
		};

		const noTable = render(<UpCard {...props({ sub })} />);
		expect(noTable.queryByText(/标签：/)).toBeNull();
		noTable.unmount();

		const stale = render(<UpCard {...props({ sub, tags: [CHAT] })} />);
		expect(stale.queryByText(/标签：/)).toBeNull();
	});
});

/**
 * grid 同一行的高度由**最高的那张卡**决定。UP 卡从前没有自己的最小高度,一直是
 * 末尾那张「添加 UP 主」卡(min-h-55)在替整行撑着 —— 于是一切到标签筛选(添加卡
 * 按设计不出现),整排 UP 卡当场矮 21px。真机实测 220 → 199(2026-08-21 主人指出)。
 */
describe("UpCard 的高度不靠邻居撑着", () => {
	it("根节点自带最小高度,且与「添加 UP 主」卡是同一个常量", () => {
		const { container } = render(<UpCard {...props()} />);
		expect((container.firstElementChild as HTMLElement).className).toContain(UP_CARD_MIN_H);
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

describe("UpCard × 拓展订阅", () => {
	it("没有 uid 那一行,名字回落到外部 id", () => {
		const { queryByText, getAllByText } = render(<UpCard {...props({ sub: makeExtSub() })} />);
		expect(queryByText(/UID/)).toBeNull();
		expect(getAllByText("MS4wLjAB-sec").length).toBeGreaterThan(0);
	});

	it("有资料缓存用资料缓存里的名字", () => {
		const cached = makeExtSub({
			cachedProfile: { name: "资料里的名字", avatar: "", sign: "", fans: 1, lastRefreshedAt: "t" },
		});
		const { getAllByText } = render(<UpCard {...props({ sub: cached })} />);
		expect(getAllByText("资料里的名字").length).toBeGreaterThan(0);
	});

	it("不出「未关注」—— 哪怕线上带来一个 followed:false", () => {
		const sub = { ...makeExtSub(), followed: false, followError: "x" } as never;
		const { queryByText } = render(<UpCard {...props({ sub })} />);
		expect(queryByText(/收不到动态/)).toBeNull();
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
	features: ["dynamic", "live"],
	absent: false,
};

describe("UpCard × 订阅源的平台", () => {
	it("平台徽章 + 只列这个源报得出的特性,「动态」叫「作品」", () => {
		// 连 B 站独有的 SC 也显式开着 —— 照样不许露面,那是一个永远不会响的开关。
		const sub = makeExtSub({ overrides: { features: { superchat: true } } });
		const { getByText, queryByText } = render(<UpCard {...props({ sub, platform: DOUYIN })} />);
		expect(getByText("抖音")).toBeTruthy();
		expect(getByText("作品")).toBeTruthy();
		expect(getByText("开播")).toBeTruthy();
		expect(queryByText("动态")).toBeNull();
		expect(queryByText("下播")).toBeNull();
		expect(queryByText("SC")).toBeNull();
	});

	it("拓展不在场 → 置灰并写明「抖音拓展没在跑」", () => {
		const { getByText, container } = render(
			<UpCard {...props({ sub: makeExtSub(), platform: { ...DOUYIN, absent: true } })} />,
		);
		expect(getByText("抖音拓展没在跑")).toBeTruthy();
		expect((container.firstElementChild as HTMLElement).className).toContain("grayscale");
	});

	it("拓展列表没回来(absent 不知道)→ 不下结论", () => {
		const { queryByText, container } = render(
			<UpCard {...props({ sub: makeExtSub(), platform: { ...DOUYIN, absent: undefined } })} />,
		);
		expect(queryByText(/拓展没在跑/)).toBeNull();
		expect((container.firstElementChild as HTMLElement).className).not.toContain("grayscale");
	});

	it("没给平台 → 也不列 B 站独有的特性", () => {
		const sub = makeExtSub({ overrides: { features: { liveGuardBuy: true } } });
		const { queryByText, getByText } = render(<UpCard {...props({ sub })} />);
		expect(getByText("动态")).toBeTruthy();
		expect(queryByText("上舰")).toBeNull();
	});
});

/** B 站订阅的身份行:「UID xxx」读的是订阅的身份(外部 id 就是 uid)。 */
describe("UpCard × B 站订阅的身份行", () => {
	it("写「UID xxx」", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			cachedProfile: { name: "UP甲", avatar: "", sign: "", fans: 1, lastRefreshedAt: "t" },
		};
		const { getByText } = render(<UpCard {...props({ sub })} />);
		expect(getByText("UID 100")).toBeTruthy();
	});
});
