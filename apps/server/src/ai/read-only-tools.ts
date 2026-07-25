import type { SubItemView, Subscriptions } from "@bilibili-notify/ai";
import type { Subscription } from "@bilibili-notify/internal";

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
 * 把「只读」的工具能力接给女仆 —— 独立端唯一的 `setSubManagement` 调用处。
 *
 * `CommentaryGenerator` 的工具表是一整套:list_subscriptions / get_user_info /
 * get_live_status 这些只查,subscribe_user / unsubscribe_user /
 * update_subscription 这些真会改订阅。后一类**只在拿到 `subMgmt` 时才可用**,
 * 没有它就统一回「功能不可用」。所以「只读档」不是靠约定,而是靠这里少传一个
 * 字段落实的 —— 也因此它值得单独成一个函数、单独一条测试盯着,而不是散在
 * engines.ts 一千多行里当一句普通接线。
 *
 * 反过来说,`getSubs` 是**必须**接的:不接的话连 list_subscriptions 都查不到,
 * 女仆会一口咬定「当前没有订阅」,而主人明明订了十几个 —— 那种答案比不会答
 * 更糟,因为它听起来像个事实。
 */
export function attachReadOnlyTools(
	engine: { setSubManagement(opts: { getSubs: () => Subscriptions | null }): void },
	stores: { subscriptionStore: SubsSource; subRuntimeStore: ProfileSource },
): void {
	engine.setSubManagement({
		// 每次工具调用现取,不是接线那一刻的快照:接线发生在启动时,订阅却是
		// 运行期随时增删的。
		getSubs: () => buildAiSubsView(stores.subscriptionStore, stores.subRuntimeStore),
	});
}

/**
 * 订阅配置 → AI 工具看得懂的视图。
 *
 * `dynamic` / `live` 的口径是「该特性下**有没有推送目标**」而不是配置里的开关:
 * 一个特性配了却没有任何目标,推不出去任何东西,对女仆来说就等于没订。
 *
 * 名字按「主人手填的备注 → 平台资料缓存 → UID 兜底」取。cachedProfile 是外置的
 * 运行时数据(不在 Subscription 里),与 `/api/subs` 的 join 同源。
 */
export function buildAiSubsView(
	subscriptionStore: SubsSource,
	subRuntimeStore: ProfileSource,
): Subscriptions {
	const view: Subscriptions = {};
	for (const sub of subscriptionStore.list()) {
		// 停用的订阅不进视图:主人把某个 UP 关掉了,女仆的答案里就不该还有他。
		if (!sub.enabled) continue;
		const cached = subRuntimeStore.get(sub.id)?.cachedProfile?.name?.trim();
		const item: SubItemView = {
			uid: sub.uid,
			uname: sub.name?.trim() || cached || `UID ${sub.uid}`,
			dynamic: sub.routing.dynamic.length > 0,
			live: sub.routing.live.length > 0,
		};
		view[sub.uid] = item;
	}
	return view;
}
