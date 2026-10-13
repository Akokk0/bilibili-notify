/**
 * **会员(上舰)装配**(`pushMembership`):过门槛 → 三支(自定义文案 / 出卡 / 兜底)→ 交给绑到订阅上的发送。
 *
 * 这里只用中立的东西喂它:一条 `MembershipEvent`、一档 `MembershipTier`、一个假渲染器、一个把调用原样记成对象的内容构造口。
 * 期望值写死成字面量。
 */

import type {
	ImageRef,
	Logger,
	MembershipEvent,
	MembershipTemplateBundle,
	MembershipTier,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { LiveContentBuilder } from "../content-builder";
import type { CustomCardStyleLike } from "../live-types";
import { type MembershipDeps, type MembershipOptions, pushMembership } from "../membership";

const CARD = Buffer.from("guard-card-jpeg");
const VIEWER_AVATAR = `${"b".repeat(64)}.webp` as ImageRef;
const CREATOR_AVATAR = `${"c".repeat(64)}.webp` as ImageRef;
const ICON_REF = `${"d".repeat(64)}.png` as ImageRef;
const BADGE_URL = "https://example.com/captain.png";

const EVENT: MembershipEvent = {
	subscriptionId: "sub-1",
	viewer: { id: "7", name: "船员" },
	program: "guard",
	tier: { key: "captain", name: "舰长", rank: 1 },
};

const TIER: MembershipTier = {
	key: "captain",
	name: "舰长",
	rank: 1,
	icon: { url: BADGE_URL },
	color: "#4ebcec",
	colorEnd: "#b494e5",
	announcement: "加入大航海",
};

const TEMPLATE_OFF: MembershipTemplateBundle = {
	enabled: false,
	default: { template: "", imageUrl: "" },
	tiers: {},
};

function options(over: Partial<MembershipOptions> = {}): MembershipOptions {
	return {
		event: EVENT,
		tier: TIER,
		minRank: undefined,
		template: TEMPLATE_OFF,
		creator: { name: "主播", avatar: CREATOR_AVATAR },
		cardStyle: { enable: false },
		fallbackText: "兜底一句",
		...over,
	};
}

/** 把调用原样记成对象的内容构造口。 */
const content: LiveContentBuilder = {
	text: (text) => ({ kind: "text", text }),
	image: (source, mime) => ({ kind: "image", source, ...(mime === undefined ? {} : { mime }) }),
	atAll: () => ({ kind: "at-all" }),
	message: (segments) => ({ kind: "message", segments }),
};

function setup(
	opts: {
		noRenderer?: boolean;
		renderFail?: boolean;
		avatarFail?: boolean;
		iconFail?: boolean;
		sendFail?: boolean;
		icon?: { ref: ImageRef } | undefined;
		avatar?: ImageRef | undefined;
	} = {},
) {
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const generateMembershipCard = vi.fn(async (_input: unknown, _style?: unknown) => {
		if (opts.renderFail) throw new Error("boom");
		return CARD;
	});
	const fetchTierIcon = vi.fn(async () => {
		if (opts.iconFail) throw new Error("icon down");
		return "icon" in opts ? opts.icon : { ref: ICON_REF };
	});
	const fetchViewerAvatar = vi.fn(async (): Promise<ImageRef | undefined> => {
		if (opts.avatarFail) throw new Error("avatar down");
		return "avatar" in opts ? opts.avatar : VIEWER_AVATAR;
	});
	const sent: unknown[] = [];
	const send = vi.fn(async (message: unknown) => {
		sent.push(message);
		if (opts.sendFail) throw new Error("send down");
	});
	const d: MembershipDeps = {
		renderer: opts.noRenderer
			? null
			: ({ generateMembershipCard } as unknown as MembershipDeps["renderer"]),
		fetchTierIcon,
		fetchViewerAvatar,
		content,
		send,
		logger: logger as unknown as Logger,
	};
	return { d, logger, generateMembershipCard, fetchTierIcon, fetchViewerAvatar, send, sent };
}

const FALLBACK_MESSAGE = {
	kind: "message",
	segments: [
		{ kind: "image", source: BADGE_URL },
		{ kind: "text", text: "兜底一句" },
	],
};

describe("pushMembership — 门槛", () => {
	it("低于门槛:什么都不做(两个取数函数、渲染器、发送都没被调)", async () => {
		const t = setup();
		await pushMembership(options({ minRank: 3 }), t.d);
		expect(t.fetchTierIcon).not.toHaveBeenCalled();
		expect(t.fetchViewerAvatar).not.toHaveBeenCalled();
		expect(t.generateMembershipCard).not.toHaveBeenCalled();
		expect(t.send).not.toHaveBeenCalled();
	});

	it("等于门槛放行", async () => {
		const t = setup();
		await pushMembership(options({ minRank: 1 }), t.d);
		expect(t.send).toHaveBeenCalledTimes(1);
	});

	it("档没有 rank:放行", async () => {
		const t = setup();
		await pushMembership(
			options({ minRank: 3, event: { ...EVENT, tier: { key: "x", name: "自定档" } } }),
			t.d,
		);
		expect(t.send).toHaveBeenCalledTimes(1);
	});
});

describe("pushMembership — 自定义文案那一支", () => {
	const custom = (over: Partial<MembershipTemplateBundle> = {}): MembershipTemplateBundle => ({
		enabled: true,
		default: { template: "{viewer}→{name}:{tier}\\n欢迎", imageUrl: "" },
		tiers: {},
		...over,
	});

	it("文字三个占位符、\\n 展开成真换行;这一档没填图片回落徽章地址;不取数不出卡", async () => {
		const t = setup();
		await pushMembership(options({ template: custom() }), t.d);
		expect(t.sent).toEqual([
			{
				kind: "message",
				segments: [
					{ kind: "image", source: BADGE_URL },
					{ kind: "text", text: "船员→主播:舰长\n欢迎" },
				],
			},
		]);
		expect(t.fetchTierIcon).not.toHaveBeenCalled();
		expect(t.fetchViewerAvatar).not.toHaveBeenCalled();
		expect(t.generateMembershipCard).not.toHaveBeenCalled();
	});

	it("这一档填了文案与图片:用它们", async () => {
		const t = setup();
		await pushMembership(
			options({
				template: custom({
					tiers: {
						captain: { template: "舰长专属 {viewer}", imageUrl: "https://example.com/mine.png" },
					},
				}),
			}),
			t.d,
		);
		expect(t.sent).toEqual([
			{
				kind: "message",
				segments: [
					{ kind: "image", source: "https://example.com/mine.png" },
					{ kind: "text", text: "舰长专属 船员" },
				],
			},
		]);
	});

	it("这一档没单独配:用体系默认那一格(默认带图也用默认的)", async () => {
		const t = setup();
		await pushMembership(
			options({
				template: custom({
					default: { template: "默认 {viewer}", imageUrl: "https://example.com/default.png" },
					tiers: { admiral: { template: "提督专属" } },
				}),
			}),
			t.d,
		);
		expect(t.sent).toEqual([
			{
				kind: "message",
				segments: [
					{ kind: "image", source: "https://example.com/default.png" },
					{ kind: "text", text: "默认 船员" },
				],
			},
		]);
	});

	it("档位表里这档没有徽章、文案也没填图 → 图片地址是空串", async () => {
		const t = setup();
		await pushMembership(options({ template: custom(), tier: { ...TIER, icon: undefined } }), t.d);
		expect(t.sent).toEqual([
			{
				kind: "message",
				segments: [
					{ kind: "image", source: "" },
					{ kind: "text", text: "船员→主播:舰长\n欢迎" },
				],
			},
		]);
	});
});

describe("pushMembership — 出卡那一支", () => {
	it("有徽章有头像:卡的入参逐格等于期望,发 image/jpeg 的图", async () => {
		const t = setup();
		await pushMembership(options(), t.d);
		expect(t.generateMembershipCard).toHaveBeenCalledTimes(1);
		expect(t.generateMembershipCard.mock.calls[0]?.[0]).toStrictEqual({
			viewer: { name: "船员", avatar: VIEWER_AVATAR },
			creator: { name: "主播", avatar: CREATOR_AVATAR },
			tier: {
				name: "舰长",
				rank: 1,
				icon: { ref: ICON_REF },
				color: "#4ebcec",
				colorEnd: "#b494e5",
				announcement: "加入大航海",
			},
		});
		expect(t.sent).toEqual([{ kind: "image", source: CARD, mime: "image/jpeg" }]);
	});

	it("没有徽章、没有头像:入参不带 icon 与 avatar 那两格", async () => {
		const t = setup({ icon: undefined, avatar: undefined });
		await pushMembership(options({ creator: { name: "主播" } }), t.d);
		expect(t.generateMembershipCard.mock.calls[0]?.[0]).toStrictEqual({
			viewer: { name: "船员" },
			creator: { name: "主播" },
			tier: {
				name: "舰长",
				rank: 1,
				color: "#4ebcec",
				colorEnd: "#b494e5",
				announcement: "加入大航海",
			},
		});
		expect(t.sent).toHaveLength(1);
	});

	it("样式没启用:不展开样式,皮肤两格照带", async () => {
		const t = setup();
		const cardStyle: CustomCardStyleLike = { enable: false, font: "Base Sans" };
		await pushMembership(
			options({
				cardStyle,
				cardSkin: "k7xxx-c0ffee",
				cardSkinKnobs: { "k7xxx-c0ffee": { accent: "#aaaaaa" } },
			}),
			t.d,
		);
		expect(t.generateMembershipCard.mock.calls[0]?.[1]).toStrictEqual({
			cardSkin: "k7xxx-c0ffee",
			cardSkinKnobs: { "k7xxx-c0ffee": { accent: "#aaaaaa" } },
		});
	});

	it("样式启用:展开样式,再带皮肤两格", async () => {
		const t = setup();
		await pushMembership(
			options({ cardStyle: { enable: true, font: "Base Sans" }, cardSkin: "default" }),
			t.d,
		);
		expect(t.generateMembershipCard.mock.calls[0]?.[1]).toStrictEqual({
			enable: true,
			font: "Base Sans",
			cardSkin: "default",
			cardSkinKnobs: undefined,
		});
	});

	it("发卡那一次 send 抛了:往外抛,send 只调过一次(不补发兜底)", async () => {
		const t = setup({ sendFail: true });
		await expect(pushMembership(options(), t.d)).rejects.toThrow("send down");
		expect(t.send).toHaveBeenCalledTimes(1);
		expect(t.sent[0]).toEqual({ kind: "image", source: CARD, mime: "image/jpeg" });
		expect(t.logger.error).not.toHaveBeenCalled();
	});
});

describe("pushMembership — 兜底那一支", () => {
	it("没有渲染器:发「徽章图 + 一句文字」,不调两个取数函数", async () => {
		const t = setup({ noRenderer: true });
		await pushMembership(options(), t.d);
		expect(t.fetchTierIcon).not.toHaveBeenCalled();
		expect(t.fetchViewerAvatar).not.toHaveBeenCalled();
		expect(t.sent).toEqual([FALLBACK_MESSAGE]);
	});

	it("档位没有徽章:图片地址是空串", async () => {
		const t = setup({ noRenderer: true });
		await pushMembership(options({ tier: { ...TIER, icon: undefined } }), t.d);
		expect(t.sent).toEqual([
			{
				kind: "message",
				segments: [
					{ kind: "image", source: "" },
					{ kind: "text", text: "兜底一句" },
				],
			},
		]);
	});

	it.each([
		["取图标抛", { iconFail: true }],
		["取头像抛", { avatarFail: true }],
		["出卡抛", { renderFail: true }],
	] as const)("%s:退到兜底并记一条 error", async (_name, opts) => {
		const t = setup(opts);
		await pushMembership(options(), t.d);
		expect(t.sent).toEqual([FALLBACK_MESSAGE]);
		expect(t.logger.error).toHaveBeenCalledTimes(1);
		const logged = String(t.logger.error.mock.calls[0]?.[0]);
		expect(logged).toContain("[image] 生成会员卡片失败：");
		expect(logged).toContain("，降级为文字推送");
	});
});
