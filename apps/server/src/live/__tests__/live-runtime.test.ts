/**
 * `createLiveRuntime` 的接线守卫:场次 / 推送 / 互动三处读直播设置的地方共用**同一个缓存读口**,
 * 不再各自 `(sub) => liveSettingsOf(sub, options.globals())`。
 *
 * 判据是 globals 的读取次数:`globals()` 每次都是整份深拷贝,互动上报又是每条弹幕一次。
 * 一条弹幕把所有设置折一遍的话,50 条就是 50 次深拷贝 —— 修前正是这样。
 */

import {
	fail,
	makeDefaultGlobalSettings,
	type ServiceContext,
	type Subscription,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeExtensionSubscription } from "../../__tests__/support/extension-subscription.js";
import { makeTrackingContext } from "../../__tests__/support/track-context.js";
import { i18n } from "../../i18n/index.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createSourceGates } from "../../subscriptions/call-source.js";
import type { SourceView } from "../../subscriptions/registry.js";
import type { LiveNotifySend } from "../live-notify.js";
import { createLiveRuntime, type LiveRuntimeOptions } from "../live-runtime.js";
import { createLiveTable } from "../live-table.js";
import { LivePushKind } from "../live-types.js";

const SUB: Subscription = makeExtensionSubscription({
	extensionId: "acme",
	externalId: "room-1",
});

function setup(over: Partial<LiveRuntimeOptions> = {}) {
	const bus = createNodeMessageBus();
	const globals = vi.fn(() => makeDefaultGlobalSettings());
	const ctx = makeTrackingContext();
	const runtime = createLiveRuntime({
		bus,
		serviceCtx: {
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			signal: ctx.signal,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose() {},
			track: ctx.track,
		} as unknown as ServiceContext,
		table: createLiveTable({ bus }),
		subscriptionStore: {
			findById: (id) => (id === SUB.id ? SUB : undefined),
			list: () => [SUB],
		},
		subscriptionStateStore: { get: () => undefined },
		sources: { get: () => undefined },
		sourceGates: createSourceGates(),
		hasLiveStatus: () => false,
		sourceStatus: { running: () => true },
		labelDeps: { sources: { get: () => undefined } },
		globals,
		targetIds: () => [],
		commentary: null,
		imageRenderer: () => null,
		pickExistingCardBg: () => undefined,
		imageFetcher: { fetchImage: async () => fail("invalid", "这条守卫不抓图") },
		readImage: async () => undefined,
		sendFor: () => async () => {},
		...over,
	});
	return { bus, globals, runtime, ctx };
}

