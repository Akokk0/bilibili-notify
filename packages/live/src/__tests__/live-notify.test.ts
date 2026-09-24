/**
 * **直播装配**(`pushLiveNotify`,ADR-0019 决策 65 / 67):吃中立的直播卡输入,出卡 → 按版式
 * 分组 → 交给绑到订阅上的发送。不认 uid、不认 B 站的房间数据 —— B 站的推送与拓展订阅的
 * 直播都走它。
 *
 * 这里只用中立的东西喂它:一份 `LiveCardInput`、一个假渲染器、一个把收到的东西记下来的发送。
 */

import type { LiveCardInput } from "@bilibili-notify/image";
import type { Logger, MessageKindLayout, MessageLayoutSegment } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { type LiveNotifyParams, type LiveNotifySend, pushLiveNotify } from "../live-notify";
import { LivePushType } from "../push-like";

const CARD = Buffer.from("card-jpeg");
const LINK = "https://example.com/live/1";

const INPUT: LiveCardInput = {
	status: "start",
	author: { name: "示例主播", face: "data:image/png;base64,FACE" },
	title: "示例标题",
	startedAt: Date.UTC(2026, 8, 24, 12, 0, 0),
	online: 12,
};

function layoutOf(
	blocks: Array<{ type: string; visible?: boolean; id?: string }>,
	separator = "\n",
): MessageKindLayout {
	return {
		blocks: blocks.map((x) => ({ id: x.id ?? x.type, type: x.type, visible: x.visible ?? true })),
		separator,
	};
}

function params(over: Partial<LiveNotifyParams> = {}): LiveNotifyParams {
	return {
		input: INPUT,
		text: "开播啦",
		link: LINK,
		layout: layoutOf([{ type: "card" }, { type: "text" }, { type: "link" }]),
		pushType: LivePushType.StartBroadcasting,
		label: "sub=s1",
		...over,
	};
}

function deps(opts: { renderFail?: boolean; noRenderer?: boolean } = {}) {
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const generateNeutralLiveCard = vi.fn(
		async (_input: LiveCardInput, _colorOptions?: unknown): Promise<Buffer> => {
			if (opts.renderFail) throw new Error("boom");
			return CARD;
		},
	);
	const send = vi.fn<LiveNotifySend>(async () => {});
	return {
		logger,
		generateNeutralLiveCard,
		send,
		deps: {
			renderer: opts.noRenderer ? null : { generateNeutralLiveCard },
			send,
			logger: logger as Logger,
		},
	};
}

const image: MessageLayoutSegment = { type: "image", buffer: CARD, mime: "image/jpeg" };
const text = (t: string): MessageLayoutSegment => ({ type: "text", text: t });

