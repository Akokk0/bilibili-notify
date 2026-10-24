import { readFile } from "node:fs/promises";
import {
	type CreatorProfile,
	createSerialQueue,
	type ImageRef,
	type Logger,
} from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { dataPath } from "./roots.js";

/**
 * SubscriptionStateStore — per-subscription cached profile data, externalized out of the
 * persisted `Subscription` config.
 *
 * Why this exists: `cachedProfile.followers` / `refreshedAt` get rewritten by
 * `ProfileRefresh` every dynamicCron tick (~2min). When that lived inside
 * `Subscription` and went through `ConfigStore.patchSubscription`, every tick
 * emitted `config-changed:subscriptions` → SubscriptionStore reseed → whole-
 * array diff → spurious `subscription-changed{update}` → DynamicPoller re-
 * subscribe + `[ops]` info-log spam (the Logs-Tab flooding bug). Moving the
 * high-churn display cache here — a pure apps/server artifact
 * with its own write path that emits **no** config/subscription events —
 * breaks that chain entirely.
 *
 * Topology: single JSON file `<dataRoot>/runtime/subscription-state.json` keyed by
 * `Subscription.id`, atomic tmpfile+rename writes, all mutations serialized
 * through one private write queue (mirrors `ConfigStore.runScoped`).
 *
 * Record shape: `/api/subscriptions` joins `cachedProfile` back as a zero-logic
 * passthrough.
 */
export interface SubscriptionState {
	/**
	 * Cached B-station public profile mirror for UI display. ProfileRefresh-owned.
	 * 拓展订阅那一支由拓展「报资料更新」写(`reported-profiles.ts`,ADR-0019 决策 7 / 62),头像存进图库、
	 * 这里只放引用(`avatar`);所以这座仓是图库的一家引用方,见 {@link SubscriptionStateStore.listImageRefs}。
	 */
	cachedProfile?: CreatorProfile;
}

export interface SubscriptionStateStore {
	/**
	 * One sub's runtime record (clone), or undefined if never seeded.
	 * Treat as read-only — it's a defensive copy, mutating it does nothing.
	 */
	get(id: string): SubscriptionState | undefined;
	/** Whole map snapshot (clone). Consumed by the `/api/subscriptions` join. */
	getAll(): Record<string, SubscriptionState>;
	/**
	 * Replace the given top-level keys of `records[id]` (creating the entry on
	 * demand) and atomically persist. Callers always pass complete
	 * `cachedProfile` objects, so this is a per-key replace, not a deep merge.
	 * Serialized against other patch/prune calls.
	 */
	patch(id: string, partial: SubscriptionState): Promise<void>;
	/** Drop any entry whose id is not in `keepIds` (orphan cleanup). */
	prune(keepIds: readonly string[]): Promise<void>;
	/** Load `<dataRoot>/runtime/subscription-state.json` (absent / malformed → empty). Idempotent. */
	load(): Promise<void>;
	/**
	 * 所有订阅资料里存进图库的头像(去重)—— 图库清扫要的「这一家引用着谁」,装配时登记成引用方交出去。
	 * 两支订阅的 `avatar` 都算;B 站头像的来源网址不在核心资料缓存里,不算。
	 *
	 * 读的是内存里最新的那一份(patch 在写盘之前就换了它)。还没载入就被问,先把盘上的载进来再答 ——
	 * 清扫要是赶在开机载入之前,拿一份空名单去删图,所有拓展订阅的头像过了宽限期就没了。
	 */
	listImageRefs(): Promise<ImageRef[]>;
	/**
	 * 关停:先等在途与已排队的写全部落盘,再关门 —— 此后的 patch / prune 一律以
	 * `SerialQueueClosedError` 拒绝、不碰盘。关停的 `flush` 段调它。
	 */
	close(): Promise<void>;
}

/**
 * 孤儿清理:丢掉订阅已不存在的那些运行时条目。开机扫一次(停机期间删掉的),运行中每次
 * 删订阅再扫一次。
 *
 * 🔴 **留下的是全部订阅的 id —— 两支都算**(ADR-0019 决策 47)。拓展订阅的资料缓存也住在
 * 这里(拓展报来的名字 / 头像 / 粉丝,决策 7);只拿 B 站订阅当保留名单的话,开机一次、
 * 每删一条 B 站订阅一次,拓展订阅的资料就被静默抹掉 —— 类型、测试、构建全绿。所以这里
 * 收的是整个订阅仓而不是一份现成的 id 列表:调用方没有机会先筛一遍。
 */
