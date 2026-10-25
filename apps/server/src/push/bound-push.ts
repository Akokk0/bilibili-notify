import type {
	FeatureKey,
	MessageLayoutSegment,
	NotificationPayload,
	PayloadSegment,
} from "@bilibili-notify/internal";
import type { Push, PushAnchor, PushRouter } from "@bilibili-notify/push";
import type { LiveNotifySend } from "../live/live-notify.js";
import type { PostPushAnchor, PushSegment } from "../posts/post-push.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function pushSegmentsToPayload(segments: PushSegment[]): NotificationPayload {
	if (segments.length === 1 && segments[0]?.kind === "text") {
		return { kind: "text", text: segments[0].text };
	}
	if (segments.length === 1 && segments[0]?.kind === "image") {
		return {
			kind: "image",
			image: { buffer: segments[0].buffer, mime: segments[0].mime },
		};
	}
	if (segments.length === 1 && segments[0]?.kind === "image-group") {
		// segment.mergeForward 由设置里的 imageGroup.mergeForward(全局与逐订阅覆盖)决定:
		//   true  → adapter 走 send_group_forward_msg 合并转发
		//   false → adapter 走多 image segment 合并到一条普通 send_group_msg
		return {
			kind: "image-group",
			images: segments[0].images,
			mergeForward: segments[0].mergeForward,
		};
	}
	const mapped: PayloadSegment[] = [];
	for (const s of segments) {
		if (s.kind === "text") mapped.push({ kind: "text", text: s.text });
		else if (s.kind === "image") mapped.push({ kind: "image", buffer: s.buffer, mime: s.mime });
		else if (s.kind === "image-group") {
			// 混在别的段里的图集降成链接;没有 `url` 的图(只带图库引用)没有链接可给,跳过。
			for (const img of s.images) if (img.url) mapped.push({ kind: "link", href: img.url });
		}
	}
	if (mapped.length === 0) return { kind: "text", text: "" };
	return { kind: "composite", segments: mapped };
}

function collapseSegments(segments: PayloadSegment[]): NotificationPayload {
	if (segments.length === 0) return { kind: "text", text: "" };
	if (segments.length === 1) {
		const only = segments[0];
		if (!only) return { kind: "text", text: "" };
		if (only.kind === "text") return { kind: "text", text: only.text };
		if (only.kind === "image") {
			return { kind: "image", image: { buffer: only.buffer, mime: only.mime } };
		}
	}
	return { kind: "composite", segments };
}

/** 一条直播消息里的中立段 → 推送载荷段;空文字段不进载荷,单图仍由 `collapseSegments` 收成图。 */
function liveSegmentsToPayload(segments: readonly MessageLayoutSegment[]): PayloadSegment[] {
	return segments.flatMap((segment): PayloadSegment[] => {
		if (segment.kind === "text") {
			return segment.text.length > 0 ? [{ kind: "text", text: segment.text }] : [];
		}
		return [{ kind: "image", buffer: segment.buffer, mime: segment.mime }];
	});
}

/**
 * 引擎→推送层的两个适配器。**提成工厂是为了让这一跳自己有守卫** ——
 * 它们原本编在 `createEngines` 里、测试够不着,于是把直播那一跳的翻译整个换掉也没一条
 * 测试会红(2026-09-19 剪线实测:219 个文件全绿)。而那一跳里揣着三样东西,掉了都是
 * 静默的:锚点上附加项的键(掉了按目标收窄全失效)、锚点的角色(图集掉成本体就会
 * 再 @ 一次全体)、`allowAtAll`(掉了「每条直播推送都 @全体」那个修过的 bug 直接回归)。
 * 历史记成什么不另说:它记的就是交出去的那把特性键。
 */
/**
 * 引擎侧的锚点 → 推送层的锚点:角色与附加项的键原样带上,内容(现成的或约定)逐条翻成载荷。
 * 两个适配器共用这一处,内容怎么翻各给各的。
 */
