/**
 * 特别关注名单的搬家(3b-16):订阅上的 `specialUsers` → `specialViewers`。**不是改名**(条目的形状也变),所以不进
 * `feature-renames.ts` 的改名表,单列在这里,接在那一步之后串着跑(`subscriptions.ts` 的 `toCurrentRow`;守卫 13 跑的也是它)。
 *
 * | 0.x(`specialUsers` 的条目) | 1.0(`specialViewers` 的条目) |
 * | --- | --- |
 * | `uid` | `id`(字符串原样) |
 * | `kinds`:`danmaku` / `enter` | `features`:`viewerChat` / `viewerEnter`,按 `kinds` 的次序一一翻、重复的只留一个 |
 * | `template`(死格,从没人读) | 丢掉 |
 *
 * 名单的次序不变,键留在原位;行上没有 `specialUsers` 的(拓展订阅)不动,schema 的默认值是空表。
 *
 * 认不出的条目**原样放过**(留在 `specialViewers` 里的原位,由配置仓开机时拒收、报出来)—— 不是对象、没有字符串 `uid`、
 * `kinds` 不是数组或一个都翻不出。故意不「丢掉那一条」:丢了就是静默少一个人,违背「一个不少」;也不「整行不动」:
 * 老键留在行上,schema 会把没人认的键悄悄剥掉,名单就整份静默消失。`kinds` 里混了认不得的种类时,认得的翻、认不得的丢。
 * 名单本身不是数组的,值原样换个键名带过去。
 *
 * 新老两键并存时以新键为准、老键丢掉;已经是新形状的行再跑一遍不变。**不依赖运行时代码**:0.12 的种类取值冻在
 * `zero-vocabulary.ts`,去向的特性键用 `satisfies` 钉成活的 `FeatureKey`。
 */

import type { FeatureKey } from "@bilibili-notify/internal";
import { isPlainObject } from "./files.js";
import { ZERO_SPECIAL_USER_KINDS, type ZeroSpecialUserKind } from "./zero-vocabulary.js";

/** 0.12 的名单种类 → 1.0 的特性键。0.12 多一种、这里没给去向,编译不过。 */
const SPECIAL_USER_KIND_FEATURES = {
	danmaku: "viewerChat",
	enter: "viewerEnter",
} as const satisfies Record<ZeroSpecialUserKind, FeatureKey>;

function isZeroKind(kind: unknown): kind is ZeroSpecialUserKind {
	return (ZERO_SPECIAL_USER_KINDS as readonly unknown[]).includes(kind);
}

/** 一个 0.x 条目 → 1.0 的条目;认不出(见文件头)就原样回(同一个值)。 */
function moveEntry(entry: unknown): unknown {
	if (!isPlainObject(entry) || typeof entry.uid !== "string" || !Array.isArray(entry.kinds)) {
		return entry;
	}
	const features = [
		...new Set(entry.kinds.filter(isZeroKind).map((kind) => SPECIAL_USER_KIND_FEATURES[kind])),
	];
	if (features.length === 0) return entry;
	return { id: entry.uid, features };
}

/** 一条订阅(0.x 最新形状经过改名之后)的 raw → raw:`specialUsers` 原位换成 `specialViewers`。 */
export function moveSpecialViewers(row: unknown): unknown {
	if (!isPlainObject(row) || !Object.hasOwn(row, "specialUsers")) return row;
	const hasNew = Object.hasOwn(row, "specialViewers");
	const entries: Array<[string, unknown]> = [];
	for (const [key, value] of Object.entries(row)) {
		if (key !== "specialUsers") entries.push([key, value]);
		else if (!hasNew)
			entries.push(["specialViewers", Array.isArray(value) ? value.map(moveEntry) : value]);
	}
	return Object.fromEntries(entries);
}
