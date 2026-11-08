// @vitest-environment jsdom
/**
 * UP 抽屉「订阅项」里的下播:卡片是本体,词云 / AI 总结是挂在它下面的两个附加项。
 *
 * 守的是:附加项跟着下播的开关走(下播关了就灰掉);关一个附加项只写那一个键
 * (`overrides.features.extras.wordcloud`),与默认值相同就不落 override。
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../../i18n";
import {
	type Connection,
	makeEmptySubscription,
	type PushTarget,
	type Subscription,
} from "../../../types/domain";
import { makeSource } from "../../rules/__tests__/fixtures";
import { SubscriptionDialog } from "../SubscriptionDialog";
import { subscriptionPlatformOf } from "../subscription-source";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
afterEach(cleanup);

function renderDialog(sub: Subscription, source = makeSource()) {
	const onSave = vi.fn();
	render(
		<SubscriptionDialog
			sub={sub}
			platform={subscriptionPlatformOf(sub.identity, [source])}
			targets={[]}
			connections={[]}
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

describe("SubscriptionDialog · 下播的附加项", () => {
	it("extra labels and default hints translate while source nouns and unsaved toggle choices remain unchanged", async () => {
		const source = makeSource();
		source.descriptor = { ...source.descriptor, postNoun: "Original posts" };
		const { onSave } = renderDialog(
			makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			source,
		);
		for (const [locale, words] of [
			[
				"en",
				{
					cloud: "Chat word cloud",
					summary: "AI summary",
					atAll: "@everyone",
					liveStart: "Live start",
					liveEnd: "Live end",
					postHint: "Content notifications",
					scHint: "Super Chat notifications",
					endHint: "End-of-stream card / Chat word cloud / AI summary",
				},
			],
			[
				"ja",
				{
					cloud: "チャットのワードクラウド",
					summary: "AI要約",
					atAll: "全員メンション",
					liveStart: "配信開始",
					liveEnd: "配信終了",
					postHint: "投稿の通知",
					scHint: "スーパーチャットの通知",
					endHint: "配信終了カード / チャットのワードクラウド / AI要約",
				},
			],
			[
				"zh-TW",
				{
					cloud: "彈幕詞雲",
					summary: "AI 總結",
					atAll: "@全體",
					liveStart: "開播",
					liveEnd: "下播",
					postHint: "作品提醒",
					scHint: "醒目留言提醒",
					endHint: "下播卡片 / 彈幕詞雲 / AI 總結",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			const cloud = extraToggle(`${words.cloud} · ${words.liveEnd}`);
			expect(extraToggle(`${words.summary} · ${words.liveEnd}`).disabled).toBe(false);
			expect(extraToggle(`${words.atAll} · Original posts`)).toBeTruthy();
			expect(extraToggle(`${words.atAll} · ${words.liveStart}`)).toBeTruthy();
			expect(screen.getByText(words.postHint)).toBeTruthy();
			expect(screen.getByText(words.scHint)).toBeTruthy();
			expect(screen.getByText(words.endHint)).toBeTruthy();
			if (locale === "en") await userEvent.click(cloud);
			expect(cloud.getAttribute("aria-pressed")).toBe("false");
			expect(onSave).not.toHaveBeenCalled();
		}
		act(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
		await userEvent.click(screen.getByRole("button", { name: "保存配置" }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toEqual({ extras: { wordcloud: false } });
	});

	it("下播下面挂着「弹幕词云」「AI 总结」两个子开关,默认都开", () => {
		renderDialog(makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }));
		expect(extraToggle("弹幕词云 · 下播").getAttribute("aria-pressed")).toBe("true");
		expect(extraToggle("AI 总结 · 下播").getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByText("词云")).toBeNull();
		expect(screen.queryByText("直播总结")).toBeNull();
	});

	it("关掉词云 → 保存时只写 extras.wordcloud:false", async () => {
		const { onSave } = renderDialog(
			makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
		);
		await userEvent.click(extraToggle("弹幕词云 · 下播"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toEqual({ extras: { wordcloud: false } });
	});

	it("再开回来 → override 清干净", async () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		sub.overrides = { features: { extras: { wordcloud: false } } };
		const { onSave } = renderDialog(sub);
		await userEvent.click(extraToggle("弹幕词云 · 下播"));
		await userEvent.click(screen.getByRole("button", { name: /保存/ }));
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.overrides.features).toBeUndefined();
	});

	it("下播关着 → 两个子开关灰掉、显示为关,点了也不写(草稿没动,保存钮不可点)", async () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
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
		scope: "group",
		address: "",
	};
}

function renderWithTarget(sub: Subscription, target: PushTarget) {
	const onSave = vi.fn();
	render(
		<SubscriptionDialog
			sub={sub}
			platform={subscriptionPlatformOf(sub.identity, [makeSource()])}
			targets={[target]}
			connections={[
				{
					id: target.connectionId,
					adapterKey: "onebot",
					platform: "onebot",
					enabled: true,
				} as Connection,
			]}
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
	const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
	sub.routing.liveEnd = [targetId];
	return sub;
}

async function save() {
	await userEvent.click(screen.getByRole("button", { name: /保存/ }));
}

describe("SubscriptionDialog · 某个推送目标自己的附加项", () => {
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
		expect(saved.extraTargets.wordcloud).toEqual({ [t.id]: false });
		expect(saved.extraTargets.liveSummary).toEqual({});
		expect(saved.overrides.features).toBeUndefined();
	});

	it("显式过了才出「重置」,点它删掉那个键 = 回到跟随", async () => {
		const t = customTarget();
		const sub = liveEndOnlySub(t.id);
		sub.extraTargets.wordcloud = { [t.id]: false };
		const { onSave } = renderWithTarget(sub, t);
		// AI 总结还在跟随,不该有它的重置钮。
		expect(screen.queryByRole("button", { name: /重置 AI 总结/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /重置 弹幕词云/ }));
		await save();
		const saved = onSave.mock.calls[0]?.[0] as Subscription;
		expect(saved.extraTargets.wordcloud).toEqual({});
	});

	it("下播没给这个目标 → 两个附加项灰掉,点了也不写(草稿没动,保存钮不可点)", async () => {
		const t = customTarget();
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
		sub.routing.post = [t.id]; // 挂着这个目标,但没给它下播
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
		expect(saved.extraTargets.wordcloud).toEqual({ [t.id]: false });
	});
});
