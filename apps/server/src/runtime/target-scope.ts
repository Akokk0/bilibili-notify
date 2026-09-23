/**
 * 「这条订阅这把特性键路由到哪些目标」+「这个目标现在还该不该收」—— 折成一张
 * **随 `config-changed` 失效**的快照。
 *
 * 为什么不每次现问 ConfigStore:`getSubscriptions` / `getTargets` / `getConnections`
 * 三个 getter **全是 `deepClone`**(structuredClone 整份集合)。人工重推那道闸要为
 * **每一行**失败的历史各问一次,而这个功能要解的场景(bot 离线一段时间)恰恰是
 * 「一整页全红」—— 面板一次拿 200 行,就是 600 份订阅 / 目标 / 连接副本,而订阅里
 * 还装着 per-UP 的 templates / cardStyle / extras。闸越往后加条件,每行付的钱越多。
 *
 * 形状照着 `link-scope.ts` 的 `resolveLinkParsingPolicies` 来:把配置折成一张
 * 查表,只在配置真的变了时重建。
 *
 * 🔴 **惰性建、不预建**。`createAppRuntime` 跑在 `configStore.load()` **之前**,而
 * `load()` 不 emit `config-changed`(它只 `touch` 元数据)。在那一刻先算一张,这张
 * 表就会永远是空的 —— 症状是每一行的重推按钮都灰着,理由写「路由里把它去掉了」,
 * 而配置文件里明明配着。`engines.ts` 那张 linkPolicies 敢预建,是因为引擎整个挂在
 * load 之后。
 */

import type {
	Connection,
	FeatureKey,
	MessageBus,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";
import { isBiliSubscription, isTargetPaused } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";

/** 折好的一张答案表。几问都是 O(1) 查表,不含任何深拷贝。 */
export interface TargetScopeTable {
	/**
	 * 这条订阅(按订阅自己的 id,ADR-0019 决策 50)这把特性键**当前**路由到哪些目标;
	 * 没有这条订阅就是空。
	 */
	routedTargets(subscriptionId: string, feature: FeatureKey): readonly string[];
	/**
	 * 历史行记下的那条订阅**现在**是哪一条,回它的 id(决策 50:重推先按 `subscriptionId`
	 * 找、找不到再按身份找 —— 删了又重加的 UP,旧历史照样能重推)。
	 *
	 * id 还在就是它;不在了就找第一个 uid 相同的 **B 站**订阅(同一个 uid 两条时先出现的
	 * 说了算);都没有回 undefined。拓展订阅的外部 id 恰好等于那串 uid 也不算 —— 那是
	 * 另一个平台上的另一个人。
	 */
	currentSubscriptionOf(row: { subscriptionId: string; uid: string }): string | undefined;
	/**
	 * 目标与它所属的连接都还启用着。
	 *
	 * 🔴 **与 `NotificationSink.isEnabled`(`sink/multiplex.ts`)同一口径**,两边都是
	 * `!isTargetPaused(target, connections)`。它多一个条件而这儿没跟上时,重推的闸会
	 * 静默留在旧口径上 —— `target-scope.test.ts` 里有一条拿真 sink 对答案的守卫钉着。
	 */
	targetEnabled(targetId: string): boolean;
}

export interface ResolveTargetScopeInput {
	subscriptions: readonly Subscription[];
	targets: readonly PushTarget[];
	connections: readonly Connection[];
}

/** 纯函数那一半:三份配置 → 一张表。 */
export function resolveTargetScope({
	subscriptions,
	targets,
	connections,
}: ResolveTargetScopeInput): TargetScopeTable {
	// 路由按订阅自己的 id 收**全部**订阅(ADR-0019 决策 50):同一个 UP 的两条订阅各有各的路由。
	const routing = new Map<string, Subscription["routing"]>();
	// 身份那一问只认 B 站:拓展订阅没有 uid,外部 id 恰好是同一串数字也不是同一个人。
	// 同一个 uid 两条时**先出现的那条说了算** —— 与从前按 uid 找订阅的口径一致。
	const byUid = new Map<string, string>();
	for (const sub of subscriptions) {
		routing.set(sub.id, sub.routing);
		if (isBiliSubscription(sub) && !byUid.has(sub.uid)) byUid.set(sub.uid, sub.id);
	}
	const enabled = new Set<string>();
	for (const target of targets) if (!isTargetPaused(target, connections)) enabled.add(target.id);
	return {
		routedTargets: (subscriptionId, feature) => routing.get(subscriptionId)?.[feature] ?? [],
		currentSubscriptionOf: ({ subscriptionId, uid }) =>
			routing.has(subscriptionId) ? subscriptionId : byUid.get(uid),
		targetEnabled: (targetId) => enabled.has(targetId),
	};
}

export interface CreateTargetScopeOptions {
	configStore: Pick<ConfigStore, "getSubscriptions" | "getTargets" | "getConnections">;
	bus: MessageBus;
}

export interface TargetScope extends TargetScopeTable {
	/** 退订 `config-changed`。 */
	dispose(): void;
}

/**
 * 带失效的那一半:第一次有人问时才折,`config-changed` 一来就整张作废。
 *
 * 只认 `subscriptions` / `targets` / `connections` 三把 —— `globals` 与 `secrets`
 * 进不了这张表,跟着它们重算是白扔(globals 是改一个 AI 人设都会发的高频 scope)。
 */
export function createTargetScope(opts: CreateTargetScopeOptions): TargetScope {
	let table: TargetScopeTable | null = null;
	const handle = opts.bus.on("config-changed", (scope) => {
		if (scope === "subscriptions" || scope === "targets" || scope === "connections") table = null;
	});
	const current = (): TargetScopeTable => {
		table ??= resolveTargetScope({
			subscriptions: opts.configStore.getSubscriptions(),
			targets: opts.configStore.getTargets(),
			connections: opts.configStore.getConnections(),
		});
		return table;
	};
	return {
		routedTargets: (subscriptionId, feature) => current().routedTargets(subscriptionId, feature),
		currentSubscriptionOf: (row) => current().currentSubscriptionOf(row),
		targetEnabled: (targetId) => current().targetEnabled(targetId),
		dispose: () => handle.dispose(),
	};
}
