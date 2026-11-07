/**
 * 直播设置的几处小规矩,**所有直播来源共用**(ADR-0019 决策 65 / 67):同一个设置对哪个来源都得是
 * 同一个意思 —— 各抄一份的话,主人给某条订阅设的封面 / 等待时长迟早有几处认得不一致。
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import type { CardSkinChoice } from "@bilibili-notify/image";
import {
	type Disposable,
	type EffectiveSubscription,
	type ExtraKey,
	type GlobalSettings,
	type MessageBus,
	type MessageKindLayout,
	resolve,
	resolveTemplates,
	type Subscription,
} from "@bilibili-notify/internal";
import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import {
	type EffectiveMembershipTemplate,
	templateDefaultsFor,
} from "@bilibili-notify/internal/texts/builtin";
import { builtinPersonasOf, resolveAiOverride } from "../runtime/ai-config.js";
import type { CustomLiveMsgLike, PickLiveCover, SpecialViewerSettings } from "./live-types";

/**
 * 一条订阅折好的**直播设置** —— 开播 / 正在直播 / 下播三张卡共用的那几格(ADR-0019 决策 65 / 67):
 * 两个特性开关、卡片样式(订阅的直播封面)、皮肤、消息版式、三句文案模板,以及推送频率 / 重启补推 /
 * 断流接续这几格按 UP 折好的值。
 *
 * 字段在这里显式写出,核心场次、推送与互动共用这一份。
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

/**
 * 附加项的开关(ADR-0016):挂在某把主特性下面、与本体分开发的一条消息。回顾只关心下播那两把
 * (词云 / AI 总结);@全体 那两把归推送层。
 */
export type PushExtrasLike = Record<ExtraKey, boolean>;

export interface CustomLiveSummaryLike {
	liveSummary: string;
}

/**
 * 一条订阅折好的**整份直播设置**(S8):{@link LiveWorkSettings} 那几格加上直播互动与回顾要的 ——
 * 四把互动开关(会员 / 醒目留言 / 特别弹幕 / 特别进场)、附加项、特别关注两块(名单加各自文案)、总结模板、
 * 醒目留言门槛、词云停用词。核心的直播互动入口与回顾收集器、B 站直播间都从
 * {@link liveSettingsOf} 拿,别抄第二份。
 */
export interface LiveSettings extends LiveWorkSettings {
	/** 这条订阅真有 per-UP 覆盖时才有;没有就让 AI 生成器跟随当前全局配置。 */
	aiOverride?: CommentaryCallOverride;
	membership: boolean;
	/**
	 * 会员门槛,按体系 id 记最低档(`defaults.membership.minRank` 折上订阅覆盖后的生效值)。某体系没键 = 全推。
	 * 字段名是表外的(`minRank` 单拎出来会被误读成醒目留言的金额门槛),交付时列给主人可否决。
	 */
	membershipMinRank: Record<string, number>;
	/**
	 * 会员文案,按体系 id 取整份(`templates.membership[体系 id]`,订阅覆盖哪个体系就整份换成订阅的)。
	 * 字段名同上,表外、可否决。
	 */
	membershipTemplates: (programId: string) => EffectiveMembershipTemplate;
	superchat: boolean;
	/**
	 * 特别弹幕 / 特别进场的开关(`eff.features.viewerChat` / `viewerEnter`)。要不要监听直播间是「开关 ∧ 名单上有人带它」
	 * (internal 的 `needsLiveMonitor`),名单在 {@link specialViewerChat} / {@link specialViewerEnter}。
	 */
	viewerChat: boolean;
	viewerEnter: boolean;
	/** 见 {@link PushExtrasLike}。宿主折叠 `eff.features.extras` 后整份填入。 */
	extras: PushExtrasLike;
	customLiveSummary: CustomLiveSummaryLike;
	specialViewerChat: SpecialViewerSettings;
	specialViewerEnter: SpecialViewerSettings;
	/** 醒目留言门槛:金额低于它不推,按人民币元算;没配 = 不设门槛。 */
	minSuperchatAmount?: number;
	/**
	 * 该 UP 解析后的弹幕词云额外停用词(英文逗号分隔)。下播 dispatch 时对热词再过滤一遍,使 per-UP 覆盖
	 * 在该 UP 的词云 / 总结热词上额外生效。undefined / 空 = 不额外过滤。
	 */
	wordcloudStopWords?: string;
}

/** 这位 UP 要不要采集弹幕(词云 / 总结的原料):下播开着,且下播那两个附加项至少一个开着。 */
export function wantsLiveEndExtras(
	settings: Pick<LiveSettings, "liveEnd"> & {
		extras: Pick<PushExtrasLike, "wordcloud" | "liveSummary">;
	},
): boolean {
	return settings.liveEnd && (settings.extras.wordcloud || settings.extras.liveSummary);
}

/**
 * 一条订阅(任何来源的)→ 整份直播设置(ADR-0019 决策 65 / 67;S8)。核心的场次 / 推送 / 互动都从这里拿,
 * 别抄第二份 —— 与 `postSettingsOf` 同一个道理:两份的话主人给某个
 * 抖音号换的文案 / 版式 / 推送频率,迟早有一格只有 B 站那头认。
 *
 * `eff` 给了就不再折一遍。
 */
