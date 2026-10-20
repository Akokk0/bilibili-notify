import type {
	Disposable,
	LiveInteractionReport,
	Logger,
	ServiceContext,
	Subscription,
} from "@bilibili-notify/internal";
import { extensionSubscriptionName } from "../runtime/extension-push-common.js";
import type { SourceStatusReader } from "../subscriptions/source-status.js";
import { errorMessageOf } from "../util/error-message.js";
import type { LiveNotifySend, LiveTextPushType } from "./live-notify.js";
import { type LiveSessionEngine, liveSubscriptionPushable } from "./live-sessions.js";
import { type LiveSettings, wantsLiveEndExtras } from "./live-settings.js";
import type { LiveTable } from "./live-table.js";
import { LivePushType } from "./live-types.js";
import type { ViewerChatCollector } from "./recap/viewer-chat-collector.js";
import { pushViewerChat, pushViewerEnter } from "./special-viewers.js";

/**
 * **来源报上来的观众互动**(`ctx.reportLiveInteraction`,R4 甲):核心按身份展开成每条订阅一份后到这里,
 * 这里对着**这条订阅现折的设置**判 —— 订阅还该不该推(在、启用着、来源在跑)、这一把特性开关开没开、
 * 特别关注名单上有没有这位观众(按 `viewer.id` 整串认)。开关与名单两样都要;推什么交给特别弹幕 / 特别进场的装配
 * ({@link pushViewerChat} / {@link pushViewerEnter}),发送绑到这条订阅上。
 *
 * 本提交只开 `viewerChat`、`viewerEnter`;醒目留言、会员随后追加。
 *
 * **回顾的弹幕收集归核心**:场次开了登记,这一场里每条弹幕记一条(条件同 {@link wantsLiveEndExtras}:下播开着、
 * 词云或总结至少一个开着,不论发弹幕的人在不在名单),场次结束清掉。没有这一场(场次没开)的弹幕不记,
 * 免得攒出一份没人清的数据。B 站老引擎到 22-10 前仍用自己那份收集器。
 */

type InteractionSettings = Pick<
	LiveSettings,
	| "liveEnd"
	| "extras"
	| "viewerChat"
	| "viewerEnter"
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
	/** 绑到这条订阅上的直播发送(`boundLivePush(push, id)`)。 */
	sendFor(subscriptionId: string): LiveNotifySend;
	/** 场次 —— 回顾的弹幕收集跟着场次登记与清掉。 */
	sessions: Pick<LiveSessionEngine, "onChange">;
	/** 回顾的弹幕收集器(核心这一份)。 */
	collector: Pick<ViewerChatCollector, "register" | "recordViewerChat" | "clear">;
	/** 每条互动文字是发出去不等的后台活,登记进 `track`,关停等它推完(推送落历史的那一笔得赶在各写道关门之前交进去)。 */
	serviceCtx: Pick<ServiceContext, "track">;
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
