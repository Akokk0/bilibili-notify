/**
 * 操作结果与失败码 —— 成功、失败、标准失败码,以及 zod 报错的扁平化。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/result` 取值。
 */

// ---- 失败规矩(ADR-0026)的零件 ------------------------------------------------------------
//
// 一次操作的结果只有一种形状:成功 `{ ok: true, … }`,失败 `{ ok: false, code, message, … }`。
// 造结果一律用 `ok()` / `fail()`,不手写对象字面量(决策 6)。码表的正本在这里,规矩见
// docs/agents/conventions/failure-results.md。面板经 `/result` 子路径拿,后端经根入口拿,同一份值。

/**
 * 标准码表(决策 3)。`retry` 是「自动重试」那一列:`no` 不重试,`later` 稍后重试,
 * `depends` 看场合,`never` 绝不重试(结果不明,可能已经成功,重来会重复)。
 *
 * `unavailable` 与 `not_configured` 别混:前者等一会儿就好(推送链路还没就绪、库还没读完),
 * 后者等多久都不会好,得主人先去配(装 Chrome、填 key、打开开关)。
 */
export const FAILURE_CODES = {
	not_found: { retry: "no" },
	invalid: { retry: "no" },
	unauthorized: { retry: "no" },
	rate_limited: { retry: "later" },
	unavailable: { retry: "later" },
	not_configured: { retry: "no" },
	timeout: { retry: "later" },
	unsupported: { retry: "no" },
	conflict: { retry: "depends" },
	indeterminate: { retry: "never" },
	unknown: { retry: "no" },
} as const satisfies Record<string, { retry: "no" | "later" | "depends" | "never" }>;

export type FailureCode = keyof typeof FAILURE_CODES;

/** 校验或检查不过的一条原因。`path` 从被校验的那一层往下数;落在根上的没有 `path`。 */
export interface Issue {
	path?: (string | number)[];
	message: string;
}

/** 一次操作失败的那一支。上游平台自己的码只放 `upstreamCode`,永远不占 `code`。 */
export interface Failure {
	ok: false;
	code: FailureCode;
	message: string;
	upstreamCode?: number | string;
	issues?: Issue[];
}

/** 一次操作的结果。成功那一支的内容铺平在 `ok` 旁边。 */
export type Result<T extends object = Record<never, never>> = ({ ok: true } & T) | Failure;

/** 成功的结果。内容不许自带 `ok` 这一格 —— 它会把判别键盖掉。 */
export function ok(): { ok: true };
export function ok<T extends object & { ok?: never }>(value: T): { ok: true } & T;
export function ok(value?: object): { ok: true } {
	return { ok: true, ...value };
}

/**
 * 失败的结果。没给的附加格不出现(不留值为 undefined 的键)。
 * 码保留字面量,只会拒收的地方可以把失败那一支写成 `Failure & { code: "invalid" }`。
 */
export function fail<C extends FailureCode>(
	code: C,
	message: string,
	extras: { upstreamCode?: number | string; issues?: Issue[] } = {},
): Failure & { code: C } {
	const failure: Failure & { code: C } = { ok: false, code, message };
	if (extras.upstreamCode !== undefined) failure.upstreamCode = extras.upstreamCode;
	if (extras.issues !== undefined) failure.issues = extras.issues;
	return failure;
}

/**
 * zod 的校验报错翻成 `Issue[]`:只留路径与原话,zod 自己的字段(`code`、`expected`……)不往外甩。
 * 参数按形状收、不 import zod —— 这个文件只许有 type import。
 */
export function issuesFromZod(error: {
	issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): Issue[] {
	return error.issues.map(({ path, message }) => {
		const segments = path.filter(
			(segment): segment is string | number =>
				typeof segment === "string" || typeof segment === "number",
		);
		return segments.length > 0 ? { path: segments, message } : { message };
	});
}
