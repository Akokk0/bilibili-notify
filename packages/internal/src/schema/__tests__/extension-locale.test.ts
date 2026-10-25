/**
 * 拓展译文文件的逐条解析（3b-43）：坏一条只丢那一条，运行时那层与清单那层各走各的。
 *
 * 期望值照 `docs/1.0/extension-contract.md`「译文与 `ctx.i18n`」那一节写，不从实现里
 * 抄一遍：普通键与 BN 同段形，清单字段住 `$manifest` 并按清单形状嵌套。
 */

import { describe, expect, it } from "vite-plus/test";
import {
	type ExtensionLocaleFile,
	type ExtensionManifest,
	parseExtensionLocaleFile,
	parseExtensionManifest,
} from "../../index";

function manifestOf(raw: Record<string, unknown>): ExtensionManifest {
	const read = parseExtensionManifest(raw);
	if (!read.ok) {
		throw new Error(`测试用的清单本身读不了：${JSON.stringify(read)}`);
	}
	return read.manifest;
}

const MANIFEST = manifestOf({
	id: "demo-ext",
	name: "示例拓展",
	description: "盯着一件事的示例。",
	version: "1.0.0",
	apiVersion: 3,
	settings: {
		fields: [
			{ key: "token", type: "string", label: "令牌" },
			{
				key: "kind",
				type: "enum",
				label: "种类",
				options: [
					{ value: "qq.official", label: "QQ 官方" },
					{ value: "a#b", label: "A 井 B" },
					{ value: "QQ 官方", label: "QQ 官方（中文值）" },
				],
			},
			{
				key: "bots",
				type: "list",
				label: "机器人",
				fields: [
					{ key: "name", type: "string", label: "名字", required: true },
					{
						key: "mode",
						type: "enum",
						label: "方式",
						options: [{ value: "ws", label: "WebSocket" }],
					},
				],
				title: "name",
				newItemCopy: [{ host: "extensionUrl", label: "地址" }],
			},
		],
	},
	contributes: {
		push: {
			label: "推送",
			shortLabel: "推",
			color: "#fe2c55",
			settingsFields: [{ key: "apiKey", type: "string", label: "密钥" }],
		},
		subscription: {
			label: "订阅",
			shortLabel: "订",
			color: "#fe2c55",
			postNoun: "作品",
			searchAccepts: ["id", "name"],
			supportedFeatures: ["post"],
		},
	},
});

function parse(raw: unknown): ExtensionLocaleFile {
	return parseExtensionLocaleFile(raw, MANIFEST);
}

