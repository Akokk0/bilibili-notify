/**
 * 会员卡的**中立输入 → 块吃的那一份**(ADR-0021 决策 26 下 2026-10-05 的 🔗)。
 *
 * 出卡入口(`ImageRenderer.generateMembershipCard`)在这里把 {@link MembershipCardInput} 排成 {@link MembershipCardView}:
 * 宣告语模板经 `interpolate` 填上观众名 / 主播名 / 档名、档色取档位声明的起色与止色、徽章与头像的图库引用换成可画的地址。
 * 块与皮肤契约只认排好的那一份 —— 预览的示例数据与卡片基线的夹具直接写它。
 */

import { interpolate } from "@bilibili-notify/internal";
import { coverUrlOf } from "./live-view";
import type { ImageUrlOf } from "./rich-text";
import { DEFAULT_TIER_COLORS } from "./styles";
import type { MembershipCardInput, MembershipCardView } from "./templates/membership-card";

export interface MembershipCardViewOptions {
	/** 图库引用 → 可画的地址。出图器事先把输入里用到的引用都解析好,这里同步查;不给 = 所有引用都解析不到。 */
	imageUrl?: ImageUrlOf;
}

/**
 * 档色:起色取 `tier.color`,止色取 `tier.colorEnd`,没声明止色就与起色同值(单色)。两样都没声明就回落**默认配色表
 * 第 1 色的起色**(施工时定的:没有声明档色的会员档是「一个色」,不借醒目留言那套按价位的渐变)。
 * 默认皮肤的外框背景是从起色到止色的渐变,所以止色决定这张卡是渐变还是单色。
 */
function tierColorOf(
	color: string | undefined,
	colorEnd: string | undefined,
): readonly [string, string] {
	const value = color || DEFAULT_TIER_COLORS[0][0];
	return [value, (color && colorEnd) || value];
}

/**
 * 中立输入 → 块吃的那一份。
 *
 * - 宣告语:`tier.announcement` 有就经 `interpolate` 填 `{viewer}`(观众名)、`{name}`(主播名)、`{tier}`(档名),没声明就是空串
 *   (那一句不画)。填不进去的变量原样留着,不抛。
 * - 徽章:`tier.icon` 带 `url` 照今天那样画,带 `ref` 走图库解析({@link coverUrlOf} 的规矩:解析不到就是没有);没有就是空串
 *   (徽章块整块收起)。
 * - `rank`:没有 rank 的档是 0。
 */
export function buildMembershipCardView(
	input: MembershipCardInput,
	{ imageUrl }: MembershipCardViewOptions = {},
): MembershipCardView {
	const { tier } = input;
	const viewerAvatar = input.viewer.avatar;
	const creatorAvatar = input.creator.avatar;
	return {
		viewerName: input.viewer.name,
		viewerAvatarUrl: (viewerAvatar !== undefined ? imageUrl?.(viewerAvatar) : undefined) || "",
		creatorName: input.creator.name,
		creatorAvatarUrl: (creatorAvatar !== undefined ? imageUrl?.(creatorAvatar) : undefined) || "",
		tierName: tier.name,
		rank: typeof tier.rank === "number" && Number.isFinite(tier.rank) ? tier.rank : 0,
		iconUrl: coverUrlOf(tier.icon, imageUrl) || "",
		announcement: tier.announcement
			? interpolate(tier.announcement, {
					viewer: input.viewer.name,
					name: input.creator.name,
					tier: tier.name,
				})
			: "",
		bgColor: tierColorOf(tier.color, tier.colorEnd),
	};
}
