import type {
	DeliveryResult,
	Disposable,
	FeatureKey,
	GlobalDefaults,
	Logger,
	NotificationPayload,
	NotificationSink,
	PayloadSegment,
	PushTarget,
	ServiceContext,
} from "@bilibili-notify/internal";
import { inQuietHours, resolve } from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";

/**
 * 把 NotificationPayload 升级为 composite 并插入 `{ type: "at-all" }` 段。
 *
 * 版式:**图片在前,@全体 紧贴文字(艾特接文字)**。at-all 落在第一个 `text`
 * 段之前(其前面的 image 段保持领头);没有 text 段(罕见纯图)时落在末尾,
 * 跟在图片后面。
 * - text → `[at-all, text]`
 * - image(+caption) → `[image, at-all, caption?]`(无 caption 则 `[image, at-all]`)
 * - composite(直播/动态卡片 `[image, text]`)→ `[image, at-all, text]`
 */
function prependAtAll(payload: NotificationPayload): NotificationPayload {
	const at: PayloadSegment = { type: "at-all" };
	let segs: PayloadSegment[];
	switch (payload.kind) {
		case "text":
			segs = [{ type: "text", text: payload.text }];
			break;
		case "image":
			segs = [{ type: "image", buffer: payload.image.buffer, mime: payload.image.mime }];
			if (payload.caption) segs.push({ type: "text", text: payload.caption });
			break;
		case "composite":
			segs = [...payload.segments];
			break;
	}
	const firstText = segs.findIndex((s) => s.type === "text");
	segs.splice(firstText < 0 ? segs.length : firstText, 0, at);
	return { kind: "composite", segments: segs };
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
	 * 可选 ServiceContext。传入后,retry backoff 的 sleep 走 `serviceCtx.setTimeout`,
	 * plugin/runtime dispose 时可被立即 clear,不会留 32s 空跑 timer。stop() 也会
	 * 唤醒所有 sleeping retry 循环立即收敛。
	 *
	 * 不传则退化为裸 setTimeout + stop() 唤醒(过渡期兼容,仍能 dispose-safe)。
	 */
	serviceCtx?: ServiceContext;
	/**
	 * Latest `GlobalDefaults` provider — used to resolve `EffectiveSubscription`
	 * per push so `features.X` and `schedule.quietHours` gates work against the
	 * current globals state (not a stale snapshot).
	 *
	 * 可选:若不传,broadcastToFeature 退化为「仅 routing 决定是否发」的旧行为,
	 * 用于过渡期的 Koishi adapter 还没接 globals 的场景。
	 */
	defaults?: () => GlobalDefaults;
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
	/**
	 * 边沿触发用:master 上次已知可达性。`undefined`=未评估;`true/false`=上次判定。
	 * 仅在跳变时打日志(见 {@link refreshMasterReachability}),避免持续不可达时
	 * 在 per-tick 热路径刷 error(Q1 约束)。
	 */
	private masterReachable?: boolean;
	private readonly logger: Logger;
	private readonly defaults?: () => GlobalDefaults;
	private readonly onSend?: (info: PushSendInfo) => void;
	private readonly serviceCtx?: ServiceContext;
	private disposed = false;
	/**
	 * Per-lifecycle generation token。每次 `start()` 自增;in-flight retry 循环
	 * 进入时快照本代号,循环条件附加 `generation === myGen`。这样 stop()→start()
	 * 快速重启时,上一生命周期遗留的 in-flight 重试循环(可能正卡在 sleep)被
	 * 唤醒后会因代号不符立即退出,不会"复活"到新生命周期上重发([both]/Codex-P1)。
	 */
	private generation = 0;
	/**
	 * 正在 sleep 等重试的 wake 函数集合 — `stop()` 时全部触发立即返回,避免裸 setTimeout
	 * 路径下 retry 循环卡到 32s 才退出。
	 */
	private readonly sleepWakers = new Set<() => void>();

	constructor(opts: BilibiliPushOptions) {
		this.sink = opts.sink;
		this.store = opts.store;
		this.master = opts.master ?? null;
		this.logger = opts.logger;
		this.defaults = opts.defaults;
		this.onSend = opts.onSend;
		this.serviceCtx = opts.serviceCtx;
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
			// 目标变了:重置边沿状态,新目标首次不可达应是一次全新 error。
			this.masterReachable = undefined;
			this.logger.info(`[push] master 目标已切换: ${prev ?? "(无)"} → ${target?.id ?? "(无)"}`);
		}
	}

	/**
	 * 边沿触发 master 可达性日志。available→unreachable 跳变(含首次未知→不可达)
	 * 报一次 `error`(告警背channel已断,运维必须立刻知道);unreachable→available
	 * 报一次 `info`;持续不可达不再刷(由调用方各自 `debug` 记录跳过)。同时满足
	 * "运维必须立刻知道" 与 Q1 "error 不得在 per-tick/per-retry 热路径刷" 两约束。
	 */
	private refreshMasterReachability(): boolean {
		if (!this.master) {
			this.masterReachable = undefined;
			return false;
		}
		const available = this.sink.isAvailable(this.master.id);
		if (available) {
			if (this.masterReachable === false) {
				this.logger.info("[push] master 目标已恢复可达");
			}
			this.masterReachable = true;
		} else {
			if (this.masterReachable !== false) {
				this.logger.error("[push] master 目标不可达，运行状态通知将无法送达——告警背channel已断");
			}
			this.masterReachable = false;
		}
		return available;
	}

	start(): void {
		this.generation += 1;
		this.disposed = false;
		if (this.master) this.refreshMasterReachability();
	}

	stop(): void {
		this.disposed = true;
		// 唤醒所有 sleeping retry 循环;snapshot 一份避免迭代中 Set 被 wake 删除。
		for (const wake of [...this.sleepWakers]) wake();
	}

	/**
	 * Broadcast a notification to all targets registered for a given uid + feature.
	 * Returns an array of DeliveryResult (one per target).
	 *
	 * @全体成员 修饰(仅 `feature === "dynamic" | "live"` 且 `opts.allowAtAll !== false` 进入):
	 * - 订阅级默认 `sub.atAllDefaults.X` 决定 inherit-state 的 target 是否 @
	 * - per-target tristate Map `sub.atAll.X[targetId]` 显式覆写:`true` 强 ON、`false` 强 OFF
	 * - Map 里没有该 key → 走默认
	 *
	 * `feature === "live"` 仅作用于开播。但 live adapter 把「开播」和周期「正在直播」
	 * 复推都翻译成 `feature === "live"`(routing/总开关共用 live,模型里没有独立的
	 * ongoing key),仅靠 feature 无法区分。调用方据 `LivePushType` 判定:非开播的
	 * live 推送(周期 ongoing 等)必须传 `opts.allowAtAll = false` 显式抑制 @全体,
	 * 否则会每条直播推送都 @全体(本次修复的 bug)。SC/上舰/词云/总结/下播 走它们
	 * 自己的 feature key,本就不进 atAll 分支,传不传 allowAtAll 无影响。不传 opts
	 * = 保持「feature 决定」的旧行为(dynamic 调用点据此不变)。
	 */
	async broadcastToFeature(
		uid: string,
		feature: FeatureKey,
		payload: NotificationPayload,
		opts?: { allowAtAll?: boolean },
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];

		const sub = this.store.findByUid(uid);
		if (!sub) {
			this.logger.debug(`[push] uid=${uid} 无订阅记录，跳过 feature=${feature}`);
			return [];
		}

		// 「features 总开关」与「quietHours 免扰时段」两道 runtime gate。两者都需要把 sub
		// 折叠成 EffectiveSubscription 才能读 —— 仅在 defaults provider 有传时启用,过渡期
		// 没传则退化到「routing-only」的旧行为(顺带保持 BilibiliPush 单元测试的简单构造)。
		const defaults = this.defaults?.();
		if (defaults) {
			const eff = resolve(sub, defaults);
			if (!eff.features[feature]) {
				this.logger.debug(`[push] uid=${uid} feature=${feature} 总开关 OFF，跳过`);
				return [];
			}
			if (inQuietHours(eff.schedule.quietHours, new Date())) {
				this.logger.debug(`[push] uid=${uid} feature=${feature} 落在免扰时段，跳过`);
				return [];
			}
		}

		const targetIds = sub.routing[feature] ?? [];
		if (targetIds.length === 0) {
			this.logger.debug(`[push] uid=${uid} feature=${feature} 无目标，跳过`);
			return [];
		}

		// 默认(opts 不传 / allowAtAll 非显式 false)= 按 feature 决定,保持旧行为。
		// 调用方显式传 false 时强制不 @全体(周期「正在直播」等非开播的 live 推送)。
		const atAllScope =
			opts?.allowAtAll === false
				? null
				: feature === "dynamic"
					? "dynamic"
					: feature === "live"
						? "live"
						: null;

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
		// ②7:per-batch generation 快照。此前 sendBatch 仅入口判 disposed,逐条
		// 间无 generation 校验 —— stop()→start() 中途切换会让单次广播跨生命周期
		// 拆发。本批属于发起时的那个 generation;lifecycle 翻转即放弃剩余目标,
		// 且最后那条已 in-flight 的结果是生命周期 artifact,不 onSend / 不计入。
		const myGen = this.generation;
		const results: DeliveryResult[] = [];
		for (const id of targetIds) {
			if (this.disposed || this.generation !== myGen) break;
			const result = await this.sendToTarget(id, payload);
			if (this.disposed || this.generation !== myGen) break;
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

		const myGen = this.generation;
		let delay = INITIAL_RETRY_DELAY_MS;
		while (!this.disposed && this.generation === myGen) {
			if (!this.sink.isAvailable(targetId)) {
				if (delay > MAX_RETRY_DELAY_MS) {
					const msg = `target=${targetId} 持续不可达，放弃推送`;
					this.logger.error(`[push] ${msg}`);
					return { ok: false, latencyMs: 0, err: msg };
				}
				this.logger.debug(`[push] target=${targetId} 暂不可达，${delay / 1000}s 后重试`);
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
		// ②7:while 退出有两因 —— disposed,或 generation 失配(stop→start)。
		// 此前一律标 "disposed",generation 失配时误导诊断。区分之。
		return {
			ok: false,
			latencyMs: 0,
			err: this.disposed ? "disposed" : "superseded",
		};
	}

	/**
	 * Send a private message to the configured master target.
	 * No-op if no master is configured or target is unavailable.
	 */
	async sendToMaster(payload: NotificationPayload): Promise<DeliveryResult | null> {
		if (this.disposed || !this.master) return null;
		if (!this.refreshMasterReachability()) {
			this.logger.debug("[push] master 目标不可达，跳过本次私信通知");
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
		return new Promise<void>((resolveSleep) => {
			let release: Disposable | undefined;
			const wake = (): void => {
				release?.dispose();
				release = undefined;
				this.sleepWakers.delete(wake);
				resolveSleep();
			};
			this.sleepWakers.add(wake);
			if (this.serviceCtx) {
				release = this.serviceCtx.setTimeout(wake, ms);
			} else {
				// 退化路径:裸 setTimeout + stop() 主动 wake。timer 自身会再走一遍 wake
				// 但 sleepWakers.delete 是幂等的,resolve 也是。
				const id = setTimeout(wake, ms);
				// P2:退化裸 setTimeout 必须 unref —— 否则一个 in-flight 重试
				// sleep 会顶住事件循环、阻塞进程优雅退出。
				id.unref?.();
				release = { dispose: () => clearTimeout(id) };
			}
		});
	}
}
