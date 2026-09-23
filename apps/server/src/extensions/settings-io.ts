import { createHash, randomUUID } from "node:crypto";
import type {
	ExtensionSettingsIssue,
	ExtensionSettingsOp,
	MaskedSecret,
} from "@bilibili-notify/contract";
import {
	type ExtensionManifestField,
	type ExtensionManifestListField,
	isSecretField,
	LIST_ITEM_ID_KEY,
	settingsFieldSchema,
	settingsListItemSchema,
} from "@bilibili-notify/internal";
import type { ZodError, ZodType } from "zod";
import type { ConfigStore } from "../config/store.js";

/**
 * 拓展设置的读写口(`/api/ext/:id/settings`,ADR-0019 决策 35)背后的那几件事:怎么遮密钥、
 * 版本号怎么算、一步步的操作怎么套上去、拓展自己那份 zod 怎么比「这次新冒出来的」、最后怎么
 * 按版本号原子地写进去。路由那头只做 wire。另有一段不走路由:存着的那份过不过得了拓展自己的
 * zod —— ctx 与装载器拿它判「设置读不了」(决策 36)。
 *
 * 存储仍在 globals 的 `extensions.<id>.settings` —— 不搬:应用内更新会退回旧载荷,旧版只认那一格。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- 读:遮密钥 ------------------------------------------------------------------------

/** 遮挡的点 —— **固定 8 个**,不随原文长度变:点数本身就泄露长度。 */
const DOTS = "•".repeat(8);

/**
 * 不到这么长的整段打点。头尾各四位加起来八位:九到十二位时,头尾几乎就是全文(决策 35 修订了
 * 决策 30 的「八位及以下」)。BN 生成的 token 是 32 位,落在露头尾那一档 —— 两条接入才分得出谁是谁。
 */
const REVEAL_MIN_LENGTH = 24;

/** 一段密钥在屏幕上的样子。按字符数(不按 UTF-16 码元)切,免得把一个字劈成两半。 */
function maskSecret(value: string): string {
	const chars = Array.from(value);
	if (chars.length < REVEAL_MIN_LENGTH) return DOTS;
	return `${chars.slice(0, 4).join("")}${DOTS}${chars.slice(-4).join("")}`;
}

/**
 * 一格密钥下发时换成什么。空串照旧是空串、没有照旧是没有 —— 面板要分得开「没配」与「配了」。
 * 不是字符串的(手改过文件)也遮:一格声明成密钥的值,不管长什么样都不原样出门。
 */
function maskCell(value: unknown): unknown {
	if (value === undefined || value === null || value === "") return value;
	const masked: MaskedSecret = { masked: typeof value === "string" ? maskSecret(value) : DOTS };
	return masked;
}

/**
 * 存着的那份,密钥格(`secret` / `generate`,顶层与列表项里都算)换成遮挡。清单没声明的键原样带着
 * —— 拓展可能有面板不管的格,那不归 BN 判是不是密钥。存着的根本不是对象(手改坏了)就当没设过。
 */
export function maskSettings(
	fields: readonly ExtensionManifestField[],
	stored: unknown,
): Record<string, unknown> {
	if (!isPlainObject(stored)) return {};
	const out: Record<string, unknown> = { ...stored };
	for (const field of fields) {
		if (!Object.hasOwn(out, field.key)) continue;
		const value = out[field.key];
		if (isSecretField(field)) {
			out[field.key] = maskCell(value);
		} else if (field.type === "list" && Array.isArray(value)) {
			const secrets = field.fields.filter(isSecretField);
			out[field.key] = value.map((item) => {
				if (!isPlainObject(item)) return item;
				const copy: Record<string, unknown> = { ...item };
				for (const sub of secrets) {
					if (Object.hasOwn(copy, sub.key)) copy[sub.key] = maskCell(copy[sub.key]);
				}
				return copy;
			});
		}
	}
	return out;
}

// ---- 版本号 ----------------------------------------------------------------------------

/** 键排好序的一份 —— 同样的内容不论键序都得出同一个摘要。 */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isPlainObject(value)) return value;
	// fromEntries 建的是自有属性:键叫 `__proto__` 的也不会去改原型。
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonical(value[key])]),
	);
}

/**
 * 版本号 = 存着的那份设置(没有就当 `null`)规范化 JSON 的 sha256,取前 16 位十六进制(64 位,
 * 只用来比对「是不是同一份」,够了)。
 *
 * 只看**这个拓展的设置**:别的全局设置、它自己的开关怎么变都不动它 —— 给整份 globals 算版本号的话,
 * 互不相干的写入会互相 409。
 */
