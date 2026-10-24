import { displayNameOf } from "@bilibili-notify/contract";
import type { ImageRenderer } from "@bilibili-notify/image";
import {
	type Disposable,
	fail,
	type Identity,
	type ImageRef,
	type LiveInteractionReport,
	type Logger,
	type MembershipEvent,
	type MembershipProgram,
	type MembershipTier,
	type MessageLayoutSegment,
	type Result,
	type ServiceContext,
	type Subscription,
	type SuperchatEvent,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { LOOKUP_TIMEOUT_MS } from "../integrations/lookup-timeout.js";
import { callSource, type SourceGates } from "../subscriptions/call-source.js";
import type { SourceView } from "../subscriptions/registry.js";
import type { SourceStatusReader } from "../subscriptions/source-status.js";
import { errorMessageOf } from "../util/error-message.js";
import type { LiveNotifySend, LiveTextPushType } from "./live-notify.js";
import { type LiveSessionEngine, liveSubscriptionPushable } from "./live-sessions.js";
import { type LiveSettings, wantsLiveEndExtras } from "./live-settings.js";
import type { LiveTable } from "./live-table.js";
import { LivePushType } from "./live-types.js";
import { pushMembership } from "./membership.js";
import type { ViewerChatCollector } from "./recap/viewer-chat-collector.js";
import { pushViewerChat, pushViewerEnter } from "./special-viewers.js";
import { pushSuperchat } from "./superchat.js";

/**
 * **来源报上来的观众互动**(`ctx.reportLiveInteraction`,R4 甲):核心按身份展开成每条订阅一份后到这里,
 * 这里对着**这条订阅现折的设置**判 —— 订阅还该不该推(在、启用着、来源在跑)、这一把特性开关开没开、
 * 特别关注名单上有没有这位观众(按 `viewer.id` 整串认)。开关与名单两样都要;推什么交给特别弹幕 / 特别进场的装配
 * ({@link pushViewerChat} / {@link pushViewerEnter}),发送绑到这条订阅上。
 *
 * 四种互动都从这里过:`viewerChat`、`viewerEnter`、`superchat`、`membership`。会员按事件带来的 `program`
 * 在**这条订阅所属来源**的描述符里找体系、再按 `tier.key` 找档;体系 id 全局唯一、档 key 只在体系内唯一。
 *
 * **回顾的弹幕收集归核心**:场次开了登记,这一场里每条弹幕记一条(条件同 {@link wantsLiveEndExtras}:下播开着、
 * 词云或总结至少一个开着,不论发弹幕的人在不在名单),醒目留言的正文也记一条;场次结束清掉。没有这一场
 * (场次没开)的弹幕不记,免得攒出一份没人清的数据。
 */

type InteractionSettings = Pick<
	LiveSettings,
	| "liveEnd"
	| "membership"
	| "membershipMinRank"
	| "membershipTemplates"
	| "superchat"
	| "minSuperchatAmount"
	| "extras"
	| "viewerChat"
	| "viewerEnter"
	| "cardSkin"
	| "cardSkinKnobs"
	| "specialViewerChat"
	| "specialViewerEnter"
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
	/** 订阅身份标签:在播详情的名字与资料名都没有时,文案里的这个是它。 */
	identityLabel(identity: Identity): string;
	/** 订阅资料里的头像引用(资料缓存,现取);没有就不带。 */
	profileAvatar(id: string): ImageRef | undefined;
	/** 来源的登记视图(现取):互动的懒取口与会员体系声明都从这一份上拿。 */
	source(sourceKey: string): Pick<SourceView, "descriptor" | "liveInteractions"> | undefined;
	/** 按来源键的串行闸(宿主里一份,与搜人、查直播状态共用)。 */
	gates: SourceGates;
	/** 出醒目留言 / 会员卡的渲染器;null = 出不了卡,只发一句文字。 */
	renderer(): Pick<ImageRenderer, "generateSuperchatCard" | "generateMembershipCard"> | null;
	/** 自定义会员图网址 → 图库引用(模板里填了图片地址时才用)。 */
	fetchImage(url: string): Promise<Result<{ ref: ImageRef }>>;
	/** 图库引用 → 字节(会员卡的徽章 / 自定义图)。 */
	readImage(ref: ImageRef): Promise<{ bytes: Uint8Array; mime: string } | undefined>;
	/** 绑到这条订阅上的直播发送(`boundLivePush(push, id)`)。 */
	sendFor(subscriptionId: string): LiveNotifySend;
	/** 场次 —— 回顾的弹幕收集跟着场次登记与清掉,这一场的互动汇总也记在这里。 */
	sessions: Pick<LiveSessionEngine, "onChange" | "noteInteraction">;
	/** 回顾的弹幕收集器(核心这一份)。 */
	collector: Pick<ViewerChatCollector, "register" | "recordViewerChat" | "clear">;
	/** 每条互动文字是发出去不等的后台活,登记进 `track`,关停等它推完(推送落历史的那一笔得赶在各写道关门之前交进去)。 */
	serviceCtx: Pick<ServiceContext, "track" | "signal">;
}

