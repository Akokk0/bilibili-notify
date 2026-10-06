/**
 * 醒目留言卡的**中立输入 → 块吃的那一份**(ADR-0021 决策 26 下 2026-10-05 的 🔗)。
 *
 * 出卡入口(`ImageRenderer.generateSuperchatCard`)在这里把 {@link SuperchatCardInput} 排成 {@link SuperchatCardView}:
 * 金额经核心的 `formatAmount` 排成字、留言时长经 `formatDuration` 排成字(没给就空串)、档位换成默认配色表里的颜色、图库引用
 * 换成可画的地址。块与皮肤契约只认排好的那一份,不读时钟 —— 预览的示例数据也就能直接写它、每次画出同一张。
 */

import { formatAmount, formatDuration } from "@bilibili-notify/internal";
import type { ImageUrlOf } from "./rich-text";
import { effectiveTierRank, tierColorOf } from "./styles";
import type { SuperchatCardInput, SuperchatCardView } from "./templates/superchat-card";

export interface SuperchatCardViewOptions {
	/** 图库引用 → 可画的地址。出图器事先把输入里用到的引用都解析好,这里同步查;不给 = 所有引用都解析不到。 */
	imageUrl?: ImageUrlOf;
}

/**
 * 留言时长:有限的正数秒才排成「1分」「2小时」(走 `formatDuration`,不另写时长函数),别的(没给、0、负数、不是有限的数)
 * 都是没有 —— 返回空串,时长块整块收起。
 */
function durationText(durationSec: number | undefined): string {
	if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) return "";
	return formatDuration(0, durationSec * 1000);
}

/**
 * 中立输入 → 块吃的那一份。
 *
 * - 档位:`tier.rank` 夹进 1–6({@link effectiveTierRank}),按它取默认配色表里的颜色({@link tierColorOf});没有 `tier` 当最低档。
 *   `rank` 字段给的就是夹过的值,与颜色对得上。
 * - 头像:观众与主播的引用解析到了就是地址,没有或解析不到,观众头像是空串(头像块整块收起)、主播头像不给(「SC to」不画小头像)。
 */
export function buildSuperchatCardView(
	input: SuperchatCardInput,
	{ imageUrl }: SuperchatCardViewOptions = {},
): SuperchatCardView {
	const rank = effectiveTierRank(input.tier?.rank);
	const viewerAvatar = input.viewer.avatar;
	const creatorAvatar = input.creator.avatar;
	return {
		viewerName: input.viewer.name,
		viewerAvatarUrl: (viewerAvatar !== undefined ? imageUrl?.(viewerAvatar) : undefined) || "",
		creatorName: input.creator.name,
		creatorAvatarUrl:
			(creatorAvatar !== undefined ? imageUrl?.(creatorAvatar) : undefined) || undefined,
		text: input.text,
		amount: formatAmount(input.amount, input.currency),
		amountValue: Number.isFinite(input.amount) ? input.amount : 0,
		duration: durationText(input.tier?.durationSec),
		rank,
		bgColor: tierColorOf(rank),
	};
}