export function settingsRevision(stored: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(stored ?? null)))
		.digest("hex")
		.slice(0, 16);
}

// ---- 写:一步步套上去,只校验动到的 ------------------------------------------------------

const MASKED_MESSAGE =
	"这是下发时的密钥遮挡,不是新值 —— 不改就别带这一格,要换就交新的明文(比如重新生成)";

/** 值是不是下发时那个遮挡的形状 —— 原样回传的话,真密钥会被盖成一个对象。 */
function isMaskedSecret(value: unknown): boolean {
	return isPlainObject(value) && Object.hasOwn(value, "masked");
}

function itemsOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function idOf(item: unknown): unknown {
	return isPlainObject(item) ? item[LIST_ITEM_ID_KEY] : undefined;
}

type Path = (string | number)[];

/** zod 的路径里可能有 symbol(拓展自己的 schema 写得出来),下发前变成字符串。 */
function plainPath(path: readonly PropertyKey[]): Path {
	return path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
}

export type AppliedSettingsOps =
	| {
			ok: true;
			/** 套完之后的那一份。 */
			next: Record<string, unknown>;
			/** 每个 `add` 生成的 id,按 op 顺序。 */
			added: string[];
			/** 一条问题(路径从设置那一层往下数,列表项按 id)是第几步惹的;认不出就是 `undefined`。 */
			opOf: (path: Path) => number | undefined;
	  }
	| { ok: false; issues: ExtensionSettingsIssue[] };

/**
 * 把一串操作按顺序套在存着的那份上,**只校验这一步动到的**(决策 35):`set` 照清单校验那一格,
 * `add` / `update` 照清单校验合并之后的那一项,`remove` 不校验。存量里别的不合规的不连坐 ——
 * 否则清单一收紧,连删一条坏项都被拒,那条坏项就永远删不掉了。
 *
 * 一步不合规矩就整发作废,但每一步都会走到:问题一次说全,不让人改一处、提交、再撞下一处。
 * 路径从设置那一层往下数,列表项**按 id 点名**(增删之后下标会挪)。
 */
