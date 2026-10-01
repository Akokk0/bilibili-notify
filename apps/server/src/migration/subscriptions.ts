/**
 * 两份订阅文件 `config/subscriptions.json`(B 站)与 `config/extension-subscriptions.json`(拓展):0.x 各个版本
 * 留下的形状 → 0.x 最新的形状。一项一项收进来(⑥c),配置仓开机只认最新的形状。
 *
 * 每一行照 zod 当年跑 preprocess 的顺序改写:外层先跑,再跑里层 —— B 站那一行先整行迁
 * ({@link migrateLegacySubscription}:@全体 并进附加项、第一代 routing 时带 `force` 迁 features 覆盖),再迁
 * `routing`({@link migrateLegacyRouting})与 `overrides.features`(不带 `force` 的
 * {@link migrateLegacyFeatureFlagsPartial})。拓展订阅没有外层那一步。
 */

import { join } from "node:path";
import {
	migrateLegacyFeatureFlagsPartial,
	migrateLegacyRouting,
	migrateLegacySubscription,
} from "./features.js";
import { isPlainObject, readJsonFile, rewriteJsonFile } from "./files.js";

/** 两种订阅共有的那两格:`routing` 与 `overrides.features`。 */
function migrateSharedParts(row: unknown): unknown {
	if (!isPlainObject(row)) return row;
	let out = row;
	if (row.routing !== undefined) out = { ...out, routing: migrateLegacyRouting(row.routing) };
	const overrides = out.overrides;
	if (isPlainObject(overrides) && overrides.features !== undefined) {
		out = {
			...out,
			overrides: { ...overrides, features: migrateLegacyFeatureFlagsPartial(overrides.features) },
		};
	}
	return out;
}

/** B 站订阅的一行。 */
export function migrateBiliSubscriptionRow(raw: unknown): unknown {
	return migrateSharedParts(migrateLegacySubscription(raw));
}

/** 拓展订阅的一行。 */
export function migrateExtensionSubscriptionRow(raw: unknown): unknown {
	return migrateSharedParts(raw);
}

const FILES = [
	["subscriptions.json", migrateBiliSubscriptionRow],
	["extension-subscriptions.json", migrateExtensionSubscriptionRow],
] as const;

/** 一条 B 站订阅的订阅 id 与 uid:统计文件名与锐评草稿按 uid 找回订阅时用。 */
export interface BiliSubscriptionKey {
	id: string;
	uid: string;
}

/**
 * 新代里(已经迁好的)B 站订阅,按 `subscriptions.json` 里的顺序 —— 同一个 uid 订了几条时谁在前,和配置仓
 * 读出来的一样。文件不在当空表(全新安装,和配置仓同口径);读不懂、不是数组回 `undefined`:配置仓开机时会
 * 拒收它,要它的那几步别在它上面改别的文件。
 */
export async function readBiliSubscriptionKeys(
	configDir: string,
): Promise<BiliSubscriptionKey[] | undefined> {
	const file = await readJsonFile(join(configDir, "subscriptions.json"));
	if (file.kind === "missing") return [];
	if (file.kind === "unreadable" || !Array.isArray(file.value)) return undefined;
	return file.value.flatMap((row) =>
		isPlainObject(row) &&
		row.kind !== "extension" &&
		typeof row.id === "string" &&
		typeof row.uid === "string"
			? [{ id: row.id, uid: row.uid }]
			: [],
	);
}

/**
 * 新代里的两份订阅文件迁成最新的形状,回改写过的文件(绝对路径)。没变的不写 —— 新代里还是搬过来的那个文件。
 * 读不懂的、不是数组的原样留着,由配置仓开机时报出来。
 */
export async function migrateSubscriptionFiles(configDir: string): Promise<string[]> {
	const rewritten: string[] = [];
	for (const [name, migrateRow] of FILES) {
		const path = join(configDir, name);
		const file = await readJsonFile(path);
		if (file.kind !== "ok" || !Array.isArray(file.value)) continue;
		const next = file.value.map(migrateRow);
		if (JSON.stringify(next) === JSON.stringify(file.value)) continue;
		await rewriteJsonFile(path, next);
		rewritten.push(path);
	}
	return rewritten;
}