function toPushAnchors<T>(
	anchors: ReadonlyArray<{
		role: PushAnchor["role"];
		extra?: PushAnchor["extra"];
		messages: T[] | Promise<T[] | undefined>;
		/** AI 写的那一份(只有作品本体与直播总结有);没有就不带这一格,不是 `undefined` 值。 */
		aiMessages?: T[] | Promise<T[] | undefined>;
	}>,
	toPayload: (message: T) => NotificationPayload,
): PushAnchor[] {
	const toPayloads = (messages: T[] | Promise<T[] | undefined>) =>
		Array.isArray(messages)
			? messages.map(toPayload)
			: messages.then((made) => made?.map(toPayload));
	return anchors.map(({ role, extra, messages, aiMessages }) => ({
		role,
		extra,
		messages: toPayloads(messages),
		...(aiMessages ? { aiMessages: toPayloads(aiMessages) } : {}),
	}));
}

/**
 * 作品那一路(核心装配 `deliverPost` 依赖里的 `push`):绑到**一条订阅**上(ADR-0019 决策 50 / 66),装配交来的
 * 锚点 → 推送层的一次推送,特性恒为 `post`。B 站动态与拓展作品共用这一跳(都经核心入口 `PostQueue` 的装配)。开关、免扰、路由、@全体、历史都在推送层(`PushRouter.push`)里。
 */
export function boundPostPush(
	push: Pick<PushRouter, "push">,
	subscriptionId: string,
): (anchors: PostPushAnchor[]) => Promise<void> {
	return async (anchors) => {
		await push.push({
			subscriptionId,
			feature: "post",
			anchors: toPushAnchors(anchors, pushSegmentsToPayload),
		});
	};
}

/**
 * 一种直播推送交给推送层时的那两格:特性键({@link liveTypeToFeature}),以及只有开播许 @全体
 * ({@link liveTypeAllowsAtAll})—— 重启补报也走 `liveStart` 那把键,不显式抑制就每条都 @。
 * B 站直播间与拓展订阅的直播共用这一处映射。
 */
function livePushHead(type: number): Pick<Push, "feature" | "allowAtAll"> {
	return {
		feature: liveTypeToFeature(type),
		...(liveTypeAllowsAtAll(type) ? {} : { allowAtAll: false }),
	};
}

/**
 * 直播那一路(`pushLiveNotify` 的 {@link LiveNotifySend}):绑到**一条订阅**上,装配交来的消息组 →
 * 推送层的一次推送(只有本体那一个锚点),特性键与 @全体 照 {@link livePushHead}。拓展订阅的直播用它
 * (ADR-0019 决策 67);中立段在这里直接翻成推送载荷。
 *
 * 一组是一条消息:几组就是本体那个锚点里的一串(推送层的序列语义,同 B 站的「分条」)。
 */
export function boundLivePush(
	push: Pick<PushRouter, "push">,
	subscriptionId: string,
): LiveNotifySend {
	return async (groups, type, extras = []) => {
		const messages = groups.map((segments) => collapseSegments(liveSegmentsToPayload(segments)));
		const anchors: PushAnchor[] = [
			{ role: "main", messages },
			...toPushAnchors(extras, (message) => collapseSegments(liveSegmentsToPayload(message))),
		];
		await push.push({
			subscriptionId,
			...livePushHead(type),
			anchors,
		});
	};
}

/**
 * LivePushType → 特性键(管开关与路由)。周期「正在直播」(0)有自己的 liveStreaming(⑬d 拆键,
 * 各有开关与目标);开播(3)与重启补报(11,补的就是一次开播)走 liveStart。下播的词云 / 总结
 * 不是单独的一种推送:它们是下播(9)那次推送里的附加项锚点,自然跟着下播那把键走。
 */
export function liveTypeToFeature(type: number): FeatureKey {
	switch (type) {
		case 0:
			return "liveStreaming";
		case 3:
		case 11:
			return "liveStart";
		case 4:
			return "membership";
		case 9:
			return "liveEnd";
		case 6:
			return "superchat";
		case 7:
			return "viewerChat";
		case 8:
			return "viewerEnter";
		default:
			return "liveStart";
	}
}

/**
 * 一条 LivePushType 是否允许 @全体成员。仅 `StartBroadcasting`(=3,开播)允许;
 * 重启补报(`CatchUp`=11)也翻译成 `feature === "liveStart"`,光看 feature 区分不出
 * 真开播 vs 补报 —— push 层据本结果决定是否进 atAll 分支,否则每条补报都 @全体
 * (从前周期复推就这么出过 bug)。裸数字 3 = LivePushType.StartBroadcasting,与
 * apps/server/src/live 的 LivePushType 保持一致。
 */
export function liveTypeAllowsAtAll(type: number): boolean {
	return type === 3;
}
