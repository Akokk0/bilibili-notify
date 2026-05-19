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
 * koishi is unaffected — it never populated cachedProfile and never used state.
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
				const prev = records[id] ?? {};
				// Per-key replace: callers pass complete cachedProfile / fansBaseline
				// objects. `undefined` keys in `partial` are skipped so a fans-only
				// tick doesn't clobber an existing fansBaseline.
				const next: SubRuntime = { ...prev };
				if (partial.cachedProfile !== undefined) next.cachedProfile = partial.cachedProfile;
				if (partial.fansBaseline !== undefined) next.fansBaseline = partial.fansBaseline;
				records = { ...records, [id]: next };
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
