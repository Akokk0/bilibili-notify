/**
 * 单元测试 — 直播推送(开播 / 直播中 / 下播)的消息版式(messageLayout)路径。
 *
 * 版式覆盖 `LiveType.StartBroadcasting` / `LiveBroadcast` / `StopBroadcast` 三类:
 * 卡片 / 文本(各自模板,{link} 剥离) / 链接(房间链接)三部件按块序装配,分条符切
 * 多条经 `broadcastSequenceToTargets`。SC / 上舰不经 `sendLiveNotifyCard`,不受影响。
 *
 * 策略:`RoomContext.prototype.sendLiveNotifyCard.call(fakeCtx, params)` 白盒直调
 * (与 room-session-handlers 的「plain object as RoomContext」同款),contentBuilder
 * 用标签对象便于断言。
 */

import type { Logger, MessageKindLayout } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { SubItemView } from "../push-like";
import { LivePushType } from "../push-like";
import { RoomContext } from "../room-helpers";
import { LiveTemplateRenderer } from "../template-renderer";
import { LiveType } from "../types";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

type Seg = { kind: string; text?: string };
type Msg = { kind: "message"; segs: Seg[] };

function makeCtx(opts?: { renderFail?: boolean; noSequence?: boolean }) {
	const broadcastToTargets = vi.fn(async (..._args: unknown[]) => {});
	const broadcastSequenceToTargets = vi.fn(async (..._args: unknown[]) => {});
	const generateLiveCard = opts?.renderFail
		? vi.fn(async () => {
				throw new Error("boom");
			})
		: vi.fn(async () => Buffer.from("img"));
	const ctx = {
		logger: silentLogger,
		isDisposed: () => false,
		imageRenderer: { generateLiveCard },
		contentBuilder: {
			text: (t: string): Seg => ({ kind: "text", text: t }),
			image: (): Seg => ({ kind: "image" }),
			message: (segs: Seg[]): Msg => ({ kind: "message", segs }),
		},
		push: opts?.noSequence
			? { broadcastToTargets }
			: { broadcastToTargets, broadcastSequenceToTargets },
	} as unknown as RoomContext;
	// 白盒:挂上真实原型,让 sendLiveNotifyCard 内部调用的私有 helper 可达。
	Object.setPrototypeOf(ctx, RoomContext.prototype);
	return { ctx, broadcastToTargets, broadcastSequenceToTargets, generateLiveCard };
}

const LINK = "https://live.bilibili.com/123";

function layoutOf(
	blocks: Array<{ type: string; visible?: boolean; id?: string }>,
	separator = "\n",
): MessageKindLayout {
	return {
		blocks: blocks.map((x) => ({ id: x.id ?? x.type, type: x.type, visible: x.visible ?? true })),
		separator,
	};
}

function baseParams(over?: Record<string, unknown>) {
	return {
		liveType: LiveType.StartBroadcasting,
		liveData: {} as never,
		liveRoomInfo: {
			live_time: "2026-01-01 00:00:00",
			short_id: 0,
			room_id: 123,
			title: "标题",
			user_cover: "",
		} as never,
		master: { username: "主播", userface: "", roomId: "123" } as never,
		cardStyle: { enable: false } as SubItemView["customCardStyle"],
		uid: "u1",
		notifyMsg: "开播文案",
		roomLink: LINK,
		...over,
	};
}

const send = (ctx: RoomContext, params: ReturnType<typeof baseParams>) =>
	RoomContext.prototype.sendLiveNotifyCard.call(ctx, params as never);

