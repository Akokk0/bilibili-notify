/**
 * 拓展连接的表单:拓展交上来的**字段表**(ADR-0012 决策 33)→ 推送目标页画得出来的那几栏。
 *
 * 此前拓展连接只能在拓展页建(主人 2026-09-10:「我希望的是我自己去新建里添加出来」)。
 * 这里钉两件事:字段表怎么翻成表单、以及**新建时的默认值**从哪来 —— 尤其是 token 那种
 * 「只要两边一样、不需要人记住」的密钥,得预填一把随机的,不能让主人自己编。
 */

import type { ExtensionConfigField } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { extensionConnectionFields } from "../connection-fields";
import { type ExtensionConnection, makeEmptyExtensionConnection } from "../domain";

const FIELDS: readonly ExtensionConfigField[] = [
	{
		kind: "select",
		code: "bridgeKind",
		label: "桥的种类",
		required: true,
		options: [
			{ value: "koishi", label: "Koishi" },
			{ value: "astrbot", label: "AstrBot" },
		],
	},
	{ kind: "text", code: "token", label: "接入 token", required: true, secret: true, generate: 16 },
	{ kind: "number", code: "retries", label: "重试", min: 0 },
	{ kind: "toggle", code: "loud", label: "吵" },
];

describe("makeEmptyExtensionConnection", () => {
	it("挂在那个拓展名下,默认值照字段表:选第一档、生成的 token 现生成、数字取下限、开关关着", () => {
		const c = makeEmptyExtensionConnection("bridge", FIELDS, "家里那台");
		expect(c).toMatchObject({
			kind: "extension",
			extensionId: "bridge",
			name: "家里那台",
			enabled: true,
		});
		const config = c.config as Record<string, unknown>;
		expect(config.bridgeKind).toBe("koishi");
		expect(config.token).toMatch(/^[0-9a-f]{32}$/);
		expect(config.retries).toBe(0);
		expect(config.loud).toBe(false);
	});

	it("两次生成的 token 不一样 —— 不是一个写死的样例", () => {
		const a = makeEmptyExtensionConnection("bridge", FIELDS, "") as { config: { token: string } };
		const b = makeEmptyExtensionConnection("bridge", FIELDS, "") as { config: { token: string } };
		expect(a.config.token).not.toBe(b.config.token);
	});
});

describe("extensionConnectionFields", () => {
	const connection = makeEmptyExtensionConnection(
		"bridge",
		FIELDS,
		"家里那台",
	) as ExtensionConnection;

	it("字段表一栏翻一栏,身份带着拓展 id —— 与内置平台的字段不撞", () => {
		const fields = extensionConnectionFields(connection, FIELDS);
		expect(fields.map((f) => ("code" in f ? f.code : f.kind))).toEqual([
			"ext.bridge.bridgeKind",
			"ext.bridge.token",
			"ext.bridge.retries",
			"ext.bridge.loud",
		]);
	});

	it("改一栏只落自己那一格,别的格原样", () => {
		const [kind] = extensionConnectionFields(connection, FIELDS);
		if (kind?.kind !== "select") throw new Error("第一栏该是 select");
		const next = kind.set("astrbot") as ExtensionConnection;
		const config = next.config as Record<string, unknown>;
		expect(config.bridgeKind).toBe("astrbot");
		expect(config.token).toBe((connection.config as Record<string, unknown>).token);
	});

	it("标了 generate 的那栏能重新生成一把,旧的那把就不在了", () => {
		const [, token] = extensionConnectionFields(connection, FIELDS);
		if (token?.kind !== "text") throw new Error("第二栏该是 text");
		expect(token.regenerate).toBeTypeOf("function");
		const next = token.regenerate?.() as ExtensionConnection;
		const fresh = (next.config as Record<string, unknown>).token as string;
		expect(fresh).toMatch(/^[0-9a-f]{32}$/);
		expect(fresh).not.toBe(token.value);
	});

	it("没标 generate 的文本栏没有那颗钮", () => {
		const fields = extensionConnectionFields(connection, [
			{ kind: "text", code: "url", label: "地址" },
		]);
		expect(fields[0]?.kind === "text" && fields[0].regenerate).toBeUndefined();
	});
});
