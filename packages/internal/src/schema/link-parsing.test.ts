/**
 * `linkParsing` —— 群里贴 B 站视频链接自动出卡片的开关、节流,与「默认行 + 逐群例外」。
 *
 * 守四条:① 老 globals.json 没有这一段照样能读(独立端启动 parse 失败是直接挂掉);
 * ② **默认关**。开着就意味着同群任何人都能让机器人出图,这得是主人自己按下去的;
 * ③ 0.9.1 的「范围 + 白名单」读时按形迁移成默认行 + 例外,行为一字不变;
 * ④ 折叠:逐群例外缺省继承默认行,写了哪个字段只覆盖哪个字段。
 */

import { describe, expect, it } from "vite-plus/test";
import { LINK_REPLY_FORMS } from "../constants";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";
import { DEFAULT_LINK_PARSING, LinkParsingConfigSchema, linkParsingFor } from "./link-parsing";

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
		expect(DEFAULT_LINK_PARSING).toEqual(FRESH);
		expect(LINK_REPLY_FORMS).toEqual(["image", "miniapp"]);
	});

	it("只给 enabled 也行,其余补默认", () => {
		expect(LinkParsingConfigSchema.parse({ enabled: true })).toEqual({ ...FRESH, enabled: true });
	});

	// 白名单进来之前发出去的版本只有 enabled / cooldownSeconds。升上来的实例必须落在
	// 「所有群都解析」—— 行为一字不变,主人开过的功能不能因为升级悄悄缩到零个群。
	it("白名单之前的版本(只有 enabled / cooldownSeconds)→ 所有群解析", () => {
		expect(LinkParsingConfigSchema.parse({ enabled: true, cooldownSeconds: 30 })).toEqual({
			...FRESH,
			enabled: true,
			cooldownSeconds: 30,
		});
	});
});

/**
 * 0.9.1 存的是 `scope: all | selected` + `targets: [{ targetId }]`。现在没有「范围」这个
 * 概念了:所有群 = 默认行解析开;仅以下群 = 默认行解析关 + 列出的群显式开。读的时候
 * 按形状认出来迁,盘上那份不动。
 */
describe("0.9.1 的范围 + 白名单按形迁移", () => {
	it("scope=all → 默认行解析开、没有例外;all 下的 targets 本来就不起作用,不带过来", () => {
		expect(
			LinkParsingConfigSchema.parse({
				enabled: true,
				cooldownSeconds: 30,
				scope: "all",
				targets: [{ targetId: A }],
			}),
		).toEqual({ ...FRESH, enabled: true, cooldownSeconds: 30 });
	});

	it("scope=selected + 两个群(其中一个写了两遍)→ 默认行解析关、两群显式开", () => {
		expect(
			LinkParsingConfigSchema.parse({
				enabled: true,
				scope: "selected",
				targets: [{ targetId: A }, { targetId: B }, { targetId: A }],
			}),
		).toEqual({
			...FRESH,
			enabled: true,
			defaults: { parse: false, form: "image" },
			groups: { [A]: { parse: true }, [B]: { parse: true } },
		});
	});

	it("scope=selected 且列表为空 → 默认关、没有例外 = 一个群都不解析", () => {
		expect(LinkParsingConfigSchema.parse({ scope: "selected", targets: [] })).toEqual({
			...FRESH,
			defaults: { parse: false, form: "image" },
		});
	});

	it("新旧键同时出现(补丁合并进老数据)→ 认新的,老键丢掉", () => {
		expect(
			LinkParsingConfigSchema.parse({
				scope: "selected",
				targets: [{ targetId: A }],
				defaults: { parse: true, form: "miniapp" },
				groups: { [B]: { form: "image" } },
			}),
		).toEqual({
			...FRESH,
			defaults: { parse: true, form: "miniapp" },
			groups: { [B]: { form: "image" } },
		});
	});
});

describe("新形状", () => {
	it("例外只存显式值:空对象条目被剥掉,写了的原样留", () => {
		expect(
			LinkParsingConfigSchema.parse({
				groups: { [A]: {}, [B]: { parse: false, form: "miniapp" } },
			}).groups,
		).toEqual({ [B]: { parse: false, form: "miniapp" } });
	});

	it("targetId 不是 uuid、形式不在两档之内 → 拒", () => {
		expect(
			LinkParsingConfigSchema.safeParse({ groups: { "group-123": { parse: true } } }).success,
		).toBe(false);
		expect(LinkParsingConfigSchema.safeParse({ defaults: { form: "both" } }).success).toBe(false);
		expect(LinkParsingConfigSchema.safeParse({ groups: { [A]: { form: "text" } } }).success).toBe(
			false,
		);
	});

	it("冷却秒数是 0–3600 的整数,越界与小数都拒", () => {
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 0 }).success).toBe(true);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 3600 }).success).toBe(true);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 3601 }).success).toBe(false);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: -1 }).success).toBe(false);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 1.5 }).success).toBe(false);
	});
});

describe("linkParsingFor —— 折叠出这个群解不解析、回什么", () => {
	const cfg = LinkParsingConfigSchema.parse({
		defaults: { parse: true, form: "image" },
		groups: { [A]: { form: "miniapp" }, [B]: { parse: false } },
	});

	it("没写例外的群跟默认行;不是推送目标的群(没有 id)也跟默认行", () => {
		expect(linkParsingFor(cfg, "33333333-3333-4333-8333-333333333333")).toEqual({
			parse: true,
			form: "image",
		});
		expect(linkParsingFor(cfg, undefined)).toEqual({ parse: true, form: "image" });
	});

	it("例外逐字段覆盖:只写 form 的群 parse 仍跟默认,只写 parse 的群 form 仍跟默认", () => {
		expect(linkParsingFor(cfg, A)).toEqual({ parse: true, form: "miniapp" });
		expect(linkParsingFor(cfg, B)).toEqual({ parse: false, form: "image" });
	});

	it("默认关、群显式开 = 原来的白名单", () => {
		const wl = LinkParsingConfigSchema.parse({
			defaults: { parse: false },
			groups: { [A]: { parse: true } },
		});
		expect(linkParsingFor(wl, A).parse).toBe(true);
		expect(linkParsingFor(wl, B).parse).toBe(false);
	});
});
