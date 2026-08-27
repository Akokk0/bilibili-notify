import {
	GuardLevel,
	type LiveEvent,
	type LiveUser,
	type UserActionType,
} from "@bilibili-notify/blive";
import type { Disposable } from "@bilibili-notify/internal";
import { DateTime } from "luxon";
import { LivePushType } from "./push-like";
import { GUARD_LEVEL_IMG } from "./room-context";
import { LiveRoomAccessDeniedError, LiveRoomPreflightBlockedError } from "./room-helpers";
import { LIVE_EVENT_COOLDOWN, RoomSessionBase } from "./room-session-base";
import { buildRoomLink } from "./template-renderer";
import { LiveType } from "./types";

/**
 * One {@link RoomSession} per UID/room actively being monitored.
 *
 * Extends {@link RoomSessionBase} (state + lifecycle + transitions) with the
 * single-callback event funnel (`buildEventHandler`) and the per-event handlers
 * (`onLiveStart`, `onIncomeDanmu`, `onIncomeSuperChat`, `onGuardBuy`,
 * `onLiveEnd`, `onError`, `onUserAction`).
 *
 * Each handler reads / mutates the protected state defined on the base.
 * `bootstrap()` (defined on the base) opens the WS connection and arms the
 * periodic timer if the room is already live; subsequent state transitions
 * are driven by the events routed through the funnel.
 */
/** Dashboard 端期望的"实时观看人数"采样间隔。B 站每几秒推一帧 WATCHED_CHANGE,
 * 这里 per-UID 门控成 2s 最多一次,够人眼感知,WS 不会刷屏。 */
const VIEWERS_EMIT_THROTTLE_MS = 2000;

/**
 * onError 触发后的退避重连节奏(单位 ms)。失败时按下标顺序消耗,直到耗尽 → 真正放弃。
 * 重连成功后 `reconnectAttempts` 复位到 0,后续新一轮 onError 重新从 1s 开始。
 */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;

/**
 * 预检被 -352 风控拦截时的**长尾**退避(单位 ms),末项封顶循环、永不放弃。
 * 与上面那条秒级梯子分开:WS 是直播状态唯一信号源(没有 HTTP 轮询兜底),
 * 风控一持续就是几十分钟,拿 31 秒的梯子去顶会把好房间全停光;而无 token
 * 直连的旧回退(blive 库时代)只能收匿名残缺数据,已随自实现一并退役。
 */
const PREFLIGHT_BLOCKED_BACKOFF_MS = [60_000, 300_000, 900_000, 1_800_000] as const;

/** B 站 live WS 静默自愈:每分钟检查一次,3 分钟无 heartbeat/消息即主动重连。 */
const LIVE_WS_WATCHDOG_INTERVAL_MS = 60_000;
export const LIVE_WS_STALE_MS = 180_000;

type ReconnectReason = "error" | "close" | "watchdog" | "preflight";
type LiveWsActivityReason =
	| "connected"
	| "open"
	| "auth-ok"
	| "heartbeat"
	| "danmu"
	| "superchat"
	| "watched"
	| "liked"
	| "guard"
	| "live-start"
	| "live-end"
	| "interact"
	| "raw"
	| "other"
	| "close";

export class RoomSession extends RoomSessionBase {
	private lastViewersEmitMs = 0;
	// cancelled 提升到 RoomSessionBase(protected)—— armPeriodicTimer 的 teardown 守卫
	// 需要在基类可见。语义不变:stopForUid / disposeAll / liveEnd 主动关闭时经 cancel() 置位,
	// onError 据此跳过重连。
	private reconnectAttempts = 0;
	/**
	 * L1 单飞守卫:并发 onError(WS 错误常突发多帧)若都进入重连路径,会各自
	 * closeListener + 退避 + startLiveRoomListener,装回多个 listener。一旦一个
	 * onError 拿到重连权,其余直接返回。
	 */
	private reconnecting = false;
	/** L3:退避 sleep 的 Disposable + 唤醒句柄,cancel/teardown 时清掉,不留回调到 expiry。 */
	private reconnectTimer?: Disposable;
	private reconnectWake?: () => void;
	private lastLiveWsActivityAt = 0;
	private lastLiveWsActivityReason: LiveWsActivityReason = "connected";
	private watchdogTimer?: Disposable;
	private watchdogReconnectCount = 0;
	/** 漂移观测:degraded raw 的 per-cmd 累计,只增不清(见 noteDegradedRaw)。 */
	private readonly degradedRawCounts = new Map<string, number>();

	/** 外层主动停止 listener 时调用,阻止 onError/onClose/watchdog 触发重连。 */
	cancel(): void {
		this.cancelled = true;
		// P2:即时复位,不再单靠 reconnectLoop 的 finally 时序。onError 顶部
		// cancelled 守卫已足以挡新重连,这里只是让 reconnecting 状态立即自洽。
		this.reconnecting = false;
		this.stopLiveWsWatchdog();
		this.clearReconnectSleep();
		// 挂起中的断流接续等待随 teardown 一并取消,绝不在房间已停后还触发一次下播。
		this.cancelPendingEnd();
		// 周期复推定时器同理。外部 teardown(stopForUid / disposeAll / startAll)本就会
		// 经 livePushTimerManager 统一清,但**自发**放弃监听那条路径只调 cancel(),留下的
		// timer 会一直 tick:每次 tick 看到已下播就发一条私聊,再调 triggerLiveEnd,而
		// handleLiveEnd 在 `!liveStatus` 守卫处就返回、走不到解除定时器那行 —— 同一条
		// 私聊每小时重复一次,直到进程重启。cancel() 语义是「这个 session 到此为止」,
		// 留任何定时器都不对。
		this.cancelPeriodicTimer();
	}

