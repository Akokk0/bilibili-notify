/**
 * 界面皮肤 `skins/dashboard/`:0.x 各个版本留下的形状 → 0.x 最新的形状。一项一项收进来(⑥c);从前是皮肤库读盘
 * 时翻、不回写,皮肤库开机只认最新的形状。
 *
 * - `active.json` 的旧单指针 `{id}` → 深浅两个槽:那套皮肤有哪种模式就落哪个槽。
 * - 每套皮肤的清单 `skin.json` 与出厂快照 `default.json`:摘掉 v0.7.0 及之前清洗层烙进 css 的两句硬规矩(见
 *   `stripDecorationResidue`)。皮肤包导入那条路还留着同一把清洁工:外面流传的老皮肤包不是盘上的数据。
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { dataPath } from "../runtime/roots.js";
import { stripDecorationResidue } from "../skins/css-sanitizer.js";
import {
	ACTIVE_FILE,
	DASHBOARD_SKINS_DIR,
	DEFAULT_SNAPSHOT_FILE,
	SKIN_MANIFEST_FILE,
} from "../skins/store.js";
import { isPlainObject, readJsonFile, rewriteTextFile } from "./files.js";

const THEMES = ["light", "dark"] as const;

/** 新代里的界面皮肤迁成最新的形状,回改写过的文件(绝对路径)。 */
export async function migrateDashboardSkins(dataRoot: string): Promise<string[]> {
	const root = dataPath(dataRoot, ...DASHBOARD_SKINS_DIR);
	const ids = await listSkinIds(root);
	const rewritten: string[] = [];
	for (const id of ids) {
		for (const name of [SKIN_MANIFEST_FILE, DEFAULT_SNAPSHOT_FILE]) {
			const path = join(root, id, name);
			const file = await readJsonFile(path);
			if (file.kind !== "ok" || !isPlainObject(file.value)) continue;
			const next = stripManifestResidue(file.value);
			if (JSON.stringify(next) === JSON.stringify(file.value)) continue;
			// 和皮肤库落盘同一个字面:带缩进,主人 / 第三方是要手看手改它们的。
			await rewriteTextFile(path, JSON.stringify(next, null, "\t"));
			rewritten.push(path);
		}
	}
	if (await migrateActivePointer(root, ids)) rewritten.push(join(root, ACTIVE_FILE));
	return rewritten;
}

/** 摘掉清单里 css(整套的与每个模式的)上的旧烙印。不是字符串的不动 —— 那是皮肤库校验的事。 */
function stripManifestResidue(manifest: Record<string, unknown>): Record<string, unknown> {
	const next = structuredClone(manifest);
	if (typeof next.css === "string") next.css = stripDecorationResidue(next.css);
	if (!isPlainObject(next.modes)) return next;
	for (const theme of THEMES) {
		const mode = next.modes[theme];
		if (isPlainObject(mode) && typeof mode.css === "string") {
			mode.css = stripDecorationResidue(mode.css);
		}
	}
	return next;
}

/**
 * `{id}` → 那套皮肤有哪种模式就落哪个槽,已有的槽留着(皮肤库开机照旧逐槽核对)。只认皮肤目录里真有的那一套
 * —— 手改的指针不拿来拼路径。回改没改。
 */
async function migrateActivePointer(root: string, ids: ReadonlySet<string>): Promise<boolean> {
	const path = join(root, ACTIVE_FILE);
	const file = await readJsonFile(path);
	if (file.kind !== "ok" || !isPlainObject(file.value) || typeof file.value.id !== "string") {
		return false;
	}
	const { id, ...slots } = file.value;
	const next: Record<string, unknown> = { ...slots };
	if (ids.has(id)) {
		const manifest = await readJsonFile(join(root, id, SKIN_MANIFEST_FILE));
		const modes =
			manifest.kind === "ok" && isPlainObject(manifest.value) && isPlainObject(manifest.value.modes)
				? manifest.value.modes
				: {};
		for (const theme of THEMES) if (modes[theme]) next[theme] = id;
	}
	// 和皮肤库写指针同一个字面(紧凑的一行)。
	await rewriteTextFile(path, JSON.stringify(next));
	return true;
}

async function listSkinIds(root: string): Promise<Set<string>> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return new Set(
			entries
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort(),
		);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw err;
	}
}
