import type {
	DeliveryResult,
	FeatureKey,
	Logger,
	NotificationPayload,
	NotificationSink,
	PayloadSegment,
	PushTarget,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";

/**
 * 把 NotificationPayload 升级为 composite 并前置 `{ type: "at-all" }` 段。
 * text → composite [at-all, text],image → composite [at-all, image-as-text-caption + image],
 * composite → 复用 segments + at-all 头。caption 文本会作为额外 text 段保留。
 */
function prependAtAll(payload: NotificationPayload): NotificationPayload {
	const head: PayloadSegment = { type: "at-all" };
	switch (payload.kind) {
		case "text":
			return { kind: "composite", segments: [head, { type: "text", text: payload.text }] };
		case "image": {
			const segs: PayloadSegment[] = [head];
			if (payload.caption) segs.push({ type: "text", text: payload.caption });
			segs.push({ type: "image", buffer: payload.image.buffer, mime: payload.image.mime });
			return { kind: "composite", segments: segs };
		}
		case "composite":
			return { kind: "composite", segments: [head, ...payload.segments] };
	}
}

const INITIAL_RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = INITIAL_RETRY_DELAY_MS * 2 ** 5;

/**
 * Per-send context fired after每条 `sendToTarget` 结束(成功/失败均触发)。Adapter
 * 用它把 history 记录里的 `uid` 与 `source` 拼对 —— multiplex sink 拿不到
 * 这两个字段(它只看 PushTarget),所以历史只能从这一层注入。
 */
export interface PushSendInfo {
	uid: string;
	feature: FeatureKey | "private";
	target: PushTarget;
	payload: NotificationPayload;
	result: DeliveryResult;
	private: boolean;
}

/** Options for constructing a BilibiliPush instance. */
export interface BilibiliPushOptions {
	/** Platform-neutral push sink — translates targetId → platform delivery. */
	sink: NotificationSink;
	/** Subscription store — used to resolve routing per uid+feature. */
	store: SubscriptionStore;
	/** Optional master PushTarget for private error notifications. */
	master?: PushTarget | null;
	/** Logger instance. */
	logger: Logger;
	/**
	 * Optional hook fired after every successful or failed send. Receives the
	 * resolved `target` plus the originating `uid` / `feature` — fields the
	 * multiplex sink can't see. Standalone wires this to history-store append.
	 */
	onSend?: (info: PushSendInfo) => void;
}

/**
 * Platform-neutral push router.
 *
 * Replaces the old koishi-coupled BilibiliPush. Routing comes from
 * store.findByUid(uid)?.routing[feature] → targetId[] → sink.send(targetId, payload).
 * The old pushArrMap, broadcastToTargets, sendPrivateMsg/sendErrorMsg are gone.
 */
export class BilibiliPush {
	private readonly sink: NotificationSink;
	private readonly store: SubscriptionStore;
	private master: PushTarget | null;
	private readonly logger: Logger;
	private readonly onSend?: (info: PushSendInfo) => void;
	private disposed = false;

	constructor(opts: BilibiliPushOptions) {
		this.sink = opts.sink;
		this.store = opts.store;
		this.master = opts.master ?? null;
		this.logger = opts.logger;
		this.onSend = opts.onSend;
	}

	/**
	 * 热替换 master PushTarget。adapter 在 globals/targets 变化后调用,
	 * 后续 `sendPrivateMsg` / `sendErrorMsg` 立即用新目标。
	 * `null` 表示"无 master 配置",私聊路径变 no-op。
	 */
	setMaster(target: PushTarget | null): void {
		const prev = this.master?.id;
		this.master = target;
		if (prev !== target?.id) {
			this.logger.info(`[push] master 目标已切换: ${prev ?? "(无)"} → ${target?.id ?? "(无)"}`);
		}
	}

	start(): void {
		this.disposed = false;
		if (this.master && !this.sink.isAvailable(this.master.id)) {
			this.logger.warn("[push] master 目标当前不可达，运行状态通知将无法发送");
		}
	}

	stop(): void {
		this.disposed = true;
	}

	/**
	 * Broadcast a notification to all targets registered for a given uid + feature.
	 * Returns an array of DeliveryResult (one per target).
	 *
	 * @全体成员 修饰(仅 `feature === "dynamic" | "live"` 进入):
	 * - 订阅级默认 `sub.atAllDefaults.X` 决定 inherit-state 的 target 是否 @
	 * - per-target tristate Map `sub.atAll.X[targetId]` 显式覆写:`true` 强 ON、`false` 强 OFF
	 * - Map 里没有该 key → 走默认
	 *
	 * `feature === "live"` 仅作用于开播,SC/上舰/词云/总结/下播 等子事件以 `liveEnd`/
	 * `superchat`/... 它们自己的 feature key 走,不会进入这条 atAll 分支。Map keys 子集
	 * 约束已在 schema refine 强制,这里不再二次校验。
	 */
	async broadcastToFeature(
		uid: string,
		feature: FeatureKey,
		payload: NotificationPayload,
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];

		const sub = this.store.findByUid(uid);
		if (!sub) {
			this.logger.debug(`[push] uid=${uid} 无订阅记录，跳过 feature=${feature}`);
			return [];
		}

		const targetIds = sub.routing[feature] ?? [];
		if (targetIds.length === 0) {
			this.logger.debug(`[push] uid=${uid} feature=${feature} 无目标，跳过`);
			return [];
		}

		const atAllScope = feature === "dynamic" ? "dynamic" : feature === "live" ? "live" : null;

		this.logger.info(`[push] uid=${uid} feature=${feature} → ${targetIds.length} 个目标`);
		if (!atAllScope) {
			return this.sendBatch(targetIds, payload, { uid, feature });
		}

		const defaultOn = sub.atAllDefaults[atAllScope];
		const overrides = sub.atAll[atAllScope];
		const atAllTargets: string[] = [];
		const plainTargets: string[] = [];
		for (const id of targetIds) {
			const explicit = overrides[id];
			const shouldAtAll = explicit ?? defaultOn;
			(shouldAtAll ? atAllTargets : plainTargets).push(id);
		}
		if (atAllTargets.length === 0) {
			return this.sendBatch(plainTargets, payload, { uid, feature });
		}
		if (plainTargets.length === 0) {
			return this.sendBatch(atAllTargets, prependAtAll(payload), { uid, feature });
		}
		const results: DeliveryResult[] = [];
		results.push(...(await this.sendBatch(plainTargets, payload, { uid, feature })));
		results.push(...(await this.sendBatch(atAllTargets, prependAtAll(payload), { uid, feature })));
		return results;
	}

	/**
	 * Send a notification to all targets in the list.
	 * Failures are captured per-target; does not throw.
	 * Optional `ctx` carries the originating uid/feature so adapter hooks
	 * (history append) get the correct fields. broadcastToFeature passes ctx;
	 * legacy callers without ctx get history rows with empty uid.
	 */
	async sendBatch(
		targetIds: string[],
		payload: NotificationPayload,
		ctx?: { uid: string; feature: FeatureKey | "private" },
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const results: DeliveryResult[] = [];
		for (const id of targetIds) {
			const result = await this.sendToTarget(id, payload);
			if (this.onSend && ctx) {
				const target = this.sink.resolve(id);
				if (target) {
					this.onSend({
						uid: ctx.uid,
						feature: ctx.feature,
						target,
						payload,
						result,
						private: false,
					});
				}
			}
			results.push(result);
		}
		return results;
	}

	/**
	 * Send a notification to a single target.
	 * Retries with exponential back-off if the sink indicates the target is temporarily unavailable.
	 */
	async sendToTarget(
		targetId: string,
		payload: NotificationPayload,
		opts?: { private?: boolean },
	): Promise<DeliveryResult> {
		if (this.disposed) return { ok: false, latencyMs: 0, err: "disposed" };

		let delay = INITIAL_RETRY_DELAY_MS;
		while (!this.disposed) {
			if (!this.sink.isAvailable(targetId)) {
				if (delay > MAX_RETRY_DELAY_MS) {
					const msg = `target=${targetId} 持续不可达，放弃推送`;
					this.logger.error(`[push] ${msg}`);
					return { ok: false, latencyMs: 0, err: msg };
				}
				this.logger.warn(`[push] target=${targetId} 暂不可达，${delay / 1000}s 后重试`);
				await this.sleep(delay);
				delay *= 2;
				continue;
			}

			const t0 = Date.now();
			try {
				const result = opts?.private
					? await this.sink.sendPrivate(targetId, payload)
					: await this.sink.send(targetId, payload);
				return result;
			} catch (e) {
				const err = e instanceof Error ? e.message : String(e);
				this.logger.error(`[push] target=${targetId} 发送失败: ${err}`);
				return { ok: false, latencyMs: Date.now() - t0, err };
			}
		}
		return { ok: false, latencyMs: 0, err: "disposed" };
	}

	/**
	 * Send a private message to the configured master target.
	 * No-op if no master is configured or target is unavailable.
	 */
	async sendToMaster(payload: NotificationPayload): Promise<DeliveryResult | null> {
		if (this.disposed || !this.master) return null;
		if (!this.sink.isAvailable(this.master.id)) {
			this.logger.warn("[push] master 目标不可达，跳过私信通知");
			return null;
		}
		return this.sendToTarget(this.master.id, payload, { private: true });
	}

	/** Convenience: send a plain-text error message to the master. */
	async sendPrivateMsg(text: string): Promise<void> {
		await this.sendToMaster({ kind: "text", text });
	}

	/** Convenience: log the error and optionally notify master. */
	async sendErrorMsg(reason: string): Promise<void> {
		this.logger.error(`[push] ${reason}`);
		await this.sendPrivateMsg(reason);
	}

	private sleep(ms: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