describe("pushLiveNotify — 出卡", () => {
	it("中立的输入原样交给渲染器;样式没启用时只带皮肤 id", async () => {
		const d = deps();
		await pushLiveNotify(
			params({ cardStyle: { enable: false, font: "不该带上" }, cardSkin: "k1" }),
			d.deps,
		);
		expect(d.generateNeutralLiveCard).toHaveBeenCalledTimes(1);
		expect(d.generateNeutralLiveCard.mock.calls[0]?.[0]).toBe(INPUT);
		expect(d.generateNeutralLiveCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "k1" });
	});

	it("样式启用了 → 整份样式与皮肤 id 一起交给渲染器", async () => {
		const d = deps();
		const cardStyle = { enable: true, font: "思源黑体", liveCoverImage: "cover-1" };
		await pushLiveNotify(params({ cardStyle, cardSkin: "k1" }), d.deps);
		expect(d.generateNeutralLiveCard.mock.calls[0]?.[1]).toEqual({ ...cardStyle, cardSkin: "k1" });
	});

	/**
	 * per-UP 那层旋钮覆盖(ADR-0014 决策 17 的 🔗)跟皮肤 id 一起走,**与样式启没启用无关** ——
	 * 没单独调过卡片样式的 UP 也可以单独拧旋钮。验红:把 live-notify.ts 里递 `cardSkinKnobs`
	 * 那一句删掉,这条红。
	 */
	it("per-UP 旋钮覆盖与皮肤 id 一起交给渲染器,样式没启用也带着", async () => {
		const d = deps();
		const cardSkinKnobs = { k1: { accent: "#aaaaaa" } };
		await pushLiveNotify(
			params({ cardStyle: { enable: false }, cardSkin: "k1", cardSkinKnobs }),
			d.deps,
		);
		expect(d.generateNeutralLiveCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "k1", cardSkinKnobs });
	});

	it("版式里卡片块藏起来 → 不出卡,只发文字与链接", async () => {
		const d = deps();
		await pushLiveNotify(
			params({
				layout: layoutOf([{ type: "card", visible: false }, { type: "text" }, { type: "link" }]),
			}),
			d.deps,
		);
		expect(d.generateNeutralLiveCard).not.toHaveBeenCalled();
		expect(d.send.mock.calls[0]?.[0]).toEqual([[text(`开播啦\n${LINK}`)]]);
	});

	it("没有渲染器(关了出图)→ 只发文字", async () => {
		const d = deps({ noRenderer: true });
		await pushLiveNotify(params(), d.deps);
		expect(d.send.mock.calls[0]?.[0]).toEqual([[text(`开播啦\n${LINK}`)]]);
	});

	it("出卡失败 → 记错误,降级为只发文字", async () => {
		const d = deps({ renderFail: true });
		await pushLiveNotify(params(), d.deps);
		expect(d.logger.error).toHaveBeenCalledTimes(1);
		expect(d.send.mock.calls[0]?.[0]).toEqual([[text(`开播啦\n${LINK}`)]]);
	});
});

describe("pushLiveNotify — 分组与发送", () => {
	it("一条消息:卡片在前,文案与链接以连接符连成一段", async () => {
		const d = deps();
		await pushLiveNotify(params(), d.deps);
		expect(d.send).toHaveBeenCalledTimes(1);
		expect(d.send.mock.calls[0]?.[0]).toEqual([[image, text(`开播啦\n${LINK}`)]]);
	});

	it("分条符切成两条 → 一次交出两组", async () => {
		const d = deps();
		await pushLiveNotify(
			params({
				layout: layoutOf(
					[{ type: "card" }, { type: "split", id: "split-1" }, { type: "text" }, { type: "link" }],
					" | ",
				),
			}),
			d.deps,
		);
		expect(d.send).toHaveBeenCalledTimes(1);
		expect(d.send.mock.calls[0]?.[0]).toEqual([[image], [text(`开播啦 | ${LINK}`)]]);
	});

	it("推送类型与 pushId 原样交给发送", async () => {
		const d = deps();
		const pushId = "11111111-1111-4111-8111-111111111111";
		await pushLiveNotify(params({ pushType: LivePushType.LiveEnd, pushId }), d.deps);
		await pushLiveNotify(params({ pushType: LivePushType.Live }), d.deps);
		expect(d.send.mock.calls[0]?.[1]).toBe(LivePushType.LiveEnd);
		expect(d.send.mock.calls[0]?.[2]).toEqual({ pushId });
		expect(d.send.mock.calls[1]?.[1]).toBe(LivePushType.Live);
		expect(d.send.mock.calls[1]?.[2]).toEqual({ pushId: undefined });
	});

	it("所有部件都藏起来 → 不出卡、不发送", async () => {
		const d = deps();
		await pushLiveNotify(
			params({
				layout: layoutOf([
					{ type: "card", visible: false },
					{ type: "text", visible: false },
					{ type: "link", visible: false },
				]),
			}),
			d.deps,
		);
		expect(d.generateNeutralLiveCard).not.toHaveBeenCalled();
		expect(d.send).not.toHaveBeenCalled();
	});
});
