import { buildPatch, type DeepPatch } from "@bilibili-notify/internal/patch";
import type {
	FeatureKey,
	GlobalConfig,
	Subscription,
	SubscriptionOverrides,
	SubscriptionRouting,
} from "../api/types";
import { FEATURE_KEYS } from "../api/types";


export function cloneConfig<T>(value: T): T {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value)) as T;
}

export function isDirty<T>(base: T, draft: T): boolean {
	return stableJson(base) !== stableJson(draft);
}

/**
 * 与**服务端当前值**做 diff 而不是把草稿整份回传。
 *
 * 配置 PATCH 是 JSON Merge Patch:键不出现 = 「不改」,只有显式 `null` 才是删除。
 * 整份回传时,被用户清空的可选字段(`app.userAgent`、`master.targetId`……)在草稿
 * 里是 `undefined`,`JSON.stringify` 会把整个键丢掉 —— 于是「清空」等于什么都没说,
 * 服务端原样留着旧值,刷新回来又冒出来。
 *
 * apps/web 的 System 页早就踩过并修过同一个坑,但这里是另一套实现,没跟着改。
 * 现在两端共用 `@bilibili-notify/internal/patch` 的同一份 diff,不会再各修各的。
 */
export function buildGlobalsPatch(
	draft: GlobalConfig,
	baseline: GlobalConfig,
): DeepPatch<Partial<GlobalConfig>> {
	return buildPatch(
		{ app: draft.app, master: draft.master, defaults: draft.defaults },
		{ app: baseline.app, master: baseline.master, defaults: baseline.defaults },
	);
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

/**
 * 订阅元信息的 PATCH 载荷。清空的字段发**显式 `null`** —— 发 `undefined` 会被
 * `JSON.stringify` 连键一起丢掉,而键不出现在 PATCH 里等于「这个字段别动」,
 * 名称/备注于是清不掉(同 {@link buildGlobalsPatch})。
 */
export function subscriptionMetaPatch(
	name: string,
	groups: string,
	notes: string,
): { name: string | null; groups: string[]; notes: string | null } {
	return {
		name: name.trim() || null,
		groups: groups
			.split(/,|\n/)
			.map((item) => item.trim())
			.filter(Boolean),
		notes: notes.trim() || null,
	};
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

function targetDisplayName(targetId: string, targets: readonly { id: string; name: string }[]): string {
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
