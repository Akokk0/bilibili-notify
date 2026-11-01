/**
 * 拓展的译文(ADR-0037 决策 14):读 `locales/`、按回落链合成、盖清单里给人看的字。
 *
 * 钉的几条:
 * - 只读语言表里的 `<语言码>.json`;不是 JSON 的整份丢、超单份上限的丢,各记一条问题
 * - 回落链固定「本语言 → 简中 → 英文 → 清单原字」:运行时那层走到链尾仍没有就回键本身
 * - 本语言缺某一句,只那一句走链,别的仍是本语言
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionManifest } from "@bilibili-notify/internal";
import { translate } from "@bilibili-notify/internal/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	EXTENSION_LOCALE_FILE_MAX_BYTES,
	localizeManifest,
	readExtensionLocales,
	runtimeDictOf,
} from "../locales.js";

let dir: string;

const MANIFEST: ExtensionManifest = {
	id: "demo",
	name: "原名",
	description: "原说明",
	version: "1.0.0",
	apiVersion: 1,
	settings: {
		fields: [
			{ key: "token", type: "string", label: "原令牌", description: "原令牌说明" },
			{
				key: "kind",
				type: "enum",
				label: "原类型",
				options: [
					{ value: "qq.official", label: "原 QQ" },
					{ value: "plain", label: "原平实" },
				],
			},
		],
	},
	contributes: {
		push: { label: "原推送", shortLabel: "原", color: "#000000" },
	},
};

/** 往 `<dir>/locales/` 里摆一份(对象会序列化,字符串原样写)。 */
async function put(name: string, content: unknown): Promise<void> {
	await mkdir(join(dir, "locales"), { recursive: true });
	await writeFile(
		join(dir, "locales", name),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-ext-locales-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("读 locales/", () => {
	it("没有 locales 目录 → 空,没有问题", async () => {
		const read = await readExtensionLocales(dir, MANIFEST);
		expect(read).toEqual({ files: {}, issues: [] });
	});

	it("只读语言表里的 <语言码>.json:别的名字不读、不记问题", async () => {
		await put("zh-CN.json", { "a.b": "简" });
		await put("ko.json", { "a.b": "한" });
		await put("notes.txt", "随手写的");
		const read = await readExtensionLocales(dir, MANIFEST);
		expect(Object.keys(read.files)).toEqual(["zh-CN"]);
		expect(read.files["zh-CN"]?.dict).toEqual({ "a.b": "简" });
		expect(read.issues).toEqual([]);
	});

	it("不是 JSON → 这一份整份丢,记一条;别的语言照读", async () => {
		await put("zh-CN.json", "{ 坏的");
		await put("en.json", { "a.b": "en" });
		const read = await readExtensionLocales(dir, MANIFEST);
		expect(Object.keys(read.files)).toEqual(["en"]);
		expect(read.issues).toEqual([{ locale: "zh-CN", code: "invalid-json", path: [] }]);
	});

	it("超单份上限 → 这一份丢,记一条", async () => {
		const filler = "x".repeat(EXTENSION_LOCALE_FILE_MAX_BYTES);
		await put("zh-CN.json", { "a.b": filler });
		await put("en.json", { "a.b": "en" });
		const read = await readExtensionLocales(dir, MANIFEST);
		expect(Object.keys(read.files)).toEqual(["en"]);
		expect(read.issues).toEqual([{ locale: "zh-CN", code: "too-large", path: [] }]);
	});

	it("译文里坏的条目:逐条丢,问题带上语言码", async () => {
		await put("en.json", { "a.b": "ok", "bad key": "x", "c.d": "" });
		const read = await readExtensionLocales(dir, MANIFEST);
		expect(read.files.en?.dict).toEqual({ "a.b": "ok" });
		expect(read.issues).toEqual([
			{ locale: "en", code: "invalid-key", path: ["bad key"] },
			{ locale: "en", code: "invalid-text", path: ["c.d"] },
		]);
	});
});

describe("回落链:本语言 → 简中 → 英文 → 清单原字", () => {
	async function load(files: Record<string, unknown>) {
		for (const [name, content] of Object.entries(files)) await put(`${name}.json`, content);
		return readExtensionLocales(dir, MANIFEST);
	}

	it("只带 zh-CN.json、当前 zh-TW → 运行时与清单名字都出简中", async () => {
		const locales = await load({
			"zh-CN": { "status.ok": "已连接", $manifest: { name: "简中名" } },
		});
		expect(translate(runtimeDictOf(locales, "zh-TW"), "zh-TW", "status.ok")).toBe("已连接");
		expect(localizeManifest(MANIFEST, locales, "zh-TW").name).toBe("简中名");
	});

	it("只带 en.json(第三方英文作者)、当前 zh-CN → 出英文", async () => {
		const locales = await load({
			en: { "status.ok": "Connected", $manifest: { name: "English name" } },
		});
		expect(translate(runtimeDictOf(locales, "zh-CN"), "zh-CN", "status.ok")).toBe("Connected");
		expect(translate(runtimeDictOf(locales, "ja"), "ja", "status.ok")).toBe("Connected");
		expect(localizeManifest(MANIFEST, locales, "zh-CN").name).toBe("English name");
	});

	it("什么都没带 → t 回键本身,清单出原字", async () => {
		const locales = await load({});
		expect(translate(runtimeDictOf(locales, "en"), "en", "status.ok")).toBe("status.ok");
		const localized = localizeManifest(MANIFEST, locales, "en");
		expect(localized.name).toBe("原名");
		expect(localized.settings?.fields[0]?.label).toBe("原令牌");
	});

	it("本语言缺某一句 → 只那一句走链,别的仍是本语言", async () => {
		const locales = await load({
			"zh-CN": { "a.one": "简一", "a.two": "简二" },
			en: { "a.one": "en one" },
		});
		const dict = runtimeDictOf(locales, "en");
		expect(translate(dict, "en", "a.one")).toBe("en one");
		// en 缺 a.two → 落简中,而不是回键本身
		expect(translate(dict, "en", "a.two")).toBe("简二");
	});

	it("单复数:键#类别 按当前语言挑", async () => {
		const locales = await load({
			en: { "n.items#one": "{count} item", "n.items#other": "{count} items" },
		});
		const dict = runtimeDictOf(locales, "en");
		expect(translate(dict, "en", "n.items", { count: 1 })).toBe("1 item");
		expect(translate(dict, "en", "n.items", { count: 3 })).toBe("3 items");
	});
});

describe("盖清单", () => {
	it("设置项按 key、选项按 value 盖(含带点的 value),没译到的留原字", async () => {
		await put("en.json", {
			$manifest: {
				name: "Demo",
				description: "Demo description",
				settings: {
					fields: {
						token: { label: "Token" },
						kind: { label: "Kind", options: { "qq.official": { label: "QQ official" } } },
					},
				},
				contributes: { push: { shortLabel: "D" } },
			},
		});
		const locales = await readExtensionLocales(dir, MANIFEST);
		const out = localizeManifest(MANIFEST, locales, "en");
		expect(out.name).toBe("Demo");
		expect(out.description).toBe("Demo description");
		const [token, kind] = out.settings?.fields ?? [];
		expect(token?.label).toBe("Token");
		// description 没译到 → 原字
		expect(token && "description" in token ? token.description : undefined).toBe("原令牌说明");
		expect(kind?.label).toBe("Kind");
		expect(kind?.type === "enum" ? kind.options.map((o) => o.label) : []).toEqual([
			"QQ official",
			"原平实",
		]);
		expect(out.contributes.push?.shortLabel).toBe("D");
		// 不可译的格不动
		expect(out.contributes.push?.color).toBe("#000000");
		// 原对象没被改
		expect(MANIFEST.name).toBe("原名");
	});

	it("对不上清单的条目:丢掉并记问题,不影响别的", async () => {
		await put("en.json", {
			$manifest: { name: "Demo", settings: { fields: { nope: { label: "x" } } } },
		});
		const locales = await readExtensionLocales(dir, MANIFEST);
		expect(localizeManifest(MANIFEST, locales, "en").name).toBe("Demo");
		expect(locales.issues).toEqual([
			{ locale: "en", code: "unknown-entry", path: ["$manifest", "settings", "fields", "nope"] },
		]);
	});

	it("订阅源的外部 id 叫法能经 $manifest 翻译", async () => {
		const manifest = {
			...MANIFEST,
			contributes: {
				...MANIFEST.contributes,
				subscription: {
					label: "订阅",
					shortLabel: "订",
					color: "#fe2c55",
					externalIdNoun: "账号",
					supportedFeatures: ["post" as const],
				},
			},
		} as ExtensionManifest;
		await put("en.json", {
			$manifest: {
				contributes: { subscription: { externalIdNoun: "account" } },
			},
		});
		const locales = await readExtensionLocales(dir, manifest);
		expect(locales.issues).toEqual([]);
		expect(localizeManifest(manifest, locales, "en").contributes.subscription?.externalIdNoun).toBe(
			"account",
		);
	});

	it("订阅源的创作者叫法能经 $manifest 翻译", async () => {
		const manifest = {
			...MANIFEST,
			contributes: {
				...MANIFEST.contributes,
				subscription: {
					label: "订阅",
					shortLabel: "订",
					color: "#fe2c55",
					creatorNoun: "博主",
					supportedFeatures: ["post" as const],
				},
			},
		} as ExtensionManifest;
		await put("en.json", {
			$manifest: {
				contributes: { subscription: { creatorNoun: "creator" } },
			},
		});
		const locales = await readExtensionLocales(dir, manifest);
		expect(locales.issues).toEqual([]);
		expect(localizeManifest(manifest, locales, "en").contributes.subscription?.creatorNoun).toBe(
			"creator",
		);
	});

	it("featureHints 逐键沿当前语言、简中、英文、清单原字回落", async () => {
		const manifest: ExtensionManifest = {
			...MANIFEST,
			contributes: {
				subscription: {
					label: "Source",
					supportedFeatures: ["post"],
					featureHints: {
						post: "Original post",
						liveStart: "Original start",
						liveEnd: "Original end",
						membership: "Original club",
					},
				},
			},
		};
		await put("en.json", {
			$manifest: {
				contributes: {
					subscription: {
						featureHints: { post: "EN post", liveStart: "EN start", liveEnd: "EN end" },
					},
				},
			},
		});
		await put("zh-CN.json", {
			$manifest: {
				contributes: { subscription: { featureHints: { post: "ZH post", liveStart: "ZH start" } } },
			},
		});
		await put("ja.json", {
			$manifest: {
				contributes: { subscription: { featureHints: { post: "JA post", liveStart: " " } } },
			},
		});
		const locales = await readExtensionLocales(dir, manifest);
		expect(
			localizeManifest(manifest, locales, "ja").contributes.subscription?.featureHints,
		).toEqual({
			post: "JA post",
			liveStart: "ZH start",
			liveEnd: "EN end",
			membership: "Original club",
		});
		expect(manifest.contributes.subscription?.featureHints?.post).toBe("Original post");
		expect(locales.issues).toEqual([
			{
				locale: "ja",
				code: "invalid-text",
				path: ["$manifest", "contributes", "subscription", "featureHints", "liveStart"],
			},
		]);
	});

	it("订阅源的搜人输入种类不可译,译文写了就丢掉并保留清单原值", async () => {
		const manifest = {
			...MANIFEST,
			contributes: {
				...MANIFEST.contributes,
				subscription: {
					label: "订阅",
					searchAccepts: ["name"],
					supportedFeatures: ["post" as const],
				},
			},
		} as ExtensionManifest;
		await put("en.json", {
			$manifest: {
				contributes: { subscription: { searchAccepts: ["id"] } },
			},
		});
		const locales = await readExtensionLocales(dir, manifest);
		expect(locales.issues).toEqual([
			{
				locale: "en",
				code: "untranslatable-entry",
				path: ["$manifest", "contributes", "subscription", "searchAccepts"],
			},
		]);
		expect(
			localizeManifest(manifest, locales, "en").contributes.subscription?.searchAccepts,
		).toEqual(["name"]);
	});
});
