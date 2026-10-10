import type { Result } from "./constants";

/** 能原样进出 JSON 的值。数字只收有限数;对象只收普通对象。 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** 一批改动里的一步(一步操作叫 `Op`,判别键叫 `kind`;取值就是方法名)。 */
export type KeyValueOp =
	| { kind: "set"; key: string; value: Json }
	| { kind: "delete"; key: string };

/**
 * 集成的小存储。`state` 与 `secrets` 是同一个接口,差别只在保管(ADR-0025 决策 9)。
 * - `get` 同步:宿主在 `start` / `activate` 之前读进内存;交回的是一份拷贝,改它不影响存着的。
 * - 写不抛(决策 10):超上限、写了 `http.` 开头的键、值不是 JSON 回 `invalid`;磁盘写失败回 `unavailable`。
 * - 读得到的永远是落了盘的:`await` 回来之前 `get` 还是旧值。
 */
export interface KeyValueStore {
	get<T extends Json>(key: string): T | undefined;
	set(key: string, value: Json): Promise<Result>;
	delete(key: string): Promise<Result>;
	/**
	 * 一批改动,**保证一起成或一起不成**:先整批校验(任何一步不合规矩,整批回 `invalid`,一步都不做),
	 * 再按顺序应用、一次原子写落盘;写失败整批不生效。同一个键出现几次,后面的盖前面的。空批直接回成功。
	 */
	batch(ops: readonly KeyValueOp[]): Promise<Result>;
}
