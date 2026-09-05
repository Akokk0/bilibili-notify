import { randomUUID } from "node:crypto";
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

/** 一条消息是推送的本体(卡片 / 分条正文)还是附加项(@全体、图集、词云、总结)。 */
export type PushMessageRole = "main" | "extra";

export interface PushMessage {
	payload: NotificationPayload;
	role: PushMessageRole;
}

export interface PushMessageOutcome extends PushMessage {
	result: DeliveryResult;
}

interface PushSendBase {
	/**
	 * 一次推送的身份。同一次推送可以分好几次广播(下播卡先发,词云 / 总结算好了再发;
	 * 动态主卡之后是图集),调用方传同一个 `pushId`,历史就落在同一行里追加。
	 */
	pushId: string;
	uid: string;
	feature: FeatureKey;
}

/**
 * 一次广播对**每个目标**回调一次(`sendBatch` 收完该目标的整段序列后),带这一段的全部
 * 消息与逐条结果 —— 历史一行 = 一次推送 × 一个目标。@全体 是 fire-and-forget,落地后
 * 以附加项的身份对同一目标再回调一次。
 *
 * 这类推送**没有任何可用目标**(没配,或配的全停用)时以 `target: null` 回调一次,消息
 * 照带、没有结果 —— 宿主据此落「无目标」那一行,面板上才看得见。上游闸(静音 / 特性关 /
 * 免扰 / 无订阅)不回调:那不是「无目标」,是本来就不该推。
 *
 * multiplex sink 拿不到 uid / feature(它只看 PushTarget),所以历史只能从这一层注入。
 */
export type PushSendInfo =
	| (PushSendBase & { target: PushTarget; messages: PushMessageOutcome[] })
	| (PushSendBase & { target: null; messages: PushMessage[] });

/** 一次广播在发送层内部带着走的上下文。 */
export interface SendContext {
	uid: string;
	feature: FeatureKey;
	pushId: string;
	role: PushMessageRole;
}

export interface BroadcastOptions {
	/** 见 {@link PushSendInfo.pushId};不传就现生成一个(只在这一次广播里通用)。 */
	pushId?: string;
	/** 显式 false 抑制 @全体(周期「正在直播」等非开播的 live 推送);不传 = 按 feature 决定。 */
	allowAtAll?: boolean;
	/** 这一段消息是本体还是附加项;缺省本体。@全体 不由它管,恒为附加项。 */
	role?: PushMessageRole;
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
	/** 推送落地的回调,契约见 {@link PushSendInfo}。独立端接到历史仓。 */
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
	 * 向某位 UP 某类推送的全部目标广播。返回每条消息的投递结果(一个目标一段序列;
	 * @全体 是 fire-and-forget,不计入返回值)。
	 *
	 * 闸门按代价排:全局静音 → 无订阅 → 特性总开关 → 免扰时段,任一挡下都静默返回 —— 这些
	 * 不是「无目标」。过了闸再看目标:路由里**启用的**(目标启用、所属适配器启用)才是候选,
	 * 停用的既不发也不进可达性重试;一个候选都没有就是「无目标」,回调 `onSend` 落一行。
	 *
	 * @全体成员 修饰(仅 `feature === "dynamic" | "live"` 且 `opts.allowAtAll !== false` 进入):
	 * - 订阅级默认 `sub.atAllDefaults.X` 决定 inherit-state 的 target 是否 @
	 * - per-target tristate Map `sub.atAll.X[targetId]` 显式覆写:`true` 强 ON、`false` 强 OFF
	 * - Map 里没有该 key → 走默认
	 *
	 * `feature === "live"` 仅作用于开播。但 live adapter 把「开播」和周期「正在直播」
	 * 复推都翻译成 `feature === "live"`(routing/总开关共用 live),仅靠 feature 无法区分。
	 * 调用方据 `LivePushType` 判定:非开播的 live 推送必须传 `opts.allowAtAll = false`
	 * 显式抑制 @全体,否则会每条直播推送都 @全体(修过的 bug)。
	 */
	async broadcastToFeature(
		uid: string,
		feature: FeatureKey,
		payload: NotificationPayload | NotificationPayload[],
		opts?: BroadcastOptions,
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		// 消息版式分条:一次推送可以是多条 payload 的序列。单 payload 归一成单元素序列,
		// 后续路径统一按序列处理。
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

		const ctx: SendContext = {
			uid,
			feature,
			pushId: opts?.pushId ?? randomUUID(),
			role: opts?.role ?? "main",
		};
		// 只有启用的目标才是候选:停用的目标 / 停用的适配器不进重试、不落历史。
		const targetIds = (sub.routing[feature] ?? []).filter((id) => this.sink.isEnabled(id));
		if (targetIds.length === 0) {
			this.logger.debug(`[push] uid=${uid} feature=${feature} 无可用目标`);
			this.onSend?.({
				...ctx,
				target: null,
				messages: payloads.map((p) => ({ payload: p, role: ctx.role })),
			});
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
			return this.sendBatch(targetIds, payloads, ctx);
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
			return this.sendBatch(plainTargets, payloads, ctx);
		}

		// 「@全体单独一条 → 原 payload」两条独立消息:@ 提醒在前、卡片正文在后。
		// 关键区别:@全体 走 best-effort「即发不 await」(见 sendAtAllThenCard)——
		// 无管理权限的群发 @全体 会被协议端拒绝并触发 adapter 重试,旧版顺序 await
		// 它会把卡片正文连同后续订阅任务一起阻塞(@全体先出、图片隔很久才出、历史
		// 标失败)。现在卡片不再被 @全体 的重试拖住,@全体 失败也只异步落历史。
		const results: DeliveryResult[] = [];
		if (plainTargets.length > 0) {
			results.push(...(await this.sendBatch(plainTargets, payloads, ctx)));
		}
		results.push(...(await this.sendAtAllThenCard(atAllTargets, payloads, ctx)));
		return results;
	}