	/** L3:dispose 退避定时器并唤醒重连循环,使其立刻重校 cancelled/disposed 后退出。 */
	private clearReconnectSleep(): void {
		this.reconnectTimer?.dispose();
		this.reconnectTimer = undefined;
		this.reconnectWake?.();
		this.reconnectWake = undefined;
	}

	protected override onListenerStarted(): void {
		this.markLiveWsActivity("connected");
		this.startLiveWsWatchdog();
	}

	protected override onMonitoringStopped(): void {
		this.cancel();
	}

	getWsHealthSnapshot(): {
		lastActivityAt: number;
		lastActivityReason: LiveWsActivityReason;
		watchdogReconnectCount: number;
	} {
		return {
			lastActivityAt: this.lastLiveWsActivityAt,
			lastActivityReason: this.lastLiveWsActivityReason,
			watchdogReconnectCount: this.watchdogReconnectCount,
		};
	}

	private markLiveWsActivity(reason: LiveWsActivityReason): void {
		this.lastLiveWsActivityAt = Date.now();
		this.lastLiveWsActivityReason = reason;
	}

	private startLiveWsWatchdog(): void {
		if (this.watchdogTimer || this.cancelled || this.ctx.isDisposed()) return;
		this.watchdogTimer = this.ctx.serviceCtx.setInterval(
			() => this.checkLiveWsWatchdog(),
			LIVE_WS_WATCHDOG_INTERVAL_MS,
		);
	}

	private stopLiveWsWatchdog(): void {
		this.watchdogTimer?.dispose();
		this.watchdogTimer = undefined;
	}

	private checkLiveWsWatchdog(): void {
		if (this.cancelled || this.ctx.isDisposed() || this.reconnecting) return;
		if (this.lastLiveWsActivityAt <= 0) return;
		const staleMs = Date.now() - this.lastLiveWsActivityAt;
		if (staleMs < LIVE_WS_STALE_MS) return;
		this.watchdogReconnectCount++;
		void this.reconnect(
			"watchdog",
			`${Math.floor(staleMs / 1000)}s 无 heartbeat/消息(last=${this.lastLiveWsActivityReason},watchdog=${this.watchdogReconnectCount})`,
		);
	}

	// ── Event funnel ──────────────────────────────────────────────────────────

	/**
	 * 单回调漏斗:连接生命周期与业务消息都从这一个口进来,switch 一次接完。
	 * 活跃度标记因此天然只有这一处(旧 handler 对象时代要在 13 个槽位里各撒一次)。
	 *
	 * 主动关闭的 close 回声不会出现在这里 —— 客户端 close() 之后保证静默,
	 * 旧的 consumeIntentionalClose 对暗号已随之退役。
	 */
	protected buildEventHandler(): (ev: LiveEvent) => void | Promise<void> {
		// 返回值透传底下 handler 的 Promise:客户端不消费它,但测试靠 await 它
		// 才能等事件真正跑完再断言(与旧 MsgHandler 的返回语义一致)。
		return (ev) => {
			switch (ev.kind) {
				case "open":
					this.markLiveWsActivity("open");
					return;
				case "auth-ok":
					this.markLiveWsActivity("auth-ok");
					return;
				case "auth-failed":
					// token 可能过期/失配。走重连梯子:每轮都重新预检拿新 token。
					this.ctx.logger.warn(`[conn] 直播间 [${this.sub.roomId}] 弹幕认证失败 code=${ev.code}`);
					void this.reconnect("error", `认证失败 code=${ev.code}`);
					return;
				case "heartbeat":
					this.markLiveWsActivity("heartbeat");
					return;
				case "closed":
					if (this.cancelled || this.ctx.isDisposed()) return;
					this.markLiveWsActivity("close");
					void this.reconnect("close");
					return;
				case "error":
					return this.onError();
				case "danmu":
					this.markLiveWsActivity("danmu");
					this.onIncomeDanmu(ev);
					return;
				case "superchat":
					this.markLiveWsActivity("superchat");
					return this.onIncomeSuperChat(ev);
				case "watched": {
					this.markLiveWsActivity("watched");
					this.liveData.watchedNum = ev.textSmall;
					const now = Date.now();
					if (now - this.lastViewersEmitMs >= VIEWERS_EMIT_THROTTLE_MS) {
						this.lastViewersEmitMs = now;
						this.ctx.emitViewers(this.sub.uid, ev.textSmall);
					}
					return;
				}
				case "liked":
					this.markLiveWsActivity("liked");
					this.liveData.likedNum = ev.count;
					return;
				case "guard-buy":
					this.markLiveWsActivity("guard");
					return this.onGuardBuy({
						guard_level: ev.guardLevel,
						gift_name: ev.giftName,
						user: ev.user,
					});
				case "live-start":
					this.markLiveWsActivity("live-start");
					return this.onLiveStart();
				case "live-end":
					this.markLiveWsActivity("live-end");
					return this.onLiveEnd();
				case "user-action":
					if (!this.sub.customSpecialUsersEnterTheRoom.enable) return;
					this.markLiveWsActivity("interact");
					return this.onUserAction(ev);
				case "raw":
					// 未解析命令也是活的流量 —— watchdog 只关心连接死没死
					this.markLiveWsActivity("raw");
					// degraded = 已知命令解析失败(B 站可能改了字段形状),是协议
					// 漂移信号,要报出来;plain raw 是刻意不解析的命令,属正常流量
					if (ev.degraded) this.noteDegradedRaw(ev.cmd);
					return;
				default:
					// 已解析但业务不消费的 kind(gift / room-change / 抽奖组等,
					// 2026-08 定案「只打协议层地基」)—— 与 raw 同理,只标活跃度
					this.markLiveWsActivity("other");
					return;
			}
		};
	}