export function applySettingsOps(
	fields: readonly ExtensionManifestField[],
	stored: unknown,
	ops: readonly ExtensionSettingsOp[],
): AppliedSettingsOps {
	// Map 不用普通对象:键是面板给的,`constructor` 这类会顺着原型链被当成「声明过」。
	const byKey = new Map(fields.map((field) => [field.key, field]));
	const next: Record<string, unknown> = isPlainObject(stored) ? structuredClone(stored) : {};
	const added: string[] = [];
	const issues: ExtensionSettingsIssue[] = [];
	/** 谁动了哪儿(`[key]` 或 `[list, id]` → 第几步),拓展自己的 zod 报出来的问题按它认是哪一步惹的。 */
	const touched = new Map<string, number>();
	const pathKey = (path: Path) => JSON.stringify(path);

	/** 列表的那一格;不是列表回一句为什么。 */
	const listOf = (key: string): ExtensionManifestListField | string => {
		const field = byKey.get(key);
		if (!field) return "清单里没有这一格";
		if (field.type !== "list") return "这一格不是列表 —— 单值的格用 set 改";
		return field;
	};
	/** 按 id 找一项;找不到是 -1。 */
	const indexOf = (list: string, id: string) =>
		itemsOf(next[list]).findIndex((item) => idOf(item) === id);

	/** 套上一步,回这一步的问题 —— 空表 = 套上了;有问题的那一步什么都不动。 */
	function step(op: ExtensionSettingsOp, index: number): ExtensionSettingsIssue[] {
		const at = (path: Path, message: string): ExtensionSettingsIssue[] => [
			{ op: index, path, message },
		];
		const fromZod = (prefix: Path, error: ZodError): ExtensionSettingsIssue[] =>
			error.issues.map((issue) => ({
				op: index,
				path: [...prefix, ...plainPath(issue.path)],
				message: issue.message,
			}));
		/** 一项里交来的那几格:`id` 归 BN 管、没声明的不收、遮挡不收。 */
		const itemValueIssues = (list: ExtensionManifestListField, values: object, prefix: Path) => {
			const declared = new Set(list.fields.map((field) => field.key));
			return Object.entries(values).flatMap(([key, value]) => {
				const why =
					key === LIST_ITEM_ID_KEY
						? "项的 id 由 BN 生成、不许交也不许改"
						: !declared.has(key)
							? "清单里这一项没有这一格"
							: isMaskedSecret(value)
								? MASKED_MESSAGE
								: undefined;
				return why ? at([...prefix, key], why) : [];
			});
		};
		/** 找不到那一项就说清楚 —— 静默当成功的话,面板以为改了 / 删了。 */
		const missing = (list: string, id: string) =>
			at([list, id], `这个列表里没有 id 为 ${id} 的一项(可能已经被删了)`);

		switch (op.op) {
			case "set": {
				const field = byKey.get(op.key);
				if (!field) return at([op.key], "清单里没有这一格");
				if (field.type === "list") {
					return at([op.key], "列表只能逐项增 / 改 / 删(add / update / remove),不能整份 set");
				}
				if (isMaskedSecret(op.value)) return at([op.key], MASKED_MESSAGE);
				const value = op.value === null ? undefined : op.value;
				const parsed = settingsFieldSchema(field).safeParse(value);
				if (!parsed.success) return fromZod([op.key], parsed.error);
				// 键是清单声明过的(过了 FieldKeySchema,拼不出 `__proto__`),直接下标写。
				if (value === undefined) delete next[op.key];
				else next[op.key] = value;
				touched.set(pathKey([op.key]), index);
				return [];
			}
			case "add": {
				const list = listOf(op.list);
				if (typeof list === "string") return at([op.list], list);
				// 项的 id 由 BN 生成、藏起来、不许改(决策 29)。
				const id = randomUUID();
				const prefix = [op.list, id];
				const bad = itemValueIssues(list, op.item, prefix);
				if (bad.length > 0) return bad;
				const item: Record<string, unknown> = { [LIST_ITEM_ID_KEY]: id };
				for (const [key, value] of Object.entries(op.item)) {
					if (value !== null) item[key] = value;
				}
				const parsed = settingsListItemSchema(list).safeParse(item);
				if (!parsed.success) return fromZod(prefix, parsed.error);
				next[op.list] = [...itemsOf(next[op.list]), item];
				added.push(id);
				touched.set(pathKey(prefix), index);
				return [];
			}
			case "update": {
				const list = listOf(op.list);
				if (typeof list === "string") return at([op.list], list);
				const where = indexOf(op.list, op.id);
				if (where < 0) return missing(op.list, op.id);
				const prefix = [op.list, op.id];
				const bad = itemValueIssues(list, op.values, prefix);
				if (bad.length > 0) return bad;
				const items = itemsOf(next[op.list]);
				// `null` = 清掉那一格,与 `set` 同一个约定。
				const merged: Record<string, unknown> = { ...(items[where] as Record<string, unknown>) };
				for (const [key, value] of Object.entries(op.values)) {
					if (value === null) delete merged[key];
					else merged[key] = value;
				}
				const parsed = settingsListItemSchema(list).safeParse(merged);
				if (!parsed.success) return fromZod(prefix, parsed.error);
				next[op.list] = items.map((item, i) => (i === where ? merged : item));
				touched.set(pathKey(prefix), index);
				return [];
			}
			case "remove": {
				const list = listOf(op.list);
				if (typeof list === "string") return at([op.list], list);
				const where = indexOf(op.list, op.id);
				if (where < 0) return missing(op.list, op.id);
				next[op.list] = itemsOf(next[op.list]).filter((_, i) => i !== where);
				return [];
			}
		}
	}

	for (const [index, op] of ops.entries()) issues.push(...step(op, index));

	if (issues.length > 0) return { ok: false, issues };
	return {
		ok: true,
		next,
		added,
		opOf: (path) =>
			touched.get(pathKey(path.slice(0, 2))) ?? touched.get(pathKey(path.slice(0, 1))),
	};
}

// ---- 拓展自己那份 zod:只拦这次新冒出来的 ------------------------------------------------

/**
 * 拓展在跑时,写入之后的那份再过它自己交过的每一份 zod(决策 35 第三点)—— 清单造出来的校验表达
 * 不了整数、正则、跨字段规则,放行的值拓展一读就整份失败。
 *
 * **判据是「这次写入之后新冒出来的」**:写前、写后各解一次,写后有、写前没有的才算。存量里本来就
 * 坏的不连坐 —— 删掉一条坏项、改对一条坏项都放得行,新写坏的拦得住。
 *
 * 🔴 两件事不能省:
 * - **`safeParseAsync`**:拓展的 schema 可以带异步 refine,同步解析一碰就抛。
 * - **列表下标换成那一项的 id** 再比:删掉排在坏项前面的一条,坏项的下标就挪了 —— 按下标比,
 *   它成了「新冒出来的」,连删一条好项都被拒。认不出 id 的项(手改坏了)照旧按下标。
 *
 * 写前那份是没设过(`undefined` / `null`)时不解:那在拓展那头是「按没有算」,不是坏了。
 * 拓展的 schema 自己抛了(不是 zod 的报错)原样往外抛 —— 那是拓展的 bug,吞掉就只剩一句「不合规矩」。
 */