export interface LiveInteractions extends Disposable {
	/** 一条订阅的一份互动上报;订阅不在 / 停用 / 来源没在跑就不收。推送开关只决定推不推,场次汇总照记。 */
	apply(subscriptionId: string, report: LiveInteractionReport): void;
}

export function createLiveInteractions(opts: LiveInteractionsOptions): LiveInteractions {
	const log = opts.logger;
	/** 此刻开着一场、收集器登记着的订阅。 */
	const active = new Set<string>();
	let disposed = false;

	/**
	 * 懒取口的两处共用这一段:经宿主调来源的外壳(超时、抛错、中止都收成失败)再进同一来源的串行门。
	 * 拿不到只是卡上少一张图,不抛、不重试。
	 */
	const fetchSourceImage = async (
		subscriptionId: string,
		sourceKey: string,
		member: "liveInteractions.fetchViewerAvatar" | "liveInteractions.fetchTierIcon",
		call: (signal: AbortSignal) => Promise<Result<{ ref: ImageRef }>>,
	): Promise<ImageRef | undefined> => {
		const got = await opts.gates.run(sourceKey, () =>
			callSource<Result<{ ref: ImageRef }>>({
				logger: log,
				sourceKey,
				member,
				timeoutMs: LOOKUP_TIMEOUT_MS,
				call,
				signal: opts.serviceCtx.signal,
				onAbort: () => fail("unavailable", "the call was cancelled by the host"),
				onTimeout: () => {
					log.error(
						`[live-interactions] 订阅 ${subscriptionId} 的 ${member} 超时(${LOOKUP_TIMEOUT_MS / 1000} 秒)`,
					);
					return fail("timeout", "the source did not answer in time");
				},
				onThrow: () => fail("unavailable", "the source threw"),
			}),
		);
		if (!got.ok) {
			log.debug(`[live-interactions] 订阅 ${subscriptionId} 的 ${member} 取不到: ${got.message}`);
			return undefined;
		}
		return got.ref;
	};

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

	/** 会员:一张卡、一句自定义文案或一句兜底,都算一次上舰推送。发送出错记日志、不重试。 */
	const membershipSender = (id: string) => (segments: readonly MessageLayoutSegment[]) => {
		if (disposed) return Promise.resolve();
		return opts
			.sendFor(id)([[...segments]], LivePushType.LiveGuardBuy)
			.catch((err) => {
				log.error(`[live-interactions] 订阅 ${id} 的会员推送出错(不重试): ${errorMessageOf(err)}`);
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
			// 主播名:这一场详情里的 → 资料里的 → 身份标签(同直播卡)。
			const creator = {
				name: displayNameOf(
					{
						eventName: opts.table.get(subscriptionId)?.details.creator?.name,
						profileName: opts.profileName(subscriptionId),
					},
					opts.identityLabel(subscriptionIdentityOf(sub)),
				),
			};
			let recognizedMembership:
				| {
						program: MembershipProgram;
						tier: MembershipTier;
				  }
				| undefined;
			if (report.kind === "membership") {
				const source = opts.source(sub.identity.sourceKey);
				const program = source?.descriptor.membershipPrograms?.find(
					(candidate) => candidate.id === report.program,
				);
				if (program === undefined) {
					log.warn(
						`[live-interactions] 订阅 ${subscriptionId} 认不出会员体系 ${report.program},丢弃这条会员上报`,
					);
					return;
				}
				// 逐档声明:取声明的那一档(名字、rank、档色、徽章都听平台的);custom:档由主播自定,
				// 只能用事件带来的名字与 rank,没有徽章、没有档色。
				const tier: MembershipTier | undefined =
					program.tiers === "custom"
						? {
								key: report.tier.key,
								name: report.tier.name,
								rank: report.tier.rank ?? 0,
							}
						: program.tiers.find((candidate) => candidate.key === report.tier.key);
				if (tier === undefined) {
					log.warn(
						`[live-interactions] 订阅 ${subscriptionId} 的会员体系 ${program.id} 认不出档 ${report.tier.key},丢弃这条会员上报`,
					);
					return;
				}
				recognizedMembership = { program, tier };
			}
			// 统计记的是这一场里发生了什么,与推送开关无关。会员先认出体系与档,认不出就不记。
			opts.sessions.noteInteraction(subscriptionId, report);
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
							settings: settings.specialViewerChat,
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
							settings: settings.specialViewerEnter,
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
									return fetchSourceImage(
										subscriptionId,
										sub.identity.sourceKey,
										"liveInteractions.fetchViewerAvatar",
										(sourceSignal) =>
											reader.fetchViewerAvatar(sub.identity, report.viewer.id, sourceSignal),
									);
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
				case "membership": {
					if (!settings.membership) return;
					const { kind: _kind, fallbackText, ...event } = report;
					if (recognizedMembership === undefined) return;
					const { program, tier } = recognizedMembership;
					const source = opts.source(sub.identity.sourceKey);
					const avatar = opts.profileAvatar(subscriptionId);
					const reader = source?.liveInteractions;
					opts.serviceCtx.track(
						pushMembership(
							{
								event: { subscriptionId, ...event } satisfies MembershipEvent,
								tier,
								minRank: settings.membershipMinRank[program.id],
								template: settings.membershipTemplates(program.id),
								creator: {
									name: creator.name,
									...(avatar === undefined ? {} : { avatar }),
								},
								cardSkin: settings.cardSkin,
								cardSkinKnobs: settings.cardSkinKnobs,
								fallbackText:
									fallbackText ??
									t("live.membershipFallback", {
										name: creator.name,
										viewer: report.viewer.name,
										tier: tier.name,
									}),
							},
							{
								renderer: opts.renderer(),
								async fetchTierIcon() {
									// 来源已经把引用写进自己那档:直接读图库,不再走一趟网络。
									const declared = tier.icon?.ref;
									if (declared !== undefined) return { ref: declared };
									// custom 体系声明不了徽章,也不该替它去问来源。
									if (program.tiers === "custom" || reader === undefined) return undefined;
									const ref = await fetchSourceImage(
										subscriptionId,
										sub.identity.sourceKey,
										"liveInteractions.fetchTierIcon",
										(sourceSignal) =>
											reader.fetchTierIcon(sub.identity, program.id, tier.key, sourceSignal),
									);
									return ref === undefined ? undefined : { ref };
								},
								async fetchViewerAvatar() {
									if (reader === undefined) return undefined;
									return fetchSourceImage(
										subscriptionId,
										sub.identity.sourceKey,
										"liveInteractions.fetchViewerAvatar",
										(sourceSignal) =>
											reader.fetchViewerAvatar(sub.identity, report.viewer.id, sourceSignal),
									);
								},
								fetchImage: opts.fetchImage,
								readImage: opts.readImage,
								send: membershipSender(subscriptionId),
								logger: log,
							},
						).catch((err) => {
							log.error(
								`[live-interactions] 订阅 ${subscriptionId} 的会员推送出错(不重试): ${errorMessageOf(err)}`,
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