	/**
	 * 漂移报警限流:同 cmd 首条立即 warn,之后每满 100 条再报一次累计 ——
	 * 漂移一旦发生是每帧都漂,逐帧 warn 会刷爆日志。计数随 session 生命周期,
	 * 不随重连清零(漂移不会因为重连而消失)。
	 */
	private noteDegradedRaw(cmd: string): void {
		const count = (this.degradedRawCounts.get(cmd) ?? 0) + 1;
		this.degradedRawCounts.set(cmd, count);
		if (count === 1 || count % 100 === 0) {
			this.ctx.logger.warn(
				`[proto] 直播间 [${this.sub.roomId}] 已知命令 ${cmd} 解析降级(累计 ${count} 次)—— B 站可能调整了字段形状,请检查更新`,
			);
		}
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private onError(): Promise<void> {
		return this.reconnect("error");
	}

	private async reconnect(reason: ReconnectReason, detail?: string): Promise<void> {
		if (this.cancelled || this.ctx.isDisposed()) return;
		if (this.reconnecting) return; // L1:并发 error/close/watchdog,已有重连在跑,丢弃
		this.reconnecting = true;
		try {
			await this.reconnectLoop(reason, detail);
		} catch (e) {
			// 总兜底:reconnect 的 promise 被 watchdog / auth-failed / closed /
			// preflight 四个入口以 void 丢弃 —— 这里再抛就是 unhandledRejection
			// (Node 默认崩进程)。已知失败模式都在 loop 内消化,这层只接漏网的
			// (如补跑推卡时渲染/推送 reject)。
			const msg = `直播间 [${this.sub.roomId}] 重连流程内部异常:${(e as Error).message}`;
			this.ctx.logger.error(`[conn] ${msg}`);
			this.ctx.emitEngineError(msg);
		} finally {
			this.reconnecting = false;
		}
	}

	/**
	 * 退避重连循环(单飞,由 reconnect 持有)。`while` 取代旧的 `setTimeout(0)`
	 * 递归续链 —— 杜绝深栈递归 + 每步都丢弃的定时器 Disposable;每次 sleep 后
	 * 重校 cancelled/disposed,sleep 自身可被 cancel/teardown dispose。
	 */
	private async reconnectLoop(reason: ReconnectReason, detail?: string): Promise<void> {
		// 「是**我们**把在播状态翻下去的」—— 只有这种情况才需要在重连成功后核对回来。
		// 判「当前不在播」是不够的:本来就没在播的房间会被拖去做一次没意义的网络核对。
		let weTurnedLiveOff = false;
		// 上一次尝试是否被预检 -352 拦下。真 → 下一次 sleep 走长尾梯子且不消耗
		// 秒级梯子的次数(不放弃);假 → 一切同旧。bootstrap 期被拦(reason=preflight)
		// 从第一轮就按长尾等。
		let preflightBlocked = reason === "preflight";
		let preflightBlockedAttempts = 0;
		while (true) {
			if (this.cancelled || this.ctx.isDisposed()) return;
			if (reason === "error") {
				if (this.liveStatus) weTurnedLiveOff = true;
				this.setLiveStatus(false);
				this.cancelPeriodicTimer();
			}
			this.ctx.closeListener(this.sub.roomId);

			let delay: number;
			const reasonText = this.describeReconnectReason(reason, detail);
			if (preflightBlocked) {
				const idx = Math.min(preflightBlockedAttempts, PREFLIGHT_BLOCKED_BACKOFF_MS.length - 1);
				delay = PREFLIGHT_BLOCKED_BACKOFF_MS[idx] as number;
				preflightBlockedAttempts++;
				// 预检被拦说明服务在响应(是风控不是连接故障)—— 复位秒级计数,
				// 否则风控波中拦截与普通失败交替时,5 个普通轮凑齐就 break 放弃。
				this.reconnectAttempts = 0;
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.sub.roomId}] ${reasonText},${Math.round(delay / 1000)}s 后重试预检(长尾第 ${preflightBlockedAttempts} 次,不放弃)`,
				);
			} else {
				if (this.reconnectAttempts >= RECONNECT_BACKOFF_MS.length) break;
				delay = RECONNECT_BACKOFF_MS[this.reconnectAttempts] as number;
				this.reconnectAttempts++;
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.sub.roomId}] ${reasonText},${delay / 1000}s 后重连(第 ${this.reconnectAttempts}/${RECONNECT_BACKOFF_MS.length} 次)`,
				);
			}
			await this.sleepReconnect(delay);
			if (this.cancelled || this.ctx.isDisposed()) return;

