/**
 * 拓展包的构建那一步(construction-plan「读设置的写法简化」,第 4 期):**规则只写一份**,清单里的设置项由构建
 * 从规则导出,作者不写第二份。拓展经门的构建子路径 `@bilibili-notify/extension/build` 拿它,挂在自己
 * `vite.config.ts` 的打包配置上;拓展的 `src/` 不许 import 它(那会把宿主代码打进拓展包)。
 *
 * 约定:拓展入口(`index.mjs`)除 `activate` 外再导出两个名字 ——
 * - `settingsSchema`:拓展自己的设置(交给 `ctx.settings(schema)` 的那份)→ 清单的 `settings.fields`;
 * - `connectionSettingsSchema`:推送那口的连接设置(适配器的 `settingsSchema`)→ `contributes.push.settingsFields`。
 *
 * 在**构建**时导出,不在打 zip 时:开发版装拓展链的是 `dist/`,只在打包时导出的话开发时面板画不出表单。
 * 线上清单的形状不变(契约修订号不抬),变的只是谁来写它;手写清单的拓展照旧,加载时照旧对表。
 */

import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodType } from "zod";
import { assertConfigFieldsMatchSchema } from "../schema/config-fields";
import { parseExtensionManifest } from "../schema/extension-manifest";
import { settingsFieldsFromSchema } from "../schema/settings-fields-from-schema";

/** 入口里这两个名字交的是规则;别的导出构建不看。 */
export interface ExtensionEntrySchemas {
	settingsSchema?: unknown;
	connectionSettingsSchema?: unknown;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 源码清单 + 入口导出的规则 → 包里那份清单。一栏都不出的不写;导出完过一遍加载时的对表与清单格式,
 * 错在构建时就报、点名到那一格。
 */
export function manifestWithSettingsFields(source: unknown, entry: ExtensionEntrySchemas): Json {
	if (!isObject(source)) throw new Error("extension.json 不是一个对象");
	const id = String(source.id);
	const fail = (msg: string): never => {
		throw new Error(`extension ${id}: ${msg}`);
	};
	const contributes = isObject(source.contributes) ? source.contributes : undefined;
	const push = isObject(contributes?.push) ? contributes.push : undefined;
	// 两份并存就又会漂:源码清单里还手写着的,一律不收。
	if (source.settings !== undefined) {
		fail("源码清单里不写 settings.fields —— 设置项由构建从入口导出的 settingsSchema 导出");
	}
	if (push?.settingsFields !== undefined) {
		fail(
			"源码清单里不写 contributes.push.settingsFields —— 由构建从入口导出的 connectionSettingsSchema 导出",
		);
	}

	const out: Json = { ...source };
	if (entry.settingsSchema !== undefined) {
		const fields = settingsFieldsFromSchema(entry.settingsSchema);
		assertConfigFieldsMatchSchema(id, entry.settingsSchema as ZodType, fields);
		if (fields.length > 0) out.settings = { fields };
	}
	if (entry.connectionSettingsSchema !== undefined) {
		if (!push) fail("入口导出了 connectionSettingsSchema,清单却没开推送那口(contributes.push)");
		const fields = settingsFieldsFromSchema(entry.connectionSettingsSchema);
		// 连接一律是从候选里挑出来的(settings 由拓展交),所以按「挑出来的」对表 —— 同宿主登记适配器时那一道。
		assertConfigFieldsMatchSchema(id, entry.connectionSettingsSchema as ZodType, fields, {
			picked: true,
		});
		if (fields.length > 0) {
			out.contributes = { ...contributes, push: { ...push, settingsFields: fields } };
		}
	}

	const read = parseExtensionManifest(out);
	if (!read.ok) {
		fail(
			`导出来的清单读不了:${read.reason === "unreadable" ? read.issues.join(";") : read.reason}`,
		);
	}
	return out;
}

/** 入口文件名,与装载器读的那个同名(`discover.ts` 的 `EXTENSION_ENTRY_FILE`)。 */
const ENTRY_FILE = "index.mjs";

/**
 * 打包插件:入口那份打包配置写完 `dist/index.mjs` 之后,把**清单 + 译文**放进 `dist/`,让它原样就是一个
 * 能装的包目录(ADR-0012 决策 8、ADR-0037 决策 14)。清单是源码根的 `extension.json` 加上从规则导出的设置项;
 * `locales/` 有才拷。
 *
 * 规则从刚打好的 `index.mjs` 里取:那份里内联的 zod 就是拓展跑起来用的那份,`.meta()` 读得到。
 * 🔴 拓展的模块顶层不许有副作用(装载器也会反复 import 它,ADR-0012 决策 10),这里 import 一次也一样安全。
 * 监听重打时每次换一个查询串,否则 import 拿到的是第一次的缓存。
 */
export function extensionPackageFiles(root: string): {
	name: string;
	closeBundle(): Promise<void>;
} {
	const out = resolve(root, "dist");
	return {
		name: "bn:extension-package-files",
		async closeBundle() {
			const source: unknown = JSON.parse(await readFile(resolve(root, "extension.json"), "utf8"));
			const url = pathToFileURL(resolve(out, ENTRY_FILE));
			url.search = `t=${Date.now()}`;
			const entry = (await import(url.href)) as ExtensionEntrySchemas;
			const manifest = manifestWithSettingsFields(source, entry);
			await writeFile(resolve(out, "extension.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
			const locales = resolve(root, "locales");
			if ((await stat(locales).catch(() => undefined))?.isDirectory()) {
				await cp(locales, resolve(out, "locales"), { recursive: true });
			}
		},
	};
}
