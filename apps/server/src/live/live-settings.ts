/**
 * 直播推送的两处小规矩,**B 站的直播间与拓展订阅的直播共用**(ADR-0019 决策 65 / 67):什么时候推两边
 * 各管各的(计时器不共用),但同一个设置在两边得是同一个意思 —— 各抄一份的话,主人给某个抖音号设的
 * 封面 / 等待时长迟早有一格只有 B 站那头认。
 */

import type { CardSkinChoice } from "@bilibili-notify/image";
import type { MessageKindLayout } from "@bilibili-notify/internal";
import type { CustomLiveMsgLike, PickLiveCover } from "./live-types";

/**
 * 一条订阅折好的**直播设置** —— 开播 / 正在直播 / 下播三张卡共用的那几格(ADR-0019 决策 65 / 67):
 * 两个特性开关、卡片样式(订阅的直播封面)、皮肤、消息版式、三句文案模板,以及推送频率 / 重启补推 /
 * 断流接续这几格按 UP 折好的值。
 *
 * 字段在这里显式写出,B 站直播引擎的订阅视图(`SubItemView`)`extends` 它 —— 依赖方向是
 * bilibili/ → live/,两边永远是同一份定义。
 *
 * 皮肤两格来自 {@link CardSkinChoice}:`cardSkin` 是该 UP 生效的**卡片皮肤 id**(ADR-0014),宿主折叠
 * `eff.cardSkin`(per-UP 指了就是它,否则全局)后填入,undefined = 内置默认皮肤,各 generate* 原样透传 ——
 * 版式住皮肤包里,不再逐块下发。`cardSkinKnobs` 是该 UP 自己那层**皮肤旋钮覆盖**,按皮肤 id 分
 * (`overrides.cardSkinKnobs` 原样,ADR-0014 决策 17 的 🔗),undefined = 一枚都没单独拧;与 `cardSkin` 一起
 * 递给每一种卡的 generate*(开播 / 直播中 / 下播 / SC / 上舰 / 词云),渲染器在出图时与全局那份逐枚合并。
 */
export interface LiveWorkSettings extends CardSkinChoice {
	liveStart: boolean;
	/** 周期「正在直播」的开关(`features.liveStreaming`)。关着就不计时、不出卡。 */
	liveStreaming: boolean;
	liveEnd: boolean;
	/**
	 * 该 UP 自己设的直播封面资产 id 列表(`overrides.cards.liveCoverImageIds` 原样)。键恒在、值可能是
	 * `undefined` = 没覆盖,跟全局;`[]` = 覆盖成「不用自定义封面」(取法见 {@link rotateLiveCover})。
	 */
	liveCoverImageIds?: string[];
	customLiveMsg: CustomLiveMsgLike;
	/** 周期「正在直播」的间隔,小时(1–24)。只在 {@link liveStreaming} 开着时有意义。 */
	streamingIntervalHours: number;
	/** 启动时发现正在播,补报一次开播(`liveStart.catchUpOnBoot`);只在 `liveStart` 开着时补。 */
	catchUpOnBoot: boolean;
	/**
	 * 断流接续:true 时该 UP 下播先挂起 `liveEndGraceMinutes` 分钟,等待窗口内重新开播
	 * 即判定网络抖动 / 超管掐流并接续为同一场(不发下播、不重发开播);超时未重开才真下播。
	 * adapter 已折算好(per-UP ?? 全局);缺省 false。
	 */
	liveEndGrace?: boolean;
	/** 断流接续等待时长(分钟,1–10);仅 `liveEndGrace=true` 生效,缺省 2。 */
	liveEndGraceMinutes?: number;
	/**
	 * 该 UP 解析后的**消息版式**直播切片(块顺序 / 显隐 / 分条符 + 分隔符)。宿主折叠
	 * `eff.messageLayout.live` 后填入。覆盖开播 / 直播中 / 下播三类推送;SC / 上舰不受影响
	 * (走各自独立渲染,不经 sendLiveNotifyCard)。
	 */
	messageLayout: MessageKindLayout;
}

/** 断流接续等多久(分钟):设置里的值,缺省 2,防御性夹到 [1, 10]。 */
export function liveEndGraceMinutes(configured: number | undefined): number {
	return Math.min(10, Math.max(1, configured ?? 2));
}

/**
 * 这一张直播卡用哪张自定义封面(资产 id),**每推一次轮一张**:订阅自己设了封面列表(含空列表 = 不用
 * 自定义封面)就只用它;没设(`perUp` 为 `undefined`)才用全局那一套默认封面。一张 = 固定用它,多张经
 * `pick`(游标键 `scopeKey`)选下一张。没有封面 → `undefined`,卡吃来源自己的封面。
 *
 * 每调一次就推进一次游标(多张时)—— 只在真要推一张卡时调。
 */
export function rotateLiveCover(
	perUp: string[] | undefined,
	defaultCovers: string[] | undefined,
	pick: PickLiveCover,
	scopeKey: string,
): string | undefined {
	// 订阅自己设了列表(含空列表)就只用它:空列表是「不用自定义封面」,不落回全局 ——
	// 面板上「没覆盖」与「覆盖成空」是两件事。没设(`undefined`)才跟全局。
	const covers = perUp ?? defaultCovers;
	if (!covers || covers.length === 0) return undefined;
	// 选择器选不出(不轮换)时,订阅自己的列表退回它的首张;全局那套没有这一档兜底。
	return covers.length === 1 ? covers[0] : (pick(scopeKey, covers) ?? perUp?.[0]);
}
