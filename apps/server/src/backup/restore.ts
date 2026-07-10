import type {
	GlobalConfig,
	PushAdapter,
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
 */

export type ImportMode = "overwrite" | "merge";

export interface CurrentState {
	globals: GlobalConfig;
	subscriptions: Subscription[];
	adapters: PushAdapter[];
	targets: PushTarget[];
}

export interface ImportSections {
	globals?: GlobalConfig;
	subscriptions?: Subscription[];
	adapters?: PushAdapter[];
	targets?: PushTarget[];
}

export interface ScopePlan<T> {
	upsert: T[];
	delete: string[];
}

export interface ImportPlan {
	setGlobals?: GlobalConfig;
	subscriptions: ScopePlan<Subscription>;
	adapters: ScopePlan<PushAdapter>;
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
		adapters: planScope(current.adapters, incoming.adapters, mode),
		targets: planScope(current.targets, incoming.targets, mode),
	};
	if (mode === "overwrite" && incoming.globals) plan.setGlobals = incoming.globals;
	return plan;
}
