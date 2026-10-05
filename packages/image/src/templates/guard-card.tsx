/**
 * 会员卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图与测试
 * 一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是 {@link MembershipCardView},所以类型留在原地。
 *
 * 会员卡有两份形状(ADR-0021 决策 26 下 2026-10-05 的 🔗,照直播卡 `LiveCardInput` / `LiveCardView` 的先例):
 * - {@link MembershipCardInput}:**中立的输入**,出卡入口 `generateMembershipCard` 吃它。只有一种会员卡,各平台的
 *   会员体系(B 站的大航海是其中一套)都交这一个形状;出图器不认识任何平台的档位怎么叫、怎么排。
 * - {@link MembershipCardView}:块与皮肤契约吃的那一份 —— 宣告语已经把观众名 / 主播名 / 档名填进去、徽章已经换成可画的地址。
 *   从输入到它只有一步(`buildMembershipCardView`)。
 */

import type { Creator, ImageRef, PostImage } from "@bilibili-notify/internal";

/**
 * **中立的会员卡输入**。
 *
 * 头像是图库引用,**选填,没有(或引用解析不到)就不画那一格**:B 站这条路不给(3a 才存进图库,照 ㉑ ㉒ 的先例)。
 * 档的各项都来自来源声明的档位表(`MembershipTier`):`color` 是档色(一个值,起止色同值;没有就回落默认配色表的第一色)、
 * `icon` 是徽章(带 `url` 照画,带 `ref` 走图库解析)、`announcement` 是宣告语模板(`{viewer}` `{name}` `{tier}`;
 * 没声明就不画那一句)、`rank` 没有就是没有 rank 的体系(皮肤字段 `membership.rank` 给 0)。
 * 没有「房管」那一格:各平台的房管标记都挂在聊天消息上,不在会员事件上。
 */
export type MembershipCardInput = {
	viewer: { name: string; avatar?: ImageRef };
	/** 卡上的主播(被上舰 / 被开通会员的那位)。 */
	creator: Creator;
	tier: {
		name: string;
		rank?: number;
		icon?: PostImage;
		color?: string;
		colorEnd?: string;
		announcement?: string;
	};
};

/**
 * 块与皮肤契约吃的那一份:**全是排好的文字 / 地址**,缺的格子是空串(`rank` 是 0)。由 `buildMembershipCardView` 从
 * {@link MembershipCardInput} 算出来;预览的示例数据与卡片基线的夹具直接写它。
 *
 * 主播那两格(`masterName` / `masterAvatarUrl`,皮肤字段 `master.name` / `master.face`)的名字不动,留给 ㉔。
 */
export type MembershipCardView = {
	viewerName: string;
	/** 观众头像的可画地址;没有就是空串(头像块整块收起)。 */
	viewerAvatarUrl: string;
	masterName: string;
	/** 主播头像的可画地址;没有就是空串(主播胶囊里不画小头像)。 */
	masterAvatarUrl: string;
	tierName: string;
	/** 档位,从 1 起、1 最低;没有 rank 的档是 0(`rank` 本身从 1 起,所以 0 不会与真档混淆)。 */
	rank: number;
	/** 徽章的可画地址;没有就是空串(徽章块整块收起)。 */
	iconUrl: string;
	/** 宣告语,模板已填好;没声明就是空串(那一句不画)。 */
	announcement: string;
	/** 档位色的起色与止色,**同一个值**;外框把它们注成 `--bn-card-tier-color` / `-end`。 */
	bgColor: readonly [string, string];
};
