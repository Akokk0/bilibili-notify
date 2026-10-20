/**
 * `linkPreview` —— 群里贴视频链接自动出预览的总开关、节流,与「默认行 + 逐目标例外」五格。
 *
 * 守四条:① 老 core.json 没有这一段照样能读(独立端启动 parse 失败是直接挂掉);
 * ② **总开关默认关**。开着就意味着同群任何人都能让机器人出图,这得是主人自己按下去的;
 * ③ 0.x 的 `linkParsing` 与 0.9.1 的「范围 + 白名单」由迁移器改写成这五格(`apps/server/src/migration/link-parsing.ts`,
 *    用例在服务端的 `migration/__tests__/settings.test.ts`),活 schema 只认新形状,见文末那一组;
 * ④ 折叠:逐目标例外缺省继承默认行,写了哪个字段只覆盖哪个字段。
 */

import { describe, expect, it } from "vite-plus/test";
import { LINK_REPLY_FORMS } from "../../constants";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { DEFAULT_LINK_PREVIEW, LinkPreviewSettingsSchema, linkPreviewFor } from "../link-preview";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** 全新安装的那一份:总开关关、默认回、回图片、没有例外、冷却 60 秒。 */
const FRESH = {
	enabled: false,
	isOnByDefault: true,
	replyForm: "image",
	byTarget: {},
	cooldownSec: 60,
};

describe("linkPreview 配置段", () => {
	it("老 core.json 没有 linkPreview → 解析成功并补成默认", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.linkPreview;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.linkPreview).toEqual(FRESH);
	});

	it("全新安装总开关关、默认回图片;形式有图片 / 原生分享 / 文字三档", () => {
		expect(makeDefaultGlobalConfig().linkPreview.enabled).toBe(false);
		expect(DEFAULT_LINK_PREVIEW).toEqual(FRESH);
		expect(LINK_REPLY_FORMS).toEqual(["image", "nativeShare", "text"]);
	});

	it("默认行与逐目标例外都收 text", () => {
		const parsed = LinkPreviewSettingsSchema.parse({
			replyForm: "text",
			byTarget: { [A]: { replyForm: "text" } },
		});
		expect(parsed.replyForm).toBe("text");
		expect(parsed.byTarget).toEqual({ [A]: { replyForm: "text" } });
	});

	it("只给 enabled 也行,其余补默认", () => {
		expect(LinkPreviewSettingsSchema.parse({ enabled: true })).toEqual({ ...FRESH, enabled: true });
	});
});

describe("五格的形状", () => {
	it("例外只存显式值:空对象条目被剥掉,写了的原样留", () => {
		expect(
			LinkPreviewSettingsSchema.parse({
				byTarget: { [A]: {}, [B]: { isOn: false, replyForm: "nativeShare" } },
			}).byTarget,
		).toEqual({ [B]: { isOn: false, replyForm: "nativeShare" } });
	});

	it("targetId 不是 uuid、形式不在三档之内 → 拒", () => {
		expect(
			LinkPreviewSettingsSchema.safeParse({ byTarget: { "group-123": { isOn: true } } }).success,
		).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ replyForm: "both" }).success).toBe(false);
		expect(
			LinkPreviewSettingsSchema.safeParse({ byTarget: { [A]: { replyForm: "card" } } }).success,
		).toBe(false);
		// 老取值 miniapp 不再认:那是迁移器改成 nativeShare 的事
		expect(LinkPreviewSettingsSchema.safeParse({ replyForm: "miniapp" }).success).toBe(false);
	});

	it("冷却秒数是 0–3600 的整数,越界与小数都拒", () => {
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSec: 0 }).success).toBe(true);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSec: 3600 }).success).toBe(true);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSec: 3601 }).success).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSec: -1 }).success).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSec: 1.5 }).success).toBe(false);
	});
});

describe("linkPreviewFor —— 折叠出这个群回不回、回什么", () => {
	const settings = LinkPreviewSettingsSchema.parse({
		isOnByDefault: true,
		replyForm: "image",
		byTarget: { [A]: { replyForm: "nativeShare" }, [B]: { isOn: false } },
	});

	it("没写例外的群跟默认行;不是推送目标的群(没有 id)也跟默认行", () => {
		expect(linkPreviewFor(settings, "33333333-3333-4333-8333-333333333333")).toEqual({
			isOn: true,
			replyForm: "image",
		});
		expect(linkPreviewFor(settings, undefined)).toEqual({ isOn: true, replyForm: "image" });
	});

	it("例外逐字段覆盖:只写 replyForm 的群 isOn 仍跟默认,只写 isOn 的群 replyForm 仍跟默认", () => {
		expect(linkPreviewFor(settings, A)).toEqual({ isOn: true, replyForm: "nativeShare" });
		expect(linkPreviewFor(settings, B)).toEqual({ isOn: false, replyForm: "image" });
	});

	it("默认关、群显式开 = 原来的白名单", () => {
		const wl = LinkPreviewSettingsSchema.parse({
			isOnByDefault: false,
			byTarget: { [A]: { isOn: true } },
		});
		expect(linkPreviewFor(wl, A).isOn).toBe(true);
		expect(linkPreviewFor(wl, B).isOn).toBe(false);
	});
});

describe("活 schema 不认 0.x 的形状(那是迁移器的事)", () => {
	// schema 上没有 preprocess:喂 0.x 的 `defaults` / `groups` / `cooldownSeconds` 进来,得到的是剥掉老键的默认值,
	// 而不是「悄悄帮你迁」。谁把老数据的兜底加回 schema,这一条就红(那会让同一份迁移逻辑在 schema 和迁移器里各住一份)。
	it("defaults / groups / cooldownSeconds → 被剥掉,五格取默认", () => {
		const parsed = LinkPreviewSettingsSchema.parse({
			enabled: true,
			cooldownSeconds: 30,
			defaults: { parse: false, form: "miniapp" },
			groups: { [A]: { parse: true } },
		});
		expect(parsed).toEqual({ ...FRESH, enabled: true });
		expect(parsed).not.toHaveProperty("defaults");
		expect(parsed).not.toHaveProperty("groups");
		expect(parsed).not.toHaveProperty("cooldownSeconds");
	});
});
