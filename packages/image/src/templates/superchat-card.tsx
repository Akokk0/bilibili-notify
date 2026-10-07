/**
 * 醒目留言卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图与测试
 * 一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是 {@link SuperchatCardView},所以类型留在原地。
 *
 * 醒目留言卡有两份形状(ADR-0021 决策 26 下 2026-10-05 的 🔗,照直播卡 `LiveCardInput` / `LiveCardView` 的先例):
 * - {@link SuperchatCardInput}:**中立的输入**,出卡入口 `generateSuperchatCard` 吃它。纯数据、不带任何平台的原始结构。
 *   B 站那头由 `apps/server/src/bilibili/live` 的 `superchatEventFromLiveEvent` 先翻成 `SuperchatEvent`(档位在那一步按价格算),
 *   再由直播会话组成这份输入。
 * - {@link SuperchatCardView}:块与皮肤契约吃的那一份 —— 金额与时长已经排好成文字、档位已经换成颜色。从输入到它
 *   只有一步(`buildSuperchatCardView`)。
 */

import type { Creator, ImageRef } from "@bilibili-notify/internal";

/**
 * **中立的醒目留言卡输入**。
 *
 * 头像是图库引用,**选填,没有(或引用解析不到)就不画那一格**:B 站这条路不给 —— 观众与主播的头像都是远端地址,
 * 3a 才存进图库(照 ㉑ ㉒ 的先例)。金额是数字加币种,由出图器经 `formatAmount` 排成字。`tier` 是来源按平台规矩算好的
 * 档(`rank` 从 1 起),没有就按最低档画;`durationSec` 是留言挂多久,没有就不画时长。
 */
export type SuperchatCardInput = {
	viewer: { name: string; avatar?: ImageRef };
	/** 卡上的主播(被留言的那位)。 */
	creator: Creator;
	text: string;
	amount: number;
	currency: string;
	tier?: { rank: number; durationSec?: number };
};

/**
 * 块与皮肤契约吃的那一份:**全是排好的文字 / 地址**。由 `buildSuperchatCardView` 从 {@link SuperchatCardInput}
 * 算出来;预览的示例数据与卡片基线的夹具直接写它。
 *
 * 主播那两格(`creatorName` / `creatorAvatarUrl`,皮肤字段 `creator.name` / `creator.avatar`)与观众那两格同一套叫法(㉔b)。
 */
export type SuperchatCardView = {
	viewerName: string;
	/** 观众头像的可画地址;没有就是空串(头像块整块收起)。 */
	viewerAvatarUrl: string;
	creatorName: string;
	/** 主播头像的可画地址;没有就不给(「SC to」那一行不画小头像)。 */
	creatorAvatarUrl?: string;
	text: string;
	/** 排好版的金额(「¥30」「US$30」),`formatAmount` 出的。 */
	amount: string;
	/** 金额的数字(没有币种)。 */
	amountValue: number;
	/** 排好版的留言时长(「1分」「2小时」);来源没给时长就是空串(时长块整块收起)。 */
	duration: string;
	/** 价位档,1–6、1 最低:`tier.rank` 夹进这个范围,没有 `tier` 是 1。 */
	rank: number;
	/** 档位色的起色与止色,`rank` 取默认配色表的第几色;外框把它们注成 `--bn-card-tier-color` / `-end`。 */
	bgColor: readonly [string, string];
};
