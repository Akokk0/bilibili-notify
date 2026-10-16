import {
	type AiSubscriptionView,
	type CreatorReader,
	creatorOf,
	type LiveNowView,
} from "@bilibili-notify/ai";
import {
	BILIBILI_SOURCE_KEY,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { extensionSubscriptionName } from "../runtime/extension-push-common.js";
import { type ExternalIdSpec, externalIdRefusal } from "../subscriptions/external-id.js";

/**
 * 只按**真正读到的那点东西**声明依赖,而不是整个 `SubscriptionStore` /
 * `SubRuntimeStore`。这两个 store 各带十来个写方法,全要过来等于宣称本模块
 * 可能改数据 —— 而这是「只读档」的接线处,签名本身就该说清它做不到写。
 * 顺带让测试不必为了调一个纯投影函数去伪造一整个 store。
 */
interface SubscriptionReader {
	list(): Subscription[];
}
interface ProfileSource {
	get(id: string): { cachedProfile?: { name?: string } } | undefined;
}
/** 来源登记表里读得到的那一点:描述符的 `label` 与外部 id 的格式(给 {@link CreatorReader.externalIdFits})。 */
interface SourceDescriptorSource {
	get(sourceKey: string): { descriptor: ExternalIdSpec } | undefined;
}

/**
 * 拓展订阅此刻在不在播从哪儿取(ADR-0019 决策 64 的 09-24 🔗):BN 手里的在播表(拓展报的开播 / 直播状态)
 * 与「这个拓展在不在跑」—— 拓展停了,它名下的在播状态就作废了(决策 61),这时答「不知道」而不是「未开播」。
 */
export interface ExtensionLiveSource {
	/** 在播表里这条订阅的那一行(在播才有)。 */
	row(
		subscriptionId: string,
	): { title?: string; startedAt?: number; totalViewers?: number } | undefined;
	/** 这个拓展此刻在跑吗。 */
	running(extensionId: string): boolean;
}

/**
 * B 站订阅此刻在不在播从哪儿取:直播引擎列出来的在播房间(只列在播的,面板「正在直播」读的同一份)。
 * 房间快照里的 `uid` / `roomId` 视图不要 —— 对订阅靠订阅自己的 id;`startedAt` 是 ISO 字符串。
 *
 * 过渡:3b-22 把 B 站的直播并进在播表之后,B 站和拓展读同一张表,这一支就不用分了。
 */
export type BiliLiveRoomsReader = () => ReadonlyArray<{
	subscriptionId: string;
	title?: string;
	startedAt?: string;
}>;

/**
 * 把订阅**查询**能力接给女仆 —— 独立端唯一的 `setCreatorReader` 调用处。
 *
 * 「只读」如今是**结构性**的:`CommentaryGenerator` 的工具表里根本没有会改订阅
 * 的工具了(三个写工具已整体下架,见 `packages/ai/src/tools.ts`)。这与从前不同
 * —— 从前只读是靠这里少传一个 `subMgmt` 字段换来的,那是个一改就破的约定。
 *
 * 读口是**必须**接的:不接的话连 list_subscriptions 都查不到,女仆会一口
 * 咬定「当前没有订阅」,而主人明明订了十几个 —— 那种答案比不会答更糟,因为它
 * 听起来像个事实。
 */
export function attachReadOnlyTools(
	engine: { setCreatorReader(reader: CreatorReader): void },
	stores: {
		subscriptionStore: SubscriptionReader;
		subRuntimeStore: ProfileSource;
		/** 订阅所属平台的叫法(问来源登记表,见 `subscriptions/platform-label.ts`)。 */
		platformLabel: (sourceKey: string) => string;
		sources: SourceDescriptorSource;
		extensionLive?: ExtensionLiveSource;
		biliLiveRooms?: BiliLiveRoomsReader;
	},
): void {
	// 每次工具调用现取,不是接线那一刻的快照:接线发生在启动时,订阅却是
	// 运行期随时增删的。
	engine.setCreatorReader({
		subscriptions: () =>
			aiSubscriptionViews(
				stores.subscriptionStore,
				stores.subRuntimeStore,
				stores.platformLabel,
				stores.extensionLive,
				stores.biliLiveRooms,
			),
		externalIdFits: (sourceKey, externalId) =>
			externalIdRefusal(stores.sources.get(sourceKey)?.descriptor, externalId) === undefined,
	});
}

/** 拓展订阅此刻的在播(见 {@link ExtensionLiveSource})。 */
function extensionLiveNow(
	live: ExtensionLiveSource,
	subscriptionId: string,
	extensionId: string,
): LiveNowView {
	if (!live.running(extensionId)) return { state: "unknown" };
	const row = live.row(subscriptionId);
	if (!row) return { state: "idle" };
	return {
		state: "live",
		title: row.title,
		startedAt: row.startedAt,
		totalViewers: row.totalViewers,
	};
}

/** B 站订阅此刻的在播:在播房间里有它就是在播,没有就是没开播(房间表只列在播的)。 */
function biliLiveNow(rooms: ReturnType<BiliLiveRoomsReader>, subscriptionId: string): LiveNowView {
	const room = rooms.find((r) => r.subscriptionId === subscriptionId);
	if (!room) return { state: "idle" };
	const startedAt = room.startedAt === undefined ? Number.NaN : Date.parse(room.startedAt);
	return {
		state: "live",
		title: room.title,
		startedAt: Number.isNaN(startedAt) ? undefined : startedAt,
	};
}

/**
 * 订阅配置 → AI 工具看得懂的视图。
 *
 * `post` / `live` 的口径是「该特性下**有没有推送目标**」而不是配置里的开关:
 * 一个特性配了却没有任何目标,推不出去任何东西,对女仆来说就等于没订。`live`(「直播 ✓」)是直播类推送:
 * 开播(`liveStart`)或周期「正在直播」(`liveStreaming`)任一有目标就算。
 *
 * 名字按「平台资料缓存 → 外部 id」取(两支同一条,走 `extensionSubscriptionName`;主人填的备注是自由文字,
 * 不当名字用)。cachedProfile 是外置的运行时数据(不在 Subscription 里),与 `/api/subscriptions` 的 join 同源。
 *
 * 每条订阅同一种形状(ADR-0030 决策 1):`creator` 是「来源键:外部 id」,平台名由宿主递进来的函数取
 * (它问来源登记表),视图本身不认哪个来源是哪个平台。在播一格:拓展接在播表,B 站接直播引擎在播的房间
 * (过渡,见 {@link BiliLiveRoomsReader});都没接上时没有这一格。
 */
export function aiSubscriptionViews(
	subscriptionStore: SubscriptionReader,
	subRuntimeStore: ProfileSource,
	platformLabel: (sourceKey: string) => string,
	extensionLive?: ExtensionLiveSource,
	biliLiveRooms?: BiliLiveRoomsReader,
): AiSubscriptionView[] {
	// 在播房间一次工具调用只取一遍,不在每条订阅里各取一次。
	const biliRooms = biliLiveRooms?.();
	const view: AiSubscriptionView[] = [];
	for (const sub of subscriptionStore.list()) {
		// 停用的订阅不进视图:主人把某个 UP 关掉了,女仆的答案里就不该还有他。
		if (!sub.enabled) continue;
		const identity = subscriptionIdentityOf(sub);
		const liveNow: LiveNowView | undefined =
			identity.sourceKey === BILIBILI_SOURCE_KEY
				? biliRooms && biliLiveNow(biliRooms, sub.id)
				: extensionLive && extensionLiveNow(extensionLive, sub.id, identity.sourceKey);
		view.push({
			creator: creatorOf(identity.sourceKey, identity.externalId),
			name: extensionSubscriptionName(sub, {
				profileName: subRuntimeStore.get(sub.id)?.cachedProfile?.name,
			}),
			platform: platformLabel(identity.sourceKey),
			post: sub.routing.post.length > 0,
			live: sub.routing.liveStart.length > 0 || sub.routing.liveStreaming.length > 0,
			...(liveNow ? { liveNow } : {}),
		});
	}
	return view;
}
