import { type Json, type KeyValueStore, ok } from "@bilibili-notify/extension";

/**
 * 桥的测试里宿主递进上下文的那两格小存储(`state` / `secrets`)。桥不读写它们,只是类型要求上下文带着;
 * 测试不能 import 服务端的测试支撑,所以这里就地写一个按 `Map` 真存的内存版(写了读得到,不是什么都回成功的空壳)。
 */
export function memoryKeyValueStore(): KeyValueStore {
	const bag = new Map<string, Json>();
	return {
		get: <T extends Json>(key: string) => bag.get(key) as T | undefined,
		async set(key, value) {
			bag.set(key, value);
			return ok();
		},
		async delete(key) {
			bag.delete(key);
			return ok();
		},
		async batch(ops) {
			for (const op of ops) {
				if (op.kind === "set") bag.set(op.key, op.value);
				else bag.delete(op.key);
			}
			return ok();
		},
	};
}
