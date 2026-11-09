// @vitest-environment jsdom

/**
 * SubscriptionDialog 渲染回归:QQ 官方机器人不支持 @全体(后端 best-effort 跳过 at-all),
 * 故其 per-target「+ @全体」开关须禁用并显示不支持说明(能力表里 atAll 是「不支持」);onebot / webhook 不受影响。
 */

import type { ConnectionCapabilitiesMap } from "@bilibili-notify/contract";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const UNSUPPORTED_NOTE = /QQ 官方.*@全体.*发送时会自动跳过/;

const noop = () => {};

function targetFor(platform: string): PushTarget {
	const base = {
		id: `${platform}-1`,
		name: `${platform} 目标`,
		connectionId: "a-1",
		enabled: true,
	};
	if (platform === "onebot") return { ...base, kind: "session", scope: "group", address: "" };
	if (platform === "qq-official") return { ...base, kind: "session", scope: "group", address: "" };
	return { ...base, kind: "endpoint" };
}

/**
 * routing 仅含 dynamic → 该 target「routing 不完整」= 自定义模式,矩阵直接展开(无需
 * 点击),dynamic 行下方挂出 per-target「+ @全体」开关。per-UP 的 atAllPost=true 让
 * 「若平台支持则默认会 @全体」,以验证 QQ 官方仍被强制禁用。
 */
function customSubFor(targetId: string): Subscription {
	const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" });
	sub.routing.post = [targetId];
	sub.overrides = { features: { extras: { atAllPost: true } } };
	return sub;
}

/** 照真适配器的回答:官机 @全体 不支持,别的支持。 */
function capabilitiesFor(platform: string): ConnectionCapabilitiesMap {
	const unknown = { state: "unknown" } as const;
	const atAll =
		platform === "qq-official"
			? ({
					state: "unsupported",
					reason: "QQ 官方机器人在群里 @全体 要特殊权限，适配器会丢掉 @全体 段",
					checkedAt: "2026-10-26T00:00:00.000Z",
				} as const)
			: ({ state: "supported", checkedAt: "2026-10-26T00:00:00.000Z" } as const);
	return { "a-1": { atAll, inbound: unknown, nativeShare: unknown } };
}

function renderDialog(platform: string) {
	// 平台只在连接上:目标自己不带,按 platform 造目标,再造一条同平台的连接挂着它。
	const target = targetFor(platform);
	return render(
		<SubscriptionDialog
			platform={subscriptionPlatformOf({ sourceKey: "bilibili" }, [makeSource()])}
			sub={customSubFor(target.id)}
			targets={[target]}
			connections={[
				{
					id: target.connectionId,
					adapterKey: platform,
					platform,
					enabled: true,
				} as Connection,
			]}
			capabilities={capabilitiesFor(platform)}
			onClose={noop}
			onSave={noop}
			onDelete={noop}
			saving={false}
		/>,
	);
}

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));
afterEach(cleanup);

it.each([
	["ja", "ご主人様、削除された送信先への参照が残っています。参照を選ぶと外せますよ。"],
	["zh-TW", "主人，下列目標已刪除，但還留有參照，點選就能移除參照喔。"],
] as const)(
	"%s maid routing guidance keeps selected and retired targets without saving",
	(locale, stale) => {
		const sub = customSubFor("target-a");
		sub.routing.post.push("retired-target");
		const target = { ...targetFor("onebot"), id: "target-a", name: "Original target 原文" };
		const onSave = vi.fn(),
			onDelete = vi.fn(),
			onClose = vi.fn();
		render(
			<SubscriptionDialog
				sub={sub}
				platform={subscriptionPlatformOf(sub.identity, [makeSource()])}
				targets={[target]}
				connections={[]}
				onClose={onClose}
				onSave={onSave}
				onDelete={onDelete}
				saving={false}
			/>,
		);
		const retired = screen.getByRole("button", { name: "retired- ×" });
		for (const voice of ["maid", "plain"] as const) {
			act(() => i18n.set({ locale, voice }));
			if (voice === "maid") expect(screen.getByText(stale)).toBeTruthy();
			expect(screen.getByText("Original target 原文")).toBeTruthy();
			expect(screen.getByRole("button", { name: "retired- ×" })).toBe(retired);
			expect(onSave).not.toHaveBeenCalled();
			expect(onDelete).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		}
	},
);

