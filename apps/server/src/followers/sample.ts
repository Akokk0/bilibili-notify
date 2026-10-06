/**
 * 粉丝样本的盘上形状(ADR-0027 决策 11、15)。
 *
 * 没有 `lastSampledAt` 的是**点**;有的是**段**:从 `sampledAt` 到 `lastSampledAt`,每个小时末的值都是
 * `followers`。点与段共用这一个类型,所有行都能按 `sampledAt` 排序与查找。时刻都是 ISO 字符串。
 */
export interface FollowersSample {
	sampledAt: string;
	followers: number;
	lastSampledAt?: string;
}

function isoMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 解析盘上的一行。认新形状 `{ sampledAt, followers, lastSampledAt? }`,也认 0.x 的旧形状
 * `{ ts, value }`(迁移与过渡用);新旧并存时以新形状为准。认不出来(坏值、时刻解析不了、
 * `lastSampledAt` 解析不了或早于 `sampledAt`)回 `undefined`,调用方跳过这行。
 * 只吐认得的三格,行上多带的键不往外漏。
 */
export function parseFollowersSample(raw: unknown): FollowersSample | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const row = raw as Record<string, unknown>;
	const isNew = "sampledAt" in row || "followers" in row;
	const sampledAt = isNew ? row.sampledAt : row.ts;
	const followers = isNew ? row.followers : row.value;
	const startMs = isoMs(sampledAt);
	if (startMs === undefined || typeof followers !== "number" || !Number.isFinite(followers)) {
		return undefined;
	}
	if (!isNew || row.lastSampledAt === undefined) {
		return { sampledAt: sampledAt as string, followers };
	}
	const endMs = isoMs(row.lastSampledAt);
	if (endMs === undefined || endMs < startMs) return undefined;
	return { sampledAt: sampledAt as string, followers, lastSampledAt: row.lastSampledAt as string };
}