describe("RoomContext.sendLiveNotifyCard — 消息版式", () => {
	it("无 messageLayout(旧路径)→ 一条 message([image, text]),不受影响", async () => {
		const { ctx, broadcastToTargets } = makeCtx();
		await send(ctx, baseParams());
		expect(broadcastToTargets).toHaveBeenCalledTimes(1);
		const [uid, content, type] = broadcastToTargets.mock.calls[0] as [string, Msg, number];
		expect(uid).toBe("u1");
		expect(type).toBe(LivePushType.StartBroadcasting);
		expect(content.segs.map((s) => s.kind)).toEqual(["image", "text"]);
		expect(content.segs[1]?.text).toBe("开播文案");
	});

	it("版式 [card,text,link] 一条:链接独立部件,同条内以分隔符连接", async () => {
		const { ctx, broadcastToTargets } = makeCtx();
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]),
			}),
		);
		expect(broadcastToTargets).toHaveBeenCalledTimes(1);
		const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
		expect(content.segs.map((s) => s.kind)).toEqual(["image", "text"]);
		expect(content.segs[1]?.text).toBe(`开播文案\n${LINK}`);
	});

	it("分条符切两条 → broadcastSequenceToTargets,一次收齐、顺序正确", async () => {
		const { ctx, broadcastToTargets, broadcastSequenceToTargets } = makeCtx();
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([
					{ type: "card" },
					{ type: "split", id: "split-1" },
					{ type: "text" },
					{ type: "link" },
				]),
			}),
		);
		expect(broadcastToTargets).not.toHaveBeenCalled();
		expect(broadcastSequenceToTargets).toHaveBeenCalledTimes(1);
		const [uid, contents, type] = broadcastSequenceToTargets.mock.calls[0] as [
			string,
			Msg[],
			number,
		];
		expect(uid).toBe("u1");
		expect(type).toBe(LivePushType.StartBroadcasting);
		expect(contents).toHaveLength(2);
		expect(contents[0]?.segs.map((s) => s.kind)).toEqual(["image"]);
		expect(contents[1]?.segs[0]?.text).toBe(`开播文案\n${LINK}`);
	});

	it("隐藏 card 块 → 跳过图片渲染", async () => {
		const { ctx, broadcastToTargets, generateLiveCard } = makeCtx();
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text" },
					{ type: "link" },
				]),
			}),
		);
		expect(generateLiveCard).not.toHaveBeenCalled();
		const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
		expect(content.segs.map((s) => s.kind)).toEqual(["text"]);
	});

	it("渲染失败 → card 部件缺席,其余部件照发", async () => {
		const { ctx, broadcastToTargets } = makeCtx({ renderFail: true });
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]),
			}),
		);
		const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
		expect(content.segs.map((s) => s.kind)).toEqual(["text"]);
		expect(content.segs[0]?.text).toBe(`开播文案\n${LINK}`);
	});

	it("全部块隐藏 → 本次不推送", async () => {
		const { ctx, broadcastToTargets, broadcastSequenceToTargets, generateLiveCard } = makeCtx();
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text", visible: false },
					{ type: "link", visible: false },
				]),
			}),
		);
		expect(generateLiveCard).not.toHaveBeenCalled();
		expect(broadcastToTargets).not.toHaveBeenCalled();
		expect(broadcastSequenceToTargets).not.toHaveBeenCalled();
	});

	it("adapter 不支持 sequence(防御兜底)→ 合并回一条", async () => {
		const { ctx, broadcastToTargets } = makeCtx({ noSequence: true });
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([
					{ type: "card" },
					{ type: "split", id: "split-1" },
					{ type: "text" },
				]),
			}),
		);
		expect(broadcastToTargets).toHaveBeenCalledTimes(1);
		const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
		expect(content.segs.map((s) => s.kind)).toEqual(["image", "text"]);
	});

	it("无 messageLayout 的直播中 / 下播推送 → 走旧路径,不受影响", async () => {
		for (const liveType of [LiveType.LiveBroadcast, LiveType.StopBroadcast]) {
			const { ctx, broadcastToTargets } = makeCtx();
			await send(ctx, baseParams({ liveType }));
			const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
			expect(content.segs.map((s) => s.kind)).toEqual(["image", "text"]);
			expect(content.segs[1]?.text).toBe("开播文案");
		}
	});

	it("直播中推送(LiveBroadcast)传版式 → 同开播一样按块序装配,链接独立部件", async () => {
		const { ctx, broadcastToTargets } = makeCtx();
		await send(
			ctx,
			baseParams({
				liveType: LiveType.LiveBroadcast,
				messageLayout: layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]),
			}),
		);
		expect(broadcastToTargets).toHaveBeenCalledTimes(1);
		const [, content, type] = broadcastToTargets.mock.calls[0] as [string, Msg, number];
		expect(type).toBe(LivePushType.Live);
		expect(content.segs.map((s) => s.kind)).toEqual(["image", "text"]);
		expect(content.segs[1]?.text).toBe(`开播文案\n${LINK}`);
	});

	it("下播推送(StopBroadcast)传版式 → 隐藏 card 后只剩文本,链接独立部件", async () => {
		const { ctx, broadcastToTargets, generateLiveCard } = makeCtx();
		await send(
			ctx,
			baseParams({
				liveType: LiveType.StopBroadcast,
				messageLayout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text" },
					{ type: "link" },
				]),
			}),
		);
		expect(generateLiveCard).not.toHaveBeenCalled();
		const [, content, type] = broadcastToTargets.mock.calls[0] as [string, Msg, number];
		expect(type).toBe(LivePushType.LiveEnd);
		expect(content.segs.map((s) => s.kind)).toEqual(["text"]);
		expect(content.segs[0]?.text).toBe(`开播文案\n${LINK}`);
	});
});