describe("运行时那层", () => {
	it("合法的键与带 #类别 的句子都收下", () => {
		const parsed = parse({
			"status.connected": "已连接",
			"bots#one": "{count} 个机器人",
			"bots#other": "{count} 个机器人",
			$manifest: { name: "示例拓展" },
		});

		expect(parsed.dict).toEqual({
			"bots#one": "{count} 个机器人",
			"bots#other": "{count} 个机器人",
			"status.connected": "已连接",
		});
		expect(parsed.issues).toEqual([]);
	});

	it("段形不对、值不是非空串、占位符写坏的那几条各丢一条并各记一条问题", () => {
		const parsed = parse({
			"status..connected": "坏",
			"status connected": "坏",
			empty: "",
			number: 42,
			broken: "你好 {user-name}",
		});

		expect(parsed.dict).toEqual({});
		expect(parsed.issues).toEqual([
			{ path: ["status..connected"], code: "invalid-key" },
			{ path: ["status connected"], code: "invalid-key" },
			{ path: ["empty"], code: "invalid-text" },
			{ path: ["number"], code: "invalid-text" },
			{ path: ["broken"], code: "malformed-placeholder" },
		]);
	});

	it("__proto__ / constructor 段丢掉，合成结果的原型没变", () => {
		const raw: Record<string, unknown> = {};
		// 与 JSON.parse 出来的一样：__proto__ 是自己的可枚举键，而不是原型。
		Object.defineProperty(raw, "__proto__", {
			value: "坏",
			enumerable: true,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(raw, "constructor", {
			value: "坏",
			enumerable: true,
			writable: true,
			configurable: true,
		});

		const parsed = parse(raw);

		expect(parsed.dict).toEqual({});
		expect(Object.hasOwn(parsed.dict, "__proto__")).toBe(false);
		expect(Object.hasOwn(parsed.dict, "constructor")).toBe(false);
		expect(Object.getPrototypeOf(parsed.dict)).toBe(Object.prototype);
		expect(parsed.issues).toEqual([
			{ path: ["__proto__"], code: "invalid-key" },
			{ path: ["constructor"], code: "invalid-key" },
		]);
	});
});

describe("清单那层（$manifest）", () => {
	it("设置项按 key、选项按 value、列表项按 key / value / host 展开，外观各格照盖", () => {
		const parsed = parse({
			$manifest: {
				name: "示例拓展（英）",
				description: "A demo extension.",
				settings: {
					fields: {
						token: { label: "Token", description: "Access token" },
						kind: {
							label: "Kind",
							options: {
								"qq.official": { label: "QQ official" },
								"a#b": { label: "A hash B" },
								"QQ 官方": { label: "QQ official (Chinese value)" },
							},
						},
						bots: {
							label: "Bots",
							itemLabel: "bot",
							removeWarning: "Removing it disconnects the bot.",
							fields: {
								name: { label: "Name" },
								mode: {
									label: "Mode",
									options: { ws: { label: "WebSocket" } },
								},
							},
							newItemCopy: { extensionUrl: { label: "URL" } },
						},
					},
				},
				contributes: {
					push: {
						label: "Push",
						shortLabel: "Pu",
						settingsFields: { apiKey: { label: "API key" } },
					},
					subscription: {
						label: "Subscription",
						shortLabel: "Su",
						postNoun: "post",
					},
				},
			},
		});

		expect(parsed.issues).toEqual([]);
		expect(parsed.manifest).toEqual({
			name: "示例拓展（英）",
			description: "A demo extension.",
			settings: {
				fields: {
					token: { label: "Token", description: "Access token" },
					kind: {
						label: "Kind",
						options: {
							"qq.official": { label: "QQ official" },
							"a#b": { label: "A hash B" },
							"QQ 官方": { label: "QQ official (Chinese value)" },
						},
					},
					bots: {
						label: "Bots",
						itemLabel: "bot",
						removeWarning: "Removing it disconnects the bot.",
						fields: {
							name: { label: "Name" },
							mode: {
								label: "Mode",
								options: { ws: { label: "WebSocket" } },
							},
						},
						newItemCopy: { extensionUrl: { label: "URL" } },
					},
				},
			},
			contributes: {
				push: {
					label: "Push",
					shortLabel: "Pu",
					settingsFields: { apiKey: { label: "API key" } },
				},
				subscription: {
					label: "Subscription",
					shortLabel: "Su",
					postNoun: "post",
				},
			},
		});
	});

	it("指向清单里没有的 key / value、或不可译的格，丢掉并各记一条问题", () => {
		const parsed = parse({
			$manifest: {
				id: "another-id",
				icon: "<svg></svg>",
				name: "好名字",
				settings: {
					fields: {
						token: { secret: true },
						nope: { label: "没有这一项" },
						kind: { options: { nope: { label: "没有这个值" } } },
					},
				},
				contributes: {
					push: { color: "#000000" },
					subscription: { color: "#000000", searchAccepts: ["id"] },
				},
				extra: "没有这个键",
			},
		});

		expect(parsed.manifest).toEqual({ name: "好名字" });
		expect(parsed.issues).toEqual([
			{ path: ["$manifest", "id"], code: "untranslatable-entry" },
			{ path: ["$manifest", "icon"], code: "untranslatable-entry" },
			{
				path: ["$manifest", "settings", "fields", "token", "secret"],
				code: "untranslatable-entry",
			},
			{ path: ["$manifest", "settings", "fields", "nope"], code: "unknown-entry" },
			{
				path: ["$manifest", "settings", "fields", "kind", "options", "nope"],
				code: "unknown-entry",
			},
			{
				path: ["$manifest", "contributes", "push", "color"],
				code: "untranslatable-entry",
			},
			{
				path: ["$manifest", "contributes", "subscription", "color"],
				code: "untranslatable-entry",
			},
			{
				path: ["$manifest", "contributes", "subscription", "searchAccepts"],
				code: "untranslatable-entry",
			},
			{ path: ["$manifest", "extra"], code: "unknown-entry" },
		]);
	});

	it("订阅源外部 id 的叫法也住 $manifest，能单独翻译", () => {
		const parsed = parse({
			$manifest: {
				contributes: {
					subscription: { externalIdNoun: "account" },
				},
			},
		});
		expect(parsed.issues).toEqual([]);
		expect(parsed.manifest).toEqual({
			contributes: {
				subscription: { externalIdNoun: "account" },
			},
		});
	});

	it("旧的第 2 版嵌套 display 不再收，记 unknown-entry", () => {
		const parsed = parse({
			$manifest: {
				contributes: {
					subscription: { display: { label: "旧形状" } },
				},
			},
		});
		expect(parsed.manifest).toEqual({});
		expect(parsed.issues).toEqual([
			{
				path: ["$manifest", "contributes", "subscription", "display"],
				code: "unknown-entry",
			},
		]);
	});

	it("超过清单那一格自己的长度上限的丢掉并记一条问题，别的照盖", () => {
		const parsed = parse({
			$manifest: {
				name: "好名字",
				contributes: {
					push: { label: "推送", shortLabel: "九个字九个字九个字" },
				},
			},
		});

		expect(parsed.issues).toEqual([
			{
				path: ["$manifest", "contributes", "push", "shortLabel"],
				code: "too-long",
			},
		]);
		expect(parsed.manifest).toEqual({
			name: "好名字",
			contributes: { push: { label: "推送" } },
		});
	});

	it("$manifest 不是对象时整层丢掉并记一条问题，运行时那层照收", () => {
		const parsed = parse({ ok: "好", $manifest: "不是对象" });

		expect(parsed.dict).toEqual({ ok: "好" });
		expect(parsed.manifest).toEqual({});
		expect(parsed.issues).toEqual([{ path: ["$manifest"], code: "invalid-text" }]);
	});
});
