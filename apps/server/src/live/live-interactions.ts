import type { ImageRenderer } from "@bilibili-notify/image";
import {
	type Disposable,
	fail,
	type ImageRef,
	type LiveInteractionReport,
	type Logger,
	type MessageLayoutSegment,
	type Result,
	type ServiceContext,
	type Subscription,
	type SuperchatEvent,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { LOOKUP_TIMEOUT_MS } from "../integrations/lookup-timeout.js";
import { extensionSubscriptionName } from "../runtime/extension-push-common.js";
import { callSource, type SourceGates } from "../subscriptions/call-source.js";
import type { SourceView } from "../subscriptions/registry.js";
import type { SourceStatusReader } from "../subscriptions/source-status.js";
import { errorMessageOf } from "../util/error-message.js";
import type { LiveNotifySend, LiveTextPushType } from "./live-notify.js";
import { type LiveSessionEngine, liveSubscriptionPushable } from "./live-sessions.js";
import { type LiveSettings, wantsLiveEndExtras } from "./live-settings.js";
import type { LiveTable } from "./live-table.js";
import { LivePushType } from "./live-types.js";
import type { ViewerChatCollector } from "./recap/viewer-chat-collector.js";
import { pushViewerChat, pushViewerEnter } from "./special-viewers.js";
import { pushSuperchat } from "./superchat.js";

/**
 * **来源报上来的观众互动**(`ctx.reportLiveInteraction`,R4 甲):核心按身份展开成每条订阅一份后到这里,
 * 这里对着**这条订阅现折的设置**判 —— 订阅还该不该推(在、启用着、来源在跑)、这一把特性开关开没开、
 * 特别关注名单上有没有这位观众(按 `viewer.id` 整串认)。开关与名单两样都要;推什么交给特别弹幕 / 特别进场的装配
 * ({@link pushViewerChat} / {@link pushViewerEnter}),发送绑到这条订阅上。
 *
 * 本提交开 `viewerChat`、`viewerEnter`、`superchat`;会员随后追加。
 *
 * **回顾的弹幕收集归核心**:场次开了登记,这一场里每条弹幕记一条(条件同 {@link wantsLiveEndExtras}:下播开着、
 * 词云或总结至少一个开着,不论发弹幕的人在不在名单),醒目留言的正文也记一条;场次结束清掉。没有这一场
 * (场次没开)的弹幕不记,免得攒出一份没人清的数据。B 站老引擎到 22-10 前仍用自己那份收集器。
 */

type InteractionSettings = Pick<
	LiveSettings,
	| "liveEnd"
	| "superchat"
	| "minSuperchatAmount"
	| "extras"
	| "viewerChat"
	| "viewerEnter"
	| "cardSkin"
	| "cardSkinKnobs"
	| "customSpecialDanmakuUsers"
	| "customSpecialUsersEnterTheRoom"
>;

export interface LiveInteractionsOptions {
	logger: Logger;
	/** 此刻的这条订阅(现取)。 */
	subscription(id: string): Subscription | undefined;
	/** 这条订阅折好的直播设置(现折,见 `liveSettingsOf`)。 */
	settings(sub: Subscription): InteractionSettings;
	/** 来源在不在跑(现取)。 */
	sourceStatus: Pick<SourceStatusReader, "running">;
	/** 在播表:主播名先取这一场详情里的。 */
	table: Pick<LiveTable, "get">;
	/** 订阅资料里的名字(资料缓存,现取)。 */
	profileName(id: string): string | undefined;
	/** 订阅资料里的头像引用(资料缓存,现取);没有就不带。 */
	profileAvatar(id: string): ImageRef | undefined;
	/** 来源的登记视图(现取):互动的懒取口从这一份上拿。 */
	source(sourceKey: string): Pick<SourceView, "liveInteractions"> | undefined;
	/** 按来源键的串行闸(宿主里一份,与搜人、查直播状态共用)。 */
	gates: SourceGates;
	/** 出醒目留言卡的渲染器;null = 出不了卡,只发一句文字。 */
	renderer(): Pick<ImageRenderer, "generateSuperchatCard"> | null;
	/** 绑到这条订阅上的直播发送(`boundLivePush(push, id)`)。 */
	sendFor(subscriptionId: string): LiveNotifySend;
	/** 场次 —— 回顾的弹幕收集跟着场次登记与清掉。 */
	sessions: Pick<LiveSessionEngine, "onChange">;
	/** 回顾的弹幕收集器(核心这一份)。 */
	collector: Pick<ViewerChatCollector, "register" | "recordViewerChat" | "clear">;
	/** 每条互动文字是发出去不等的后台活,登记进 `track`,关停等它推完(推送落历史的那一笔得赶在各写道关门之前交进去)。 */
	serviceCtx: Pick<ServiceContext, "track" | "signal">;
}

export interface LiveInteractions extends Disposable {
	/** 一条订阅的一份互动上报。订阅不在 / 停用 / 来源没在跑 / 开关关着 / 名单没有这个人,都是什么都不做。 */
	apply(subscriptionId: string, report: LiveInteractionReport): void;
}

export function createLiveInteractions(opts: LiveInteractionsOptions): LiveInteractions {
	const log = opts.logger;
	/** 此刻开着一场、收集器登记着的订阅。 */
	const active = new Set<string>();
	let disposed = false;

	/** 把「推一句文字」绑到这条订阅上:过推送层,出错记日志、不重试。 */
	const textSender = (id: string, type: LiveTextPushType) => (text: string) => {
		if (disposed) return;
		opts.serviceCtx.track(
			opts
				.sendFor(id)([[{ kind: "text", text }]], type)
				.catch((err) => {
					log.error(
						`[live-interactions] 订阅 ${id} 的互动推送出错(不重试): ${errorMessageOf(err)}`,
					);
				}),
		);
	};

	/** 醒目留言:一张卡或一句文字,都算一次醒目留言推送。发送出错记日志、不重试。 */
	const superchatSender = (id: string) => (segment: MessageLayoutSegment) => {
		if (disposed) return Promise.resolve();
		return opts
			.sendFor(id)([[segment]], LivePushType.Superchat)
			.catch((err) => {
				log.error(
					`[live-interactions] 订阅 ${id} 的醒目留言推送出错(不重试): ${errorMessageOf(err)}`,
				);
			});
	};

	const watch = opts.sessions.onChange((change) => {
		switch (change.kind) {
			case "start":
				// 新的一场从零记起。
				opts.collector.clear(change.subscriptionId);
				opts.collector.register(change.subscriptionId);
				active.add(change.subscriptionId);
				return;
			case "end":
				active.delete(change.subscriptionId);
				opts.collector.clear(change.subscriptionId);
				return;
			default:
				return;
		}
	});

	return {
		apply(subscriptionId, report) {
			if (disposed) return;
			const sub = opts.subscription(subscriptionId);
			if (!liveSubscriptionPushable(sub, opts.sourceStatus)) {
				log.debug(
					`[live-interactions] 订阅 ${subscriptionId} 不在 / 停用了 / 来源没在跑,${report.kind} 不收`,
				);
				return;
			}
			const settings = opts.settings(sub);
			// 主播名:这一场详情里的 → 资料里的 → 外部 id(同直播卡)。
			const creator = {
				name: extensionSubscriptionName(sub, {
					eventName: opts.table.get(subscriptionId)?.details.creator?.name,
					profileName: opts.profileName(subscriptionId),
				}),
			};
			switch (report.kind) {
				case "viewerChat":
					if (active.has(subscriptionId) && wantsLiveEndExtras(settings)) {
						opts.collector.recordViewerChat(subscriptionId, report.text, report.viewer.name);
					}
					// 开关与名单两样都要;不按推送目标挡(没配目标由推送层记成「无目标」)。
					if (!settings.viewerChat) return;
					pushViewerChat(
						{
							viewer: report.viewer,
							text: report.text,
							settings: settings.customSpecialDanmakuUsers,
							creator,
						},
						{ send: textSender(subscriptionId, LivePushType.ViewerChat) },
					);
					return;
				case "viewerEnter":
					if (!settings.viewerEnter) return;
					pushViewerEnter(
						{
							viewer: report.viewer,
							settings: settings.customSpecialUsersEnterTheRoom,
							creator,
						},
						{ send: textSender(subscriptionId, LivePushType.ViewerEnter) },
					);
					return;
				case "superchat": {
					// 回顾收集照今天的规矩:醒目留言的正文也算一份弹幕原料,与推不推这一条无关。
					if (active.has(subscriptionId) && wantsLiveEndExtras(settings)) {
						opts.collector.recordViewerChat(subscriptionId, report.text, report.viewer.name);
					}
					if (!settings.superchat) return;
					const { kind: _kind, fallbackText, ...event } = report;
					const avatar = opts.profileAvatar(subscriptionId);
					const reader = opts.source(sub.identity.sourceKey)?.liveInteractions;
					opts.serviceCtx.track(
						pushSuperchat(
							{
								event: { subscriptionId, ...event } satisfies SuperchatEvent,
								minAmount: settings.minSuperchatAmount,
								creator: {
									name: creator.name,
									...(avatar === undefined ? {} : { avatar }),
								},
								cardSkin: settings.cardSkin,
								cardSkinKnobs: settings.cardSkinKnobs,
								// 来源拼好的平台叫法优先;没给就用核心字典里一句中性的。
								fallbackText:
									fallbackText ??
									t("live.superchatFallback", {
										name: creator.name,
										viewer: report.viewer.name,
										text: report.text,
									}),
							},
							{
								renderer: opts.renderer(),
								// 懒取:确定要出卡才问来源;没交这一口就是卡上没有观众头像。
								async fetchViewerAvatar() {
									if (!reader) return undefined;
									// 经宿主调来源的公共外壳:超时、抛错都收成失败;再进同一来源的串行门(搜人、查直播状态共用)。
									const got = await opts.gates.run(sub.identity.sourceKey, () =>
										callSource<Result<{ ref: ImageRef }>>({
											logger: log,
											sourceKey: sub.identity.sourceKey,
											member: "liveInteractions.fetchViewerAvatar",
											timeoutMs: LOOKUP_TIMEOUT_MS,
											call: (sourceSignal) =>
												reader.fetchViewerAvatar(sub.identity, report.viewer.id, sourceSignal),
											signal: opts.serviceCtx.signal,
											onAbort: () => fail("unavailable", "the call was cancelled by the host"),
											onTimeout: () => {
												log.error(
													`[live-interactions] 订阅 ${subscriptionId} 取观众头像超时(${LOOKUP_TIMEOUT_MS / 1000} 秒)`,
												);
												return fail("timeout", "the source did not answer in time");
											},
											onThrow: () => fail("unavailable", "the source threw"),
										}),
									);
									if (!got.ok) {
										log.debug(
											`[live-interactions] 订阅 ${subscriptionId} 的观众头像取不到: ${got.message}`,
										);
										return undefined;
									}
									return got.ref;
								},
								send: superchatSender(subscriptionId),
								logger: log,
							},
						).catch((err) => {
							log.error(
								`[live-interactions] 订阅 ${subscriptionId} 的醒目留言推送出错(不重试): ${errorMessageOf(err)}`,
							);
						}),
					);
					return;
				}
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			watch.dispose();
			active.clear();
		},
	};
}