it("target selection and stale-reference guidance translate without changing names or deleting subscriptions", () => {
	const sub = makeEmptySubscription({ sourceKey: "bilibili", externalId: "0012" });
	sub.routing.post = ["retired-target"];
	const targetA = { ...targetFor("onebot"), id: "target-a", name: "Original target A" };
	const targetB = { ...targetFor("onebot"), id: "target-b", name: "Original target B" };
	const onSave = vi.fn();
	const onDelete = vi.fn();
	render(
		<SubscriptionDialog
			sub={sub}
			platform={subscriptionPlatformOf(sub.identity, [makeSource()])}
			targets={[targetA, targetB]}
			connections={[
				{ id: "a-1", adapterKey: "onebot", platform: "onebot", enabled: true } as Connection,
			]}
			onClose={noop}
			onSave={onSave}
			onDelete={onDelete}
			saving={false}
		/>,
	);
	for (const [locale, words] of [
		[
			"en",
			{
				unassigned:
					"No targets are assigned to this subscription. Use Add push target below to choose one.",
				add: "Add push target · 2 remaining",
				stale: "Stale references",
				explanation:
					"These targets have been deleted, but routing still references them. Select a reference to remove it.",
				warning:
					"No push target is selected. Saving will leave this subscription with nowhere to send messages.",
			},
		],
		[
			"ja",
			{
				unassigned:
					"この購読には送信先が設定されていません。下の「送信先を追加」から選択してください。",
				add: "送信先を追加・残り2件",
				stale: "無効な参照",
				explanation:
					"削除された送信先への参照がルーティングに残っています。参照を選択すると削除できます。",
				warning:
					"送信先が選択されていません。このまま保存すると、この購読の通知はどこにも送信されません。",
			},
		],
		[
			"zh-TW",
			{
				unassigned: "此訂閱尚未指定推播目標，請點擊下方「新增推播目標」選擇。",
				add: "新增推播目標 · 尚有 2 項可新增",
				stale: "已失效的參照",
				explanation: "下列推播目標已刪除，但路由仍有參照；點擊即可移除參照。",
				warning: "尚未選取任何推播目標，儲存後此訂閱將無處推播訊息。",
			},
		],
	] as const) {
		act(() => i18n.set({ locale, voice: "plain" }));
		expect(screen.getByText(words.unassigned)).toBeTruthy();
		expect(screen.getByRole("button", { name: words.add })).toBeTruthy();
		expect(screen.getByText(words.stale)).toBeTruthy();
		expect(screen.getByText(words.explanation)).toBeTruthy();
		expect(screen.getByText(words.warning)).toBeTruthy();
	}
	fireEvent.click(screen.getByRole("button", { name: "新增推播目標 · 尚有 2 項可新增" }));
	expect(screen.getByText("選擇要新增的推播目標")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /Original target A/ }));
	expect(screen.getByText("Original target A")).toBeTruthy();
	const pickerHeader = screen.getByText("選擇要新增的推播目標").parentElement as HTMLElement;
	fireEvent.click(within(pickerHeader).getByRole("button", { name: "取消" }));
	expect(screen.getByRole("button", { name: "新增推播目標 · 尚有 1 項可新增" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "移除此推播目標" }));
	expect(screen.queryByText("Original target A")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "retired- ×" }));
	expect(screen.queryByText("已失效的參照")).toBeNull();
	expect(onSave).not.toHaveBeenCalled();
	expect(onDelete).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "儲存設定" }));
	expect(onSave).toHaveBeenCalledWith(
		expect.objectContaining({ id: sub.id, routing: expect.objectContaining({ post: [] }) }),
	);
});

describe("SubscriptionDialog · QQ 官方 @全体 提示", () => {
	it("QQ 官方 target 的 @全体 开关被禁用并显示不支持说明", () => {
		renderDialog("qq-official");

		const note = screen.getByText(UNSUPPORTED_NOTE);
		expect(note).toBeTruthy();

		// note 与开关同处一个 wrapper;wrapper 内唯一的 button 即被禁用的 @全体 Toggle
		// (不支持时不渲染 reset 按钮)。
		const wrapper = note.parentElement as HTMLElement;
		const toggle = within(wrapper).getAllByRole("button")[0] as HTMLButtonElement;
		expect(toggle.disabled).toBe(true);
	});

	it("onebot target 不显示不支持说明", () => {
		renderDialog("onebot");
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});

	it("webhook 那一族的 target 不显示不支持说明", () => {
		renderDialog("feishu");
		expect(screen.queryByText(UNSUPPORTED_NOTE)).toBeNull();
	});
});

/** B 站订阅的头部:「UID xxx」读的是订阅的身份(外部 id 就是 uid)。 */
describe("SubscriptionDialog · B 站订阅的头部", () => {
	it("写「UID xxx」", () => {
		const sub = {
			...makeEmptySubscription({ sourceKey: "bilibili", externalId: "100" }),
			cachedProfile: { name: "UP甲", followers: 1, refreshedAt: "t" },
		};
		render(
			<SubscriptionDialog
				platform={subscriptionPlatformOf({ sourceKey: "bilibili" }, [makeSource()])}
				sub={sub}
				targets={[]}
				connections={[]}
				onClose={noop}
				onSave={noop}
				onDelete={noop}
				saving={false}
			/>,
		);
		expect(screen.getByText("UID 100")).toBeTruthy();
	});
});
