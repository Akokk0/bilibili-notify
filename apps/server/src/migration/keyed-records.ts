import { t as serverText } from "./i18n.js";
/**
 * 迁移清单(守卫 13 前半):盘上存的记录里,所有「用特性键 / 附加项键 / 卡种做键」的位置,以及每一条由谁负责从 0.x 迁到 1.0。
 *
 * 为什么要有它:这几套词表一改名(⑬c 的 `dynamic` → `post` ……),凡是拿它们做键的记录都得跟着改。漏一处不会报错 ——
 * schema 对未知键是 strip,老键下次写盘时悄悄消失,必填键则是整份开机被拒,而类型、测试、构建全绿。
 *
 * 守卫(`__tests__/keyed-records.test.ts`)怎么用它:
 * - (a) 判定函数在四个存盘的根(`GlobalSettings` / `Subscription` / `HistoryEntry` / `CardSkinManifest`)上找出所有用这几套
 *   词表做键的位置,和这张表两头对:schema 里有、表里没登记 → 红;表里有、schema 里找不到(字段删了、挪了)→ 也红,免得表烂掉;
 * - (b) 归 `settings` / `subscription` 的每一条:用冻住的 0.x 词表(`zero-vocabulary.ts`)在 0.x 的路径上摆满旧键,跑那一族的
 *   1.0 步骤(改名 + 直播拆键),断言 `path` 上出来的键都在活词表里、0.x 的旧键一个不剩、每个 0.x 键的值都落进了某个新键;
 *   归 `history` 的那一条是**值**用特性键、不是拿它做键:用冻住的 `ZERO_PUSH_KINDS` 每个取值各造一行 0.x 的历史行(再加 0.x 早期
 *   `source` 形状的行),过一遍历史那一族的行级函数(`history.ts` 的 `migrateHistoryLine`),断言 `path` 上出来的值都在活词表里、
 *   `zeroPath` 上的旧格一个不剩、没有两种旧取值落到同一个键;
 * - (c) 归 `pending` 的不做行为核对,测试里逐条列出来、标明归哪一片。
 *
 * 以后:
 * - 往某个根里加了用这几套词表做键的字段 → (a) 红。在这里加一条,写明谁迁它,再照那一条补迁移步骤,(b) 盯着它真的迁了;
 * - 改了词表(改名、删键)→ 看 (b) 与 `feature-renames.ts` 里 `satisfies` 的编译错误;`pending` 的条目随归属那一片一起改,改完把它挪到
 *   `settings` / `subscription` 或者删掉;
 * - 新开了一个存盘的仓 → 判定函数发现不了没登记的新仓,要自己把它的 schema 加进测试的根列表;
 * - 新增一套词表 → 加进 {@link KeyedVocabulary} 与 {@link KEYED_VOCABULARIES}。
 *
 * 历史行推送种类那一格(⑬f 之前叫 `kind`、值是 0.x 自成一套的八种推送种类名)现在叫 `feature`、值就是特性键:判定函数把它当「枚举当值用」
 * 找到,登记在 `history` 一族名下(0.x 住在 `kind`)。
 */

import { CARD_KINDS, EXTRA_KEYS, FEATURE_KEYS } from "@bilibili-notify/internal";

/** 被拿来做键的几套词表。卡种键只有一套(㉔e 把从前的四种卡与七种卡两套收成了一套)。 */
export type KeyedVocabulary = "FeatureKey" | "ExtraKey" | "CardKind";

/** 每套词表现行的键。判定函数拿它认位置;守卫拿它核「出来的键都是活的」。 */
export const KEYED_VOCABULARIES: Record<KeyedVocabulary, readonly string[]> = {
	FeatureKey: FEATURE_KEYS,
	ExtraKey: EXTRA_KEYS,
	CardKind: CARD_KINDS,
};

/** 存盘的根:一个仓读写的那份 schema。 */
export type KeyedRecordRoot =
	| "GlobalSettings"
	| "Subscription"
	| "HistoryEntry"
	| "CardSkinManifest";

/**
 * 谁负责把这条记录从 0.x 迁到 1.0:
 * - `settings`:设置那一族的 1.0 步骤(`settings.ts` 的 `migrateGlobalsToCurrent`:改名、会员与卡片搬家、直播拆键、历史保留换键、拆 `app`、账本与 AI 上提到顶层);
 * - `subscription`:订阅那一族的 1.0 步骤(`subscriptions.ts` 的 `toCurrentRow`:改名 + 直播拆键);
 * - `history`:历史那一族的 1.0 步骤(`history.ts` 的 `migrateHistoryLine`:老 `source` → 0.x 的推送种类 → 特性键)。
 *   它登记的是一个**值**(推送种类那一格),`zeroPath` 是 0.x 里装种类名的那一格;
 * - `rejected`:不迁、整份拒收(卡片皮肤包:格式版本不对的包进不了门,所以盘上没有要改写的键),`note` 说明为什么;
 * - `pending`:归某一片、还没做。`slice` 是片号,`note` 说明为什么归它。
 *
 * `zeroPath`:这条记录在 0.x 里住的路径;1.0 挪过窝才写(订阅顶层的逐目标表 `extras` → `extraTargets`、历史行的 `kind` →
 * `feature`),缺省同 `path`。
 */
export type KeyedRecordHandledBy =
	| { kind: "settings" | "subscription" | "history"; zeroPath?: string }
	| { kind: "rejected"; note: string }
	| { kind: "pending"; slice: string; note: string };

/** 清单的一条。`path` 的写法见 `__tests__/keyed-record-finder.ts`(对象键 `.`,数组元素 `[]`,record 的值 `*`)。 */
export interface KeyedRecordEntry {
	root: KeyedRecordRoot;
	path: string;
	vocabulary: KeyedVocabulary;
	handledBy: KeyedRecordHandledBy;
}

export const KEYED_RECORD_ENTRIES: readonly KeyedRecordEntry[] = [
	// 全局设置
	{
		root: "GlobalSettings",
		path: "defaults.features",
		vocabulary: "FeatureKey",
		handledBy: { kind: "settings" },
	},
	{
		root: "GlobalSettings",
		path: "defaults.features.extras",
		vocabulary: "ExtraKey",
		handledBy: { kind: "settings" },
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

	// 历史行:推送种类那一格(值用特性键);0.x 住在 `kind`,值是八种推送种类名
	{
		root: "HistoryEntry",
		path: "feature",
		vocabulary: "FeatureKey",
		handledBy: { kind: "history", zeroPath: "kind" },
	},

	// 卡片皮肤包的清单
	{
		root: "CardSkinManifest",
		path: "cards",
		vocabulary: "CardKind",
		handledBy: {
			kind: "rejected",
			get note() {
				return serverText("service.migration.keyed-records.text.1");
			},
		},
	},
];
