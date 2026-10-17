/**
 * `linkParsing` —— 群里贴 B 站视频链接自动出卡片的开关、节流,与「默认行 + 逐群例外」。
 *
 * 守四条:① 老 globals.json 没有这一段照样能读(独立端启动 parse 失败是直接挂掉);
 * ② **默认关**。开着就意味着同群任何人都能让机器人出图,这得是主人自己按下去的;
 * ③ 0.9.1 的「范围 + 白名单」由迁移器改写成默认行 + 例外(`apps/server/src/migration/link-parsing.ts`,
 *    用例在服务端的 `migration/__tests__/settings.test.ts`),活 schema 只认新形状,见文末那一组;
 * ④ 折叠:逐群例外缺省继承默认行,写了哪个字段只覆盖哪个字段。
 */

import { describe, expect, it } from "vite-plus/test";
import { LINK_REPLY_FORMS } from "../../constants";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";
import { DEFAULT_LINK_PREVIEW, LinkPreviewSettingsSchema, linkPreviewFor } from "../link-preview";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** 全新安装的那一份:关、冷却 60 秒、所有群解析、回图片卡、没有例外。 */
const FRESH = {
	enabled: false,
	cooldownSeconds: 60,
	defaults: { parse: true, form: "image" },
	groups: {},
};

describe("linkParsing 配置段", () => {
	it("老 globals.json 没有 linkParsing → 解析成功并补成默认", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.linkParsing;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.linkParsing).toEqual(FRESH);
	});

	it("全新安装默认关、默认回图片卡;形式只有图片卡 / 小程序卡两档", () => {
		expect(makeDefaultGlobalConfig().linkParsing.enabled).toBe(false);
		expect(DEFAULT_LINK_PREVIEW).toEqual(FRESH);
		expect(LINK_REPLY_FORMS).toEqual(["image", "miniapp"]);
	});

	it("只给 enabled 也行,其余补默认", () => {
		expect(LinkPreviewSettingsSchema.parse({ enabled: true })).toEqual({ ...FRESH, enabled: true });
	});

	// 白名单进来之前发出去的版本只有 enabled / cooldownSeconds。升上来的实例必须落在
	// 「所有群都解析」—— 行为一字不变,主人开过的功能不能因为升级悄悄缩到零个群。
	it("白名单之前的版本(只有 enabled / cooldownSeconds)→ 所有群解析", () => {
		expect(LinkPreviewSettingsSchema.parse({ enabled: true, cooldownSeconds: 30 })).toEqual({
			...FRESH,
			enabled: true,
			cooldownSeconds: 30,
		});
	});
});

describe("新形状", () => {
	it("例外只存显式值:空对象条目被剥掉,写了的原样留", () => {
		expect(
			LinkPreviewSettingsSchema.parse({
				groups: { [A]: {}, [B]: { parse: false, form: "miniapp" } },
			}).groups,
		).toEqual({ [B]: { parse: false, form: "miniapp" } });
	});

	it("targetId 不是 uuid、形式不在两档之内 → 拒", () => {
		expect(
			LinkPreviewSettingsSchema.safeParse({ groups: { "group-123": { parse: true } } }).success,
		).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ defaults: { form: "both" } }).success).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ groups: { [A]: { form: "text" } } }).success).toBe(
			false,
		);
	});

	it("冷却秒数是 0–3600 的整数,越界与小数都拒", () => {
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSeconds: 0 }).success).toBe(true);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSeconds: 3600 }).success).toBe(true);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSeconds: 3601 }).success).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSeconds: -1 }).success).toBe(false);
		expect(LinkPreviewSettingsSchema.safeParse({ cooldownSeconds: 1.5 }).success).toBe(false);
	});
});

describe("linkPreviewFor —— 折叠出这个群解不解析、回什么", () => {
	const cfg = LinkPreviewSettingsSchema.parse({
		defaults: { parse: true, form: "image" },
		groups: { [A]: { form: "miniapp" }, [B]: { parse: false } },
	});

	it("没写例外的群跟默认行;不是推送目标的群(没有 id)也跟默认行", () => {
		expect(linkPreviewFor(cfg, "33333333-3333-4333-8333-333333333333")).toEqual({
			parse: true,
			form: "image",
		});
		expect(linkPreviewFor(cfg, undefined)).toEqual({ parse: true, form: "image" });
	});

	it("例外逐字段覆盖:只写 form 的群 parse 仍跟默认,只写 parse 的群 form 仍跟默认", () => {
		expect(linkPreviewFor(cfg, A)).toEqual({ parse: true, form: "miniapp" });
		expect(linkPreviewFor(cfg, B)).toEqual({ parse: false, form: "image" });
	});

	it("默认关、群显式开 = 原来的白名单", () => {
		const wl = LinkPreviewSettingsSchema.parse({
			defaults: { parse: false },
			groups: { [A]: { parse: true } },
		});
		expect(linkPreviewFor(wl, A).parse).toBe(true);
		expect(linkPreviewFor(wl, B).parse).toBe(false);
	});
});

describe("活 schema 不再认老形状(那是迁移器的事)", () => {
	// schema 上没有 preprocess:喂 0.9.1 的「范围 + 白名单」进来,得到的是剥掉老键的默认行,而不是「悄悄帮你迁」。
	// 这正是老形状绕过迁移的后果 —— 白名单悄悄变成「所有群都解析」。0.x 的老形状只在开新代时由迁移器改写一次;
	// 谁把老数据的兜底加回 schema,这一条就红(那会让同一份迁移逻辑在 schema 和迁移器里各住一份)。
	it("scope=selected + targets → scope / targets 被剥掉,defaults.parse 取默认 true、groups 留空", () => {
		const parsed = LinkPreviewSettingsSchema.parse({
			enabled: true,
			scope: "selected",
			targets: [{ targetId: A }],
		});
		expect(parsed).toEqual({ ...FRESH, enabled: true });
		expect(parsed).not.toHaveProperty("scope");
		expect(parsed).not.toHaveProperty("targets");
	});
});
