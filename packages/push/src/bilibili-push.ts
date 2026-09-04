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
 * 「@全体单独一条消息」的 payload。atAllTargets 上的发送序列:先发这条独立
 * @全体,再发原 payload(卡片 + 文字)—— 接收端看到的是两条独立消息,@ 提醒
 * 在前、卡片在后,不再把 at-all 段塞进卡片消息里。
 *
 * forward-images 同样适用:旧 `prependAtAll` 版本因要把 at-all 段塞进合并转发
 * 节点内部语义不清而沉默忽略,新版本下 @全体 已经是**外层独立一条消息**,跟
 * 合并转发节点不冲突 → 一视同仁照常先发独立 @全体 再发合并转发。
 */
function makeAtAllPayload(): NotificationPayload {
	const at: PayloadSegment = { type: "at-all" };
	return { kind: "composite", segments: [at] };
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
	 * 宿主的 ServiceContext:retry backoff 的 sleep 走 `serviceCtx.setTimeout`,runtime dispose
	 * 时可被立即 clear,不会留 32s 空跑 timer。stop() 也会唤醒所有 sleeping retry 循环立即收敛。
	 */
	serviceCtx: ServiceContext;
	/**
	 * Latest `GlobalDefaults` provider — used to resolve `EffectiveSubscription`
	 * per push so `features.X` and `schedule.quietHours` gates work against the
	 * current globals state (not a stale snapshot).
	 */
	defaults: () => GlobalDefaults;
	/**
	 * Optional hook fired after every successful or failed send. Receives the
	 * resolved `target` plus the originating `uid` / `feature` — fields the
	 * multiplex sink can't see. Standalone wires this to history-store append.
	 */
	onSend?: (info: PushSendInfo) => void;
	/**
	 * 全局静音 —— 「安静一会儿」。返回 true 时 {@link BilibiliPush.broadcastToFeature}
	 * 整条短路,所有 feature 一起挡。
	 *
	 * **每条推送现问一次**,不快照:静音是有到期时刻的,快照下来就得等下次重启才恢复。
	 *
	 * 发给主人的私聊(`sendToMaster` / `sendPrivateMsg`)**不受它管** —— 指令回复走的
	 * 就是那条路,连同挡掉的话主人只会看到指令毫无反应。
	 */
	muted: () => boolean;
}

