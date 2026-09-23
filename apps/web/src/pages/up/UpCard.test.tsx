// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type ExtensionSubscription, makeEmptySubscription } from "../../types/domain";
import { UP_CARD_MIN_H, UpCard, type UpCardProps } from "./UpCard";

/**
 * 卡片的菜单触发接线:桌面右键(onContextMenu,阻止浏览器原生菜单)、触屏长按,都
 * 转成 onRequestMenu(坐标),由父层据此在该坐标弹 UpCardMenu。
 */
afterEach(cleanup);

function props(overrides: Partial<UpCardProps> = {}): UpCardProps {
	return {
		sub: makeEmptySubscription("100"),
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
			...makeEmptySubscription("100"),
			followed: false,
			followError: "对方已将你拉黑",
		};
		const { getByText } = render(<UpCard {...props({ sub })} />);

		expect(getByText(/收不到动态/)).toBeTruthy();
		expect(getByText(/拉黑/)).toBeTruthy();
	});

	it("followed=true → 什么都不显示", () => {
		const sub = { ...makeEmptySubscription("100"), followed: true };
		const { queryByText } = render(<UpCard {...props({ sub })} />);

		expect(queryByText(/收不到动态/)).toBeNull();
	});

	it("followed=undefined(老数据/服务端没检查过)→ 不显示,别凭空吓人", () => {
		const { queryByText } = render(<UpCard {...props()} />);

		expect(queryByText(/收不到动态/)).toBeNull();
	});
});

/**
 * grid 同一行的高度由**最高的那张卡**决定。UP 卡从前没有自己的最小高度,一直是
 * 末尾那张「添加 UP 主」卡(min-h-55)在替整行撑着 —— 于是一切到分组筛选(添加卡
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
function makeExtSub(over: Partial<ExtensionSubscription> = {}): ExtensionSubscription {
	const {
		kind: _k,
		uid: _u,
		roastSchedule: _r,
		specialUsers: _s,
		followed: _f,
		followError: _e,
		...common
	} = makeEmptySubscription("0");
	return {
		...common,
		kind: "extension",
		extensionId: "douyin",
		externalId: "MS4wLjAB-sec",
		...over,
	};
}

describe("UpCard × 拓展订阅", () => {
	it("没有 uid 那一行,名字回落到外部 id", () => {
		const { queryByText, getAllByText } = render(<UpCard {...props({ sub: makeExtSub() })} />);
		expect(queryByText(/UID/)).toBeNull();
		expect(getAllByText("MS4wLjAB-sec").length).toBeGreaterThan(0);
	});

	it("有名字用名字,有资料缓存用资料缓存", () => {
		const named = render(<UpCard {...props({ sub: makeExtSub({ name: "抖音那位" }) })} />);
		expect(named.getAllByText("抖音那位").length).toBeGreaterThan(0);
		named.unmount();
		const cached = makeExtSub({
			name: "抖音那位",
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
