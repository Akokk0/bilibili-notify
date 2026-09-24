import type { ExtensionLiveNow, SubItemView, Subscriptions } from "@bilibili-notify/ai";
import { isBiliSubscription, type Subscription } from "@bilibili-notify/internal";

/**
 * 只按**真正读到的那点东西**声明依赖,而不是整个 `SubscriptionStore` /
 * `SubRuntimeStore`。这两个 store 各带十来个写方法,全要过来等于宣称本模块
 * 可能改数据 —— 而这是「只读档」的接线处,签名本身就该说清它做不到写。
 * 顺带让测试不必为了调一个纯投影函数去伪造一整个 store。
 */
interface SubsSource {
	list(): Subscription[];
}
interface ProfileSource {
	get(id: string): { cachedProfile?: { name?: string } } | undefined;
}
/**
 * 拓展订阅的平台名从哪儿取(那个订阅源清单里的叫法)。取不到(拓展卸载了、装载器还没起来)交
 * `undefined`,视图退拓展 id —— 与面板同一个口径(ADR-0019 决策 10 / 73)。
 */
export interface PlatformLabelSource {
	label(extensionId: string): string | undefined;
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
 * 把订阅**查询**能力接给女仆 —— 独立端唯一的 `setSubscriptionsSource` 调用处。
 *
 * 「只读」如今是**结构性**的:`CommentaryGenerator` 的工具表里根本没有会改订阅
 * 的工具了(三个写工具已整体下架,见 `packages/ai/src/tools.ts`)。这与从前不同
 * —— 从前只读是靠这里少传一个 `subMgmt` 字段换来的,那是个一改就破的约定。
 *
 * `getSubs` 是**必须**接的:不接的话连 list_subscriptions 都查不到,女仆会一口
 * 咬定「当前没有订阅」,而主人明明订了十几个 —— 那种答案比不会答更糟,因为它
 * 听起来像个事实。
 */
export function attachReadOnlyTools(
	engine: { setSubscriptionsSource(getSubs: () => Subscriptions | null): void },
	stores: {
		subscriptionStore: SubsSource;
		subRuntimeStore: ProfileSource;
		platforms?: PlatformLabelSource;
		extensionLive?: ExtensionLiveSource;
	},
): void {
	// 每次工具调用现取,不是接线那一刻的快照:接线发生在启动时,订阅却是
	// 运行期随时增删的。
	engine.setSubscriptionsSource(() =>
		buildAiSubsView(
			stores.subscriptionStore,
			stores.subRuntimeStore,
			stores.platforms,
			stores.extensionLive,
		),
	);
}

/** 拓展订阅此刻的在播(见 {@link ExtensionLiveSource})。 */
function extensionLiveNow(
	live: ExtensionLiveSource,
	subscriptionId: string,
	extensionId: string,
): ExtensionLiveNow {
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

/**
 * 订阅配置 → AI 工具看得懂的视图。
 *
 * `dynamic` / `live` 的口径是「该特性下**有没有推送目标**」而不是配置里的开关:
 * 一个特性配了却没有任何目标,推不出去任何东西,对女仆来说就等于没订。
 *
 * 名字按「主人手填的备注 → 平台资料缓存 → UID 兜底」取(拓展订阅兜底的是外部 id)。
 * cachedProfile 是外置的运行时数据(不在 Subscription 里),与 `/api/subs` 的 join 同源。
 *
 * 按订阅自己的 `id` 为键,两支都收(ADR-0019 决策 64):B 站条目带 `uid`,那几格的含义不变;
 * 拓展条目没有 uid,带平台名与外部 id —— 外部 id 不是 B 站 UID,工具那头据此不拿它去问 B 站;接上了在播来源
 * 时再带上它此刻在不在播(`get_live_status` 照它答)。
 */
export function buildAiSubsView(
	subscriptionStore: SubsSource,
	subRuntimeStore: ProfileSource,
	platforms?: PlatformLabelSource,
	extensionLive?: ExtensionLiveSource,
): Subscriptions {
	const view: Subscriptions = {};
	for (const sub of subscriptionStore.list()) {
		// 停用的订阅不进视图:主人把某个 UP 关掉了,女仆的答案里就不该还有他。
		if (!sub.enabled) continue;
		const cached = subRuntimeStore.get(sub.id)?.cachedProfile?.name?.trim();
		const common = {
			dynamic: sub.routing.dynamic.length > 0,
			live: sub.routing.live.length > 0,
		};
		const item: SubItemView = isBiliSubscription(sub)
			? { uid: sub.uid, uname: sub.name?.trim() || cached || `UID ${sub.uid}`, ...common }
			: {
					platform: platforms?.label(sub.extensionId) || sub.extensionId,
					externalId: sub.externalId,
					uname: sub.name?.trim() || cached || sub.externalId,
					...common,
					...(extensionLive
						? { liveNow: extensionLiveNow(extensionLive, sub.id, sub.extensionId) }
						: {}),
				};
		view[sub.id] = item;
	}
	return view;
}
