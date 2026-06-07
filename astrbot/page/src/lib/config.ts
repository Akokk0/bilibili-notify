import type {
	FeatureKey,
	GlobalConfig,
	Subscription,
	SubscriptionOverrides,
	SubscriptionRouting,
} from "../api/types";
import { FEATURE_KEYS } from "../api/types";

export type DirtyState = "clean" | "dirty" | "saving";

export function cloneConfig<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

export function isDirty<T>(base: T, draft: T): boolean {
	return stableJson(base) !== stableJson(draft);
}

export function buildGlobalsPatch(draft: GlobalConfig): Partial<GlobalConfig> {
	return {
		app: draft.app,
		master: draft.master,
		defaults: draft.defaults,
	};
}

export function linesToList(value: string): string[] {
	return value
		.split(/\r?\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function listToLines(value: readonly string[] | undefined): string {
	return (value ?? []).join("\n");
}

export function emptyRouting(): SubscriptionRouting {
	return Object.fromEntries(FEATURE_KEYS.map((key) => [key, [] as string[]])) as SubscriptionRouting;
}

export function withRouteTarget(
	routing: SubscriptionRouting,
	feature: FeatureKey,
	targetId: string,
	enabled: boolean,
): SubscriptionRouting {
	const next = cloneConfig(routing);
	const current = new Set(next[feature]);
	if (enabled) current.add(targetId);
	else current.delete(targetId);
	next[feature] = [...current];
	return next;
}

export function cleanOverrides(overrides: SubscriptionOverrides): SubscriptionOverrides {
	return removeEmpty(cloneConfig(overrides)) as SubscriptionOverrides;
}

export function targetDisplayName(targetId: string, targets: readonly { id: string; name: string }[]): string {
	return targets.find((target) => target.id === targetId)?.name ?? targetId.slice(0, 8);
}

export function subscriptionTitle(sub: Subscription): string {
	return sub.name ? `${sub.name} (${sub.uid})` : sub.uid;
}

export function featureRouteSummary(
	routing: SubscriptionRouting,
	labels: Record<FeatureKey, string>,
	targets: readonly { id: string; name: string }[],
): string {
	const enabled = FEATURE_KEYS.flatMap((feature) => {
		const names = routing[feature].map((targetId) => targetDisplayName(targetId, targets));
		return names.length > 0 ? [`${labels[feature]}→${names.join("、")}`] : [];
	});
	return enabled.length > 0 ? enabled.join("；") : "尚未配置推送目标";
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, sortKeys(entry)]),
	);
}

function removeEmpty(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(removeEmpty);
	if (!value || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>)
		.map(([key, entry]) => [key, removeEmpty(entry)] as const)
		.filter(([, entry]) => {
			if (entry === undefined) return false;
			if (isPlainObject(entry) && Object.keys(entry).length === 0) return false;
			return true;
		});
	return Object.fromEntries(entries);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