			// L4:startLiveRoomListener 现返回是否真有 listener(新建,或退避窗口
			// 内已被别处恢复)。throw 与 false 一并视为本轮失败,继续退避(while
			// 续链,无递归、无丢弃定时器)。只有真成功才复位 backoff。
			let ok = false;
			preflightBlocked = false;
			try {
				ok = await this.ctx.startLiveRoomListener(
					this.sub.roomId,
					this.buildEventHandler(),
					() => this.cancelled,
				);
			} catch (e) {
				if (e instanceof LiveRoomAccessDeniedError) {
					this.reconnectAttempts = 0;
					this.setLiveStatus(false);
					this.cancelPeriodicTimer();
					this.cancel();
					this.ctx.stopMonitoring(e.message, this.sub.roomId);
					return;
				}
				if (e instanceof LiveRoomPreflightBlockedError) {
					// 风控还没散,回长尾继续等;计数不清零,间隔继续爬到封顶。
					preflightBlocked = true;
					continue;
				}
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.sub.roomId}] 重连发起异常:${(e as Error).message}`,
				);
			}
			// ②6:post-await 重校。startLiveRoomListener 期间若与 stopForUid /
			// teardown 交错(cancelled / disposed 翻转),刚建的 listener 是孤儿 ——
			// 主动关掉再退出,绝不留永不关闭的连接(此前只判 ok 漏了这条)。
			if (this.cancelled || this.ctx.isDisposed()) {
				if (ok) this.ctx.closeListener(this.sub.roomId);
				return;
			}
			if (ok) {
				this.onListenerStarted();
				this.ctx.logger.info(`[conn] 直播间 [${this.sub.roomId}] 重连成功`);
				this.reconnectAttempts = 0;
				// 预检被风控挡在 bootstrap 门外的房间,从没跑过 bootstrapRoomState ——
				// 房间信息 / 已在播检测 / restartPush 都还欠着,这里补跑(同款
				// 「翻成在播」窗口包裹)。与 weTurnedLiveOff 天然互斥:没 bootstrap
				// 过的房间 liveStatus 恒为 false,不可能是我们翻下去的。
				if (!this.bootstrapped) {
					if (this.bootstrapInFlight) {
						// bootstrap 窗口内断线:首跑还在途,新 listener 已就位,房态
						// 由首跑收尾 —— 不并发第二份(双开会重复推「正在直播」卡、
						// 交错 transition 窗口)。
						return;
					}
					this.beginLiveTransition();
					let stateReady = false;
					try {
						stateReady = await this.bootstrapRoomState();
					} finally {
						this.finishLiveTransition();
					}
					if (stateReady) return;
					// 熬过风控刚连上,初始信息拉取又失败 —— 多半泡在同一场风控余波里。
					// 回长尾继续等,不 cancel:一次瞬时 HTTP 失败不该毙掉「永不放弃」的房间。
					this.ctx.logger.warn(
						`[conn] 直播间 [${this.sub.roomId}] 重连后初始房态拉取失败,回长尾退避重试`,
					);
					preflightBlocked = true;
					continue;
				}
				// 上面 `reason === "error"` 的分支把状态翻成了下播并停了周期复推。
				// 那是保守处置(连接断了,我们确实不知道房间还在不在播),但**必须
				// 在重连成功后核对回来** —— 否则几小时后真正的下播事件会撞上
				// `handleLiveEnd` 的 `!this.liveStatus` 守卫被丢弃,这一场永远等不到
				// end:面板停在断连那一刻,统计侧的时长也在那里截断。
				//
				// 核对走 `isLiveAgain()`(重拉房间信息看 `live_status`),它经由
				// `useLiveRoomInfo` 的非 Start 分支保留 `live_time` —— 与开播时带出去的
				// 是同一个字符串,统计侧据此认出这是同一场,把先前那帧 end 覆盖掉,
				// 时长自动补回完整值。
				//
				// 这段 await 是个真实的抢占窗口:上面 `onListenerStarted()` 已经跑过,
				// 新 WS 正在派发事件,而 `liveStatus` 此刻是 false。期间若真下播,那条 END
				// 会被 `handleLiveEnd` 的守卫丢弃 —— 再无条件翻回在播就永远卡住了,
				// 所以翻之前必须查 `endArrivedWhileTransitioning`。
				if (weTurnedLiveOff) {
					// 这条路径正在替这个房间裁决在播状态,并发的 LIVE 帧交给 isLiveAgain()
					// 的结果统一收口即可,不必再走一遍开播流水线多推一张开播卡。
					this.beginLiveTransition(true);
					const stillLive = await this.isLiveAgain();
					const endedMeanwhile = this.finishLiveTransition();
					// post-await 重校:核对期间可能已被 stopForUid / teardown 掐掉。
					if (this.cancelled || this.ctx.isDisposed()) return;
					if (stillLive && !endedMeanwhile) {
						this.setLiveStatus(true);
						this.armPeriodicTimer();
					} else if (endedMeanwhile) {
						this.ctx.logger.info(
							`[conn] 直播间 [${this.sub.roomId}] 重连核对期间已收到下播事件，保持下播状态`,
						);
					}
				}
				return;
			}
			this.ctx.logger.warn(`[conn] 直播间 [${this.sub.roomId}] 重连未成功,继续退避`);
		}
		// 退避耗尽 → 真正放弃 + 走 engine-error(adapter 转 master DM / log channel)。
		this.reconnectAttempts = 0;
		const msg = `直播间 [${this.sub.roomId}] ${this.describeReconnectReason(reason, detail)}后连接持续失败,重试 ${RECONNECT_BACKOFF_MS.length} 次后放弃监听`;
		this.ctx.logger.error(`[conn] ${msg}`);
		this.ctx.emitEngineError(msg);
		// 收口在播状态。上面翻 idle 只发生在 reason === "error" 那条路径上,watchdog /
		// close 全程没碰过它;而 `cancel()` 只管取消,不翻状态。走到这里 WS 已彻底关闭、
		// 再不会有任何事件,留着 true 就是个永远「在播」的僵尸:listLiveRooms 一直把它
		// 报成在播,统计侧按 now−startedAt 让时长无界增长。
		if (this.liveStatus) {
			// 但**不能只是**把状态翻下去:那样这一场对用户就是凭空消失 —— 没有下播卡、
			// 没有词云 / 直播总结,弹幕缓冲还留着漏进下一场。死掉的只是 WS,HTTP 照样通,
			// 整条下播流水线都跑得起来,所以正经走完它。
			//
			// 但这里是「一切都已经失败」的收尾路径,它自己绝不能再炸:reconnect 多由
			// `void this.reconnect(...)`(watchdog)发起,抛出去就是个没人接的 rejection,
			// 而且状态就停在 true —— 恰好回到我们要消灭的那个僵尸。兜住,至少把状态收口。
			try {
				await this.handleLiveEnd("giveup");
			} catch (e) {
				this.ctx.logger.warn(
					`[conn] 直播间 [${this.sub.roomId}] 放弃监听时的下播处理失败:${(e as Error).message}`,
				);
				this.setLiveStatus(false);
			}
		} else {
			this.setLiveStatus(false);
		}
		this.cancel();
	}

	private describeReconnectReason(reason: ReconnectReason, detail?: string): string {
		if (reason === "error") return detail ? `连接错误(${detail})` : "连接错误";
		if (reason === "close") return "连接关闭";
		if (reason === "preflight") return "弹幕预检被风控拦截";
		return detail ? `连接静默(${detail})` : "连接静默";
	}

	/** bootstrap 期预检被 -352 拦截 → 直接进长尾重试(不占用秒级梯子、不放弃房间)。 */
	protected override onPreflightBlocked(): void {
		void this.reconnect("preflight");
	}

	/**
	 * L3:可被 {@link clearReconnectSleep} 取消的退避 sleep。dispose 时立即
	 * resolve,让 reconnectLoop 醒来重校 cancelled/disposed 后退出 —— 不再留
	 * 一个无法清除的延迟回调到 expiry。
	 */
	private sleepReconnect(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			this.reconnectWake = resolve;
			this.reconnectTimer = this.ctx.serviceCtx.setTimeout(() => {
				this.reconnectTimer = undefined;
				this.reconnectWake = undefined;
				resolve();
			}, ms);
		});
	}

	private onIncomeDanmu(body: { content: string; user: { uname: string; uid: number } }): void {
		if (
			this.ctx.isSubscribed(this.sub, "wordcloud") ||
			this.ctx.isSubscribed(this.sub, "liveSummary")
		) {
			this.ctx.danmakuCollector.recordDanmaku(this.sub.roomId, body.content, body.user.uname);
		}
		if (
			this.sub.customSpecialDanmakuUsers.enable &&
			this.ctx.hasTargets(this.sub, "specialDanmaku") &&
			this.sub.customSpecialDanmakuUsers.specialDanmakuUsers?.includes(body.user.uid.toString())
		) {
			const text = this.ctx.templateRenderer.renderSpecialDanmaku({
				template: this.sub.customSpecialDanmakuUsers.msgTemplate,
				uname: body.user.uname,
				master: this.masterInfo,
				content: body.content,
			});
			if (this.ctx.isDisposed()) return;
			this.ctx.safeBroadcast(
				this.sub.uid,
				this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(text)]),
				LivePushType.UserDanmakuMsg,
			);
		}
	}

	private async onIncomeSuperChat(body: {
		content: string;
		user: { uname: string; uid: number };
		price: number;
	}): Promise<void> {
		const collectsDanmaku =
			this.ctx.isSubscribed(this.sub, "wordcloud") ||
			this.ctx.isSubscribed(this.sub, "liveSummary");
		const pushesSC = this.ctx.isSubscribed(this.sub, "superchat");
		if (!collectsDanmaku && !pushesSC) return;
		if (collectsDanmaku) {
			this.ctx.danmakuCollector.recordDanmaku(this.sub.roomId, body.content, body.user.uname);
		}
		if (!pushesSC) return;
		// minScPrice 已由 adapter 折算好(per-UP ?? 全局)。
		if (body.price < this.sub.minScPrice) return;

		const data = await this.ctx.api.getUserInfoInLive(body.user.uid.toString(), this.sub.uid);
		if (data.code !== 0) {
			const text = `【${this.masterInfo?.username ?? ""}的直播间】${body.user.uname}的SC:${body.content}（${body.price}元）`;
			if (this.ctx.isDisposed()) return;
			await this.enqueuePush(() =>
				this.ctx.push.broadcastToTargets(
					this.sub.uid,
					this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(text)]),
					LivePushType.Superchat,
				),
			);
			return;
		}
		if (this.ctx.imageRenderer?.generateSCCard) {
			try {
				const userInfo = data.data;
				const scStyle = this.resolvedCardStyle("sc");
				const buf = await this.ctx.imageRenderer.generateSCCard(
					{
						senderFace: userInfo.face,
						senderName: userInfo.uname,
						masterName: this.masterInfo?.username ?? "",
						masterAvatarUrl: this.masterInfo?.userface ?? "",
						text: body.content,
						price: body.price,
					},
					scStyle.enable ? scStyle : undefined,
					this.sub.cardLayout?.sc,
				);
				if (this.ctx.isDisposed()) return;
				await this.enqueuePush(() =>
					this.ctx.push.broadcastToTargets(
						this.sub.uid,
						this.ctx.contentBuilder.image(buf, "image/jpeg"),
						LivePushType.Superchat,
					),
				);
				return;
			} catch (e) {
				this.ctx.logger.error(`[sc] 生成SC图片失败：${(e as Error).message}`);
			}
		}
		const fallback = `【${this.masterInfo?.username ?? ""}的直播间】${data.data.uname}的SC:${body.content}（${body.price}元）`;
		if (this.ctx.isDisposed()) return;
		await this.enqueuePush(() =>
			this.ctx.push.broadcastToTargets(
				this.sub.uid,
				this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(fallback)]),
				LivePushType.Superchat,
			),
		);
	}

	private async onGuardBuy(body: {
		guard_level: GuardLevel;
		gift_name: string;
		user: { uname: string; uid: number };
	}): Promise<void> {
		if (!this.ctx.isSubscribed(this.sub, "liveGuardBuy")) return;
		// minGuardLevel 已由 adapter 折算好(per-UP ?? 全局,同 SC 阈值语义)。
		if (body.guard_level > this.sub.minGuardLevel) return;
		const guardImg = GUARD_LEVEL_IMG[body.guard_level];
		const effectiveGuardBuy = this.sub.customGuardBuy.enable
			? this.sub.customGuardBuy
			: this.ctx.config.customGuardBuy;
		if (effectiveGuardBuy.enable) {
			const customGuardImg: Record<GuardLevel, string | undefined> = {
				[GuardLevel.None]: undefined,
				[GuardLevel.Captain]: effectiveGuardBuy.captainImgUrl,
				[GuardLevel.Admiral]: effectiveGuardBuy.supervisorImgUrl,
				[GuardLevel.Governor]: effectiveGuardBuy.governorImgUrl,
			};
			const text = this.ctx.templateRenderer.renderGuardBuy({
				guardBuyConfig: effectiveGuardBuy,
				uname: body.user.uname,
				master: this.masterInfo,
				giftName: body.gift_name,
			});
			if (this.ctx.isDisposed()) return;
			await this.ctx.push.broadcastToTargets(
				this.sub.uid,
				this.ctx.contentBuilder.message([
					this.ctx.contentBuilder.image(customGuardImg[body.guard_level] ?? guardImg),
					this.ctx.contentBuilder.text(text),
				]),
				LivePushType.LiveGuardBuy,
			);
			return;
		}
		if (this.ctx.imageRenderer?.generateGuardCard) {
			const data = await this.ctx.api.getUserInfoInLive(body.user.uid.toString(), this.sub.uid);
			if (data.code === 0) {
				try {
					const guardStyle = this.resolvedCardStyle("guard");
					const buf = await this.ctx.imageRenderer.generateGuardCard(
						{
							guardLevel: body.guard_level,
							uname: data.data.uname,
							face: data.data.face,
							isAdmin: data.data.is_admin,
						},
						{
							masterName: this.masterInfo?.username ?? "",
							masterAvatarUrl: this.masterInfo?.userface ?? "",
						},
						guardStyle.enable ? guardStyle : undefined,
						this.sub.cardLayout?.guard,
					);
					if (this.ctx.isDisposed()) return;
					await this.ctx.push.broadcastToTargets(
						this.sub.uid,
						this.ctx.contentBuilder.image(buf, "image/jpeg"),
						LivePushType.LiveGuardBuy,
					);
					return;
				} catch (e) {
					this.ctx.logger.error(`[guard] 生成上舰图片失败：${(e as Error).message}`);
				}
			}
		}
		if (this.ctx.isDisposed()) return;
		await this.ctx.push.broadcastToTargets(
			this.sub.uid,
			this.ctx.contentBuilder.message([
				this.ctx.contentBuilder.image(guardImg),
				this.ctx.contentBuilder.text(
					`【${this.masterInfo?.username ?? ""}的直播间】${body.user.uname}加入了大航海（${body.gift_name}）`,
				),
			]),
			LivePushType.LiveGuardBuy,
		);
	}

	private async onLiveStart(): Promise<void> {
		const now = Date.now();
		// 断流接续:挂起等待期内的重新开播 = 同一场直播。取消等待、恢复复推,**不**发开播卡、
		// **不**清弹幕缓冲、**不**动 liveTime/粉丝基线(全沿用第一次开播)。先于冷却 / liveStatus
		// 去重判断,因为挂起期 liveStatus 仍为 true,否则会被既有「已开播,忽略」分支吞掉。
		if (this.pendingEndTimer) {
			const gapSec = Math.round((now - this.lastLiveEnd) / 1000);
			this.cancelPendingEnd();
			this.armPeriodicTimer();
			this.ctx.logger.info(
				`[grace] 直播间 [${this.sub.roomId}] 断流 ${gapSec}s 后重新开播,接续为同一场直播`,
			);
			return;
		}
		if (now - this.lastLiveStart < LIVE_EVENT_COOLDOWN) {
			this.ctx.logger.debug(`[live] 直播间 [${this.sub.roomId}] 的开播事件在冷却期内，忽略`);
			return;
		}
		// `startingUp` 一并挡在这里:翻状态挪到刷新之后以后,`liveStatus` 在整段准备期
		// 都还是 false,不能再独自兼任同步去重闸门。冷却窗口(10s)通常也够,但网络慢到
		// await 超过冷却时就漏了,这道闸门与它是叠加关系。
		//
		// 注意用的是 `startingUp` 而不是 `transitioningToLive` —— 后者 bootstrap 也会开,
		// 拿它去重会把 bootstrap 期间的真开播事件一并吞掉(见 startingUp 的说明)。
		if (this.liveStatus || this.startingUp) {
			this.ctx.logger.debug(
				`[live] 直播间 [${this.sub.roomId}] 已经是开播状态或正在开播准备中，忽略重复的开播事件`,
			);
			return;
		}
		// L2:仅在真正“接受”一次开播(过冷却 + 过 liveStatus 去重)时才打冷却
		// 戳。此前在去重前就 lastLiveStart=now,一条 >10s 的重复 START 也会刷新
		// 窗口,导致紧随其后 10s 内的“真重启”被冷却静默吞掉。
		this.lastLiveStart = now;
		// 先把房间信息刷成**本场**的,再翻状态 —— 这个顺序不能反。
		//
		// `setLiveStatus(true)` 会把 `liveRoomInfo.live_time` 换算成 `startedAt` 带出去,
		// 而那个字符串**就是这一场的身份**:统计侧按它认场次(精确相等匹配),同一场还会
		// 被断线重连后的核对、重启后的 bootstrap 再观测到,那两条路径读的都是 B 站的
		// `live_time`。所以这里必须用同一把尺子。
		//
		// 抢在刷新之前翻状态会读到上一场的陈旧值(非 Start 分支刻意冻结 `live_time`,
		// 好让下播卡算已播时长),带出去就是隔天的时刻。曾经为此改成「先清空再翻」,
		// 结果 `startedAt` 变成 undefined、消费方回退到「我们发现的时刻」,与另两条
		// 路径差着几秒 —— 同一场被记成两条区间重叠的记录,场次数与总时长直接膨胀,
		// 而且错误写进 append-only 文件后事后无法修。两害相权,统一用 B 站的尺子。
		//
		// 代价是整段 await 期间 `liveStatus` 仍是 false,不能再兼任同步去重闸门:
		// 重复 START 由上面的 `startingUp` 挡,期间到达的 END 由它记账、下面收口。
		this.beginLiveTransition(true);
		const refreshed =
			(await this.useLiveRoomInfo(LiveType.StartBroadcasting)) &&
			(await this.useMasterInfo(LiveType.StartBroadcasting));
		// 先关窗口再判失败:否则刷新失败那条路径会把标志漏给下一次事件。
		const endedMeanwhile = this.finishLiveTransition();
		// 这三个条件分开写而不是并进一个布尔量:TS 的控制流收窄认字段判空,
		// 收进变量后下面 `this.liveRoomInfo!` 就到处都要非空断言了。
		if (!refreshed || !this.liveRoomInfo || !this.masterInfo) {
			if (this.ctx.isDisposed()) return;
			this.onMonitoringStopped();
			this.ctx.stopMonitoring("获取直播间信息失败，推送直播开播卡片失败", this.sub.roomId);
			return;
		}
		if (endedMeanwhile) {
			// 准备期间这一场就结束了。翻成在播的话,那条已被守卫丢弃的 END 不会再来
			// 第二次,房间从此永远卡在「直播中」。开播卡也不推 —— 人都已经下播了。
			// 弹幕缓冲已由 finishLiveTransition 排空。
			this.ctx.logger.info(
				`[live] 直播间 [${this.sub.roomId}] 开播准备期间已收到下播事件，放弃本次开播推送`,
			);
			return;
		}
		this.setLiveStatus(true);
		this.ctx.logger.info(
			`[stat] 房间号：${this.masterInfo.roomId}，开播时的粉丝数：${this.masterInfo.liveOpenFollowerNum}`,
		);
		this.liveTime = this.liveRoomInfo.live_time || DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
		const diffTime = await this.ctx.getTimeDifference(this.liveTime);
		const followerNum =
			this.masterInfo.liveOpenFollowerNum >= 10_000
				? `${(this.masterInfo.liveOpenFollowerNum / 10000).toFixed(1)}万`
				: this.masterInfo.liveOpenFollowerNum.toString();
		this.liveData.fansNum = this.masterInfo.liveOpenFollowerNum;
		const roomLink = buildRoomLink(this.liveRoomInfo);
		// 消息版式:per-UP 折叠值优先,缺失时兜底引擎 config 级(koishi 的默认版式 +
		// 链接开关);两级都缺 = 旧路径。版式路径下链接独立成部件,开播模板按 omitLink
		// 剥掉 {link},由 sendLiveNotifyCard 按块序装配。
		const messageLayout = this.sub.messageLayout ?? this.ctx.config.messageLayout;
		const liveStartMsg = this.ctx.templateRenderer.renderLiveStart({
			sub: this.sub,
			globalCustom: this.ctx.config.customLiveMsg,
			master: this.masterInfo,
			diffTime,
			followerNum,
			roomLink,
			omitLink: messageLayout !== undefined,
		});

		// 串行闸(enqueuePush):秒级断流重开时,这张开播卡会与上一场还在途的下播卡
		// 并发 —— 不排队的话谁快谁先送达,用户看到「先开播后下播」的倒序。
		// 抓成局部变量再入闸:非空收窄进不了闭包,卡片也本就该反映发起时刻的状态。
		const liveRoomInfo = this.liveRoomInfo;
		const master = this.masterInfo;
		await this.enqueuePush(() =>
			this.ctx.sendLiveNotifyCard({
				liveType: LiveType.StartBroadcasting,
				liveData: this.liveData,
				liveRoomInfo,
				master,
				cardStyle: this.resolvedCardStyle("live"),
				cardLayout: this.sub.cardLayout,
				uid: this.sub.uid,
				notifyMsg: liveStartMsg,
				messageLayout,
				roomLink,
			}),
		);

		if (this.ctx.isDisposed()) return;
		// 跨 useLiveRoomInfo / useMasterInfo / getTimeDifference / sendLiveNotifyCard
		// 这串长 await(卡片渲染+推送可数秒)后重校 liveStatus:期间可能已交错
		// onLiveEnd → handleLiveEnd 把状态翻 idle 并 teardown。此刻若已非开播态,
		// 这条 stale start 绝不能再 armPeriodicTimer,否则 idle 房间被挂上 live
		// 周期定时器(轮询/词云/总结全部错位触发)。
		if (!this.liveStatus) {
			this.ctx.logger.warn(
				`[live] 直播间 [${this.sub.roomId}] 开播流程完成时已非开播态（疑似交错下播），跳过周期任务`,
			);
			return;
		}
		this.armPeriodicTimer();
	}

	private async onLiveEnd(): Promise<void> {
		const now = Date.now();
		if (now - this.lastLiveEnd < LIVE_EVENT_COOLDOWN) {
			// 冷却是用来吞掉 B 站对**同一次**转换重复派发的帧的。但正处在「翻成在播」窗口时,
			// 这条 END 讲的是新的一场(直播抖动:END → 3s 后 LIVE → 8s 后又 END,第二条就落在
			// 上一条的冷却里),而这里在 triggerLiveEnd 之前就 return —— 记账代码在
			// handleLiveEnd 里,这条路径根本走不到。所以记账必须提到冷却之前。
			this.noteEndDuringTransition();
			this.ctx.logger.debug(`[live] 直播间 [${this.sub.roomId}] 的下播事件在冷却期内，忽略`);
			return;
		}
		this.lastLiveEnd = now;
		await this.triggerLiveEnd("ws");
	}

	/**
	 * 特别关注用户进房。
	 *
	 * 事件源是 `INTERACT_WORD_V2` **一帧独供**(parser 只解它;`ENTRY_EFFECT` /
	 * v1 `INTERACT_WORD` / `LIKE_INFO_V3_CLICK` 一律走 raw 不进来)。blive 库时代
	 * `onUserAction` 是四个上游事件的汇流口,ENTRY_EFFECT 被硬编码成 "enter",
	 * 舰长进房会推两次 —— 那时靠 `msg.type` 对暗号排重;自实现后源头就只有一个,
	 * 暗号不需要了,但**别把 ENTRY_EFFECT 加回 parser**,不然旧 bug 原样复活。
	 *
	 * `user.uid` 是 number,而白名单存的是 string,比对前必须转。
	 */
	private async onUserAction(ev: { action: UserActionType; user: LiveUser }): Promise<void> {
		if (
			!this.sub.customSpecialUsersEnterTheRoom.enable ||
			!this.ctx.hasTargets(this.sub, "specialUserEnter")
		) {
			return;
		}
		if (ev.action !== "enter") return;
		const uid = String(ev.user.uid);
		if (!this.sub.customSpecialUsersEnterTheRoom.specialUsersEnterTheRoom?.includes(uid)) return;
		const text = this.ctx.templateRenderer.renderSpecialUserEnter({
			template: this.sub.customSpecialUsersEnterTheRoom.msgTemplate,
			uname: ev.user.uname,
			master: this.masterInfo,
		});
		this.ctx.safeBroadcast(
			this.sub.uid,
			this.ctx.contentBuilder.message([this.ctx.contentBuilder.text(text)]),
			LivePushType.UserActions,
		);
	}
}
