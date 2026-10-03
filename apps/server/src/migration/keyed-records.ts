/**
 * 迁移清单(守卫 13 前半):盘上存的记录里,所有「用特性键 / 附加项键 / 卡种做键」的位置,以及每一条由谁负责从 0.x 迁到 1.0。
 *
 * 为什么要有它:这几套词表一改名(⑬c 的 `dynamic` → `post` ……),凡是拿它们做键的记录都得跟着改。漏一处不会报错 ——
 * schema 对未知键是 strip,老键下次写盘时悄悄消失,必填键则是整份开机被拒,而类型、测试、构建全绿。
 *
 * 守卫(`__tests__/keyed-records.test.ts`)怎么用它:
 * - (a) 判定函数在四个存盘的根(`GlobalConfig` / `Subscription` / `HistoryEntry` / `CardSkinManifest`)上找出所有用这几套
 *   词表做键的位置,和这张表两头对:schema 里有、表里没登记 → 红;表里有、schema 里找不到(字段删了、挪了)→ 也红,免得表烂掉;
 * - (b) 归 `settings` / `subscription` 的每一条:用冻住的 0.x 词表(`zero-vocabulary.ts`)在 0.x 的路径上摆满旧键,跑那一族的
 *   1.0 步骤(改名 + 直播拆键),断言 `path` 上出来的键都在活词表里、0.x 的旧键一个不剩、每个 0.x 键的值都落进了某个新键;
 * - (c) 归 `pending` 的不做行为核对,测试里逐条列出来、标明归哪一片。
 *
 * 以后:
 * - 往某个根里加了用这几套词表做键的字段 → (a) 红。在这里加一条,写明谁迁它,再照那一条补迁移步骤,(b) 盯着它真的迁了;
 * - 改了词表(改名、删键)→ 看 (b) 与 `feature-renames.ts` 里 `satisfies` 的编译错误;`pending` 的条目随归属那一片一起改,改完把它挪到
 *   `settings` / `subscription` 或者删掉;
 * - 新开了一个存盘的仓 → 判定函数发现不了没登记的新仓,要自己把它的 schema 加进测试的根列表;
 * - 新增一套词表 → 加进 {@link KeyedVocabulary} 与 {@link KEYED_VOCABULARIES}。
 *
 * 历史行今天那一格是 `kind`(推送种类 `PushKind`,自成一套词表),不在这几套里,判定函数找不到、这里也不写;⑬f 把它改成特性键
 * 的值以后,(a) 会自然要求补一条。
 */

import {
	CARD_SKIN_KINDS,
	CardKindSchema,
	EXTRA_KEYS,
	FEATURE_KEYS,
} from "@bilibili-notify/internal";

/** 被拿来做键的几套词表。`CardKind`(4 种卡)是 `CardSkinKind`(7 种卡)的子集,两套今天各用各的。 */
export type KeyedVocabulary = "FeatureKey" | "ExtraKey" | "CardKind" | "CardSkinKind";

/** 每套词表现行的键。判定函数拿它认位置;守卫拿它核「出来的键都是活的」。 */
export const KEYED_VOCABULARIES: Record<KeyedVocabulary, readonly string[]> = {
	FeatureKey: FEATURE_KEYS,
	ExtraKey: EXTRA_KEYS,
	CardKind: CardKindSchema.options,
	CardSkinKind: CARD_SKIN_KINDS,
};

/** 存盘的根:一个仓读写的那份 schema。 */
export type KeyedRecordRoot = "GlobalConfig" | "Subscription" | "HistoryEntry" | "CardSkinManifest";

/**
 * 谁负责把这条记录从 0.x 迁到 1.0:
 * - `settings`:设置那一族的 1.0 步骤(`settings.ts` 的 `migrateGlobalsToCurrent`:改名 + 直播拆键);
 * - `subscription`:订阅那一族的 1.0 步骤(`subscriptions.ts` 的 `toCurrentRow`:改名 + 直播拆键);
 * - `pending`:归某一片、还没做。`slice` 是片号,`note` 说明为什么归它。
 *
 * `zeroPath`:这条记录在 0.x 里住的路径;1.0 挪过窝才写(订阅顶层的逐目标表 `extras` → `extraTargets`),缺省同 `path`。
 */
export type KeyedRecordHandledBy =
	| { kind: "settings" | "subscription"; zeroPath?: string }
	| { kind: "pending"; slice: string; note: string };

/** 清单的一条。`path` 的写法见 `__tests__/keyed-record-finder.ts`(对象键 `.`,数组元素 `[]`,record 的值 `*`)。 */
export interface KeyedRecordEntry {
	root: KeyedRecordRoot;
	path: string;
	vocabulary: KeyedVocabulary;
	handledBy: KeyedRecordHandledBy;
}

/** 卡种键与卡片皮肤共用 `live` / `dynamic` / `sc` / `guard`,`live` 的新名要 ㉔ 才定,分两趟改两边会对不上。 */
const CARD_KINDS_ARE_SLICE_24: KeyedRecordHandledBy = {
	kind: "pending",
	slice: "㉔",
	note: "卡种键改名与 `cardStyleByKind` 挪进 `defaults.cards.byKind` 一起做",
};

/** 卡片皮肤包不迁、旧包拒收(`docs/1.0/data-and-migration.md`):盘上没有要改写的,但包的 schema 抬版归 ㉔。 */
const CARD_SKIN_PACK_IS_SLICE_24: KeyedRecordHandledBy = {
	kind: "pending",
	slice: "㉔",
	note: "卡片皮肤包不迁、旧包拒收;皮肤 schema 抬版时一起改卡种键",
};

export const KEYED_RECORD_ENTRIES: readonly KeyedRecordEntry[] = [
	// 全局设置
	{
		root: "GlobalConfig",
		path: "defaults.features",
		vocabulary: "FeatureKey",
		handledBy: { kind: "settings" },
	},
	{
		root: "GlobalConfig",
		path: "defaults.features.extras",
		vocabulary: "ExtraKey",
		handledBy: { kind: "settings" },
	},
	{
		root: "GlobalConfig",
		path: "defaults.cardStyleByKind",
		vocabulary: "CardKind",
		handledBy: CARD_KINDS_ARE_SLICE_24,
	},

	// 订阅
	{
		root: "Subscription",
		path: "routing",
		vocabulary: "FeatureKey",
		handledBy: { kind: "subscription" },
	},
	{
		root: "Subscription",
		path: "extraTargets",
		vocabulary: "ExtraKey",
		handledBy: { kind: "subscription", zeroPath: "extras" },
	},
	{
		root: "Subscription",
		path: "overrides.features",
		vocabulary: "FeatureKey",
		handledBy: { kind: "subscription" },
	},
	{
		root: "Subscription",
		path: "overrides.features.extras",
		vocabulary: "ExtraKey",
		handledBy: { kind: "subscription" },
	},
	{
		root: "Subscription",
		path: "overrides.cardStyleByKind",
		vocabulary: "CardKind",
		handledBy: CARD_KINDS_ARE_SLICE_24,
	},

	// 卡片皮肤包的清单
	{
		root: "CardSkinManifest",
		path: "variablesByKind",
		vocabulary: "CardSkinKind",
		handledBy: CARD_SKIN_PACK_IS_SLICE_24,
	},
	{
		root: "CardSkinManifest",
		path: "cards",
		vocabulary: "CardSkinKind",
		handledBy: CARD_SKIN_PACK_IS_SLICE_24,
	},
];
