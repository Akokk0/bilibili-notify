/**
 * 卡片皮肤库的 wire 契约 —— `/api/card-skins` 上面板与服务端之间的那几样形状
 * (ADR-0014 决策 2 / 5 / 17)。
 *
 * **皮肤包本体的形状不在这里**:`card-skin.json`(`CardSkinManifest`、字段表、挂点表、
 * 各项上限)是 `packages/internal/src/schema/card-skin.ts` 的契约常量 —— 出图那头
 * (`packages/image`)也要读它,而 `packages/*` 不许反向依赖 `apps/contract`(决策 14 的
 * 同一条依赖方向)。这里只借一道类型给面板。
 *
 * 与 dashboard 皮肤(`skin.ts`)刻意的两处不同:**启用的是一套不是两套**(卡片没有深浅
 * 两色之分,`active` 是单个 id),以及 **`builtin` 那份列得出但改不了删不了**(决策 5)。
 */

import type { CardSkinKind, CardSkinManifest } from "@bilibili-notify/internal";

export type { CardSkinManifest };

/**
 * 皮肤库列表里的一行。**服务端 `CardSkinStore.list()` 实现的就是这个类型** ——
 * 盘上那份(`card-skin.json`)字段多得多,列表只要这几样。
 */
export interface CardSkinSummary {
	id: string;
	name: string;
	author?: string;
	description?: string;
	/** 内置只读那份(改不了、删不了,只能「复制一份」)。 */
	builtin: boolean;
	/** `card-skin.json` 的 mtime(ms);内置那份不落盘,恒 0。 */
	updatedAt: number;
}

/**
 * GET /api/card-skins
 *
 * `active` = `globals.defaults.cardSkin`(全局在用哪套)。per-UP 的那一层住订阅里
 * (`overrides.cardSkin`),不在这张表上 —— 皮肤页管的是库与全局默认。
 */
export interface CardSkinListResponse {
	skins: CardSkinSummary[];
	active: string;
	/**
	 * 这次运行里出图**回落过**默认皮肤的记录(ADR-0014 决策 19「回落必须可见」)。
	 * 最近的在前、封顶 20 条、不落盘。空数组 = 一次都没回落过。
	 */
	fallbacks: CardSkinFallback[];
}

/** 一条回落记录。同一套皮肤 + 同一种卡 + 同一个原因只占一条,`count` 说它发生了几次。 */
export interface CardSkinFallback {
	skinId: string;
	kind: CardSkinKind;
	/** 人话原因:「皮肤不存在」「渲染失败(…)」「卡片高度 5200 超过上限 4000」。 */
	reason: string;
	/** 最近一次发生的时刻(ms)。 */
	at: number;
	count: number;
}

/** GET /api/card-skins/:id —— `assets` 是包内资产清单(`assets/<名>`),编辑器背景图那一栏的可选项。 */
export interface CardSkinManifestResponse {
	manifest: CardSkinManifest;
	assets: string[];
}

/** POST /api/card-skins(multipart zip 装包)。`warnings` = 清洗时丢掉了什么,逐条列给作者。 */
export interface CardSkinInstallResponse {
	id: string;
	warnings: string[];
}

/** POST /api/card-skins/:id/duplicate —— 名字缺省「<原名> 副本」。 */
export interface CardSkinDuplicateRequest {
	name?: string;
}

/** POST /api/card-skins/:id/duplicate 的回值。 */
export interface CardSkinDuplicateResponse {
	id: string;
}

/** PUT /api/card-skins/:id(编辑器就地保存,资产不动)。 */
export interface CardSkinSaveResponse {
	warnings: string[];
}

/** PUT /api/card-skins/active —— 改 `globals.defaults.cardSkin`。 */
export interface CardSkinActiveRequest {
	id: string;
}

/**
 * DELETE /api/card-skins/:id 撞上「还有人在用」(409)。
 *
 * 光回一句「删不掉」等于让主人挨个页面翻一遍。`global` 说的是全局默认那一档,
 * `subscriptions` 列的是订阅里手填的昵称(没填就是 uid)。
 */
export interface CardSkinInUseResponse {
	ok: false;
	err: string;
	usedBy: {
		global: boolean;
		subscriptions: string[];
	};
}
