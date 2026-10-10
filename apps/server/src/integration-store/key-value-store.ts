import {
	fail,
	type Json,
	type KeyValueOp,
	type KeyValueStore,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";

/**
 * 一袋键值 + 它的规矩:保留前缀、限额、值是不是 JSON、`batch` 的「先验后写再换」。
 * **不碰盘** —— 落盘是注入进来的 `persist(entries)`,所以同一份实现既是生产的存储,也是测试里的内存版。
 *
 * 同一袋有两个 `KeyValueStore`:`integration` 拒 `http.` 开头的键,`host` 只许 `http.` 开头的键 ——
 * 宿主也不许碰集成的键。两个共用同一袋、同一条写道,所以不会各写各的。
 */

/** `http.` 开头的键归宿主(ADR-0025 决策 9)。 */
export const HOST_KEY_PREFIX = "http.";

/** 盘上文件的版本判别,今天只认 1。 */
export const STORE_FILE_VERSION = 1;

export const STATE_LIMITS = { maxKeyBytes: 64 * 1024, maxTotalBytes: 1024 * 1024 } as const;
export const SECRETS_LIMITS = { maxTotalBytes: 256 * 1024 } as const;

const MAX_KEY_NAME_BYTES = 256;
const MAX_JSON_DEPTH = 64;

/** 落盘的那一段明文。盘上两种文件(明文与加密)都是它。 */
export function serializeEntries(entries: ReadonlyMap<string, Json>): string {
	return JSON.stringify({ version: STORE_FILE_VERSION, entries: Object.fromEntries(entries) });
}

export interface CreateKeyValueStoresOptions {
	/** 读进来的那一袋(键的先后原样保留)。 */
	initial?: ReadonlyMap<string, Json>;
	limits: {
		/** 单个值序列化之后的字节数上限;不给就不限单键。 */
		maxKeyBytes?: number;
		/** 整份(要落盘的那段明文,键名也算)的字节数上限。 */
		maxTotalBytes: number;
	};
	/** 把整袋落盘;失败回结果,抛了按 `unavailable`。 */
	persist(entries: ReadonlyMap<string, Json>): Promise<Result>;
	/**
	 * 写道:同一袋的写按交进来的顺序一个接一个做。不给就是这一袋自己一条;宿主给的是整个宿主共用的那一条。
	 * 写道关了会抛(`SerialQueueClosedError`),按 `unavailable` 回。
	 */
	lane?: <T>(task: () => Promise<T>) => Promise<T>;
	/**
	 * 这一袋现在不许写的原因(把手关了、文件读不了);`undefined` 就是能写。写**交进来那一刻**看它,
	 * 关之前已经排上的写照常落完。读不了的袋子 `initial` 是空的,所以 `get` 也一律空。
	 */
	blocked?: () => string | undefined;
}

/** 建好之后拿回的把手:同一袋的两个存储,加整袋的控制口。 */
export interface KeyValueStoreHandle {
	/** 集成那一面:`http.` 开头的键拒。 */
	readonly integration: KeyValueStore;
	/** 宿主那一面:只许 `http.` 开头的键。 */
	readonly host: KeyValueStore;
	/** 现在的整袋(拷贝)。 */
	snapshot(): Map<string, Json>;
	/**
	 * 把整袋换掉(恢复备份用):按两个面都放行的规矩验过限额,落盘成功才换内存。
	 * 里面的 `http.` 键照样收 —— 恢复的是整袋。
	 */
	replace(entries: ReadonlyMap<string, Json>): Promise<Result>;
	/**
	 * 宿主那一组(`http.` 键)与集成自己那一组改动合成**同一次原子写**:一个写道任务、一次 `persist`。
	 * 宿主那一组是个函数,**进了写道才调**(取罐子此刻的内容,不是排队之前的快照);集成那一组入队前验,
	 * 带 `http.` 键回 `invalid`。两组各按自己那一面的规矩验,任何一组不合规整批不做。
	 */
	commit(
		hostOps: () => readonly KeyValueOp[],
		integrationOps: readonly KeyValueOp[],
	): Promise<Result>;
}

/** 值里有不是 JSON 的东西(内部用:抛出去,最外层转成 `invalid`)。 */
class NotJsonError extends Error {}

function walkJson(value: unknown, depth: number): Json {
	if (depth > MAX_JSON_DEPTH) throw new NotJsonError(`嵌套超过 ${MAX_JSON_DEPTH} 层`);
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new NotJsonError("数字只收有限数(不收 NaN / Infinity)");
		return value;
	}
	if (Array.isArray(value)) {
		const items: Json[] = [];
		for (let i = 0; i < value.length; i++) items.push(walkJson(value[i], depth + 1));
		return items;
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) throw new NotJsonError("对象只收普通对象");
		// 键是第三方给的:用 defineProperty 落在自己身上,`__proto__` 之类不会改原型。
		const out: { [key: string]: Json } = {};
		for (const [key, inner] of Object.entries(value)) {
			Object.defineProperty(out, key, {
				value: walkJson(inner, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return out;
	}
	throw new NotJsonError(`${typeof value} 不是 JSON 值`);
}

/** 值逐层走一遍,只收 `Json`;交回的是一份拷贝(调用方之后再改原值不影响存着的)。 */
function copyJson(value: unknown): Result<{ value: Json }> {
	try {
		return ok({ value: walkJson(value, 0) });
	} catch (err) {
		if (err instanceof NotJsonError) return fail("invalid", err.message);
		throw err;
	}
}

function bytesOf(json: string): number {
	return Buffer.byteLength(json);
}

/** 校验过、值已拷贝的一步。 */
type CheckedOp = { kind: "set"; key: string; value: Json } | { kind: "delete"; key: string };

/** `whole` 是整袋换(恢复备份):两个面的键都收。 */
function checkKey(face: "integration" | "host" | "whole", key: unknown): string | undefined {
	if (typeof key !== "string" || key.length === 0) return "键要是非空字符串";
	if (bytesOf(key) > MAX_KEY_NAME_BYTES) return `键超过 ${MAX_KEY_NAME_BYTES} 字节`;
	const hosted = key.startsWith(HOST_KEY_PREFIX);
	if (face === "integration" && hosted) return `「${HOST_KEY_PREFIX}」开头的键归宿主,集成不能写`;
	if (face === "host" && !hosted) return `宿主只许写「${HOST_KEY_PREFIX}」开头的键`;
	return undefined;
}

/** 整批过一遍:任何一步不合规矩就回原因,一步都不做。 */
function checkOps(
	face: "integration" | "host" | "whole",
	ops: readonly KeyValueOp[],
): CheckedOp[] | string {
	const checked: CheckedOp[] = [];
	for (const [index, op] of ops.entries()) {
		const at = `第 ${index + 1} 步`;
		const kind = (op as { kind?: unknown } | null)?.kind;
		if (kind !== "set" && kind !== "delete") return `${at}:kind 只能是 set 或 delete`;
		const keyProblem = checkKey(face, op.key);
		if (keyProblem !== undefined) return `${at}:${keyProblem}`;
		if (op.kind === "delete") {
			checked.push({ kind: "delete", key: op.key });
			continue;
		}
		const value = copyJson(op.value);
		if (!value.ok) return `${at}(${op.key}):${value.message}`;
		checked.push({ kind: "set", key: op.key, value: value.value });
	}
	return checked;
}

/**
 * 读盘读出来的那段 JSON 认不认:`{ version: 1, entries: { 键: Json } }`。认就回那一袋(值已拷贝),不认回 `undefined`。
 * 盘上的键不再核前缀与长度 —— 那是写入时的规矩,读出来的是自己写过的。
 */
export function parseStoredEntries(parsed: unknown): Map<string, Json> | undefined {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const { version, entries } = parsed as { version?: unknown; entries?: unknown };
	if (version !== STORE_FILE_VERSION) return undefined;
	if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return undefined;
	const bag = new Map<string, Json>();
	for (const [key, value] of Object.entries(entries)) {
		const copy = copyJson(value);
		if (!copy.ok) return undefined;
		bag.set(key, copy.value);
	}
	return bag;
}

function makeLane(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (task) => {
		const run = tail.then(task);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

export function createKeyValueStores(opts: CreateKeyValueStoresOptions): KeyValueStoreHandle {
	let current = new Map<string, Json>(opts.initial);
	const lane = opts.lane ?? makeLane();

	/** 限额:对「应用完之后的整袋」算。 */
	function overLimit(
		next: ReadonlyMap<string, Json>,
		setKeys: Iterable<string>,
	): string | undefined {
		const { maxKeyBytes, maxTotalBytes } = opts.limits;
		if (maxKeyBytes !== undefined) {
			for (const key of setKeys) {
				const value = next.get(key);
				if (value !== undefined && bytesOf(JSON.stringify(value)) > maxKeyBytes) {
					return `「${key}」的值超过单键上限 ${maxKeyBytes} 字节`;
				}
			}
		}
		const total = bytesOf(serializeEntries(next));
		if (total > maxTotalBytes) return `整份 ${total} 字节,超过上限 ${maxTotalBytes} 字节`;
		return undefined;
	}

	/** 在写道里:落盘成功才把内存换成 `next`。 */
	async function commit(next: Map<string, Json>, setKeys: Iterable<string>): Promise<Result> {
		const problem = overLimit(next, setKeys);
		if (problem !== undefined) return fail("invalid", problem);
		// 与现在的一模一样就不写:删一个本来没有的键、存一个没变的值。
		if (serializeEntries(next) === serializeEntries(current)) return ok();
		let result: Result;
		try {
			result = await opts.persist(next);
		} catch (err) {
			result = fail("unavailable", `存盘失败:${errorMessageOf(err)}`);
		}
		if (result.ok) current = next;
		return result;
	}

	async function enqueue(task: () => Promise<Result>): Promise<Result> {
		// 交进来那一刻看:关了之后才发的写一律拒,关之前已经排上的照常落完。
		const blockedBy = opts.blocked?.();
		if (blockedBy !== undefined) return fail("unavailable", blockedBy);
		try {
			return await lane(task);
		} catch (err) {
			// 写道关了(关停之后)迟到的写:回 unavailable,不落盘。
			return fail("unavailable", `写道已关门:${errorMessageOf(err)}`);
		}
	}

	/** 在写道里:把已校验的几步按序应用到当前这一袋的拷贝上,落盘成功才换。 */
	function applyChecked(checked: readonly CheckedOp[]): Promise<Result> {
		const next = new Map(current);
		const setKeys: string[] = [];
		for (const op of checked) {
			if (op.kind === "set") {
				next.set(op.key, op.value);
				setKeys.push(op.key);
			} else {
				next.delete(op.key);
			}
		}
		return commit(next, setKeys);
	}

	function storeOf(which: "integration" | "host"): KeyValueStore {
		function batch(ops: readonly KeyValueOp[]): Promise<Result> {
			if (ops.length === 0) return Promise.resolve(ok());
			const checked = checkOps(which, ops);
			if (typeof checked === "string") return Promise.resolve(fail("invalid", checked));
			return enqueue(() => applyChecked(checked));
		}
		return {
			get<T extends Json>(key: string): T | undefined {
				// 读不了的那一袋 `initial` 本来就是空的,这里不用另判。
				const value = current.get(key);
				return value === undefined ? undefined : (structuredClone(value) as T);
			},
			set: (key, value) => batch([{ kind: "set", key, value }]),
			delete: (key) => batch([{ kind: "delete", key }]),
			batch,
		};
	}

	return {
		integration: storeOf("integration"),
		host: storeOf("host"),
		snapshot: () => new Map(current),
		commit(hostOps, integrationOps) {
			// 集成那一组在入队之前就验:带了 `http.` 键的当场回 `invalid`,什么都不排、盘上不变。
			const integrationChecked = checkOps("integration", integrationOps);
			if (typeof integrationChecked === "string") {
				return Promise.resolve(fail("invalid", integrationChecked));
			}
			return enqueue(() => {
				// 宿主那一组**进了写道才算**(罐子此刻的内容),再按宿主那一面的规矩验;两组合成一次写。
				let hostChecked: CheckedOp[] | string;
				try {
					hostChecked = checkOps("host", hostOps());
				} catch (err) {
					return Promise.resolve(
						fail("unavailable", `取宿主那一组改动时出错:${errorMessageOf(err)}`),
					);
				}
				if (typeof hostChecked === "string") return Promise.resolve(fail("invalid", hostChecked));
				return applyChecked([...hostChecked, ...integrationChecked]);
			});
		},
		replace(entries) {
			const checked = checkOps(
				"whole",
				[...entries].map(([key, value]) => ({ kind: "set" as const, key, value })),
			);
			if (typeof checked === "string") return Promise.resolve(fail("invalid", checked));
			return enqueue(() => {
				const next = new Map<string, Json>();
				for (const op of checked) if (op.kind === "set") next.set(op.key, op.value);
				return commit(next, next.keys());
			});
		},
	};
}
