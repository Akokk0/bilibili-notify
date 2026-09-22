/**
 * v1 的退路:老名字在收下那一刻翻译成新形状(ADR-0019 决策 17 的改名表)。
 *
 * 宿主里只有新形状,所以**这张表就是 v1 拓展在面板上长什么样的全部依据** —— 漏译一格,
 * 面板上那一栏就静默少一个属性(比如密钥不再遮住),而类型检查拦不住:新形状里那些格都是可选的。
 */

import type { ExtensionConfigField } from "@bilibili-notify/extension";
import { describe, expect, it } from "vite-plus/test";
import { displayFromV1, fieldFromV1 } from "../legacy-v1.js";

describe("v1 → 新形状", () => {
	it("外观:tint 改叫 color", () => {
		expect(displayFromV1({ label: "机器人框架桥接", shortLabel: "桥", tint: "#a855f7" })).toEqual({
			label: "机器人框架桥接",
			shortLabel: "桥",
			color: "#a855f7",
		});
	});

	it.each<[string, ExtensionConfigField, unknown]>([
		[
			"text → string(mono → monospace,secret 原样)",
			{
				kind: "text",
				code: "token",
				label: "Token",
				hint: "插件那头填的",
				required: true,
				placeholder: "粘贴",
				mono: true,
				secret: true,
			},
			{
				type: "string",
				key: "token",
				label: "Token",
				description: "插件那头填的",
				required: true,
				placeholder: "粘贴",
				monospace: true,
				secret: true,
			},
		],
		[
			"number(suffix → unit)",
			{ kind: "number", code: "port", label: "端口", min: 1, max: 65535, step: 1, suffix: "号" },
			{ type: "number", key: "port", label: "端口", min: 1, max: 65535, step: 1, unit: "号" },
		],
		[
			"toggle → boolean",
			{ kind: "toggle", code: "tls", label: "走 TLS" },
			{ type: "boolean", key: "tls", label: "走 TLS" },
		],
		[
			"select → enum",
			{
				kind: "select",
				code: "kind",
				label: "种类",
				options: [{ value: "koishi", label: "koishi" }],
			},
			{ type: "enum", key: "kind", label: "种类", options: [{ value: "koishi", label: "koishi" }] },
		],
	])("%s", (_label, v1, expected) => {
		// toStrictEqual:没写的格在新形状里也**没有**,而不是一格 undefined。
		expect(fieldFromV1(v1)).toStrictEqual(expected);
	});
});
