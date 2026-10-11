/**
 * 直播的中立小类型:推送是哪一种、特性键、订阅上的直播卡样式与「特别用户」两块设置的形状。
 * B 站的直播间与拓展订阅的直播共用(ADR-0019 决策 65 / 67),不认 uid、不认房间数据。
 */

/**
 * Push category enum — numeric values are the historical bilibili-notify push-type codes.
 * 只在进程内流转(推送层的翻译表按它分流、日志里打出来),**不落盘、不过 wire**:历史行与订阅、
 * 设置存的都是特性键,所以加一档、删一档都不用迁移。
 *
 * 它说的是「这是哪一种推送」:定特性键、定许不许 @全体。下播的附加项(词云、AI 总结)不是单独的
 * 一种推送,是下播那次推送里的锚点(`LivePushAnchor`),按附加项的键认 —— 原先的 5 / 10 两档
 * 随之删掉,编号空着不复用。
 */
export enum LivePushType {
	/** 周期「正在直播」(`liveStreaming`)。 */
	Live = 0,
	StartBroadcasting = 3,
	LiveGuardBuy = 4,
	Superchat = 6,
	UserDanmakuMsg = 7,
	UserActions = 8,
	LiveEnd = 9,
	/**
	 * 重启补报(`liveStart.catchUpOnBoot`):启动时发现正在播,补一张开播。卡与文字是「正在直播」那一套,
	 * 但走开播(`liveStart`)的目标、历史记成开播、**不 @全体**。与周期那一档({@link Live})分成两档,
	 * 宿主的翻译表才分得出一个归 `liveStart`、一个归 `liveStreaming`。
	 */
	CatchUp = 11,
}

/**
 * Channel-level feature keys (mirror `@bilibili-notify/push`'s `PushFeature`).
 * Each entry on `SubItemView.target` maps to a list of resolved channel
 * identifiers; an empty / missing list means "not subscribed for this feature".
 */
export type LivePushFeature =
	| "post"
	| "liveStart"
	| "liveStreaming"
	| "liveEnd"
	| "membership"
	| "superchat"
	| "specialDanmaku"
	| "specialUserEnter";

/**
 * Master-level feature keys — the boolean toggles set per-UP. Subset of
 * `LivePushFeature` which omits `specialDanmaku` / `specialUserEnter`
 * (those are gated by `customSpecial*.enable` instead).
 */
export type LiveCreatorFeature = Exclude<LivePushFeature, "specialDanmaku" | "specialUserEnter">;

/** Sub-level customisation blocks copied from `@bilibili-notify/push`. */
export interface CustomCardStyleLike {
	enable: boolean;
	// 🪦 `backgroundImage` / `backgroundImages` 2026-09-20 随整条链删掉 —— 背景图归皮肤
	// 自己的 `image` 旋钮(`--bn-knob-wallpaper`),不再从样式覆盖里透传。
	/** 直播卡自定义封面资产 id(独立端专属);透传给 generateLiveCard 的 colorOptions。 */
	liveCoverImage?: string;
	/**
	 * 直播卡自定义封面的**完整**列表(>1 张时「每次推送轮换」,与背景图同一 rotator、
	 * key 维度独立)。adapter 填入;推送点选下一张覆盖 `liveCoverImage`。
	 */
	liveCoverImages?: string[];
	/**
	 * 字体家族名;透传给 generate* 的 colorOptions(缺省回退渲染器全局 config)。
	 *
	 * 这一项此前整条链都漏着:schema 存得下、resolve 算得出,但 adapter 没往这里填、
	 * 类型里也没有 —— 于是「给这位 UP 单独换个字体」选了等于没选。
	 */
	font?: string;
	/** 主人自带字体的资产 id(独立端专属);设了优先于 `font`,缺省回退全局。 */
	fontAsset?: string;
}

/**
 * 直播封面轮换选择器:给定 scopeKey(`uid:live-cover`)与完整图列表,返回本次该用的那张
 * (并在实现内推进游标)。宿主注入(独立端有 fs 持久化游标);返回 undefined = 不轮换。
 *
 * 名字里的 "Background" 是历史:它从前也管卡片背景图轮换,那条链 2026-09-20 删掉了
 * (背景图归皮肤的 `image` 旋钮),今天只剩直播封面在用。
 */
export type PickLiveCover = (scopeKey: string, images: string[]) => string | undefined;

export interface CustomSpecialDanmakuUsersLike {
	enable: boolean;
	specialDanmakuUsers?: string[];
	msgTemplate: string;
}

export interface CustomSpecialUsersEnterTheRoomLike {
	enable: boolean;
	specialUsersEnterTheRoom?: string[];
	msgTemplate: string;
}
