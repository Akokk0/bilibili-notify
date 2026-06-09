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

/**
 * 解析数字输入框的原始字符串值。`Number("") === 0`,直接 `Number(raw)` 会在用户清空输入框时
 * 静默写 0,继而触发 zod min/enum 校验失败(如 healthCheckMinutes min 5、minGuardLevel 仅 1|2|3)。
 * 此 helper 在空字符串/NaN 时回退到 fallback(通常为当前有效值),从而保留上一个合法值而非写 0。
 * 不在此做范围 clamp —— 各字段约束不同,由调用方/Input 的 min/max 与 zod 负责。
 */
export function parseNumberInput(raw: string, fallback: number): number {
	if (raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isNaN(parsed) ? fallback : parsed;
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
	const cleaned = removeEmpty(cloneConfig(overrides)) as SubscriptionOverrides;
	if (cleaned.ai && isInheritOnlyAi(cleaned.ai)) {
		delete cleaned.ai;
	}
	return cleaned;
}

/**
 * AI override section 与其它 section 不对称:其它 section 初始化为 `{}`,被 removeEmpty 视为空;
 * AI 初始化为 `{ preset: "inherit" }` 这一非空占位,removeEmpty 会保留它,导致"只开 AI 覆盖、不填字段、
 * 保存"后 toggle 复活。此函数判断一个 (已 removeEmpty 过的) ai section 是否只剩继承占位、无实质覆盖值:
 * preset 仍为 "inherit" 且 persona/dynamicPrompt/liveSummaryPrompt/temperature 均已被 removeEmpty 清掉。
 * 一旦 preset 选成 "custom" / preset.id,或填了任意实质字段,即视为真正的覆盖,保留不动。
 */
function isInheritOnlyAi(ai: NonNullable<SubscriptionOverrides["ai"]>): boolean {
	if (ai.preset !== "inherit") return false;
	return Object.keys(ai).every((key) => key === "preset");
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
