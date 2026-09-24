/**
 * 单元测试 — 直播推送(开播 / 直播中 / 下播)的消息版式(messageLayout)路径。
 *
 * 版式覆盖 `LiveType.StartBroadcasting` / `LiveBroadcast` / `StopBroadcast` 三类:
 * 卡片 / 文本(各自模板) / 链接(房间链接)三部件按块序装配,分条符切
 * 多条经 `broadcastSequenceToTargets`。SC / 上舰不经 `sendLiveNotifyCard`,不受影响。
 *
 * 策略:`RoomContext.prototype.sendLiveNotifyCard.call(fakeCtx, params)` 白盒直调
 * (与 room-session-handlers 的「plain object as RoomContext」同款),contentBuilder
 * 用标签对象便于断言。装配本身(`pushLiveNotify`)在 `live-notify.test.ts` 里单独钉;
 * 这里钉的是 B 站那头把它接对了 —— 房间数据翻成中立输入、按 uid 发出去。
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

function makeCtx(opts?: { renderFail?: boolean }) {
	const broadcastToTargets = vi.fn(async (..._args: unknown[]) => {});
	const broadcastSequenceToTargets = vi.fn(async (..._args: unknown[]) => {});
	// 参数签名照抄 `ImageRenderer#generateNeutralLiveCard`,不写成零参 —— 零参的 mock 让
	// `mock.calls[0][1]` 在类型上成了「长度 0 的元组」,断言第 2 个参数根本编译不过。
	const generateNeutralLiveCard = opts?.renderFail
		? vi.fn(async (..._args: unknown[]): Promise<Buffer> => {
				throw new Error("boom");
			})
		: vi.fn(async (..._args: unknown[]) => Buffer.from("img"));
	const ctx = {
		logger: silentLogger,
		isDisposed: () => false,
		imageRenderer: { generateNeutralLiveCard },
		contentBuilder: {
			text: (t: string): Seg => ({ kind: "text", text: t }),
			image: (): Seg => ({ kind: "image" }),
			message: (segs: Seg[]): Msg => ({ kind: "message", segs }),
		},
		push: { broadcastToTargets, broadcastSequenceToTargets },
	} as unknown as RoomContext;
	// 白盒:挂上真实原型,让 sendLiveNotifyCard 内部调用的私有 helper 可达。
	Object.setPrototypeOf(ctx, RoomContext.prototype);
	return { ctx, broadcastToTargets, broadcastSequenceToTargets, generateNeutralLiveCard };
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
		// 宿主恒填版式;单个用例按需覆盖。
		messageLayout: layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]),
		...over,
	};
}

const send = (ctx: RoomContext, params: ReturnType<typeof baseParams>) =>
	RoomContext.prototype.sendLiveNotifyCard.call(ctx, params as never);

describe("RoomContext.sendLiveNotifyCard — 消息版式", () => {
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

	// 皮肤 id 要一路走到出卡的 colorOptions:断在这一跳的话,主人给这位
	// UP 选的皮肤只有预览认,推出去还是默认那副样子,而且全绿。
	it("皮肤 id 透传给出卡(样式没启用也照带)", async () => {
		const { ctx, generateNeutralLiveCard } = makeCtx();
		await send(ctx, baseParams({ cardSkin: "k4ddd-0ddba11" }));
		// 验红:把 room-helpers.ts 里那句 `cardSkin` 删掉,这条红。
		expect(generateNeutralLiveCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "k4ddd-0ddba11" });
	});

	// per-UP 旋钮覆盖(ADR-0014 决策 17 的 🔗)同一跳:断在这儿的话,主人给这位 UP 拧的
	// 只有预览认。验红:把 room-helpers.ts 里递 `cardSkinKnobs` 那一句删掉,这条红。
	it("per-UP 旋钮覆盖随皮肤 id 一起透传给出卡", async () => {
		const { ctx, generateNeutralLiveCard } = makeCtx();
		const cardSkinKnobs = { "k4ddd-0ddba11": { accent: "#aaaaaa" } };
		await send(ctx, baseParams({ cardSkin: "k4ddd-0ddba11", cardSkinKnobs }));
		expect(generateNeutralLiveCard.mock.calls[0]?.[1]).toEqual({
			cardSkin: "k4ddd-0ddba11",
			cardSkinKnobs,
		});
	});

	// B 站那头的翻译要真接上:出卡收到的是房间数据翻成的中立输入,状态照 liveType 明写。
	it("房间数据翻成中立的直播卡输入再出卡", async () => {
		const { ctx, generateNeutralLiveCard } = makeCtx();
		await send(ctx, baseParams({ liveType: LiveType.StopBroadcast }));
		// 验红:把 room-helpers.ts 里交给 `biliLiveCardInput` 的 liveType 换成写死的 1,这条红。
		expect(generateNeutralLiveCard.mock.calls[0]?.[0]).toMatchObject({
			status: "end",
			author: { name: "主播", face: "" },
			title: "标题",
		});
	});

	// 刻画(拆成中立装配 + 按 uid 发送之前就是这样):出卡要好几秒,这期间引擎被拆了就不再推。
	it("出卡期间引擎被拆了 → 不推", async () => {
		const { ctx, broadcastToTargets, broadcastSequenceToTargets, generateNeutralLiveCard } =
			makeCtx();
		let disposed = false;
		(ctx as unknown as { isDisposed: () => boolean }).isDisposed = () => disposed;
		generateNeutralLiveCard.mockImplementation(async () => {
			disposed = true;
			return Buffer.from("img");
		});
		await send(ctx, baseParams());
		// 验红:把 room-helpers.ts 里 `sendToUid` 开头那句 `isDisposed()` 删掉,这条红。
		expect(generateNeutralLiveCard).toHaveBeenCalledTimes(1);
		expect(broadcastToTargets).not.toHaveBeenCalled();
		expect(broadcastSequenceToTargets).not.toHaveBeenCalled();
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
		const { ctx, broadcastToTargets, generateNeutralLiveCard } = makeCtx();
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
		expect(generateNeutralLiveCard).not.toHaveBeenCalled();
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
		const { ctx, broadcastToTargets, broadcastSequenceToTargets, generateNeutralLiveCard } =
			makeCtx();
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
		expect(generateNeutralLiveCard).not.toHaveBeenCalled();
		expect(broadcastToTargets).not.toHaveBeenCalled();
		expect(broadcastSequenceToTargets).not.toHaveBeenCalled();
	});
	// 刻画(ADR-0019 决策 67 把装配合成一份之前钉的现状):自定义连接符、隐藏的分条符
	// 不切组、卡片夹在文字中间时前后两段文字各自成段。
	it("自定义连接符连相邻文字;隐藏的分条符不切组", async () => {
		const { ctx, broadcastToTargets, broadcastSequenceToTargets } = makeCtx();
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf(
					[
						{ type: "link" },
						{ type: "split", id: "split-1", visible: false },
						{ type: "text" },
						{ type: "card" },
					],
					" | ",
				),
			}),
		);
		expect(broadcastSequenceToTargets).not.toHaveBeenCalled();
		const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
		expect(content.segs.map((s) => s.kind)).toEqual(["text", "image"]);
		expect(content.segs[0]?.text).toBe(`${LINK} | 开播文案`);
	});

	it("卡片夹在文字中间 → 前后两段文字各自成段,不跨卡片连接", async () => {
		const { ctx, broadcastToTargets } = makeCtx();
		await send(
			ctx,
			baseParams({
				messageLayout: layoutOf([{ type: "text" }, { type: "card" }, { type: "link" }]),
			}),
		);
		const content = broadcastToTargets.mock.calls[0]?.[1] as Msg;
		expect(content.segs.map((s) => s.kind)).toEqual(["text", "image", "text"]);
		expect(content.segs[0]?.text).toBe("开播文案");
		expect(content.segs[2]?.text).toBe(LINK);
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
		const { ctx, broadcastToTargets, generateNeutralLiveCard } = makeCtx();
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
		expect(generateNeutralLiveCard).not.toHaveBeenCalled();
		const [, content, type] = broadcastToTargets.mock.calls[0] as [string, Msg, number];
		expect(type).toBe(LivePushType.LiveEnd);
		expect(content.segs.map((s) => s.kind)).toEqual(["text"]);
		expect(content.segs[0]?.text).toBe(`开播文案\n${LINK}`);
	});
});

describe("LiveTemplateRenderer.renderLiveStart — 模板不带链接", () => {
	const master = { username: "主播", userface: "", roomId: "123" } as never;
	const sub = { customLiveMsg: { enable: false } } as SubItemView;

	it("默认模板不带链接,链接由版式部件提供", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveStart({
			sub,
			master,
			diffTime: "",
			followerNum: "100",
		});
		expect(out).toBe("主播 开播啦，当前粉丝数：100");
	});

	it("模板里的字面 \\n 展开为换行", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveStart({
			sub: {
				customLiveMsg: { enable: true, customLiveStart: "{name}开播\\n粉丝 {follower}" },
			} as SubItemView,
			master,
			diffTime: "",
			followerNum: "100",
		});
		expect(out).toBe("主播开播\n粉丝 100");
	});
});

describe("LiveTemplateRenderer.renderLiveOngoing / renderLiveEnd — 模板不带链接", () => {
	const master = { username: "主播", userface: "", roomId: "123" } as never;
	const sub = { customLiveMsg: { enable: false } } as SubItemView;

	it("renderLiveOngoing:默认模板不带链接", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveOngoing({
			sub,
			master,
			diffTime: "1小时",
			watched: "100",
		});
		expect(out).toBe("主播 正在直播，已播 1小时，累计观看：100");
	});
	it("renderLiveEnd:默认模板不带链接", () => {
		const r = new LiveTemplateRenderer();
		const out = r.renderLiveEnd({
			sub,
			master,
			diffTime: "1小时",
			followerChange: 5,
		});
		expect(out).toBe("主播 下播啦，本次直播了 1小时，粉丝变化 +5");
	});
});