/**
 * Platform-neutral push router.
 *
 * The standalone runtime's push router. Routing comes from
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
	private readonly defaults: () => GlobalDefaults;
	private readonly muted: () => boolean;
	private readonly onSend?: (info: PushSendInfo) => void;
	private readonly serviceCtx: ServiceContext;
	private disposed = false;
	/**
	 * Per-lifecycle generation token。每次 `start()` 自增;in-flight retry 循环
	 * 进入时快照本代号,循环条件附加 `generation === myGen`。这样 stop()→start()
	 * 快速重启时,上一生命周期遗留的 in-flight 重试循环(可能正卡在 sleep)被
	 * 唤醒后会因代号不符立即退出,不会"复活"到新生命周期上重发([both]/Codex-P1)。
	 */
	private generation = 0;
	/**
	 * 正在 sleep 等重试的 wake 函数集合 — `stop()` 时全部触发立即返回,避免
	 * retry 循环卡到 32s 才退出。
	 */
	private readonly sleepWakers = new Set<() => void>();

	constructor(opts: BilibiliPushOptions) {
		this.sink = opts.sink;
		this.store = opts.store;
		this.master = opts.master ?? null;
		this.logger = opts.logger;
		this.defaults = opts.defaults;
		this.muted = opts.muted;
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
		payload: NotificationPayload | NotificationPayload[],
		opts?: { allowAtAll?: boolean },
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		// 消息版式分条:一次推送可以是多条 payload 的序列。单 payload 归一成单元素序列,
		// 后续路径统一按序列处理,行为与旧签名逐字一致。
		const payloads = Array.isArray(payload) ? payload : [payload];
		if (payloads.length === 0) return [];

		// 全局静音闸,排在所有查询之前 —— 静音期间一次订阅查找都不必做。
		// 只挡订阅推送;发给主人的私聊不走这里,理由见 `muted` 的注释。
		if (this.muted()) {
			this.logger.debug(`[push] uid=${uid} feature=${feature} 处于全局静音，跳过`);
			return [];
		}

		const sub = this.store.findByUid(uid);
		if (!sub) {
			this.logger.debug(`[push] uid=${uid} 无订阅记录，跳过 feature=${feature}`);
			return [];
		}

		// 「features 总开关」与「quietHours 免扰时段」两道 runtime gate:把 sub 折叠成
		// EffectiveSubscription 后按当前 globals 判定。
		const defaults = this.defaults();
		const eff = resolve(sub, defaults);
		if (!eff.features[feature]) {
			this.logger.debug(`[push] uid=${uid} feature=${feature} 总开关 OFF，跳过`);
			return [];
		}
		if (inQuietHours(eff.schedule.quietHours, new Date())) {
			this.logger.debug(`[push] uid=${uid} feature=${feature} 落在免扰时段，跳过`);
			return [];
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
			return this.sendBatch(targetIds, payloads, { uid, feature });
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
			return this.sendBatch(plainTargets, payloads, { uid, feature });
		}

		// 「@全体单独一条 → 原 payload」两条独立消息:@ 提醒在前、卡片正文在后。
		// 关键区别:@全体 走 best-effort「即发不 await」(见 sendAtAllThenCard)——
		// 无管理权限的群发 @全体 会被协议端拒绝并触发 adapter 重试,旧版顺序 await
		// 它会把卡片正文连同后续订阅任务一起阻塞(@全体先出、图片隔很久才出、历史
		// 标失败)。现在卡片不再被 @全体 的重试拖住,@全体 失败也只异步落历史。
		const results: DeliveryResult[] = [];
		if (plainTargets.length > 0) {
			results.push(...(await this.sendBatch(plainTargets, payloads, { uid, feature })));
		}
		results.push(...(await this.sendAtAllThenCard(atAllTargets, payloads, { uid, feature })));
		return results;
	}

	/**
	 * atAllTargets 的发送序列:每个目标先「即发」一条独立 @全体(**不 await**,
	 * best-effort),紧接着 await 卡片正文。@全体 的结果异步记入推送历史。
	 *
	 * 为什么不 await @全体:无管理权限的群发 @全体 会被 onebot/协议端拒绝并触发
	 * adapter 的 retryTimes×retryIntervalMs 重试,顺序 await 会让卡片正文等满整个
	 * 重试周期才发出,并连带阻塞 sendBatch 之后的后续订阅任务(用户报告的
	 * 「@全体先出、图片隔很久才出、推送历史标失败」)。fire-and-forget 后 @全体
	 * 第一时间发出、失败也只异步落历史,卡片正文与后续任务都不再被它拖住。
	 *
	 * 顺序保证:@全体 的 `sendToTarget` 在卡片之前**同步发起**(其内部 `sink.send`
	 * 先于卡片被调用),故接收端仍是 @ 提醒在前、卡片在后。
	 */
	private async sendAtAllThenCard(
		atAllTargets: string[],
		payloads: NotificationPayload[],
		ctx: { uid: string; feature: FeatureKey },
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const myGen = this.generation;
		const atAllPayload = makeAtAllPayload();
		const results: DeliveryResult[] = [];
		outer: for (const id of atAllTargets) {
			if (this.disposed || this.generation !== myGen) break;
			// @全体 best-effort:同步发起(先于序列首条入 sink),不 await,结果异步落历史。
			void this.sendToTarget(id, atAllPayload, { routing: ctx })
				.then((r) => this.recordSend(id, atAllPayload, r, ctx))
				.catch(() => {});
			for (const payload of payloads) {
				const result = await this.sendToTarget(id, payload, { routing: ctx });
				if (this.disposed || this.generation !== myGen) break outer;
				this.recordSend(id, payload, result, ctx);
				results.push(result);
				// 序列语义:该 target 某条失败即中止其后续条(失败后大概率继续失败,
				// 且乱序补发比缺失更糟);其他 target 不受牵连。
				if (!result.ok) break;
			}
		}
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
		payload: NotificationPayload | NotificationPayload[],
		ctx?: { uid: string; feature: FeatureKey | "private" },
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const payloads = Array.isArray(payload) ? payload : [payload];
		if (payloads.length === 0) return [];
		// ②7:per-batch generation 快照。此前 sendBatch 仅入口判 disposed,逐条
		// 间无 generation 校验 —— stop()→start() 中途切换会让单次广播跨生命周期
		// 拆发。本批属于发起时的那个 generation;lifecycle 翻转即放弃剩余目标,
		// 且最后那条已 in-flight 的结果是生命周期 artifact,不 onSend / 不计入。
		const myGen = this.generation;
		const routing =
			ctx && ctx.feature !== "private" ? { uid: ctx.uid, feature: ctx.feature } : undefined;
		const results: DeliveryResult[] = [];
		outer: for (const id of targetIds) {
			if (this.disposed || this.generation !== myGen) break;
			for (const p of payloads) {
				const result = await this.sendToTarget(id, p, { routing });
				if (this.disposed || this.generation !== myGen) break outer;
				if (ctx) this.recordSend(id, p, result, ctx);
				results.push(result);
				// 序列语义:该 target 某条失败即中止其后续条;其他 target 不受牵连。
				if (!result.ok) break;
			}
		}
		return results;
	}

	/**
	 * 把单条 send 结果交给 `onSend` hook(adapter 据此 append 推送历史)。multiplex
	 * sink 看不到 uid/feature,只能从这一层注入;target 由 sink 反解 id 得到。
	 * onSend 未配置或 id 反解不到 target 时静默跳过。
	 */
	private recordSend(
		id: string,
		payload: NotificationPayload,
		result: DeliveryResult,
		ctx: { uid: string; feature: FeatureKey | "private" },
	): void {
		if (!this.onSend) return;
		const target = this.sink.resolve(id);
		if (!target) return;
		this.onSend({
			uid: ctx.uid,
			feature: ctx.feature,
			target,
			payload,
			result,
			private: false,
		});
	}

	/**
	 * Send a notification to a single target.
	 * Retries with exponential back-off if the sink indicates the target is temporarily unavailable.
	 *
	 * `opts.routing` re-checks (每次重试前,不只入口一次)`targetId` 是否仍在
	 * `store.findByUid(uid).routing[feature]` 里。退避重试窗口最长可达约 190s
	 * (3s→6s→…→96s),这期间用户完全可能编辑订阅、把这个 target 从路由里移除 ——
	 * 若不复检,一次因目标暂时不可达(如 OneBot WS 正在重连)而进入重试的推送,
	 * 会在用户"取消"之后、目标恢复可达时才真正发出,造成"取消了还在推"的错觉
	 * (routing 早已改了,只是这条重试还攥着入口时那份旧 targetId 没放手)。
	 * `sendToMaster` 等非订阅路由的调用不传 `routing`,不受影响。
	 */
	async sendToTarget(
		targetId: string,
		payload: NotificationPayload,
		opts?: { private?: boolean; routing?: { uid: string; feature: FeatureKey } },
	): Promise<DeliveryResult> {
		if (this.disposed) return { ok: false, latencyMs: 0, err: "disposed" };

		const myGen = this.generation;
		let delay = INITIAL_RETRY_DELAY_MS;
		while (!this.disposed && this.generation === myGen) {
			if (opts?.routing && !this.isStillRouted(opts.routing.uid, opts.routing.feature, targetId)) {
				const msg = `target=${targetId} 已从 uid=${opts.routing.uid} feature=${opts.routing.feature} 的路由中移除，放弃重试中的推送`;
				this.logger.info(`[push] ${msg}`);
				return { ok: false, latencyMs: 0, err: msg };
			}
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

	/** `targetId` 当前是否仍在 uid 该 feature 的 routing 里。查不到订阅视为不再路由。 */
	private isStillRouted(uid: string, feature: FeatureKey, targetId: string): boolean {
		const sub = this.store.findByUid(uid);
		return (sub?.routing[feature] ?? []).includes(targetId);
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
			release = this.serviceCtx.setTimeout(wake, ms);
		});
	}
}