	/**
	 * atAllTargets 的发送序列:每个目标先「即发」一条独立 @全体(**不 await**,
	 * best-effort),紧接着 await 卡片正文。@全体 落地后以附加项身份再回调一次 onSend ——
	 * 排在本体那次回调之后,历史那一行先由本体建起来,小卡上的首条文案不会是「@全体」。
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
		ctx: SendContext,
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const myGen = this.generation;
		const routing = { uid: ctx.uid, feature: ctx.feature };
		const results: DeliveryResult[] = [];
		for (const id of atAllTargets) {
			if (this.disposed || this.generation !== myGen) break;
			// @全体 best-effort:同步发起(先于序列首条入 sink),不 await。
			const atAllPayload = makeAtAllPayload();
			const atAllJob = this.sendToTarget(id, atAllPayload, { routing });
			const outcomes = await this.sendSequence(id, payloads, ctx, myGen);
			if (outcomes === null) break;
			results.push(...outcomes.map((o) => o.result));
			this.emit(ctx, id, outcomes);
			// 本体那次回调已经发出,@全体 的结果再追加 —— 就算它早就落地了也排在后面。
			void atAllJob
				.then((result) => this.emit(ctx, id, [{ payload: atAllPayload, role: "extra", result }]))
				.catch(() => {});
		}
		return results;
	}

	/**
	 * 把同一段消息序列发给一批目标。失败逐目标捕获,不抛。
	 *
	 * 每个目标收完整段序列后回调一次 onSend(见 {@link PushSendInfo});生命周期翻转
	 * (stop→start)时放弃剩余目标,最后那条已 in-flight 的结果是生命周期 artifact,
	 * 不回调、不计入。
	 */
	async sendBatch(
		targetIds: string[],
		payload: NotificationPayload | NotificationPayload[],
		ctx: SendContext,
	): Promise<DeliveryResult[]> {
		if (this.disposed) return [];
		const payloads = Array.isArray(payload) ? payload : [payload];
		if (payloads.length === 0) return [];
		const myGen = this.generation;
		const results: DeliveryResult[] = [];
		for (const id of targetIds) {
			if (this.disposed || this.generation !== myGen) break;
			const outcomes = await this.sendSequence(id, payloads, ctx, myGen);
			if (outcomes === null) break;
			results.push(...outcomes.map((o) => o.result));
			this.emit(ctx, id, outcomes);
		}
		return results;
	}

	/**
	 * 一个目标的一段序列:顺序发,某条失败即中止其后续条(失败后大概率继续失败,且乱序
	 * 补发比缺失更糟);失败那条留在结果里,被中止的不在。返回 null = 生命周期翻转,
	 * 这一段作废。
	 */
	private async sendSequence(
		targetId: string,
		payloads: NotificationPayload[],
		ctx: SendContext,
		myGen: number,
	): Promise<PushMessageOutcome[] | null> {
		const routing = { uid: ctx.uid, feature: ctx.feature };
		const outcomes: PushMessageOutcome[] = [];
		for (const payload of payloads) {
			const result = await this.sendToTarget(targetId, payload, { routing });
			if (this.disposed || this.generation !== myGen) return null;
			outcomes.push({ payload, role: ctx.role, result });
			if (!result.ok) break;
		}
		return outcomes;
	}

	/** 把一个目标这一段的结果交给 onSend。target 由 sink 反解 id 得到,反解不到就静默跳过。 */
	private emit(ctx: SendContext, targetId: string, messages: PushMessageOutcome[]): void {
		if (!this.onSend) return;
		const target = this.sink.resolve(targetId);
		if (!target) return;
		this.onSend({ pushId: ctx.pushId, uid: ctx.uid, feature: ctx.feature, target, messages });
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
