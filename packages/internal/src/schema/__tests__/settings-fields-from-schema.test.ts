import { bindPackageText } from "../../texts";
import { OnebotConnectionSettingsSchema, WebhookConnectionSettingsSchema } from "../targets";
/**
 * 规则只写一份(construction-plan「读设置的写法简化」,第 4 期):清单里的设置项由规则导出 ——
 * 类型、默认值、必填、上下限、枚举的取值读规则本身,给人看的那几格读 `.meta()`。
 *
 * 期望值一律手写成今天清单里的样子,不照着实现再算一遍。
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { assertConfigFieldsMatchSchema } from "../config-fields";
import { settingsFieldsFromSchema } from "../settings-fields-from-schema";

describe("单值的几种", () => {
	it("类型、默认值、必填、上下限从规则读,标签与提示从 meta 读;顺序照规则的键", () => {
		const schema = z.object({
			name: z.string().min(1).meta({ label: "名字", placeholder: "比如「家里那台」" }),
			token: z
				.string()
				.meta({
					label: "token",
					secret: true,
					generate: true,
					monospace: true,
					description: "只看一次",
				})
				.default(""),
			interval: z
				.number()
				.int()
				.min(5)
				.max(180)
				.default(30)
				.meta({ label: "间隔", unit: "秒", step: 5 }),
			enabled: z.boolean().default(true).meta({ label: "启用" }),
			note: z.string().optional().meta({ label: "备注", multiline: true }),
		});
		expect(settingsFieldsFromSchema(schema)).toEqual([
			{
				key: "name",
				type: "string",
				label: "名字",
				required: true,
				placeholder: "比如「家里那台」",
			},
			{
				key: "token",
				type: "string",
				label: "token",
				description: "只看一次",
				default: "",
				secret: true,
				generate: true,
				monospace: true,
			},
			{
				key: "interval",
				type: "number",
				label: "间隔",
				default: 30,
				min: 5,
				max: 180,
				step: 5,
				unit: "秒",
			},
			{ key: "enabled", type: "boolean", label: "启用", default: true },
			{ key: "note", type: "string", label: "备注", multiline: true },
		]);
	});
});

describe("枚举", () => {
	const KINDS = {
		koishi: { label: "koishi", icon: "data:image/png;base64,AAAA" },
		astrbot: { label: "AstrBot" },
	};

	it("取值与顺序读规则,每个选项的标签 / 图标读 meta 的 options;z.enum 与字面量的 union 一样", () => {
		const expected = [
			{
				key: "kind",
				type: "enum",
				label: "哪一种",
				required: true,
				options: [
					{ value: "koishi", label: "koishi", icon: "data:image/png;base64,AAAA" },
					{ value: "astrbot", label: "AstrBot" },
				],
			},
		];
		const viaEnum = z.object({
			kind: z.enum(["koishi", "astrbot"]).meta({ label: "哪一种", options: KINDS }),
		});
		const viaUnion = z.object({
			kind: z
				.union([z.literal("koishi"), z.literal("astrbot")])
				.meta({ label: "哪一种", options: KINDS }),
		});
		expect(settingsFieldsFromSchema(viaEnum)).toEqual(expected);
		expect(settingsFieldsFromSchema(viaUnion)).toEqual(expected);
	});

	it("默认值照样读出来", () => {
		const schema = z.object({
			kind: z
				.enum(["koishi", "astrbot"])
				.default("astrbot")
				.meta({ label: "哪一种", options: KINDS }),
		});
		expect(settingsFieldsFromSchema(schema)[0]).toMatchObject({ default: "astrbot" });
		expect(settingsFieldsFromSchema(schema)[0]).not.toHaveProperty("required");
	});

	it("规则里有、meta 里没写标签的取值,点名抛;meta 多写了规则里没有的取值也抛", () => {
		const missing = z.object({
			kind: z.enum(["koishi", "astrbot", "nonebot"]).meta({ label: "哪一种", options: KINDS }),
		});
		expect(() => settingsFieldsFromSchema(missing)).toThrow(/"kind".*nonebot/);
		const extra = z.object({ kind: z.enum(["koishi"]).meta({ label: "哪一种", options: KINDS }) });
		expect(() => settingsFieldsFromSchema(extra)).toThrow(/"kind".*astrbot/);
		const none = z.object({ kind: z.enum(["koishi"]).meta({ label: "哪一种" }) });
		expect(() => settingsFieldsFromSchema(none)).toThrow(/"kind".*koishi/);
	});

	it("取值里混了不是字符串的,抛:面板存的永远是字符串", () => {
		const schema = z.object({
			level: z.literal([1, 2]).meta({ label: "档", options: { 1: { label: "一" } } }),
		});
		expect(() => settingsFieldsFromSchema(schema)).toThrow(/"level"/);
	});
});

describe("列表", () => {
	const Link = z.object({
		id: z.string().min(1),
		name: z.string().min(1).meta({ label: "名字" }),
		token: z.string().default("").meta({ label: "token", secret: true }),
		enabled: z.boolean().default(true).meta({ label: "启用" }),
	});
	const schema = z.object({
		links: z
			.array(Link)
			.default([])
			.meta({
				label: "桥接入",
				itemLabel: "接入",
				title: "name",
				toggle: "enabled",
				description: "建一条",
				newItemCopy: [{ host: "extensionUrl", label: "BN 地址" }, { field: "token" }],
				removeWarning: "那一头会连不上",
			}),
	});

	it("项里写了 label 的出栏(BN 生成的 id 不出),列表那几格读 meta;列表自己的默认值不出", () => {
		expect(settingsFieldsFromSchema(schema)).toEqual([
			{
				key: "links",
				type: "list",
				label: "桥接入",
				description: "建一条",
				itemLabel: "接入",
				title: "name",
				toggle: "enabled",
				newItemCopy: [{ host: "extensionUrl", label: "BN 地址" }, { field: "token" }],
				removeWarning: "那一头会连不上",
				fields: [
					{ key: "name", type: "string", label: "名字", required: true },
					{ key: "token", type: "string", label: "token", default: "", secret: true },
					{ key: "enabled", type: "boolean", label: "启用", default: true },
				],
			},
		]);
	});

	it("导出来的设置项与规则恒对得上:加载时的对表一格不拦", () => {
		expect(() =>
			assertConfigFieldsMatchSchema("e", schema, settingsFieldsFromSchema(schema)),
		).not.toThrow();
	});

	it("项不是对象、项里再套列表、第一层套对象,都点名抛", () => {
		const scalarItems = z.object({ tags: z.array(z.string()).meta({ label: "标签" }) });
		expect(() => settingsFieldsFromSchema(scalarItems)).toThrow(/"tags"/);
		const nested = z.object({
			links: z
				.array(
					z.object({
						id: z.string(),
						hops: z.array(z.object({ id: z.string() })).meta({ label: "跳" }),
					}),
				)
				.meta({ label: "接入", title: "id" }),
		});
		expect(() => settingsFieldsFromSchema(nested)).toThrow(/"links\.hops"/);
		const object = z.object({ proxy: z.object({ url: z.string() }).meta({ label: "代理" }) });
		expect(() => settingsFieldsFromSchema(object)).toThrow(/"proxy"/);
	});
});

describe("表达不了的写法", () => {
	it("不含端点的上下限(.gt() / .positive()):设置项的 min / max 只能含端点", () => {
		const schema = z.object({ port: z.number().positive().meta({ label: "端口" }) });
		expect(() => settingsFieldsFromSchema(schema)).toThrow(/"port".*\.min\(\)/);
	});

	it("meta 里写了这一种用不上的格(开关上写占位字),点名抛:写了却不生效,比报错更难查", () => {
		const schema = z.object({ on: z.boolean().meta({ label: "开", placeholder: "x" }) });
		expect(() => settingsFieldsFromSchema(schema)).toThrow(/"on".*placeholder/);
	});

	it("别家的 meta(备份脱敏的 backupOnly / url、zod 自己的 id)不算错", () => {
		const schema = z.object({
			url: z.string().meta({ label: "地址", backupOnly: true, url: true, id: "proxy-url" }),
		});
		expect(settingsFieldsFromSchema(schema)).toEqual([
			{ key: "url", type: "string", label: "地址", required: true },
		]);
	});

	it("第一层不是对象,抛", () => {
		expect(() => settingsFieldsFromSchema(z.string())).toThrow(/z\.object/);
	});

	it("没写 label 的键不出栏:连接里由拓展交的那几格就是这样", () => {
		const schema = z.object({ link: z.string().min(1), botId: z.string().min(1) });
		expect(settingsFieldsFromSchema(schema)).toEqual([]);
	});
});

describe("内置连接表单", () => {
	it("已建好的内置规则在读取描述时才翻译,字段、枚举与平台提示均随语言变化", () => {
		const binding = bindPackageText((key) => `译:${key}`);
		try {
			const fields = settingsFieldsFromSchema(OnebotConnectionSettingsSchema, { connection: true });
			expect(fields[0]?.label).toBe("译:internal.connection.transport.label");
			expect(fields.find((field) => field.key === "accessToken")?.label).toBe(
				"译:internal.connection.token.label",
			);
			const hook = settingsFieldsFromSchema(WebhookConnectionSettingsSchema, { connection: true });
			expect(hook.find((field) => field.key === "secret")?.byPlatform?.feishu?.description).toBe(
				"译:internal.connection.hookSecret.feishu",
			);
		} finally {
			binding.dispose();
		}
	});
	it("区分分支的规则导出条件字段与切换草稿,共同键才保留,必填初值不放宽校验", () => {
		const common = {
			token: z.string().optional().meta({ label: "令牌", secret: true }),
			retries: z.number().min(0).default(0).meta({ label: "重试", preserveTruthy: true }),
		};
		const schema = z
			.discriminatedUnion("mode", [
				z
					.object({
						mode: z.literal("out"),
						url: z.string().min(1).meta({ label: "地址" }),
						...common,
					})
					.meta({ initial: { url: "https://example.test" } }),
				z
					.object({
						mode: z.literal("in"),
						port: z
							.number()
							.min(1)
							.max(65535)
							.meta({ label: "端口", listener: { scheme: "ws" } }),
						...common,
					})
					.meta({ initial: { port: 9000, retries: 3 } }),
			])
			.meta({ label: "方式", options: { out: { label: "连出" }, in: { label: "连入" } } });
		const fields = settingsFieldsFromSchema(schema, { connection: true });
		expect(fields[0]).toMatchObject({
			key: "mode",
			type: "enum",
			options: [
				{ value: "out", label: "连出" },
				{ value: "in", label: "连入" },
			],
			variants: {
				in: {
					settings: { mode: "in", port: 9000, retries: 3 },
					preserve: [{ key: "token" }, { key: "retries", truthy: true }],
				},
			},
		});
		expect(fields.find((field) => field.key === "port")).toMatchObject({
			when: { key: "mode", value: "in" },
			required: true,
			min: 1,
			max: 65535,
			listener: { scheme: "ws" },
		});
		expect(schema.safeParse({ mode: "in" }).success).toBe(false);
	});

	it("键值表保留规则的默认值,普通清单导出仍拒绝这类字段", () => {
		const schema = z.object({
			headers: z.record(z.string(), z.string()).default({}).meta({ label: "请求头" }),
		});
		expect(settingsFieldsFromSchema(schema, { connection: true })).toEqual([
			{ key: "headers", type: "record", label: "请求头", default: {} },
		]);
		expect(() => settingsFieldsFromSchema(schema)).toThrow();
	});
});
