import type {
	Connection,
	ExtensionSubscription,
	GlobalConfig,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";

/**
 * Restore planning — turns (current state + imported sections + mode) into a
 * flat set of write operations, as a pure function so the overwrite/merge
 * semantics are testable without touching the config store.
 *
 * - **overwrite**: the backup becomes the state. Each list scope replaces the
 *   current set (upsert everything in the backup, delete current entries the
 *   backup lacks). Globals are applied when the backup carries them.
 * - **merge**: additive only. Each list scope upserts the backup entries and
 *   deletes nothing. Globals are left untouched — merging someone's shared
 *   subscriptions must not clobber your own settings.
 *
 * A scope absent from the backup yields no writes for that scope in either mode.
 *
 * 订阅在备份里是两节(B 站 `subscriptions` / 拓展 `extensionSubscriptions`,ADR-0019 决策 48),
 * **各算各的**:这样凡是没有拓展那一节的备份(改动之前导出的全部)在两种模式下都碰不到现有的
 * 拓展订阅 —— overwrite 只替换它带着的那一支。折回去时两支再拼成 ConfigStore 要的那一份。
 */

export type ImportMode = "overwrite" | "merge";

export interface CurrentState {
	globals: GlobalConfig;
	/** 现有的 B 站订阅。 */
	subscriptions: Subscription[];
	/** 现有的拓展订阅。 */
	extensionSubscriptions: ExtensionSubscription[];
	connections: Connection[];
	targets: PushTarget[];
}

export interface ImportSections {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	extensionSubscriptions?: ExtensionSubscription[];
	connections?: Connection[];
	targets?: PushTarget[];
}

/** 折好的终态 —— ConfigStore.replaceSections 要的形状:订阅是两支拼成的一份。 */
export interface FoldedSections {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	connections?: Connection[];
	targets?: PushTarget[];
}

interface ScopePlan<T> {
	upsert: T[];
	delete: string[];
}

export interface ImportPlan {
	setGlobals?: GlobalConfig;
	subscriptions: ScopePlan<Subscription>;
	extensionSubscriptions: ScopePlan<ExtensionSubscription>;
	connections: ScopePlan<Connection>;
	targets: ScopePlan<PushTarget>;
}

function planScope<T extends { id: string }>(
	current: T[],
	incoming: T[] | undefined,
	mode: ImportMode,
): ScopePlan<T> {
	if (!incoming) return { upsert: [], delete: [] };
	if (mode === "merge") return { upsert: incoming, delete: [] };
	const incomingIds = new Set(incoming.map((x) => x.id));
	const del = current.filter((x) => !incomingIds.has(x.id)).map((x) => x.id);
	return { upsert: incoming, delete: del };
}

export function planImport(
	current: CurrentState,
	incoming: ImportSections,
	mode: ImportMode,
): ImportPlan {
	const plan: ImportPlan = {
		subscriptions: planScope(current.subscriptions, incoming.subscriptions, mode),
		extensionSubscriptions: planScope(
			current.extensionSubscriptions,
			incoming.extensionSubscriptions,
			mode,
		),
		connections: planScope(current.connections, incoming.connections, mode),
		targets: planScope(current.targets, incoming.targets, mode),
	};
	if (mode === "overwrite" && incoming.globals) plan.setGlobals = incoming.globals;
	return plan;
}

function applyScope<T extends { id: string }>(
	current: readonly T[],
	plan: ScopePlan<T>,
): T[] | undefined {
	if (plan.upsert.length === 0 && plan.delete.length === 0) return undefined;
	const del = new Set(plan.delete);
	const next = current.filter((x) => !del.has(x.id));
	for (const item of plan.upsert) {
		const idx = next.findIndex((x) => x.id === item.id);
		if (idx < 0) next.push(item);
		else next[idx] = item;
	}
	return next;
}

/**
 * 把计划折成「这个分区最终应当是什么」。
 *
 * 恢复不是一串用户编辑,是一次整体替换 —— 所以 ConfigStore 那边要的是**终态**而不是
 * upsert/delete 序列。分区没有任何改动时返回 `undefined`,让它保持不动;返回空数组才是
 * 真清空(overwrite 模式下备份里给了空分区就是这个意思)。
 */
export function foldPlan(current: CurrentState, plan: ImportPlan): FoldedSections {
	const bili = applyScope(current.subscriptions, plan.subscriptions);
	const ext = applyScope(current.extensionSubscriptions, plan.extensionSubscriptions);
	return {
		globals: plan.setGlobals,
		// 两支哪支都没动就不给(保持不动);动了一支,另一支原样拼上。
		subscriptions:
			bili || ext
				? [...(bili ?? current.subscriptions), ...(ext ?? current.extensionSubscriptions)]
				: undefined,
		connections: applyScope(current.connections, plan.connections),
		targets: applyScope(current.targets, plan.targets),
	};
}