export function liveSettingsOf(
	sub: Subscription,
	globals: GlobalSettings,
	eff: EffectiveSubscription = resolve(sub, globals.defaults),
): LiveSettings {
	// 文字模板设置里只存主人改过的:缺的此刻按当前语言取出厂,不写盘(换语言立即生效)。
	const templates = resolveTemplates(
		sub,
		globals.defaults,
		templateDefaultsFor(textSettingsOf(globals).locale),
	);
	return {
		aiOverride: resolveAiOverride(sub, globals.ai, builtinPersonasOf(globals)),
		// 特性布尔 = features.X(source-side gate)。routing 由推送层 PushRouter 在每个锚点发出
		// 时按 routing 空 = 无 dispatcher 自然兜底,这里不再 AND routing。即:features.X=true / routing.X=[] 的
		// UP 也开 WS / build payload,加 routing 后下一次事件立即生效。
		liveStart: eff.features.liveStart,
		liveStreaming: eff.features.liveStreaming,
		liveEnd: eff.features.liveEnd,
		membership: eff.features.membership,
		// 会员门槛与文案都按体系 id 存好;核心按事件带来的 `program` 取自己那一格,不认识任何平台的体系名。
		membershipMinRank: eff.membership.minRank,
		membershipTemplates: templates.membership,
		superchat: eff.features.superchat,
		viewerChat: eff.features.viewerChat,
		viewerEnter: eff.features.viewerEnter,
		// 四把附加项整份下发(ADR-0016);回顾只读下播那两把,@全体 归推送层。
		extras: eff.features.extras,
		// 直播封面:订阅自己设的列表原样给(没设 = undefined,跟全局;空列表 = 不用自定义封面),取法见
		// `rotateLiveCover`。🪦 这里从前还映射一份带 `font` / `fontAsset` 的样式对象:字体 2026-09-14 退役成皮肤
		// 自己的旋钮,那两格再没有读者,别加回来(字段留在 schema 里只为老配置装得进来)。
		liveCoverImageIds: sub.overrides.cards?.liveCoverImageIds,
		// Per-UP 调度(per-UP ?? 全局,resolve 已折算)。核心场次与推送每次现折这份设置。
		streamingIntervalHours: eff.liveStreaming.streamingIntervalHours,
		catchUpOnBoot: eff.liveStart.catchUpOnBoot,
		// 断流接续:该 UP 下播是否先挂起等待重开。
		liveEndGrace: eff.schedule.liveEndGrace,
		liveEndGraceMinutes: eff.schedule.liveEndGraceMinutes,
		// 无开关:始终下发 eff 模板(eff 合并 per-UP override → 全局),与 liveSummary 同模式。
		customLiveMsg: {
			customLiveStart: templates.liveStart,
			customLiveStreaming: templates.liveStreaming,
			customLiveEnd: templates.liveEnd,
		},
		customLiveSummary: {
			liveSummary: templates.liveSummary,
		},
		// per-UP 解析后的卡片皮肤 id(eff = per-UP 指了就是它,否则全局)。
		cardSkin: eff.cardSkin,
		// 这位 UP 自己那层旋钮覆盖,原样给、不折全局(理由同 `postSettingsOf` 那一格)。
		// 开播 / 直播中 / 下播 / SC / 上舰 / 词云都吃这一份(不分卡种)。
		cardSkinKnobs: sub.overrides.cardSkinKnobs,
		// per-UP 解析后的消息版式直播切片(覆盖开播 / 直播中 / 下播),恒有值。
		messageLayout: eff.messageLayout.live,
		// 门槛是折好的生效值,没配 = 不设门槛。
		minSuperchatAmount: eff.superchat.minAmount,
		// per-UP 解析后的弹幕词云额外停用词(eff = per-UP override ?? 全局)。
		wordcloudStopWords: templates.wordcloudStopWords,
		// 两块设置同带一份名单(条目自己说带哪把特性键),各配各的文案。
		specialViewerChat: {
			specialViewers: sub.specialViewers,
			template: templates.viewerChat,
		},
		specialViewerEnter: {
			specialViewers: sub.specialViewers,
			template: templates.viewerEnter,
		},
	};
}

/**
 * 折好的直播设置的**缓存读口**(与 `stats/enabled.ts` 同一个做法)。
 *
 * `globals()` 每读一次是整份深拷贝,而 `liveSettingsOf` 还要再折四遍;互动每条弹幕报一次、
 * 推送每两秒报一份人数,现折是白做 —— 设置只在保存时才变。宿主建一份,场次 / 推送 / 互动
 * 共用;删掉的订阅随对象回收。
 */
export interface LiveSettingsCache extends Disposable {
	/** 这条订阅此刻折好的设置;同一个订阅对象在 globals 变之前拿到的是同一份。 */
	of(sub: Subscription): LiveSettings;
}

/**
 * 按 **`Subscription` 对象身份**缓存:订阅仓每次改动都整条换新对象(内容没变不换),所以订阅
 * 改了自然不命中,不用另听 `subscription-changed`。核心设置变了(总线上 `config-changed` 的
 * `globals`)整张换新 —— 语言与 AI 人格都在 globals 里,没有别的作用域会影响折出来的结果。
 *
 * 返回的设置从此在调用方之间共享,**谁都不许就地改它**。
 */
export function createLiveSettingsCache(opts: {
	bus: MessageBus;
	getGlobals: () => GlobalSettings;
}): LiveSettingsCache {
	let bySubscription = new WeakMap<Subscription, LiveSettings>();
	const subscription = opts.bus.on("config-changed", ({ scope }) => {
		if (scope === "globals") bySubscription = new WeakMap();
	});
	return {
		of(sub) {
			let settings = bySubscription.get(sub);
			if (!settings) {
				settings = liveSettingsOf(sub, opts.getGlobals());
				bySubscription.set(sub, settings);
			}
			return settings;
		},
		dispose() {
			subscription.dispose();
		},
	};
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
