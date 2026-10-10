/**
 * 测试里的内存版小存储 —— 包一层**真的** `createKeyValueStores`,规矩(保留前缀、限额、JSON、`batch` 一起成)与生产
 * 同一份实现,不是另抄的假货;只有 `persist` 换成了「记一笔、回成功」。
 *
 * - `persists` 是每次落盘时那一袋的拷贝,按先后排:测试数「落了几次」、看第一次落盘那一刻两个键同时是新值。
 * - `failNext` 给几次就让接下来几次 `persist` 回 `unavailable`,模拟写盘失败。
 */

import {
	type Disposable,
	fail,
	type Json,
	type KeyValueStore,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import {
	createKeyValueStores,
	type KeyValueStoreHandle,
	SECRETS_LIMITS,
	STATE_LIMITS,
} from "../../integration-store/key-value-store.js";
import type { IntegrationStoreHandle } from "../../integration-store/store.js";

export interface MemoryKeyValueStores {
	readonly stores: KeyValueStoreHandle;
	/** 集成那一面。 */
	readonly store: KeyValueStore;
	readonly persists: Array<Map<string, Json>>;
	/** 接下来这么多次落盘回失败。 */
	failNext(times?: number): void;
	/** 让下一次落盘停在半路,直到调用返回的那个函数;用来造「前一笔还没落完、后一笔已经来了」。 */
	holdNext(): () => void;
}

export function memoryKeyValueStores(
	kind: "state" | "secrets" = "state",
	initial?: Record<string, Json>,
): MemoryKeyValueStores {
	const persists: Array<Map<string, Json>> = [];
	let failures = 0;
	let gate: Promise<void> | undefined;
	const stores = createKeyValueStores({
		initial: initial ? new Map(Object.entries(initial)) : undefined,
		limits: kind === "state" ? STATE_LIMITS : SECRETS_LIMITS,
		async persist(entries): Promise<Result> {
			const waiting = gate;
			gate = undefined;
			if (waiting) await waiting;
			if (failures > 0) {
				failures -= 1;
				return fail("unavailable", "测试里让这次落盘失败");
			}
			persists.push(new Map(entries));
			return ok();
		},
	});
	return {
		stores,
		store: stores.integration,
		persists,
		failNext(times = 1) {
			failures = times;
		},
		holdNext() {
			let release = () => {};
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
	};
}

/** 一对内存版的 `state` / `secrets`(适配器上下文、拓展上下文的测试支撑用)。 */
export function memoryStores(): { state: KeyValueStore; secrets: KeyValueStore } {
	return {
		state: memoryKeyValueStores("state").store,
		secrets: memoryKeyValueStores("secrets").store,
	};
}

/**
 * 一个集成的内存版存储把手(四个存储 + 合并提交 + 关闭),落盘只记一笔、不碰盘。`initial` 是两份存储起始的内容
 * (含宿主那一面的 `http.` 键)。B 站的 `Api` 测试与只读真机脚本用它拼 `BiliContext`。
 */
export function memoryStoreHandle(
	initial: { state?: Record<string, Json>; secrets?: Record<string, Json> } = {},
) {
	const state = memoryKeyValueStores("state", initial.state);
	const secrets = memoryKeyValueStores("secrets", initial.secrets);
	let closed = false;
	const handle: IntegrationStoreHandle = {
		state: state.store,
		secrets: secrets.store,
		hostState: state.stores.host,
		hostSecrets: secrets.stores.host,
		commitSecrets: secrets.stores.commit,
		onSecretsReplaced: (): Disposable => ({ dispose() {} }),
		close() {
			closed = true;
		},
	};
	return { handle, state, secrets, isClosed: () => closed };
}

/**
 * 内存版的存储宿主(`IntegrationStore` 里装载器与内置适配器登记用到的那一面):`open` 同一个键开着就抛、
 * `close()` 之后能再开,与生产一样。
 */
export function memoryIntegrationStore(): {
	open(key: string): Promise<IntegrationStoreHandle>;
	/** 现在开着的键。 */
	openKeys(): string[];
	/** 开过的次数(按键)。 */
	openCount(key: string): number;
} {
	const opened = new Set<string>();
	const counts = new Map<string, number>();
	return {
		async open(key) {
			if (opened.has(key)) throw new Error(`集成 ${key} 的存储已经开着`);
			opened.add(key);
			counts.set(key, (counts.get(key) ?? 0) + 1);
			const { handle } = memoryStoreHandle();
			return {
				...handle,
				close() {
					opened.delete(key);
				},
			};
		},
		openKeys: () => [...opened],
		openCount: (key) => counts.get(key) ?? 0,
	};
}
