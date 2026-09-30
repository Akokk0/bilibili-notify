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
