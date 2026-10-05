/**
 * 这种卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图与测试
 * 一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份 props,所以类型留在原地。
 *
 * 直播卡有两份形状(ADR-0019 决策 68):
 * - {@link LiveCardInput}:**中立的输入**,出卡入口 `generateLiveCard` 吃它。纯数据、
 *   不带任何平台的原始结构,状态明写。B 站那头(`liveCardInputFromRoomInfo`,在 `@bilibili-notify/live`)
 *   与拓展订阅那头(`liveCardInputFromReport`,在服务端)各把自己的数据翻成它。
 * - {@link LiveCardView}:块与皮肤契约吃的那一份 —— 全是排好的文字(数字排成「1.2万」、
 *   开播时刻算成「直播时长：…」那句)。从输入到它只有一步(`buildLiveCardView`),预览的
 *   示例数据直接写它(不读时钟)。
 */

import type { Creator, PostImage } from "@bilibili-notify/internal";

/**
 * 直播卡此刻是哪一种,**明写**(从前是一个数字:一处压成角标用的 0 / 1 / 2、别处却判 3 ——
 * 下播那一支因此从来没画出来过,决策 76)。
 *
 * - `start` 开播、`streaming` 直播中:角标都是「直播中」,数据区「人气 + 当前粉丝数」;
 *   两者只差卡上那句时间(开播时间 / 直播时长)。
 * - `end` 下播:角标「已下播」,数据区「点赞 + 累计观看人数」(决策 76)。
 * - `offline` 没在播:私聊指令查询一个没开播的房间时那一种 —— 角标「未开播」。
 */
export type LiveCardStatus = "start" | "streaming" | "end" | "offline";

/**
 * **中立的直播卡输入**(ADR-0019 决策 68;最终形状见 ADR-0021 决策 24 / 25 与 `docs/1.0/data-model.md`)。
 * 纯数据,不带任何平台的原始结构。
 *
 * 人数一类的格子**只收精确数**(BN 排成「1.2万」),缺了就缺键、卡上对应那一格不画 —— 不补 0、不收平台
 * 排好的文字。时刻是 ISO 字符串。图是引用:出卡前由出图器经宿主注入的解析口换成可画的地址。
 */
export type LiveCardInput = {
	status: LiveCardStatus;
	/**
	 * 卡上的主播。`avatar` 是图库引用,**选填,没有(或引用解析不到)就不画头像** —— 头像块整块收起,
	 * 皮肤契约的 `up.face` 是空串。
	 *
	 * B 站这条路不给:`Creator.avatar` 只收图库引用,B 站的头像是远端地址,要到 3a 才存进图库
	 * (ADR-0021 决策 24 下 2026-10-05 的 🔗,照决策 22 下作品卡的先例)。拓展直播自己带着头像,照旧画。
	 */
	creator: Creator;
	title?: string;
	/** 分区。 */
	category?: string;
	/** 房间简介,**纯文本**(B 站那头先剥掉了富文本标签)。 */
	description?: string;
	/**
	 * **生效的**封面 —— 用哪一张由来源自己定(B 站:直播中先关键帧、其余先房间封面,缺了拿另一张兜)。
	 * 有 `ref` 认它的解析结果,**解析不到当成没有封面**(不退回 `url`);只有 `url` 原样用(B 站在 3a 存进图库之前
	 * 靠它);两样都没有同样是没有封面。主人给这条订阅设的自定义直播封面在出卡时另行覆盖在它上面。没有封面
	 * 且没有自定义封面时,卡上画 BN 自带的「暂无封面」占位图。
	 */
	cover?: PostImage;
	/**
	 * 开播时刻,**ISO 字符串**。卡上那句「开播时间：…」(开播 / 下播)或「直播时长：…」(直播中)由它算,按北京时间
	 * 写。不给、或读不懂,就不写那句。
	 */
	startedAt?: string;
	/** 此刻在线(人气那一格,开播 / 直播中 / 没在播的卡上画)。 */
	currentViewers?: number;
	/** 本场累计观看(下播卡的那一格)。 */
	totalViewers?: number;
	/** 点赞(下播卡的那一格)。 */
	likes?: number;
	/** 当前粉丝数(开播 / 直播中的卡上画)。 */
	followers?: number;
	/**
	 * 本场粉丝数变化。**默认卡不画**(决策 76,它进下播文案),皮肤契约照给
	 * (`stats.fansChanged`),自己做皮肤的人想画就能画。数字排成带正负号的写法。
	 */
	followersDelta?: number;
};

/**
 * 块与皮肤契约吃的那一份:**全是排好的文字**,缺的格子是空串。由 `buildLiveCardView` 从
 * {@link LiveCardInput} 算出来(那一步读时钟算「直播时长」,所以这里不再有时间戳)。
 */
export type LiveCardView = {
	status: LiveCardStatus;
	username: string;
	/** 头像地址;空串 = 没有头像,头像块整块收起(见 {@link LiveCardInput.creator})。 */
	userface: string;
	title: string;
	area: string;
	/** 纯文本。 */
	description: string;
	/**
	 * 生效的封面(自定义直播封面已经覆盖上去了),**永远画得出来**:没有真封面时是 BN 自带的
	 * 占位图(`LIVE_COVER_PLACEHOLDER`),不是空串 —— 空的 `src` 画出来是一张裂图。
	 */
	cover: string;
	/** 有没有**真的**封面(自定义封面或来源给的那张);占位图不算。 */
	hasCover: boolean;
	/** 「开播时间：…」/「直播时长：…」/「未开播」那一句。 */
	time: string;
	online: string;
	likes: string;
	totalViewers: string;
	fans: string;
	fansChanged: string;
};