export async function newExtensionIssues(
	schemas: readonly ZodType[],
	fields: readonly ExtensionManifestField[],
	before: unknown,
	after: Record<string, unknown>,
): Promise<{ path: Path; message: string }[]> {
	const lists = new Set(fields.filter((field) => field.type === "list").map((field) => field.key));
	/** 一条问题的身份:路径(列表项按 id)+ 种类 + 那句话。 */
	const identify = (
		issue: { path: readonly PropertyKey[]; code: string; message: string },
		value: unknown,
	) => {
		const path = plainPath(issue.path);
		const [head, index] = path;
		if (typeof head === "string" && lists.has(head) && typeof index === "number") {
			const id = isPlainObject(value) ? idOf(itemsOf(value[head])[index]) : undefined;
			if (typeof id === "string") path[1] = id;
		}
		return { path, key: JSON.stringify([path, issue.code, issue.message]) };
	};
	const issuesOf = async (schema: ZodType, value: unknown) => {
		const parsed = await schema.safeParseAsync(value);
		return parsed.success ? [] : parsed.error.issues;
	};

	const fresh: { path: Path; message: string }[] = [];
	const reported = new Set<string>();
	for (const schema of schemas) {
		const known = new Set<string>();
		if (before !== undefined && before !== null) {
			for (const issue of await issuesOf(schema, before)) known.add(identify(issue, before).key);
		}
		for (const issue of await issuesOf(schema, after)) {
			const { path, key } = identify(issue, after);
			if (known.has(key) || reported.has(key)) continue;
			reported.add(key);
			fresh.push({ path, message: issue.message });
		}
	}
	return fresh;
}

// ---- 存着的那份过不过得了拓展自己的 zod ------------------------------------------------

/**
 * 存着的那份对拓展交过的每一份 zod 的判决(决策 36)。`values` 按 schema 放解出来的那一份 ——
 * 拓展 `get()` 拿到的就是它;`detail` 是给主人看的那句「哪一格、为什么」。
 */
export type StoredSettingsVerdict =
	| { ok: true; values: ReadonlyMap<ZodType, unknown> }
	| { ok: false; detail: string };

/** 一句话里最多点名几处。手改坏的文件一口气能报几百条,原因把整张卡撑满就什么都看不清了。 */
const MAX_NAMED_ISSUES = 3;

/**
 * zod 路径 → 主人认得的说法:格按清单里的名字,**列表项按它的标题**(没有标题按 id,再没有才按
 * 第几项)—— 下标对主人没有意义,删掉前面一条它就挪了。清单没声明的格(v1 一律没有)路径原样念。
 */
function whereOf(fields: readonly ExtensionManifestField[], raw: unknown, path: Path): string {
	const [head, ...rest] = path;
	if (head === undefined) return "整份设置";
	const field = fields.find((candidate) => candidate.key === head);
	if (!field) return `「${path.join(".")}」`;
	const name = `「${field.label}」`;
	if (rest.length === 0) return name;
	const [index, ...inner] = rest;
	if (field.type !== "list" || typeof index !== "number") return `${name}的「${rest.join(".")}」`;
	const item = isPlainObject(raw) ? itemsOf(raw[field.key])[index] : undefined;
	// 标题不会是密钥格(清单校验拦着,决策 38),念出来不漏东西。
	const title = isPlainObject(item) ? item[field.title] : undefined;
	const id = idOf(item);
	const which =
		typeof title === "string" && title !== ""
			? `「${title}」这一项`
			: typeof id === "string" && id !== ""
				? ` id 为 ${id} 的那一项`
				: `第 ${index + 1} 项`;
	const [cell, ...deeper] = inner;
	if (cell === undefined) return `${name}里${which}`;
	const sub = field.fields.find((candidate) => candidate.key === cell);
	return `${name}里${which}的「${sub ? [sub.label, ...deeper].join(".") : inner.join(".")}」`;
}

/** zod 的问题 → 一句人话:「哪一格:为什么」,同一句只说一次,多了只点名前几处。 */
function describeSettingsIssues(
	fields: readonly ExtensionManifestField[],
	raw: unknown,
	issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
	const lines = [
		...new Set(
			issues.map((issue) => `${whereOf(fields, raw, plainPath(issue.path))}:${issue.message}`),
		),
	];
	const named = lines.slice(0, MAX_NAMED_ISSUES).join(";");
	const more = lines.length - MAX_NAMED_ISSUES;
	return more > 0 ? `${named};…另有 ${more} 处` : named;
}

