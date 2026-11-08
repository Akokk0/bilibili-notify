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
	const onClose = vi.fn();
	render(
		<SubscriptionDialog
			sub={sub}
			platform={subscriptionPlatformOf(sub.identity, [source])}
			targets={[]}
			connections={[]}
			onClose={onClose}
			onSave={onSave}
			onDelete={() => {}}
			saving={false}
		/>,
	);
	return { onSave, onClose };
}

/** 子开关按 aria-label 取 —— 按文案找再摸 parentElement 会被行内排版的改动带倒。 */
function extraToggle(label: string): HTMLButtonElement {
	return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("SubscriptionDialog · 下播的附加项", () => {
	it.each([0, 1])(
		"follower count %s translates as a complete phrase without changing the count",
		(followers) => {
			const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "0012" });
			sub.cachedProfile = {
				name: "Original creator",
				followers,
				refreshedAt: "2026-11-01T00:00:00Z",
			};
			renderDialog(sub);
			expect(screen.getByText(`${followers} 粉丝`, { exact: true })).toBeTruthy();
			act(() => i18n.set({ locale: "en", voice: "plain" }));
			expect(screen.getByText(`Followers: ${followers}`, { exact: true })).toBeTruthy();
			act(() => i18n.set({ locale: "ja", voice: "plain" }));
			expect(screen.getByText(`フォロワー ${followers}`, { exact: true })).toBeTruthy();
			act(() => i18n.set({ locale: "zh-TW", voice: "plain" }));
			expect(screen.getByText(`追蹤人數：${followers}`, { exact: true })).toBeTruthy();
		},
	);

	it.each([true, false])(
		"feature descriptions and extra availability tooltips translate with parent enabled=%s",
		(enabled) => {
			const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "0012" });
			sub.overrides.features = { post: enabled, liveStart: enabled, liveEnd: enabled };
			const source = makeSource();
			source.descriptor = { ...source.descriptor, postNoun: "Original posts" };
			const { onSave } = renderDialog(sub, source);
			for (const [locale, words] of [
				[
					"en",
					{
						live: "Live start notifications",
						reminder: "Send another reminder every few hours after the stream starts.",
						special: "Special viewers",
						postHint: "Include an @everyone mention with content notifications.",
						startHint:
							"Mention everyone only for live-start notifications, not other live messages.",
						endHint: "Send as an additional message when the stream ends.",
						offPost: "Enable “Original posts” before sending this extra.",
						offStart: "Enable “Live start” before sending this extra.",
						offEnd: "Enable “Live end” before sending this extra.",
						cloud: "Chat word cloud · Live end",
					},
				],
				[
					"ja",
					{
						live: "配信開始の通知",
						reminder: "配信開始後、数時間おきに再通知します。",
						special: "特別ユーザー",
						postHint: "投稿の通知に全員メンションを付けます。",
						startHint: "全員メンションは配信開始の通知にのみ付け、ほかの配信通知には付けません。",
						endHint: "配信終了時に追加メッセージとして送信します。",
						offPost: "この追加通知を送るには、先に「Original posts」を有効にしてください。",
						offStart: "この追加通知を送るには、先に「配信開始」を有効にしてください。",
						offEnd: "この追加通知を送るには、先に「配信終了」を有効にしてください。",
						cloud: "チャットのワードクラウド · 配信終了",
					},
				],
				[
					"zh-TW",
					{
						live: "開播提醒",
						reminder: "開播後每隔數小時再次提醒。",
						special: "特別關注",
						postHint: "作品推送時附加 @全體。",
						startHint: "僅在開播推送時附加 @全體，其他直播訊息不附加。",
						endHint: "下播時作為附加訊息一併推送。",
						offPost: "須先開啟「Original posts」才能推送此附加項目。",
						offStart: "須先開啟「開播」才能推送此附加項目。",
						offEnd: "須先開啟「下播」才能推送此附加項目。",
						cloud: "彈幕詞雲 · 下播",
					},
				],
			] as const) {
				act(() => i18n.set({ locale, voice: "plain" }));
				expect(screen.getByText(words.live)).toBeTruthy();
				expect(screen.getByText(words.reminder)).toBeTruthy();
				expect(screen.getByText(words.special)).toBeTruthy();
				expect(extraToggle(words.cloud).disabled).toBe(!enabled);
				if (enabled) {
					expect(screen.getByTitle(words.postHint)).toBeTruthy();
					expect(screen.getByTitle(words.startHint)).toBeTruthy();
					expect(screen.getAllByTitle(words.endHint)).toHaveLength(2);
				} else {
					expect(screen.getByTitle(words.offPost)).toBeTruthy();
					expect(screen.getByTitle(words.offStart)).toBeTruthy();
					expect(screen.getAllByTitle(words.offEnd)).toHaveLength(2);
				}
			}
			expect(onSave).not.toHaveBeenCalled();
		},
	);

	it.each(["create", "edit"] as const)(
		"pending %s feedback translates without allowing another submit, cancel or removal",
		async (mode) => {
			const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "0012" });
			const onSave = vi.fn();
			const onClose = vi.fn();
			const onDelete = vi.fn();
			const props = {
				sub,
				platform: subscriptionPlatformOf(sub.identity, [makeSource()]),
				targets: [],
				connections: [],
				onSave,
				onClose,
				onDelete,
				mode,
				saving: true,
			};
			const view = render(<SubscriptionDialog {...props} />);
			for (const [locale, words] of [
				[
					"en",
					{
						creating: "Creating…",
						saving: "Saving…",
						create: "Create subscription",
						cancel: "Cancel",
						remove: "Remove subscription",
					},
				],
				[
					"ja",
					{
						creating: "作成中…",
						saving: "保存中…",
						create: "購読を作成",
						cancel: "キャンセル",
						remove: "購読を削除",
					},
				],
				[
					"zh-TW",
					{
						creating: "建立中…",
						saving: "儲存中…",
						create: "建立訂閱",
						cancel: "取消",
						remove: "移除訂閱",
					},
				],
			] as const) {
				act(() => i18n.set({ locale, voice: "plain" }));
				const submit = screen.getByRole("button", {
					name: mode === "create" ? words.creating : words.saving,
				}) as HTMLButtonElement;
				const cancel = screen.getByRole("button", { name: words.cancel }) as HTMLButtonElement;
				expect(submit.disabled).toBe(true);
				expect(cancel.disabled).toBe(true);
				await userEvent.click(submit);
				await userEvent.click(cancel);
				if (mode === "edit") {
					const remove = screen.getByRole("button", { name: words.remove }) as HTMLButtonElement;
					expect(remove.disabled).toBe(true);
					await userEvent.click(remove);
				} else expect(screen.queryByRole("button", { name: words.remove })).toBeNull();
			}
			expect(onSave).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
			expect(onDelete).not.toHaveBeenCalled();
			view.rerender(<SubscriptionDialog {...props} saving={false} />);
			expect(
				screen.getByRole("button", { name: mode === "create" ? "建立訂閱" : "儲存設定" }),
			).toBeTruthy();
		},
	);

	it("subscription details and discard guidance translate while notes remain an unsaved draft", async () => {
		const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "0012" });
		sub.cachedProfile = {
			name: "Original creator",
			followers: 0,
			refreshedAt: "2026-11-01T00:00:00Z",
		};
		const { onSave, onClose } = renderDialog(sub);
		act(() => i18n.set({ locale: "en", voice: "plain" }));
		const notes = screen.getByRole("textbox", { name: "Notes" });
		await userEvent.type(notes, "Original draft / 原文");
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		for (const [locale, words] of [
			[
				"en",
				{
					basic: "Basics",
					off: "Turning this off stops all pushes for this subscription.",
					notes: "Notes",
					defaults: "Subscription · Default push content",
					description:
						"These are the subscription’s default push settings. Targets below use them unless you customize that target.",
					title: "Discard unsaved changes?",
					message:
						"Your changes to this subscription have not been saved. Closing will discard them.",
					discard: "Discard",
					keep: "Continue editing",
					save: "Save settings",
					remove: "Remove subscription",
				},
			],
			[
				"ja",
				{
					basic: "基本設定",
					off: "オフにすると、この購読の通知をすべて停止します。",
					notes: "メモ",
					defaults: "購読・既定の通知内容",
					description:
						"この購読の既定の通知設定です。下の送信先で個別にカスタマイズしない限り、この設定に従います。",
					title: "未保存の変更を破棄しますか？",
					message: "この購読への変更は保存されていません。閉じると変更が失われます。",
					discard: "破棄",
					keep: "編集を続ける",
					save: "設定を保存",
					remove: "購読を削除",
				},
			],
			[
				"zh-TW",
				{
					basic: "基本設定",
					off: "關閉後將停止此訂閱的所有推送。",
					notes: "備註",
					defaults: "訂閱項目 · 預設推送內容",
					description: "這是此訂閱的預設推送設定。下方的推送目標若未另行自訂，便會使用這份設定。",
					title: "捨棄未儲存的修改？",
					message: "此訂閱的變更尚未儲存，關閉後將遺失。",
					discard: "捨棄",
					keep: "繼續編輯",
					save: "儲存設定",
					remove: "移除訂閱",
				},
			],
		] as const) {
			act(() => i18n.set({ locale, voice: "plain" }));
			expect(screen.getByText(words.basic)).toBeTruthy();
			expect(screen.getByText(words.off)).toBeTruthy();
			expect(screen.getByText(words.defaults)).toBeTruthy();
			expect(screen.getByText(words.description)).toBeTruthy();
			expect(
				(screen.getByRole("textbox", { name: words.notes }) as HTMLTextAreaElement).value,
			).toBe("Original draft / 原文");
			expect(screen.getByText(words.title)).toBeTruthy();
			expect(screen.getByText(words.message)).toBeTruthy();
			expect(screen.getByRole("button", { name: words.discard })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.keep })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.save })).toBeTruthy();
			expect(screen.getByRole("button", { name: words.remove })).toBeTruthy();
		}
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "繼續編輯" }));
		expect(screen.queryByText("捨棄未儲存的修改？")).toBeNull();
		expect(screen.getByDisplayValue("Original draft / 原文")).toBeTruthy();
	});

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
