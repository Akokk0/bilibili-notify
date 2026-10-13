/**
 * **醒目留言装配**(`pushSuperchat`):吃中立的醒目留言事件,过门槛 → 出卡 → 交给绑到订阅上的发送;出不了卡退一句文字。
 *
 * 这里只用中立的东西喂它:一条 `SuperchatEvent`、一个假渲染器、一个把收到的段记下来的发送。期望值写死成字面量。
 */

import type {
	ImageRef,
	Logger,
	MessageLayoutSegment,
	SuperchatEvent,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CustomCardStyleLike } from "../live-types";
import { pushSuperchat, type SuperchatDeps, type SuperchatOptions } from "../superchat";

const CARD = Buffer.from("sc-card-jpeg");
const VIEWER_AVATAR = `${"b".repeat(64)}.webp` as ImageRef;
const CREATOR_AVATAR = `${"c".repeat(64)}.webp` as ImageRef;

const EVENT: SuperchatEvent = {
	subscriptionId: "sub-1",
	viewer: { id: "42", name: "粉丝" },
	text: "加油",
	amount: 50,
	currency: "CNY",
	tier: { rank: 2, durationSec: 120 },
};

function options(over: Partial<SuperchatOptions> = {}): SuperchatOptions {
	return {
		event: EVENT,
		minAmount: undefined,
		creator: { name: "主播", avatar: CREATOR_AVATAR },
		cardStyle: { enable: false },
		fallbackText: "兜底一句",
		...over,
	};
}

function setup(
	opts: {
		noRenderer?: boolean;
		renderFail?: boolean;
		avatarFail?: boolean;
		sendFail?: boolean;
		avatar?: ImageRef;
	} = {},
) {
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const generateSuperchatCard = vi.fn(async (_input: unknown, _style?: unknown) => {
		if (opts.renderFail) throw new Error("boom");
		return CARD;
	});
	const fetchViewerAvatar = vi.fn(async (): Promise<ImageRef | undefined> => {
		if (opts.avatarFail) throw new Error("avatar down");
		return "avatar" in opts ? opts.avatar : VIEWER_AVATAR;
	});
	const sent: MessageLayoutSegment[] = [];
	const send = vi.fn(async (segment: MessageLayoutSegment) => {
		sent.push(segment);
		if (opts.sendFail) throw new Error("send down");
	});
	const d: SuperchatDeps = {
		renderer: opts.noRenderer ? null : ({ generateSuperchatCard } as SuperchatDeps["renderer"]),
		fetchViewerAvatar,
		send,
		logger: logger as unknown as Logger,
	};
	return { d, logger, generateSuperchatCard, fetchViewerAvatar, send, sent };
}