/**
 * **同步**判一次存着的那份 —— 判不了回 `undefined`,交给 {@link judgeStoredSettings}。
 *
 * 能同步就同步,是因为拓展那头要「当场」:`ctx.settings(schema)` 那一下就得抛,设置一变的扇出也不
 * 该平白晚一拍。判不了有两种:schema 里有异步 refine(zod 同步解析一碰就抛),或者它自己的代码抛了。
 * 🔴 两种都不按 `instanceof` 分 —— 拓展内联的是**另一份 zod**,它抛的异步错不是宿主这份的实例。
 *
 * 没设过(`undefined` / `null`)不算坏:在拓展那头是「按没有算」,每份 schema 交 `undefined`。
 */
export function judgeStoredSettingsSync(
	schemas: readonly ZodType[],
	fields: readonly ExtensionManifestField[],
	raw: unknown,
): StoredSettingsVerdict | undefined {
	const values = new Map<ZodType, unknown>();
	const issues: ZodError["issues"] = [];
	for (const schema of schemas) {
		if (raw === undefined || raw === null) {
			values.set(schema, undefined);
			continue;
		}
		let parsed: ReturnType<ZodType["safeParse"]>;
		try {
			parsed = schema.safeParse(raw);
		} catch {
			return undefined;
		}
		if (parsed.success) values.set(schema, parsed.data);
		else issues.push(...parsed.error.issues);
	}
	if (issues.length > 0) return { ok: false, detail: describeSettingsIssues(fields, raw, issues) };
	return { ok: true, values };
}

/**
 * 判一次存着的那份,同步判不了的走 `safeParseAsync`。**不抛**:拓展的 schema 自己抛了也折成一条
 * 判决 —— 那种时候宿主一样没法把设置交给它,而原因要摆到面板上,不能变成一发没人接的拒绝。
 */
export async function judgeStoredSettings(
	schemas: readonly ZodType[],
	fields: readonly ExtensionManifestField[],
	raw: unknown,
): Promise<StoredSettingsVerdict> {
	const sync = judgeStoredSettingsSync(schemas, fields, raw);
	if (sync) return sync;
	const values = new Map<ZodType, unknown>();
	const issues: ZodError["issues"] = [];
	for (const schema of schemas) {
		let parsed: Awaited<ReturnType<ZodType["safeParseAsync"]>>;
		try {
			parsed = await schema.safeParseAsync(raw);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				detail: `它自己的设置校验抛了(是拓展代码的毛病,不是哪一格填错了):${reason}`,
			};
		}
		if (parsed.success) values.set(schema, parsed.data);
		else issues.push(...parsed.error.issues);
	}
	if (issues.length > 0) return { ok: false, detail: describeSettingsIssues(fields, raw, issues) };
	return { ok: true, values };
}

// ---- 原子地写进去 ----------------------------------------------------------------------

/** 队里比对时撞上的那一发 —— 只在 {@link commitSettings} 里抛、里接。 */
class RevisionMoved extends Error {
	constructor(readonly revision: string) {
		super("revision moved");
	}
}

/**
 * 按版本号把新的那份写进去:**比对与落盘在 globals 那条排队里是一件事**。
 *
 * 路由在队外先比过一次、算好新值、跑完校验(拓展的 zod 是异步的,不许进队,见
 * `ConfigStore.updateGlobals`);那之后到这里之间,别人可能已经写过这一格。所以到了队里再比一次:
 * 版本号还是那个,才说明算新值时依据的就是现在这份。对不上回 `{ ok: false, revision: 现在的 }`,
 * 一个字都不写 —— 否则两发带同一个版本号同时到,后落盘的那发拿着它读到的旧名单整份写回,
 * 先写的那条接入静默消失。
 */
export async function commitSettings(
	store: Pick<ConfigStore, "updateGlobals">,
	id: string,
	expected: string,
	next: Record<string, unknown>,
): Promise<{ ok: true; settings: unknown } | { ok: false; revision: string }> {
	try {
		const saved = await store.updateGlobals((globals) => {
			const now = settingsRevision(globals.extensions[id]?.settings);
			if (now !== expected) throw new RevisionMoved(now);
			// 开关原样留着;还没有这一格(装好还没碰过)就按关着建。
			globals.extensions[id] = {
				...(globals.extensions[id] ?? { enabled: false }),
				settings: next,
			};
			return globals;
		});
		return { ok: true, settings: saved.extensions[id]?.settings };
	} catch (err) {
		if (err instanceof RevisionMoved) return { ok: false, revision: err.revision };
		throw err;
	}
}