export function pruneOrphanSubscriptionState(
	runtime: SubscriptionStateStore,
	subscriptions: Pick<SubscriptionStore, "list">,
): Promise<void> {
	return runtime.prune(subscriptions.list().map((s) => s.id));
}

export interface CreateSubscriptionStateStoreOptions {
	dataRoot: string;
	logger: Logger;
}

/** 写道的唯一一个键:整份只有一个文件。 */
const WRITE_KEY = "subscription-state";

function cloneRuntime(r: SubscriptionState): SubscriptionState {
	return structuredClone(r);
}

/** 订阅运行态在代里的位置。 */
export const SUBSCRIPTION_STATE_FILE = ["runtime", "subscription-state.json"] as const;

export function createSubscriptionStateStore(
	opts: CreateSubscriptionStateStoreOptions,
): SubscriptionStateStore {
	const file = dataPath(opts.dataRoot, ...SUBSCRIPTION_STATE_FILE);
	let records: Record<string, SubscriptionState> = {};
	/** 载入只做一次;`listImageRefs` 等的就是这一次(没载完时被问的人和第一个调 `load` 的等同一件事)。 */
	let loading: Promise<void> | undefined;
	// Single private write queue (one key — there is only one file) so concurrent patch/prune
	// (a ProfileRefresh tick vs. a POST self-seed) never interleave their read-modify-write of the
	// whole-file JSON. Errors propagate to the caller without poisoning the queue.
	const writes = createSerialQueue();

	function runSerial<T>(task: () => Promise<T>): Promise<T> {
		return writes.run(WRITE_KEY, task);
	}

	async function persist(): Promise<void> {
		try {
			await atomicWriteJson(file, records);
		} catch (err) {
			opts.logger.warn(`[subscription-state] persist failed: ${String(err)}`);
			throw err;
		}
	}

	function load(): Promise<void> {
		loading ??= (async () => {
			try {
				const raw = await readFile(file, "utf8");
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					records = parsed as Record<string, SubscriptionState>;
				} else {
					opts.logger.warn("[subscription-state] file is not an object; starting empty");
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[subscription-state] load failed, starting empty: ${String(err)}`);
				}
			}
		})();
		return loading;
	}

	return {
		get(id) {
			const r = records[id];
			return r ? cloneRuntime(r) : undefined;
		},

		getAll() {
			const out: Record<string, SubscriptionState> = {};
			for (const [id, r] of Object.entries(records)) out[id] = cloneRuntime(r);
			return out;
		},

		patch(id, partial) {
			return runSerial(async () => {
				// Per-key replace: callers pass complete cachedProfile objects rather
				// than deep-merge fragments.
				//
				// 🔴 判据是**键在不在**,不是值等不等于 `undefined`,而且**逐键遍历、不点名**:
				//   - 点名的话(原先那张三键清单)往 `SubscriptionState` 加一个字段而忘了补一行,
				//     那个键就静默不落盘 —— 类型、门禁、运行期都不会说一个字。
				//   - 按值判的话,显式传 `undefined`(意思是「把上次那个值清掉」)永远清不掉。
				// 「不带这个键」仍然是「别动它」—— 空 patch 不冲掉 cachedProfile。
				const next: Record<string, unknown> = { ...(records[id] ?? {}) };
				for (const [key, value] of Object.entries(partial)) {
					if (value === undefined) delete next[key];
					else next[key] = value;
				}
				records = { ...records, [id]: next as SubscriptionState };
				await persist();
			});
		},

		prune(keepIds) {
			return runSerial(async () => {
				const keep = new Set(keepIds);
				const next: Record<string, SubscriptionState> = {};
				let dropped = 0;
				for (const [id, r] of Object.entries(records)) {
					if (keep.has(id)) next[id] = r;
					else dropped++;
				}
				if (dropped === 0) return;
				records = next;
				await persist();
				opts.logger.debug(`[subscription-state] pruned ${dropped} orphan entr(ies)`);
			});
		},

		close: () => writes.close(),

		load,

		async listImageRefs() {
			await load();
			const refs = new Set<ImageRef>();
			for (const record of Object.values(records)) {
				const avatar = record.cachedProfile?.avatar;
				// 盘上是裸 JSON.parse 读出来的,不是字符串的不当引用。
				if (typeof avatar === "string") refs.add(avatar);
			}
			return [...refs];
		},
	};
}
