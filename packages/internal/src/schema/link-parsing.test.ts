/**
 * `linkParsing` —— 群里贴 B 站视频链接自动出卡片的开关与节流。
 *
 * 守两条:① 老 globals.json 没有这一段照样能读(独立端启动 parse 失败是直接挂掉);
 * ② **默认关**。开着就意味着同群任何人都能让机器人出图,这得是主人自己按下去的。
 */

import { describe, expect, it } from "vite-plus/test";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";
import { DEFAULT_LINK_PARSING, LinkParsingConfigSchema } from "./link-parsing";

describe("linkParsing 配置段", () => {
	it("老 globals.json 没有 linkParsing → 解析成功并补成默认:关、冷却 60 秒", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.linkParsing;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.linkParsing).toEqual({ enabled: false, cooldownSeconds: 60 });
	});

	it("全新安装默认关", () => {
		expect(makeDefaultGlobalConfig().linkParsing.enabled).toBe(false);
		expect(DEFAULT_LINK_PARSING.enabled).toBe(false);
	});

	it("只给 enabled 也行,冷却补默认", () => {
		expect(LinkParsingConfigSchema.parse({ enabled: true })).toEqual({
			enabled: true,
			cooldownSeconds: 60,
		});
	});

	it("冷却秒数是 0–3600 的整数,越界与小数都拒", () => {
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 0 }).success).toBe(true);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 3600 }).success).toBe(true);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 3601 }).success).toBe(false);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: -1 }).success).toBe(false);
		expect(LinkParsingConfigSchema.safeParse({ cooldownSeconds: 1.5 }).success).toBe(false);
	});
});