describe("LiveTemplateRenderer.renderLiveStart — omitLink", () => {
	const master = { username: "主播", userface: "", roomId: "123" } as never;
	const sub = { customLiveMsg: { enable: false } } as SubItemView;

	it("omitLink → {link} 连同前导空白剥离,不留孤行", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveStart({
			sub,
			master,
			diffTime: "",
			followerNum: "100",
			roomLink: LINK,
			omitLink: true,
		});
		expect(out).toBe("主播 开播啦，当前粉丝数：100");
	});

	it("默认模板已不含 {link}:不传 omitLink 也不再出现链接(链接由版式部件提供)", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveStart({
			sub,
			master,
			diffTime: "",
			followerNum: "100",
			roomLink: LINK,
		});
		expect(out).toBe("主播 开播啦，当前粉丝数：100");
	});

	it("旧存档自定义模板写 {link} 且不 omitLink(旧路径)→ 链接仍内嵌渲染", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveStart({
			sub: {
				customLiveMsg: { enable: true, customLiveStart: "{name}开播:{link}" },
			} as SubItemView,
			master,
			diffTime: "",
			followerNum: "100",
			roomLink: LINK,
		});
		expect(out).toBe(`主播开播:${LINK}`);
	});

	it("omitLink 兼容用户模板里的字面 \\n 与 legacy -link 写法", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveStart({
			sub: {
				customLiveMsg: { enable: true, customLiveStart: "{name}开播\\n-link" },
			} as SubItemView,
			master,
			diffTime: "",
			followerNum: "100",
			roomLink: LINK,
			omitLink: true,
		});
		expect(out).toBe("主播开播");
	});
});

describe("LiveTemplateRenderer.renderLiveOngoing / renderLiveEnd — omitLink", () => {
	const master = { username: "主播", userface: "", roomId: "123" } as never;
	const sub = { customLiveMsg: { enable: false } } as SubItemView;

	it("renderLiveOngoing omitLink → {link} 剥离,不留孤行", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveOngoing({
			sub,
			master,
			diffTime: "1小时",
			watched: "100",
			roomLink: LINK,
			omitLink: true,
		});
		expect(out).toBe("主播 正在直播，已播 1小时，累计观看：100");
	});

	it("renderLiveOngoing 旧存档自定义模板写 {link} 且不 omitLink(旧路径)→ 链接仍内嵌渲染", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveOngoing({
			sub: { customLiveMsg: { enable: true, customLive: "{name}直播中:{link}" } } as SubItemView,
			master,
			diffTime: "1小时",
			watched: "100",
			roomLink: LINK,
		});
		expect(out).toBe(`主播直播中:${LINK}`);
	});

	it("renderLiveEnd omitLink → {link} 剥离,不留孤行", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveEnd({
			sub,
			master,
			diffTime: "1小时",
			followerChange: 5,
			roomLink: LINK,
			omitLink: true,
		});
		expect(out).toBe("主播 下播啦，本次直播了 1小时，粉丝变化 +5");
	});

	it("renderLiveEnd 自定义模板写 {link} 且不 omitLink(旧路径)→ 链接仍内嵌渲染", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveEnd({
			sub: { customLiveMsg: { enable: true, customLiveEnd: "{name}下播:{link}" } } as SubItemView,
			master,
			diffTime: "1小时",
			followerChange: 5,
			roomLink: LINK,
		});
		expect(out).toBe(`主播下播:${LINK}`);
	});
});
