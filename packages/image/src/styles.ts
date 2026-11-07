// ── 颜色数据 ──────────────────────────────────────────────────────────────────

/**
 * **默认的六色档位配色**(起色、止色各一):醒目留言卡按 `tier.rank` 取色,`rank` 从 1 起对应第 1 色;会员卡没有声明
 * `tier.color` 时回落第 1 色的起色、起止同值(施工时定的;声明了的档色可以另带止色 `colorEnd`)。
 *
 * 「按价格算档」已经搬去来源那一侧(`superchatEventFromLiveEvent`),出图器只认 `rank`。这张表是出图器自己的默认配色,
 * 与「价位档」的线无关 —— 来源的档数不一定是六档,所以 {@link tierColorOf} 把超出的 `rank` 夹进来。
 */
export const DEFAULT_TIER_COLORS = [
	["#a8e6cf", "#88d8b0"], // 1 清新绿
	["#74b9ff", "#0984e3"], // 2 天空蓝
	["#a29bfe", "#6c5ce7"], // 3 梦幻紫
	["#fd79a8", "#e84393"], // 4 热情粉
	["#fdcb6e", "#e17055"], // 5 荣耀金
	["#ff7675", "#d63031"], // 6 传说红
] as const;

/** 默认配色表里的最大 `rank`。 */
const DEFAULT_TIER_RANK_MAX = DEFAULT_TIER_COLORS.length;

/**
 * `rank`(从 1 起、1 最低)→ 它在默认配色表里的有效档位:超出 6 用最后一档,没有(或不是有限的数、小于 1)用第 1 档。
 * 小数向下取整。皮肤字段 `superchat.rank` 给的就是这个值,所以始终落在 1–6。
 */
export function effectiveTierRank(rank: number | undefined): number {
	if (rank === undefined || !Number.isFinite(rank)) return 1;
	return Math.min(DEFAULT_TIER_RANK_MAX, Math.max(1, Math.floor(rank)));
}

/** 有效档位 → 默认配色表里那一对(起色、止色)。 */
export function tierColorOf(rank: number | undefined): readonly [string, string] {
	const color = DEFAULT_TIER_COLORS[effectiveTierRank(rank) - 1];
	return color ?? DEFAULT_TIER_COLORS[0];
}