describe("pushSuperchat", () => {
	it("过门槛:出卡,send 收到图那一段,卡的入参逐格等于期望", async () => {
		const t = setup();
		await pushSuperchat(options({ minAmount: 30 }), t.d);
		expect(t.generateSuperchatCard).toHaveBeenCalledTimes(1);
		expect(t.generateSuperchatCard.mock.calls[0]?.[0]).toStrictEqual({
			viewer: { name: "粉丝", avatar: VIEWER_AVATAR },
			creator: { name: "主播", avatar: CREATOR_AVATAR },
			text: "加油",
			amount: 50,
			currency: "CNY",
			tier: { rank: 2, durationSec: 120 },
		});
		expect(t.sent).toEqual([{ kind: "image", buffer: CARD, mime: "image/jpeg" }]);
	});

	it("低于门槛:不取头像、不出卡、不发", async () => {
		const t = setup();
		await pushSuperchat(options({ minAmount: 100 }), t.d);
		expect(t.fetchViewerAvatar).not.toHaveBeenCalled();
		expect(t.generateSuperchatCard).not.toHaveBeenCalled();
		expect(t.send).not.toHaveBeenCalled();
	});

	it("等于门槛放行", async () => {
		const t = setup();
		await pushSuperchat(options({ minAmount: 50 }), t.d);
		expect(t.send).toHaveBeenCalledTimes(1);
	});

	it("非人民币不比门槛,放行", async () => {
		const t = setup();
		await pushSuperchat(
			options({ minAmount: 30, event: { ...EVENT, amount: 5, currency: "USD" } }),
			t.d,
		);
		expect(t.generateSuperchatCard).toHaveBeenCalledTimes(1);
		expect(t.sent[0]?.kind).toBe("image");
	});

	it("没有渲染器:发兜底文字,不取头像", async () => {
		const t = setup({ noRenderer: true });
		await pushSuperchat(options(), t.d);
		expect(t.fetchViewerAvatar).not.toHaveBeenCalled();
		expect(t.sent).toEqual([{ kind: "text", text: "兜底一句" }]);
	});

	it("出卡抛错:发兜底文字并记一条 error", async () => {
		const t = setup({ renderFail: true });
		await pushSuperchat(options(), t.d);
		expect(t.sent).toEqual([{ kind: "text", text: "兜底一句" }]);
		expect(t.logger.error).toHaveBeenCalledTimes(1);
		expect(t.logger.error).toHaveBeenCalledWith(
			"[image] 生成醒目留言卡片失败：boom，降级为文字推送",
		);
	});

	it("取头像抛错:同样退到文字", async () => {
		const t = setup({ avatarFail: true });
		await pushSuperchat(options(), t.d);
		expect(t.generateSuperchatCard).not.toHaveBeenCalled();
		expect(t.sent).toEqual([{ kind: "text", text: "兜底一句" }]);
		expect(t.logger.error).toHaveBeenCalledTimes(1);
	});

	it("取不到头像(undefined):卡的入参 viewer 不带 avatar 那一格", async () => {
		const t = setup({ avatar: undefined });
		await pushSuperchat(options({ creator: { name: "主播" } }), t.d);
		const input = t.generateSuperchatCard.mock.calls[0]?.[0] as {
			viewer: unknown;
			creator: unknown;
		};
		expect(input.viewer).toStrictEqual({ name: "粉丝" });
		expect(input.creator).toStrictEqual({ name: "主播" });
		expect(t.sent[0]?.kind).toBe("image");
	});

	it("样式没启用:不展开样式,皮肤两格照带", async () => {
		const t = setup();
		const cardStyle: CustomCardStyleLike = { enable: false, font: "Base Sans" };
		await pushSuperchat(
			options({
				cardStyle,
				cardSkin: "k7xxx-c0ffee",
				cardSkinKnobs: { "k7xxx-c0ffee": { accent: "#aaaaaa" } },
			}),
			t.d,
		);
		expect(t.generateSuperchatCard.mock.calls[0]?.[1]).toStrictEqual({
			cardSkin: "k7xxx-c0ffee",
			cardSkinKnobs: { "k7xxx-c0ffee": { accent: "#aaaaaa" } },
		});
	});

	it("样式启用:展开样式,再带皮肤两格", async () => {
		const t = setup();
		await pushSuperchat(
			options({ cardStyle: { enable: true, font: "Base Sans" }, cardSkin: "default" }),
			t.d,
		);
		expect(t.generateSuperchatCard.mock.calls[0]?.[1]).toStrictEqual({
			enable: true,
			font: "Base Sans",
			cardSkin: "default",
			cardSkinKnobs: undefined,
		});
	});

	it("发图那一次 send 抛了:往外抛,send 只调过一次(不补发文字)", async () => {
		const t = setup({ sendFail: true });
		await expect(pushSuperchat(options(), t.d)).rejects.toThrow("send down");
		expect(t.send).toHaveBeenCalledTimes(1);
		expect(t.sent[0]?.kind).toBe("image");
		expect(t.logger.error).not.toHaveBeenCalled();
	});
});
