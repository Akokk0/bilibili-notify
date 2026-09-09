import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CachedProfile, FansBaseline, Logger } from "@bilibili-notify/internal";

/**
 * SubRuntimeStore — per-subscription **runtime** data, externalized out of the
 * persisted `Subscription` config.
 *
 * Why this exists: `cachedProfile.fans` / `lastRefreshedAt` get rewritten by
 * `FansPoller` every dynamicCron tick (~2min). When that lived inside
 * `Subscription` and went through `ConfigStore.patchSubscription`, every tick
 * emitted `config-changed:subscriptions` → SubscriptionStore reseed → whole-
 * array diff → spurious `subscription-changed{update}` → DynamicEngine re-
 * subscribe + `[ops]` info-log spam (the Logs-Tab flooding bug). Moving the
 * high-churn display cache + fans anchor here — a pure apps/server artifact
 * with its own write path that emits **no** config/subscription events —
 * breaks that chain entirely.
 *
 * Topology: single JSON file `<dataDir>/state/sub-runtime.json` keyed by
 * `Subscription.id`, atomic tmpfile+rename writes, all mutations serialized
 * through one private FIFO promise chain (mirrors `ConfigStore.runScoped`).
 *
 * Record shape (sibling keys, NOT baseline-inside-profile): keeping
 * `fansBaseline` a sibling of `cachedProfile` lets `/api/subs` join the
 * profile back as a zero-logic passthrough while `fansBaseline` (FansPoller-
 * private bookkeeping) never leaks into the DTO.
 */
export interface SubRuntime {
	/** Cached B-station public profile mirror for UI display. FansPoller-owned. */
	cachedProfile?: CachedProfile;
	/** Fans count + ts at first poll of this sub; written once, never changed. */
	fansBaseline?: FansBaseline;
	/**
	 * 解析出的直播间号(uid → live_room.roomid)。LiveEngine 首次解析后写回,之后
	 * 启动/reload 直接读盘复用,省掉每次对每个 UP 的 `getUserInfo` 房号解析请求(③)。
	 */
	roomId?: string;
	/**
	 * 是否已在 B 站关注该 UP。
	 *
	 * **这是订阅能否工作的前提,不是装饰性元数据**:动态走 `feed/all`(关注流),没关注
	 * 就一条动态都收不到。所以它得能被前端看见 —— 订阅卡片上持续显示「未关注」,而不是
	 * 创建时一闪而过的 toast。
	 *
	 * `undefined` = 还没检查过(老数据 / 当时未登录),不等于「未关注」。
	 */
	followed?: boolean;
	/** `followed === false` 时的原因(风控 / 被拉黑 / 断网…),给用户看的。 */
	followError?: string;
}

export interface SubRuntimeStore {
	/**
	 * One sub's runtime record (clone), or undefined if never seeded.
	 * Treat as read-only — it's a defensive copy, mutating it does nothing.
	 */
	get(id: string): SubRuntime | undefined;
	/** Whole map snapshot (clone). Consumed by the `/api/subs` join. */
	getAll(): Record<string, SubRuntime>;
	/**
	 * Replace the given top-level keys of `records[id]` (creating the entry on
	 * demand) and atomically persist. Callers always pass complete
	 * `cachedProfile` / `fansBaseline` objects, so this is a per-key replace,
	 * not a deep merge. Serialized against other patch/prune calls.
	 */
	patch(id: string, partial: SubRuntime): Promise<void>;
	/** Drop any entry whose id is not in `keepIds` (orphan cleanup). */
	prune(keepIds: readonly string[]): Promise<void>;
	/** Load `<dataDir>/state/sub-runtime.json` (absent / malformed → empty). Idempotent. */
	load(): Promise<void>;
}

export interface CreateSubRuntimeStoreOptions {
	dataDir: string;
	logger: Logger;
}

function cloneRuntime(r: SubRuntime): SubRuntime {
	return structuredClone(r);
}

async function atomicWriteJson(absPath: string, value: unknown): Promise<void> {
	await mkdir(dirname(absPath), { recursive: true });
	const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const tmp = `${absPath}.tmp.${suffix}`;
	const body = `${JSON.stringify(value, null, 2)}\n`;
	await writeFile(tmp, body, { encoding: "utf8" });
	await rename(tmp, absPath);
}

export function createSubRuntimeStore(opts: CreateSubRuntimeStoreOptions): SubRuntimeStore {
	const file = join(opts.dataDir, "state", "sub-runtime.json");
	let records: Record<string, SubRuntime> = {};
	let loaded = false;
	// Single private FIFO chain so concurrent patch/prune (a FansPoller tick
	// vs. a POST self-seed) never interleave their read-modify-write of the
	// whole-file JSON. Errors propagate to the caller without poisoning the
	// chain. Same idiom as ConfigStore.runScoped, collapsed to one scope
	// (there is only one file).
	let queue: Promise<unknown> = Promise.resolve();

	function runSerial<T>(task: () => Promise<T>): Promise<T> {
		const next = queue.then(task, task);
		queue = next.catch(() => undefined);
		return next;
	}

	async function persist(): Promise<void> {
		try {
			await atomicWriteJson(file, records);
		} catch (err) {
			opts.logger.warn(`[sub-runtime] persist failed: ${String(err)}`);
			throw err;
		}
	}

	return {
		get(id) {
			const r = records[id];
			return r ? cloneRuntime(r) : undefined;
		},

		getAll() {
			const out: Record<string, SubRuntime> = {};
			for (const [id, r] of Object.entries(records)) out[id] = cloneRuntime(r);
			return out;
		},

		patch(id, partial) {
			return runSerial(async () => {
				// Per-key replace: callers pass complete cachedProfile / fansBaseline
				// objects rather than deep-merge fragments.
				//
				// 🔴 判据是**键在不在**,不是值等不等于 `undefined`,而且**逐键遍历、不点名**:
				//   - 点名的话(原先那张三键清单)往 `SubRuntime` 加一个字段而忘了补一行,
				//     那个键就静默不落盘 —— `followed` / `followError` 正是这么丢了很久的,
				//     类型、门禁、运行期都不会说一个字。
				//   - 按值判的话,`{ followed: true, followError: undefined }`(两处调用方
				//     都这么写,意思是「关上了,把上次那条错误清掉」)永远清不掉。
				// 「不带这个键」仍然是「别动它」—— fans-only 那一轮就靠这个不冲掉 baseline。
				const next: Record<string, unknown> = { ...(records[id] ?? {}) };
				for (const [key, value] of Object.entries(partial)) {
					if (value === undefined) delete next[key];
					else next[key] = value;
				}
				records = { ...records, [id]: next as SubRuntime };
				await persist();
			});
		},

		prune(keepIds) {
			return runSerial(async () => {
				const keep = new Set(keepIds);
				const next: Record<string, SubRuntime> = {};
				let dropped = 0;
				for (const [id, r] of Object.entries(records)) {
					if (keep.has(id)) next[id] = r;
					else dropped++;
				}
				if (dropped === 0) return;
				records = next;
				await persist();
				opts.logger.debug(`[sub-runtime] pruned ${dropped} orphan entr(ies)`);
			});
		},

		async load() {
			if (loaded) return;
			loaded = true;
			try {
				const raw = await readFile(file, "utf8");
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					records = parsed as Record<string, SubRuntime>;
				} else {
					opts.logger.warn("[sub-runtime] file is not an object; starting empty");
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					opts.logger.warn(`[sub-runtime] load failed, starting empty: ${String(err)}`);
				}
			}
		},
	};
}
