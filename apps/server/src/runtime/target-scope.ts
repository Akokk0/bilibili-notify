/**
 * 「这个 uid 这把特性键路由到哪些目标」+「这个目标现在还该不该收」—— 折成一张
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
import { isTargetPaused } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";

/** 折好的一张答案表。两问都是 O(1) 查表,不含任何深拷贝。 */
export interface TargetScopeTable {
	/** 这个 uid 这把特性键**当前**路由到哪些目标;没有这条订阅就是空。 */
	routedTargets(uid: string, feature: FeatureKey): readonly string[];
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
	// 同一个 uid 配了两条订阅时**先出现的那条说了算** —— 与从前那句
	// `getSubscriptions().find((s) => s.uid === uid)` 一字不差。
	const routing = new Map<string, Subscription["routing"]>();
	for (const sub of subscriptions) if (!routing.has(sub.uid)) routing.set(sub.uid, sub.routing);
	const enabled = new Set<string>();
	for (const target of targets) if (!isTargetPaused(target, connections)) enabled.add(target.id);
	return {
		routedTargets: (uid, feature) => routing.get(uid)?.[feature] ?? [],
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
		routedTargets: (uid, feature) => current().routedTargets(uid, feature),
		targetEnabled: (targetId) => current().targetEnabled(targetId),
		dispose: () => handle.dispose(),
	};
}
