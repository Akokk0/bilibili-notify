/**
 * 接入名单那张表从规则导出(规则只写一份):源码清单里不写设置项,构建照入口导出的 `settingsSchema` 写进
 * 包里的 `dist/extension.json`。入口忘了导出,清单里就没有这张表 —— 宿主照样装得上(名单有默认值),
 * 面板上却建不了接入,所以这里钉住包里那份(门禁先构建再跑测试)。
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { BridgeConnectionSettingsSchema } from "../config.js";
import * as entry from "../index.js";
import { BridgeSettingsSchema } from "../settings.js";

interface ManifestField {
	key: string;
	type: string;
	required?: boolean;
	default?: unknown;
	fields?: ManifestField[];
	options?: { value: string; label: string }[];
}

async function builtManifest(): Promise<{
	settings?: { fields: ManifestField[] };
	contributes: { push: { settingsFields?: unknown } };
}> {
	return JSON.parse(await readFile(new URL("../../dist/extension.json", import.meta.url), "utf8"));
}

describe("设置项从规则导出", () => {
	it("入口交给构建的就是 activate 用的那两份规则", () => {
		expect(entry.settingsSchema).toBe(BridgeSettingsSchema);
		expect(entry.connectionSettingsSchema).toBe(BridgeConnectionSettingsSchema);
	});

	it("包里的清单带着接入名单那张表:四栏按规则的键排,BN 生成的 id 不出栏", async () => {
		const [links] = (await builtManifest()).settings?.fields ?? [];
		expect(links).toMatchObject({ key: "links", type: "list" });
		expect(links?.fields?.map((f) => [f.key, f.type, f.required ?? f.default])).toEqual([
			["bridgeKind", "enum", true],
			["name", "string", true],
			["token", "string", ""],
			["enabled", "boolean", true],
		]);
		expect(links?.fields?.[0]?.options?.map((o) => [o.value, o.label])).toEqual([
			["koishi", "koishi"],
			["astrbot", "AstrBot"],
		]);
	});

	it("连接没有一栏是人填的(从 bot 里挑),包里的清单也就不写连接配置项", async () => {
		expect((await builtManifest()).contributes.push.settingsFields).toBeUndefined();
	});
});

// This checks the files shipped in the package, including counts and interpolation data.
describe("随包交付的四语译文", () => {
	it("每种语言有完整的键与占位符，数量分支符合语言且清单结构完整", async () => {
		const catalogs = await Promise.all(
			["zh-CN", "en", "ja", "zh-TW"].map(
				async (locale) =>
					JSON.parse(
						await readFile(new URL(`../../dist/locales/${locale}.json`, import.meta.url), "utf8"),
					) as Record<string, unknown>,
			),
		);
		function shape(value: unknown, locale: string): unknown {
			if (typeof value === "string") {
				expect(value.length).toBeGreaterThan(0);
				return [...value.matchAll(/\{(\w+)\}/g)].map((one) => one[1]).sort();
			}
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("Invalid catalog entry");
			const result: Record<string, unknown> = {};
			for (const [key, text] of Object.entries(value)) {
				const [stem, category] = key.split("#");
				if (!stem) throw new Error("Empty text key");
				if (category)
					expect(new Intl.PluralRules(locale).resolvedOptions().pluralCategories).toContain(
						category,
					);
				const entry = shape(text, locale);
				if (Object.hasOwn(result, stem)) expect(entry).toEqual(result[stem]);
				result[stem] = entry;
			}
			return result;
		}
		for (const [i, locale] of ["zh-CN", "en", "ja", "zh-TW"].entries())
			expect(shape(catalogs[i], locale)).toEqual(shape(catalogs[0], "zh-CN"));

		expect(catalogs[1]?.["view.onlineSuffix#one"]).toBe(" bot online");
		expect(catalogs[1]?.["view.onlineSuffix#other"]).toBe(" bots online");
	});
});
