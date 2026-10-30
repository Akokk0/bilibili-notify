import { z } from "zod";

/**
 * 凭据字段的标记(ADR-0021 决策 44)—— 下发打码与备份脱敏读的是同一份标记,不再各自按键名猜。
 *
 * 标记就是 zod 4 的 `.meta()`,入口是 {@link markSecret} / {@link markBackupOnly}。两档:
 * - `secret`:面板打码、备份也抹掉(token、密钥、webhook 地址 —— 它的 token 常在路径里);
 * - `backupOnly`:面板照常显示、备份抹掉(OneBot 的地址、AI 的 baseUrl、市场源地址、请求头的值)。
 *
 * `url` 位只管备份抹成什么:备份要能恢复,`z.url()` 的格子抹成空串就再也存不回去,所以网络地址
 * 抹成 {@link REDACTED_URL_HOST} 上的占位,其余抹成空串。
 *
 * 🔴 标记写在**最里层的叶子上**,再往外套 `.optional()` / `.default()`:这几个包裹各是一个新的
 * schema 实例,不带里面的 meta,所以读标记的 {@link secretMarkOf} 会一层层往里剥(探针见
 * `secret-meta-probe.test.ts`)。
 *
 * 🔴 **联合要按值走**:同一个键名在不同分支里含义可以相反(OneBot ws 的 `url` 不是密钥,webhook 的是),
 * 所以静态取各分支路径的并集不行,{@link mapMarked} 拿值去试每一支、走对得上的那一支。
 */
export type SecretMark = { secret: true; url?: true } | { backupOnly: true; url?: true };

interface MarkOptions {
	/** 备份里抹成网络地址占位而不是空串。 */
	url?: boolean;
}

/** 备份里网络地址占位用的主机。`.invalid` 是 RFC 2606 保留的,永远解析不了。 */
export const REDACTED_URL_HOST = "redacted.invalid";

function metaOf(options?: MarkOptions): { url?: true } {
	return options?.url ? { url: true } : {};
}

/** 面板打码 + 备份抹掉。 */
export function markSecret<T extends z.ZodType>(schema: T, options?: MarkOptions): T {
	return schema.meta({ secret: true, ...metaOf(options) }) as T;
}

/** 面板照常显示,只在备份里抹掉。 */
export function markBackupOnly<T extends z.ZodType>(schema: T, options?: MarkOptions): T {
	return schema.meta({ backupOnly: true, ...metaOf(options) }) as T;
}

interface Def {
	type: string;
	[key: string]: unknown;
}

function defOf(schema: unknown): Def | undefined {
	return (schema as { _zod?: { def?: Def } } | null)?._zod?.def;
}

/** 只是套了一层、值的形状不变的包裹:往里剥。 */
const WRAPPERS = new Set([
	"optional",
	"nullable",
	"default",
	"prefault",
	"catch",
	"readonly",
	"nonoptional",
]);

function innerOf(def: Def): unknown {
	if (WRAPPERS.has(def.type)) return def.innerType;
	if (def.type === "lazy" && typeof def.getter === "function")
		return (def.getter as () => unknown)();
	return undefined;
}

/** 剥掉所有只套一层的包裹,回里面那份真身。 */
function peel(schema: unknown): unknown {
	let cursor = schema;
	for (let depth = 0; depth < 16; depth++) {
		const def = defOf(cursor);
		const inner = def ? innerOf(def) : undefined;
		if (inner === undefined) return cursor;
		cursor = inner;
	}
	return cursor;
}

function ownMark(schema: unknown): SecretMark | undefined {
	const meta = z.globalRegistry.get(schema as z.ZodType) as
		| { secret?: unknown; backupOnly?: unknown }
		| undefined;
	if (meta?.secret === true || meta?.backupOnly === true) return meta as SecretMark;
	return undefined;
}

/** 这一格上的标记;`.optional()` / `.default()` 等包裹一层层往里剥着找。 */
export function secretMarkOf(schema: unknown): SecretMark | undefined {
	let cursor = schema;
	for (let depth = 0; depth < 16 && cursor !== undefined; depth++) {
		const mark = ownMark(cursor);
		if (mark) return mark;
		const def = defOf(cursor);
		cursor = def ? innerOf(def) : undefined;
	}
	return undefined;
}

