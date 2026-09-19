// @vitest-environment jsdom
/**
 * UP 抽屉「订阅项」里的下播:卡片是本体,词云 / AI 总结是挂在它下面的两个附加项。
 *
 * 守的是:附加项跟着下播的开关走(下播关了就灰掉);关一个附加项只写那一个键
 * (`overrides.features.extras.wordcloud`),与默认值相同就不落 override。
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type PushTarget, type Subscription } from "../../types/domain";
import { UpDialog } from "./UpDialog";

afterEach(cleanup);

function renderDialog(sub: Subscription) {
	const onSave = vi.fn();
	render(
		<UpDialog
			sub={sub}
			targets={[]}
			onClose={() => {}}
			onSave={onSave}
			onDelete={() => {}}
			saving={false}
		/>,
	);
	return { onSave };
}

/** 子开关按 aria-label 取 —— 按文案找再摸 parentElement 会被行内排版的改动带倒。 */
function extraToggle(label: string): HTMLButtonElement {
	return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("UpDialog · 下播的附加项", () => {
	it("下播下面挂着「弹幕词云」「AI 总结」两个子开关,默认都开", () => {
		renderDialog(makeEmptySubscription("100"));
		expect(extraToggle("弹幕词云 · 下播").getAttribute("aria-pressed")).toBe("true");
		expect(extraToggle("AI 总结 · 下播").getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByText("词云")).toBeNull();
		expect(screen.queryByText("直播总结")).toBeNull();
	});

	it("关掉词云 → 保存时只写 extras.wordcloud:false", async () => {
		const { onSave } = renderDialog(makeEmptySubscription("100"));
		await userEvent.click(extraToggle("弹幕词云 · 下播"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toEqual({ extras: { wordcloud: false } });
	});

	it("再开回来 → override 清干净", async () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { extras: { wordcloud: false } } };
		const { onSave } = renderDialog(sub);
		await userEvent.click(extraToggle("弹幕词云 · 下播"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toBeUndefined();
	});

	it("下播关着 → 两个子开关灰掉、显示为关,点了也不写(草稿没动,保存钮不可点)", async () => {
		const sub = makeEmptySubscription("100");
		sub.overrides = { features: { liveEnd: false } };
		const { onSave } = renderDialog(sub);
		expect(extraToggle("弹幕词云 · 下播").disabled).toBe(true);
		expect(extraToggle("弹幕词云 · 下播").getAttribute("aria-pressed")).toBe("false");
		expect(extraToggle("AI 总结 · 下播").disabled).toBe(true);
		await userEvent.click(extraToggle("AI 总结 · 下播"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		expect(onSave).not.toHaveBeenCalled();
	});
});

/**
 * 同一批附加项,到了**某个推送目标**那一层是三态:显式 ON / 显式 OFF / 跟随订阅默认。
 * 要调它得先把那个目标从「跟随订阅项」拨到「自定义」(ADR-0016 决策 8),所以下面的夹具
 * 都给一份「routing 不完整」的订阅 —— 那正是自定义态,矩阵直接展开。
 */
function customTarget(id = "t-1"): PushTarget {
	return {
		id,
		name: "群 A",
		connectionId: "a-1",
		enabled: true,
		kind: "session",
		platform: "onebot",
		scope: "group",
		address: "",
	};
}

function renderWithTarget(sub: Subscription, target: PushTarget) {
	const onSave = vi.fn();
	render(
		<UpDialog
			sub={sub}
			targets={[target]}
			onClose={() => {}}
			onSave={onSave}
			onDelete={() => {}}
			saving={false}
		/>,
	);
	return { onSave };
}

/** 只订了下播的订阅 = 该目标 routing 不完整 = 自定义态。 */
function liveEndOnlySub(targetId: string): Subscription {
	const sub = makeEmptySubscription("100");
	sub.routing.liveEnd = [targetId];
	return sub;
}

async function save() {
	await userEvent.click(screen.getByRole("button", { name: /保存/ }));
}

describe("UpDialog · 某个推送目标自己的附加项", () => {
	it("自定义面板的下播行下面也挂着那两个附加项,起手跟随订阅默认(开)", () => {
		const t = customTarget();
		renderWithTarget(liveEndOnlySub(t.id), t);
		expect(extraToggle("弹幕词云 · 群 A").getAttribute("aria-pressed")).toBe("true");
		expect(extraToggle("AI 总结 · 群 A").getAttribute("aria-pressed")).toBe("true");
	});

	it("点一下 → 只给这个目标写一条显式覆写,订阅那一层不动", async () => {
		const t = customTarget();
		const { onSave } = renderWithTarget(liveEndOnlySub(t.id), t);
		await userEvent.click(extraToggle("弹幕词云 · 群 A"));
		await save();
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.extras.wordcloud).toEqual({ [t.id]: false });
		expect(saved.extras.liveSummary).toEqual({});
		expect(saved.overrides.features).toBeUndefined();
	});

	it("显式过了才出「重置」,点它删掉那个键 = 回到跟随", async () => {
		const t = customTarget();
		const sub = liveEndOnlySub(t.id);
		sub.extras.wordcloud = { [t.id]: false };
		const { onSave } = renderWithTarget(sub, t);
		// AI 总结还在跟随,不该有它的重置钮。
		expect(screen.queryByRole("button", { name: /重置 AI 总结/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /重置 弹幕词云/ }));
		await save();
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.extras.wordcloud).toEqual({});
	});

	it("下播没给这个目标 → 两个附加项灰掉,点了也不写(草稿没动,保存钮不可点)", async () => {
		const t = customTarget();
		const sub = makeEmptySubscription("100");
		sub.routing.dynamic = [t.id]; // 挂着这个目标,但没给它下播
		const { onSave } = renderWithTarget(sub, t);
		expect(extraToggle("弹幕词云 · 群 A").disabled).toBe(true);
		expect(extraToggle("弹幕词云 · 群 A").getAttribute("aria-pressed")).toBe("false");
		expect(extraToggle("AI 总结 · 群 A").disabled).toBe(true);
		await userEvent.click(extraToggle("弹幕词云 · 群 A"));
		await save();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("QQ 官方机器人只卡 @全体,词云 / AI 总结照样调得动", async () => {
		const t = { ...customTarget(), platform: "qq-official" as const };
		const { onSave } = renderWithTarget(liveEndOnlySub(t.id), t);
		const wc = extraToggle("弹幕词云 · 群 A");
		expect(wc.disabled).toBe(false);
		await userEvent.click(wc);
		await save();
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.extras.wordcloud).toEqual({ [t.id]: false });
	});
});