describe("createLiveRuntime — 直播设置读口的接线", () => {
	it("连发 50 条 viewerChat,globals 至多读 1 次", () => {
		const { globals, runtime } = setup();
		// 构造时词云的停用词读了一次 globals;此后 50 条互动只该折一次设置。
		const before = globals.mock.calls.length;
		for (let i = 0; i < 50; i++) {
			runtime.applyInteraction(SUB.id, {
				kind: "viewerChat",
				viewer: { id: String(i), name: `观众${i}` },
				text: "来了",
			});
		}
		expect(globals.mock.calls.length - before).toBeLessThanOrEqual(1);
		runtime.dispose();
	});

	it("同一直播运行时跨四语重取周期模板，保留场次和来源原文且不把默认模板写入设置", async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 10, 10, 4);
		vi.setSystemTime(now);
		const globals = makeDefaultGlobalSettings();
		globals.defaults.features.liveStart = false;
		globals.defaults.features.liveStreaming = true;
		globals.defaults.cards.enabled = false;
		const source: SourceView = {
			sourceKey: "acme",
			descriptor: { label: "Original source", supportedFeatures: ["liveStreaming"] },
			searchCreators: async () => fail("unsupported", "Not used"),
			fetchProfile: async () => fail("unsupported", "Not used"),
			fetchLiveStatus: async () => ({
				ok: true,
				kind: "live",
				details: {
					url: "https://example.com/live/original",
					title: "Original title 原文",
					creator: { name: "Original creator 原文" },
					totalViewers: 12_345,
				},
			}),
		};
		const send = vi.fn<LiveNotifySend>(async () => {});
		const { bus, runtime, ctx } = setup({
			globals: () => globals,
			sources: { get: () => source },
			hasLiveStatus: () => true,
			sendFor: () => send,
		});
		try {
			runtime.applySignal({
				kind: "start",
				subscriptionId: SUB.id,
				identity: SUB.identity,
				startedAt: new Date(now - 3_600_000).toISOString(),
				details: { url: "https://example.com/live/original", title: "Original title 原文" },
			});
			await ctx.settled();
			expect(send).not.toHaveBeenCalled();
			const session = runtime.session(SUB.id);
			for (const [locale, expected] of [
				["en", "Original creator 原文 is live. Duration: 1h. Total viewers: 12.3K"],
				["ja", "Original creator 原文が配信中です。配信時間：1時間、累計視聴者数：1.2万"],
				["zh-TW", "Original creator 原文 正在直播，已播 1小時，累計觀看：1.2萬"],
				["zh-CN", "Original creator 原文 正在直播，已播 1小时，累计观看：1.2万"],
			] as const) {
				globals.locale = locale;
				i18n.set({ locale, voice: "plain" });
				bus.emit("config-changed", { scope: "globals" });
				send.mockClear();
				expect(await runtime.tickNow(SUB.id)).toBe(true);
				await ctx.settled();
				expect(send).toHaveBeenCalledTimes(1);
				expect(send.mock.calls[0]?.[1]).toBe(LivePushKind.LiveStreaming);
				expect(send.mock.calls[0]?.[0].flat()).toEqual([
					{ kind: "text", text: `${expected}\nhttps://example.com/live/original` },
				]);
				expect(runtime.session(SUB.id)?.startedAt).toBe(session?.startedAt);
				expect(runtime.session(SUB.id)?.lastDetails?.title).toBe("Original title 原文");
				expect(globals.defaults.templates).not.toHaveProperty("liveStreaming");
			}
		} finally {
			runtime.dispose();
			i18n.set({ locale: "zh-CN", voice: "maid" });
			vi.useRealTimers();
		}
	});

	it("同一运行时的特别关注、会员模板和互动回退跟随四语，原始观众名与消息不翻译", async () => {
		const globals = makeDefaultGlobalSettings();
		Object.assign(globals.defaults.features, {
			liveStart: false,
			viewerChat: true,
			viewerEnter: true,
			superchat: true,
			membership: true,
		});
		globals.defaults.cards.enabled = false;
		const sub = {
			...SUB,
			specialViewers: [
				{ id: "viewer-1", note: "Stored 原文", features: ["viewerChat", "viewerEnter"] },
			],
		} satisfies Subscription;
		const source: SourceView = {
			sourceKey: "acme",
			descriptor: {
				label: "Original source",
				supportedFeatures: ["membership", "superchat", "viewerChat", "viewerEnter"],
				membershipPrograms: [{ id: "acme-club", name: "Original club", tiers: "custom" }],
			},
			searchCreators: async () => fail("unsupported", "Not used"),
			fetchProfile: async () => fail("unsupported", "Not used"),
		};
		const send = vi.fn<LiveNotifySend>(async () => {});
		const { bus, runtime, ctx } = setup({
			globals: () => globals,
			subscriptionStore: { findById: () => sub, list: () => [sub] },
			sources: { get: () => source },
			sendFor: () => send,
		});
		const viewer = { id: "viewer-1", name: "Viewer {name} 原文" };
		const membership = {
			kind: "membership",
			viewer,
			program: "acme-club",
			tier: { key: "gold", name: "Tier {text} 原文", rank: 1 },
		} as const;
		const superchat = {
			kind: "superchat",
			viewer,
			text: "Message {viewer} 原文",
			amount: 30,
			currency: "CNY",
		} as const;
		try {
			runtime.applySignal({
				kind: "start",
				subscriptionId: SUB.id,
				identity: SUB.identity,
				details: { url: "https://example.com/live", creator: { name: "Creator {viewer} 原文" } },
			});
			await ctx.settled();
			for (const [locale, chat, enter, member, paid, fallback] of [
				[
					"en",
					"Selected viewer Viewer {name} 原文 sent a chat message in Creator {viewer} 原文’s room: Message {viewer} 原文",
					"Viewer {name} 原文 entered Creator {viewer} 原文’s live room",
					"Viewer {name} 原文 joined Creator {viewer} 原文 at the Tier {text} 原文 tier!",
					"Viewer {name} 原文 sent a paid message in Creator {viewer} 原文's stream: Message {viewer} 原文",
					"In Creator {viewer} 原文's stream, Viewer {name} 原文 joined membership tier Tier {text} 原文.",
				],
				[
					"ja",
					"注目ユーザーViewer {name} 原文がCreator {viewer} 原文の配信に弾幕を送信：Message {viewer} 原文",
					"Viewer {name} 原文がCreator {viewer} 原文の配信ルームに入室しました",
					"Viewer {name} 原文がCreator {viewer} 原文のTier {text} 原文メンバーになりました！",
					"Creator {viewer} 原文の配信で、Viewer {name} 原文が有料メッセージを送りました：Message {viewer} 原文",
					"Creator {viewer} 原文の配信で、Viewer {name} 原文がTier {text} 原文の会員になりました。",
				],
				[
					"zh-TW",
					"關注的使用者 Viewer {name} 原文 在 Creator {viewer} 原文 的直播間傳送彈幕：Message {viewer} 原文",
					"Viewer {name} 原文 進入了 Creator {viewer} 原文 的直播間",
					"Viewer {name} 原文 成為了 Creator {viewer} 原文 的Tier {text} 原文！",
					"在 Creator {viewer} 原文 的直播中，Viewer {name} 原文 傳送了一則付費留言：Message {viewer} 原文",
					"在 Creator {viewer} 原文 的直播中，Viewer {name} 原文 成為了 Tier {text} 原文 會員。",
				],
				[
					"zh-CN",
					"Creator {viewer} 原文 的关注用户 Viewer {name} 原文 发送弹幕：Message {viewer} 原文",
					"Viewer {name} 原文 进入了 Creator {viewer} 原文 的直播间",
					"Viewer {name} 原文 成为了 Creator {viewer} 原文 的Tier {text} 原文！",
					"Creator {viewer} 原文的直播间里，Viewer {name} 原文 发了一条醒目留言：Message {viewer} 原文",
					"Creator {viewer} 原文的直播间里，Viewer {name} 原文 成为了Tier {text} 原文",
				],
			] as const) {
				globals.locale = locale;
				const storedMembership = {
					enabled: true,
					default: { imageUrl: "" },
					tiers: {},
				};
				globals.defaults.templates.membership["acme-club"] = storedMembership;
				i18n.set({ locale, voice: "plain" });
				bus.emit("config-changed", { scope: "globals" });
				send.mockClear();
				runtime.applyInteraction(SUB.id, { kind: "viewerChat", viewer, text: superchat.text });
				runtime.applyInteraction(SUB.id, { kind: "viewerEnter", viewer });
				runtime.applyInteraction(SUB.id, superchat);
				runtime.applyInteraction(SUB.id, membership);
				await ctx.settled();
				expect(send).toHaveBeenCalledTimes(4);
				for (const [kind, text] of [
					[LivePushKind.ViewerChat, chat],
					[LivePushKind.ViewerEnter, enter],
					[LivePushKind.Superchat, paid],
					[LivePushKind.Membership, member],
				] as const) {
					const calls = send.mock.calls.filter((call) => call[1] === kind);
					expect(calls).toHaveLength(1);
					expect(calls[0]?.[0]).toEqual([[{ kind: "text", text }]]);
				}
				storedMembership.enabled = false;
				bus.emit("config-changed", { scope: "globals" });
				runtime.applyInteraction(SUB.id, membership);
				await ctx.settled();
				expect(send.mock.lastCall?.[0]).toEqual([[{ kind: "text", text: fallback }]]);
				runtime.applyInteraction(SUB.id, {
					...superchat,
					fallbackText: "Source fallback 原文 {name}",
				});
				await ctx.settled();
				expect(send.mock.lastCall?.[0]).toEqual([
					[{ kind: "text", text: "Source fallback 原文 {name}" }],
				]);
				expect(globals.defaults.templates).not.toHaveProperty("viewerChat");
				expect(globals.defaults.templates).not.toHaveProperty("viewerEnter");
				expect(storedMembership.default).toEqual({ imageUrl: "" });
			}
		} finally {
			runtime.dispose();
			i18n.set({ locale: "zh-CN", voice: "maid" });
		}
	});
});