/** Classify a whole invalid cell by its rules, without inspecting or parsing its value. */
export function hasSecretCells(schema: unknown): boolean {
	const visit = (node: unknown, ancestors: ReadonlySet<unknown>, depth: number): boolean => {
		const mark = secretMarkOf(node);
		if (mark && "secret" in mark) return true;
		if (depth > 32 || ancestors.has(node)) return true;
		const def = defOf(node);
		if (!def) return true;
		const seen = new Set(ancestors).add(node);
		const next = (child: unknown) => visit(child, seen, depth + 1);
		if (WRAPPERS.has(def.type) || def.type === "lazy") return next(innerOf(def));
		switch (def.type) {
			case "pipe":
				return next(def.out);
			case "object":
				return (
					Object.values(def.shape as Record<string, unknown>).some(next) ||
					(def.catchall !== undefined &&
						defOf(def.catchall)?.type !== "never" &&
						next(def.catchall))
				);
			case "record":
				return next(def.valueType);
			case "array":
				return next(def.element);
			case "union":
				return (def.options as unknown[]).some(next);
			case "intersection":
				return next(def.left) || next(def.right);
			case "tuple":
				return (
					(def.items as unknown[]).some(next) ||
					(def.rest !== null && def.rest !== undefined && next(def.rest))
				);
			case "string":
			case "number":
			case "boolean":
			case "bigint":
			case "literal":
			case "enum":
			case "date":
			case "null":
			case "undefined":
			case "never":
				return false;
			default:
				return true;
		}
	};
	return visit(schema, new Set(), 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MapMarkedHandlers {
	/** 命中标记的叶子换成什么。 */
	onMark: (value: unknown, mark: SecretMark) => unknown;
	/**
	 * schema 管不到的那片(`z.unknown()`、没声明的键、对不上任何一支的值)换成什么。
	 * 是对象里没声明的键时带上 `key` —— 调用方按键名处理的话要用得上。
	 */
	onUntyped: (value: unknown, key?: string) => unknown;
}

/**
 * 拿 schema 当地图走一遍**值**,命中标记的叶子交给 `onMark`,schema 管不到的交给 `onUntyped`,
 * 其余原样。不改传进来的那份。
 *
 * 值是 schema **解析之后**的样子(存着的那份);对不上任何一支联合的值整片算「管不到」,
 * 由调用方决定宁可多抹还是原样。
 */
export function mapMarked(schema: unknown, value: unknown, handlers: MapMarkedHandlers): unknown {
	return go(schema, value, handlers, 0, undefined);
}

function go(
	schema: unknown,
	value: unknown,
	handlers: MapMarkedHandlers,
	depth: number,
	key: string | undefined,
): unknown {
	const mark = secretMarkOf(schema);
	if (mark) return handlers.onMark(value, mark);
	const def = defOf(schema);
	const untyped = () => handlers.onUntyped(value, key);
	if (!def || depth > 32) return untyped();
	const next = (child: unknown, v: unknown, k?: string) => go(child, v, handlers, depth + 1, k);

	if (WRAPPERS.has(def.type) || def.type === "lazy") {
		if (value === undefined || value === null) return value;
		return next(innerOf(def), value, key);
	}
	switch (def.type) {
		case "pipe":
			// `z.preprocess(fn, schema)` 的输出侧才是存着的形状。
			return next(def.out, value, key);
		case "object": {
			if (!isPlainObject(value)) return untyped();
			const shape = def.shape as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const [k, child] of Object.entries(value)) {
				out[k] = Object.hasOwn(shape, k) ? next(shape[k], child, k) : handlers.onUntyped(child, k);
			}
			return out;
		}
		case "record": {
			if (!isPlainObject(value)) return untyped();
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, next(def.valueType, v, k)]),
			);
		}
		case "array": {
			if (!Array.isArray(value)) return untyped();
			return value.map((item) => next(def.element, item));
		}
		case "union": {
			const hit = (def.options as z.ZodType[]).find((option) => option.safeParse(value).success);
			return hit ? next(hit, value, key) : untyped();
		}
		case "string":
		case "number":
		case "boolean":
		case "bigint":
		case "literal":
		case "enum":
		case "date":
		case "null":
		case "undefined":
			return value;
		default:
			return untyped();
	}
}

export interface StringLeaf {
	/** 到这个叶子的键路径;record 与数组的那一层记 `*`。 */
	path: string[];
	mark?: SecretMark;
}

/**
 * 一份 schema 里所有字符串叶子(含没标记的)—— 联合的每一支都列。给守卫用:
 * 「键名像密钥的字符串叶子必须带标记」要先知道有哪些叶子。
 */
export function stringLeavesOf(schema: unknown): StringLeaf[] {
	const out: StringLeaf[] = [];
	const walk = (node: unknown, path: string[], depth: number): void => {
		if (depth > 32) return;
		const mark = secretMarkOf(node);
		const cursor = defOf(peel(node));
		if (!cursor) return;
		switch (cursor.type) {
			case "string":
				out.push({ path, ...(mark ? { mark } : {}) });
				return;
			case "pipe":
				walk(cursor.out, path, depth + 1);
				return;
			case "object":
				for (const [key, child] of Object.entries(cursor.shape as Record<string, unknown>)) {
					walk(child, [...path, key], depth + 1);
				}
				return;
			case "record":
				walk(cursor.valueType, [...path, "*"], depth + 1);
				return;
			case "array":
				walk(cursor.element, [...path, "*"], depth + 1);
				return;
			case "union":
				for (const option of cursor.options as unknown[]) walk(option, path, depth + 1);
				return;
			default:
		}
	};
	walk(schema, [], 0);
	return out;
}

// ---- 下发打码 ---------------------------------------------------------------------------

/** 遮挡的点 —— **固定 8 个**,不随原文长度变:点数本身就泄露长度。 */
const DOTS = "•".repeat(8);

/**
 * 不到这么长的整段打点。头尾各四位加起来八位:九到十二位时,头尾几乎就是全文(决策 35 修订了
 * 决策 30 的「八位及以下」)。BN 生成的 token 是 32 位,落在露头尾那一档 —— 两条接入才分得出谁是谁。
 */
const REVEAL_MIN_LENGTH = 24;

/** 一段密钥在屏幕上的样子。按字符数(不按 UTF-16 码元)切,免得把一个字劈成两半。 */
export function maskSecret(value: string): string {
	const chars = Array.from(value);
	if (chars.length < REVEAL_MIN_LENGTH) return DOTS;
	return `${chars.slice(0, 4).join("")}${DOTS}${chars.slice(-4).join("")}`;
}

/**
 * 一格密钥下发时换成什么(形状同契约的 `MaskedSecret`)。空串照旧是空串、没有照旧是没有 ——
 * 面板要分得开「没配」与「配了」。不是字符串的(手改过文件)也遮:一格声明成密钥的值,
 * 不管长什么样都不原样出门。
 */
export function maskCell(value: unknown): unknown {
	if (value === undefined || value === null || value === "") return value;
	return { masked: typeof value === "string" ? maskSecret(value) : DOTS };
}
