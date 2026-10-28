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
