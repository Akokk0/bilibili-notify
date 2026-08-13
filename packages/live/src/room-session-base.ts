import type { LiveRoomInfo } from "@bilibili-notify/api";
import type { CardKind, Disposable } from "@bilibili-notify/internal";
import type { MsgHandler } from "blive-message-listener";
import { DateTime } from "luxon";
import { type CustomCardStyleLike, LivePushType, type SubItemView } from "./push-like";
import { LiveRoomAccessDeniedError, type RoomContext } from "./room-helpers";
import { parseStopWords } from "./stop-words";
import { buildRoomLink } from "./template-renderer";
import { type LiveData, LiveType, type MasterInfo } from "./types";

/**
 * Cooldown window between accepting `onLiveStart` / `onLiveEnd` events; the
 * Bilibili WS sometimes fires duplicates for the same transition.
 */
export const LIVE_EVENT_COOLDOWN = 10 * 1000;

/**
 * Base class for {@link import("./room-session").RoomSession}, holding all
 * per-room mutable state and the high-level lifecycle / transition logic
 * (bootstrap, periodic-timer arm/cancel, live-end pipeline). Event handlers
 * (`onLiveStart`, `onIncomeSuperChat`, etc.) live in the subclass.
 *
 * State fields are `protected` so the subclass can read & mutate them
 * directly when handling MsgHandler events.
 */
export abstract class RoomSessionBase {
	protected readonly ctx: RoomContext;
	protected readonly sub: SubItemView;

	protected liveTime!: string;
	protected liveStatus = false;
	protected liveRoomInfo: LiveRoomInfo["data"] | undefined;
	protected masterInfo: MasterInfo | undefined;
	protected readonly liveData: LiveData = { likedNum: "0" };

	protected pushAtTimeTimer: Disposable | null = null;
	protected lastLiveStart = 0;
	protected lastLiveEnd = 0;

	/**
	 * 外层主动停止(cancel())后置 true。除了挡新重连(子类的 onError/watchdog 守卫),
	 * 也让 armPeriodicTimer 变 no-op —— teardown 抢在 in-flight onLiveStart/bootstrap
	 * 的 arm 之前 cancel() 时,不能再挂上孤儿周期 timer。
	 */
	protected cancelled = false;

	/**
	 * 「正在把状态翻成在播」的窗口。开播准备(刷房间信息 / 主播信息)、冷启动 bootstrap、
	 * 重连成功后的状态核对都要 await 网络,这几段期间 `liveStatus` 仍是 false。
	 *
	 * 它存在的唯一理由是:那几段期间 WS **已经在派发事件**了。此刻到达的下播事件会
	 * 撞上 {@link handleLiveEnd} 的 `!liveStatus` 守卫被静默丢弃(grace 也拦不住 ——
	 * 它同样要求 liveStatus 为真),而我们随后又无条件把状态翻成在播:这一场从此再
	 * 也等不到第二条 END。面板恒显「直播中」,统计侧按 now−startedAt 计时长,每天
	 * 自增 24 小时且无上限,而默认 `pushTime=0` 连轮询兜底都没有。
	 *
	 * 别直接读写这两个字段 —— 一律经 {@link beginLiveTransition} /
	 * {@link finishLiveTransition} / {@link noteEndDuringTransition}。手写这套记账
	 * 时漏过整整三条通道(bootstrap、END 冷却、放弃监听),每条都是永久卡「直播中」。
	 */
	protected transitioningToLive = false;
	/** 上述窗口内到达过下播事件。翻状态前必须查它;查完即清。 */
	protected endArrivedWhileTransitioning = false;
	/**
	 * `onLiveStart` 的**重入**守卫 —— 与 {@link transitioningToLive} 刻意分开。
	 *
	 * 两者一度是同一个字段,于是「记账 END」和「去重 LIVE」被绑死。把 bootstrap 也
	 * 纳入记账窗口后这个耦合立刻要命:bootstrap 拉到的 `live_status` 是 0、而 UP 恰好
	 * 在这几秒内开播时,那条 LIVE 会被去重吞掉,而 bootstrap 又不会翻成在播 —— 房间
	 * 永久卡在「未直播」,和它要修的「永久卡在直播中」正好是一对。
	 *
	 * 去重只该防 `onLiveStart` 自己被并发的重复 LIVE 帧重入;bootstrap 不处理开播事件,
	 * 就不该替它拦。
	 */
	protected startingUp = false;

	/**
	 * 断流接续「挂起中」的等待计时器(内存,服务重启即丢 —— 已与用户约定接受)。非 null
	 * 即表示该房间正处于「下播待定」窗口:liveStatus 仍 true、弹幕缓冲未清、复推已暂停。
	 */
	protected pendingEndTimer: Disposable | null = null;
	/**
	 * 进入挂起那刻定格的直播时长字串。真下播卡按「最后一次下播时刻」渲染时长,不含等待
	 * 窗口的 N 分钟(M2);接续 / 到期重开时清空。
	 */
	protected graceEndDiffTime: string | undefined;
	/**
	 * 进入挂起那刻的**真实下播时刻**(ISO)。与 {@link graceEndDiffTime} 同生共死 ——
	 * 一个是给下播卡看的时长文案,一个是给统计侧落盘用的时刻。
	 *
	 * 没有它的话,统计侧只能拿「到期时刻」当下播时间,于是每场直播都平白多出
	 * 1–10 分钟(整个 grace 窗口),而下播卡上写的是定格时长 —— 同一场直播,
	 * 卡片和统计页两个数对不上。
	 */
	protected graceEndAt: string | undefined;

	constructor(ctx: RoomContext, sub: SubItemView) {
		this.ctx = ctx;
		this.sub = sub;
	}

	/** {@link enqueuePush} 的链尾。永不 reject(失败在链上吞掉,但会抛回发起方)。 */
	private pushTail: Promise<unknown> = Promise.resolve();

	/**
	 * 同房间对外推送的串行闸:所有 target 推送(开播 / 下播 / 正在直播 / 词云 / 总结 /
	 * SC / 上舰)都从这里过,**送达次序 = 发起次序**。
	 *
	 * 真实事故:主播下播后几秒内重开,下播流程与新场开播流程是两个互不排队的异步
	 * 上下文,各自渲染 + 发送 —— 开播卡跑得快就先送达,QQ 与 history(按送达完成序
	 * 落库)都呈现「开播 → 下播 → 总结」的倒序,一小时后新场的周期复推于是被用户
	 * 读成「下播了还推正在直播」的误报。
	 *
	 * 只包**发送**那一步,不包渲染前的取数与生成:词云 / AI 总结要跑几十秒,把它们
	 * 也锁进闸里,重开的开播卡就得白等一整段生成。失败不断链:排在后面的推送照常
	 * 送出,异常原样抛回发起方(各调用点的错误语义与从前一致)。
	 *
	 * `safeBroadcast`(特别关注弹幕 / 进房)不在闸内 —— 它本身就是 fire-and-forget、
	 * 不 await 送达,队列锁不住它真正的送达时刻。
	 */
	protected enqueuePush<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.pushTail.then(fn);
		this.pushTail = run.catch(() => undefined);
		return run;
	}

	/**
	 * 取某卡片类型的生效样式:优先该 kind 的 per-kind 覆盖,缺失回退基准 `customCardStyle`。
	 * 始终有定义(基准恒在);是否启用由调用点据 `enable` 自行判定 —— SC / guard 把未启用
	 * 折成 undefined 让 generate* 走渲染器全局 config 兜底,live 则原样透传(room-helpers
	 * 再据 enable 门控)。adapter 已把 per-kind 折算成完整样式,这里只做选取。
	 *
	 * 背景图「每次推送轮换」:优先用该样式自带的 `backgroundImages`;若该 UP / kind 没有
	 * 任何覆盖(样式自带列表为空)→ 落回引擎级 `defaultBackgroundImages`(全局默认图廊)—
	 * 否则这些 UP 会一直渲染渲染器内部缓存的静态首图,图廊配再多张也不轮换(回归 bug)。
	 * 列表 >1 张时经注入的 `pickBackground`(按 `uid:kind` 独立游标)选下一张并强制
	 * `enable:true`,其余字段留空,靠调用点 `?? this.config.X` 逐字段回退渲染器全局配置。
	 * 未注入选择器(koishi)/ 列表 ≤1 张 → 原样返回(用首图或渲染器静态兜底)。
	 * 每次调用即一次推送,故在此推进游标恰好 = 每推送一次轮换一张。
	 */
	protected resolvedCardStyle(kind: CardKind): CustomCardStyleLike {
		const style = this.sub.customCardStyleByKind?.[kind] ?? this.sub.customCardStyle;
		let out = style;
		const images =
			style.backgroundImages && style.backgroundImages.length > 0
				? style.backgroundImages
				: this.ctx.config.defaultBackgroundImages;
		if (images && images.length > 1) {
			const picked = this.ctx.pickBackground(`${this.sub.uid}:${kind}`, images);
			if (picked !== undefined) out = { ...out, enable: true, backgroundImage: picked };
		}
		// 直播封面轮换(独立端专属,仅 live 卡有封面):同一 rotator,key 维度独立
		// (`uid:live-cover` vs 背景的 `uid:kind`),互不干扰。语义与背景完全同构:
		// 样式自带列表优先,否则落回引擎级全局默认;>1 张才轮换,单张由 adapter 预填。
		if (kind === "live") {
			const covers =
				style.liveCoverImages && style.liveCoverImages.length > 0
					? style.liveCoverImages
					: this.ctx.config.defaultLiveCoverImages;
			if (covers && covers.length > 1) {
				const picked = this.ctx.pickBackground(`${this.sub.uid}:live-cover`, covers);
				if (picked !== undefined) out = { ...out, enable: true, liveCoverImage: picked };
			}
		}
		return out;
	}

	/** Whether the underlying B-station room is currently broadcasting. */
	get isLive(): boolean {
		return this.liveStatus;
	}

	/**
	 * 唯一允许翻转 `liveStatus` 的入口。只在真实 transition 时通过 RoomContext
	 * 推送 `live-state-changed` 事件,前端的"正在直播"面板靠它实时收敛。
	 * 直接赋值 `this.liveStatus = ...` 会绕过这里,**不要这样做**。
	 */
	protected setLiveStatus(next: boolean, endedAt?: string): void {
		if (this.liveStatus === next) return;
		this.liveStatus = next;
		// 开播时把 B 站的真实 `live_time` 一并带出去。它是 "yyyy-MM-dd HH:mm:ss"
		// 且**恒为北京时间**,在这里就换算成 ISO —— 交给消费方自己解析的话,
		// 非北京时区的服务器上 `Date.parse` 会当成本地时间,平白差出 8 小时。
		//
		// 下播侧带的是 `endedAt`:走断流接续时,真实下播时刻在进入挂起那一刻就定格了,
		// 而事件要等 N 分钟窗口到期才发得出来。不带的话消费方只能用「收到事件的时刻」,
		// 每场直播平白多算一整个 grace 窗口,与下播卡上的时长对不上。
		this.ctx.emitLiveState(
			this.sub.uid,
			next ? "live" : "idle",
			next ? this.liveStartIso() : endedAt,
		);
	}

	/**
	 * 进入「翻成在播」窗口。与 {@link finishLiveTransition} 成对使用,中间那段 await
	 * 期间到达的下播事件会被记账,而不是撞上守卫后静默消失。
	 *
	 * `dedupeStart` 仅由真正在处理开播事件的通道传 true(见 {@link startingUp}):
	 * 它额外把并发的重复 LIVE 帧挡掉。bootstrap 传 false —— 它不处理开播事件,拦下来
	 * 就没人接了。
	 */
	protected beginLiveTransition(dedupeStart = false): void {
		this.transitioningToLive = true;
		this.endArrivedWhileTransitioning = false;
		this.startingUp = dedupeStart;
	}

	/**
	 * 离开「翻成在播」窗口,并裁决这一场是不是已经结束了。
	 *
	 * 返回 true = 期间收到过下播事件,**绝不能**再翻成在播:那条 END 已被丢弃、B 站
	 * 不会再发第二次,翻过去房间就永久停在「直播中」。这一场也从没跑过下播流水线,
	 * 所以弹幕缓冲在这里排空 —— 否则这几秒的弹幕会被折进**下一场**的词云 / 直播总结,
	 * 观众看到一堆本场根本没人发过的弹幕。
	 *
	 * 可重复调用(第二次恒返回 false),好让调用方在 finally 里兜底而不必担心重复排空。
	 */
	protected finishLiveTransition(): boolean {
		this.transitioningToLive = false;
		this.startingUp = false;
		if (!this.endArrivedWhileTransitioning) return false;
		this.endArrivedWhileTransitioning = false;
		this.ctx.danmakuCollector.clear(this.sub.roomId);
		this.ctx.danmakuCollector.registerRoom(this.sub.roomId);
		return true;
	}

	/**
	 * 记下「窗口期内到达过下播事件」。下播事件**每一个**会被提前丢弃的入口都要调它:
	 * {@link handleLiveEnd} 的 `!liveStatus` 守卫是一个,`onLiveEnd` 的 10s 冷却是另一个
	 * —— 后者在 `triggerLiveEnd` 之前就 return,曾经整条路径都记不上账。
	 */
	protected noteEndDuringTransition(): void {
		if (this.transitioningToLive) this.endArrivedWhileTransitioning = true;
	}

	/** `live_time`(北京时间字符串)→ ISO;缺失或解析不出时返回 undefined。 */
	private liveStartIso(): string | undefined {
		const raw = this.liveRoomInfo?.live_time;
		if (!raw) return undefined;
		const dt = DateTime.fromFormat(raw, "yyyy-MM-dd HH:mm:ss", { zone: "UTC+8" });
		return dt.isValid ? (dt.toUTC().toISO() ?? undefined) : undefined;
	}

	/**
	 * Read-only diagnostic snapshot for routes / dashboards. Includes `uid`,
	 * `roomId`, and — when `liveRoomInfo` was successfully fetched — `title`,
	 * `cover`, `areaName`, `startedAt`. Returns undefined fields rather than
	 * partial data so consumers can render fallbacks deterministically.
	 */
	getLiveSnapshot(): {
		uid: string;
		roomId: string;
		isLive: boolean;
		title?: string;
		cover?: string;
		areaName?: string;
		startedAt?: string;
		/**
		 * B 站 WS `WATCHED_CHANGE` 帧给出的"累计观看人数",预格式化字符串(如 "1.2万")。
		 * 还没收到该帧时为 undefined,前端显示 "—"。我们不存原始 num,因为 bilibili 自己
		 * 给的 text_small 已是用户预期的中文压缩形式。
		 */
		viewers?: string;
	} {
		const w = this.liveData.watchedNum;
		const viewers = typeof w === "number" ? String(w) : w;
		return {
			uid: this.sub.uid,
			roomId: this.sub.roomId,
			isLive: this.liveStatus,
			title: this.liveRoomInfo?.title,
			cover: this.liveRoomInfo?.user_cover || this.liveRoomInfo?.keyframe || undefined,
			areaName: this.liveRoomInfo?.area_name,
			startedAt: this.liveRoomInfo?.live_time || undefined,
			viewers: viewers && viewers !== "暂未获取到" ? viewers : undefined,
		};
	}

	/**
	 * Open the WS connection (via `RoomContext.startLiveRoomListener`), pull
	 * the initial live-room snapshot, and — if the room is already live —
	 * kick off the `restartPush` branch + arm the periodic timer.
	 */
	async bootstrap(): Promise<void> {
		// listener 建失败时此前丢弃返回值仍继续:下文 live_status===1 会
		// armPeriodicTimer + setLiveStatus(true) → 房间标"直播中"、周期复推在跑,
		// 但无 WS,永不收弹幕 / onLiveEnd。建不起来即同"获取信息失败"一并放弃。
		let listening = false;
		try {
			listening = await this.ctx.startLiveRoomListener(this.sub.roomId, this.buildHandler());
		} catch (e) {
			if (e instanceof LiveRoomAccessDeniedError) {
				this.onMonitoringStopped();
				this.ctx.stopMonitoring(e.message, this.sub.roomId);
				return;
			}
			throw e;
		}
		if (!listening) {
			await this.ctx.push.sendPrivateMsg(
				`直播间 [${this.sub.roomId}] 弹幕连接建立失败，已停止该房间监测`,
			);
			this.onMonitoringStopped();
			this.ctx.closeListener(this.sub.roomId);
			return;
		}

		// WS 从上面这行起就在派发事件了,而 `liveStatus` 要等本方法末尾才翻 —— 中间隔着
		// 刷房间/主播信息、算已播时长、渲染并推送「正在直播」卡片,可达数秒。这是全仓
		// 最长的一段「翻成在播」窗口,期间到达的 END 同样必须记账。
		this.beginLiveTransition();
		try {
			await this.bootstrapRoomState();
		} finally {
			// 兜底:上面每条提前 return 的路径也要把窗口关掉,不能让标志漏到下一次事件。
			this.finishLiveTransition();
		}
	}

	/** {@link bootstrap} 装好 listener 之后的部分,整段跑在「翻成在播」窗口里。 */
	private async bootstrapRoomState(): Promise<void> {
		if (
			!(await this.useLiveRoomInfo(LiveType.FirstLiveBroadcast)) ||
			!(await this.useMasterInfo(LiveType.FirstLiveBroadcast)) ||
			!this.liveRoomInfo ||
			!this.masterInfo
		) {
			await this.ctx.push.sendPrivateMsg("获取直播间信息失败，启动直播间弹幕检测失败");
			this.onMonitoringStopped();
			this.ctx.closeListener(this.sub.roomId);
			return;
		}

		this.onListenerStarted();
		this.ctx.logger.debug(`[stat] 当前粉丝数：${this.masterInfo.liveOpenFollowerNum}`);

		if (this.liveRoomInfo.live_status === 1) {
			this.liveTime = this.liveRoomInfo.live_time;
			const watched = String(this.liveData.watchedNum ?? "暂未获取到");
			this.liveData.watchedNum = watched;
			const diffTime = await this.ctx.getTimeDifference(this.liveTime);
			const roomLink = buildRoomLink(this.liveRoomInfo);
			// 消息版式(per-UP ?? 引擎 config 级,两级都缺 = 旧路径)覆盖开播 / 直播中 / 下播,
			// 与 onLiveStart 同款接线。
			const messageLayout = this.sub.messageLayout ?? this.ctx.config.messageLayout;
			const liveMsg = this.ctx.templateRenderer.renderLiveOngoing({
				sub: this.sub,
				globalCustom: this.ctx.config.customLiveMsg,
				master: this.masterInfo,
				diffTime,
				watched,
				roomLink,
				omitLink: messageLayout !== undefined,
			});

			// restartPush 已由 adapter 折算好(per-UP ?? 全局)。
			// 抓成局部变量再入闸:非空收窄进不了闭包,而且卡片本就该反映**发起时刻**的状态。
			const liveRoomInfo = this.liveRoomInfo;
			const master = this.masterInfo;
			if (this.sub.restartPush) {
				await this.enqueuePush(() =>
					this.ctx.sendLiveNotifyCard({
						liveType: LiveType.LiveBroadcast,
						liveData: this.liveData,
						liveRoomInfo,
						master,
						cardStyle: this.resolvedCardStyle("live"),
						cardLayout: this.sub.cardLayout,
						uid: this.sub.uid,
						notifyMsg: liveMsg,
						messageLayout,
						roomLink,
					}),
				);
			}
			// 卡片推送也在窗口内,所以裁决放在最后一刻:这几秒里 UP 停播的话,翻成
			// 在播就再没有第二条 END 能把它翻回来了。
			if (this.finishLiveTransition()) {
				this.ctx.logger.info(
					`[live] 直播间 [${this.sub.roomId}] 启动期间已收到下播事件，不按在播处理`,
				);
				return;
			}
			// P2:与 onLiveStart 同序(先 setLiveStatus 再 arm)。此前 bootstrap
			// 反着写,当前无害但语义不一致 —— 统一为「先翻状态再 arm 周期复推」。
			this.setLiveStatus(true);
			this.armPeriodicTimer();
		}
	}

	/** Build the platform-specific {@link MsgHandler}; provided by the subclass. */
	protected abstract buildHandler(): MsgHandler;

	/** Hook for subclass-owned connection-health bookkeeping after listener bootstrap succeeds. */
	protected onListenerStarted(): void {}

	/** Hook for subclass-owned cleanup before this session intentionally stops monitoring. */
	protected onMonitoringStopped(): void {}

	// ── State transitions ─────────────────────────────────────────────────────

	protected async useLiveRoomInfo(liveType: LiveType): Promise<boolean> {
		const data = await this.ctx.getLiveRoomInfo(this.sub.roomId);
		if (!data?.uid) return false;
		if (liveType === LiveType.StartBroadcasting || liveType === LiveType.FirstLiveBroadcast) {
			this.liveRoomInfo = data;
			return true;
		}
		// Preserve `live_time` across mid-session refreshes so that the live-end
		// elapsed-time card matches the original live start.
		this.liveRoomInfo = { ...data, live_time: this.liveRoomInfo?.live_time ?? data.live_time };
		return true;
	}

	protected async useMasterInfo(liveType: LiveType): Promise<boolean> {
		try {
			this.masterInfo = await this.ctx.getMasterInfo(
				this.liveRoomInfo?.uid.toString() ?? this.sub.uid,
				this.masterInfo,
				liveType,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Live 配置 `pushTime` 热更后调用:重新按当前(可能已变更的) `pushTime`
	 * arm 定时器。仅对正在直播的房间生效,因为只有 live 状态下才会有 timer。
	 *
	 * 注意:`setInterval` 句柄的 ms 参数是 immutable,只能 dispose 重建。
	 */
	rearmPeriodicTimer(): void {
		if (!this.isLive) return;
		this.cancelPeriodicTimer();
		this.armPeriodicTimer();
	}

	protected armPeriodicTimer(): void {
		// teardown 交错守卫:session 已 cancel() 或 ctx 已 disposed 时绝不 arm ——
		// 否则 in-flight onLiveStart/bootstrap 恢复后会挂上一个孤儿 setInterval,
		// session 已从 sessionRecord 删除,interval 却永远 tick(见 timer-guard 测试)。
		if (this.cancelled || this.ctx.isDisposed()) return;
		// pushTime 已由 adapter 折算好(per-UP ?? 全局)。0 = 关闭该 UP 的「正在直播」复推。
		const pushTime = this.sub.pushTime;
		if (pushTime === 0 || this.pushAtTimeTimer) return;
		this.pushAtTimeTimer = this.ctx.serviceCtx.setInterval(
			() => this.tickPushAtTime(),
			pushTime * 1000 * 60 * 60,
		);
		this.ctx.livePushTimerManager.set(this.sub.roomId, () => this.pushAtTimeTimer?.dispose());
		this.ctx.logSideEffectState(`timer:created room=${this.sub.roomId}`);
	}

	protected cancelPeriodicTimer(): void {
		if (!this.pushAtTimeTimer) return;
		this.pushAtTimeTimer.dispose();
		this.pushAtTimeTimer = null;
		this.ctx.livePushTimerManager.delete(this.sub.roomId);
		this.ctx.logSideEffectState(`timer:deleted room=${this.sub.roomId}`);
	}

	/** Periodic "正在直播" tick (callback for `setInterval`). */
	protected async tickPushAtTime(): Promise<void> {
		if (!(await this.useLiveRoomInfo(LiveType.LiveBroadcast)) || !this.liveRoomInfo) {
			this.onMonitoringStopped();
			this.ctx.stopMonitoring("获取直播间信息失败，推送直播卡片失败", this.sub.roomId);
			return;
		}
		// Fallback when the room actually closed but no onLiveEnd event arrived.
		if (this.liveRoomInfo.live_status === 0 || this.liveRoomInfo.live_status === 2) {
			this.ctx.logger.warn(
				`[live] 直播间 [${this.sub.roomId}] 检测到已下播但未收到 onLiveEnd 事件，进入下播处理`,
			);
			await this.ctx.push.sendPrivateMsg(
				`直播间 [${this.sub.roomId}] 已下播但未收到 WS 下播事件，已自动进入下播处理`,
			);
			// 与 WS 下播同走 grace 闸门:开启断流接续时也先挂起等待,而非立即下播。
			await this.triggerLiveEnd("polling");
			return;
		}
		if (!(await this.useMasterInfo(LiveType.LiveBroadcast)) || !this.masterInfo) return;

		this.liveTime = this.liveRoomInfo.live_time;
		const watched = String(this.liveData.watchedNum ?? "暂未获取到");
		this.liveData.watchedNum = watched;
		const diffTime = await this.ctx.getTimeDifference(this.liveTime);
		const roomLink = buildRoomLink(this.liveRoomInfo);
		const messageLayout = this.sub.messageLayout ?? this.ctx.config.messageLayout;
		const liveMsg = this.ctx.templateRenderer.renderLiveOngoing({
			sub: this.sub,
			globalCustom: this.ctx.config.customLiveMsg,
			master: this.masterInfo,
			diffTime,
			watched,
			roomLink,
			omitLink: messageLayout !== undefined,
		});

		// 抓成局部变量再入闸:非空收窄进不了闭包,卡片也本就该反映发起时刻的状态。
		const liveRoomInfo = this.liveRoomInfo;
		const master = this.masterInfo;
		await this.enqueuePush(() =>
			this.ctx.sendLiveNotifyCard({
				liveType: LiveType.LiveBroadcast,
				liveData: this.liveData,
				liveRoomInfo,
				master,
				cardStyle: this.resolvedCardStyle("live"),
				cardLayout: this.sub.cardLayout,
				uid: this.sub.uid,
				notifyMsg: liveMsg,
				messageLayout,
				roomLink,
			}),
		);
	}

	/** 断流接续等待时长(分钟),per-UP 缺省 2,防御性夹到 [1,10]。 */
	protected graceMinutes(): number {
		return Math.min(10, Math.max(1, this.sub.liveEndGraceMinutes ?? 2));
	}

	/**
	 * 下播事件统一收口(WS `onLiveEnd` 与轮询兜底共用)。开启断流接续且当前在播时,先
	 * 进入「挂起」等待而非立即下播;否则直接走 {@link handleLiveEnd}。已在挂起中的重复
	 * 下播事件直接忽略(等待已在进行)。
	 */
	protected async triggerLiveEnd(source: "ws" | "polling"): Promise<void> {
		if (this.pendingEndTimer) return;
		if (this.sub.liveEndGrace && this.liveStatus) {
			await this.enterGrace(source);
			return;
		}
		await this.handleLiveEnd(source);
	}

	/**
	 * 进入断流接续「挂起」:定格下播时刻的直播时长(M2)、暂停复推(Q3)、起内存等待计时器。
	 * 刻意**不**翻 liveStatus(Q2 前端仍「直播中」)、**不**清弹幕缓冲(Q1 跨段),等重开接续
	 * 或到期真下播时再决定。
	 */
	protected async enterGrace(source: "ws" | "polling"): Promise<void> {
		this.graceEndDiffTime = await this.ctx.getTimeDifference(this.liveTime);
		// 现在就是真实下播时刻;等到期再取就混进了整个等待窗口。
		this.graceEndAt = new Date().toISOString();
		this.cancelPeriodicTimer();
		const minutes = this.graceMinutes();
		this.pendingEndTimer = this.ctx.serviceCtx.setTimeout(
			() => void this.onGraceExpiry(),
			minutes * 60 * 1000,
		);
		this.ctx.logger.info(
			`[grace] 直播间 [${this.sub.roomId}] 下播,进入 ${minutes} 分钟断流接续等待 (source=${source})`,
		);
	}

	/** 取消挂起等待(接续 / teardown 时调用),清掉计时器与定格时长。 */
	protected cancelPendingEnd(): void {
		if (!this.pendingEndTimer) return;
		this.pendingEndTimer.dispose();
		this.pendingEndTimer = null;
		this.graceEndDiffTime = undefined;
		this.graceEndAt = undefined;
	}

	/**
	 * 等待窗口到期。到期前先跟 B站核对真实状态(兜住 WS 漏掉 `onLiveStart` 的情形):
	 * 仍离线 → 判定真下播,走 {@link handleLiveEnd}(用定格时长);已重开 → 当接续,恢复复推。
	 */
	protected async onGraceExpiry(): Promise<void> {
		this.pendingEndTimer = null;
		if (this.ctx.isDisposed() || !this.liveStatus) {
			this.graceEndDiffTime = undefined;
			this.graceEndAt = undefined;
			return;
		}
		const reopened = await this.isLiveAgain();
		if (reopened) {
			this.ctx.logger.info(
				`[grace] 直播间 [${this.sub.roomId}] 等待到期核对发现已重新开播,接续为同一场`,
			);
			this.graceEndDiffTime = undefined;
			this.graceEndAt = undefined;
			this.armPeriodicTimer();
			return;
		}
		this.ctx.logger.info(
			`[grace] 直播间 [${this.sub.roomId}] 等待 ${this.graceMinutes()} 分钟仍未重开,判定真下播`,
		);
		const frozen = this.graceEndDiffTime;
		this.graceEndDiffTime = undefined;
		await this.handleLiveEnd("grace", frozen);
	}

	/** 到期核对:重拉房间信息,B站 `live_status===1` 即视为已重新开播。拉取失败按离线处理。 */
	protected async isLiveAgain(): Promise<boolean> {
		if (!(await this.useLiveRoomInfo(LiveType.StopBroadcast)) || !this.liveRoomInfo) return false;
		return this.liveRoomInfo.live_status === 1;
	}

	/**
	 * Live-end pipeline (shared by the WS `onLiveEnd` event and the polling
	 * fallback in {@link tickPushAtTime}).
	 *
	 * Order: cancel periodic timer → refresh room/master info → push live-end
	 * card → kick off wordcloud + summary → drain danmaku buffer.
	 *
	 * `precomputedDiffTime` 仅断流接续到期路径传入 —— 用进入挂起那刻定格的直播时长,
	 * 避免把等待窗口的 N 分钟算进「已播时长」(M2)。
	 */
	protected async handleLiveEnd(
		source: "ws" | "polling" | "grace" | "giveup",
		precomputedDiffTime?: string,
	): Promise<void> {
		if (!this.liveStatus) {
			// 正处在「翻成在播」的 await 窗口里 —— 这条 END 是真的,不能当重复事件丢掉。
			// 记下来,由那边在翻状态前自行收口。
			this.noteEndDuringTransition();
			this.ctx.logger.warn(
				`[live] 直播间 [${this.sub.roomId}] 已经是下播状态，忽略 (source=${source})`,
			);
			return;
		}
		this.cancelPeriodicTimer();
		// 定格时刻取完即清,与 `graceEndDiffTime` 同一套生命周期。非 grace 路径为
		// undefined,消费方按「收到事件的此刻」处理 —— WS 下播事件本就是即时的。
		const endedAt = this.graceEndAt;
		this.graceEndAt = undefined;

		if (
			!(await this.useLiveRoomInfo(LiveType.StopBroadcast)) ||
			!(await this.useMasterInfo(LiveType.StopBroadcast)) ||
			!this.liveRoomInfo ||
			!this.masterInfo
		) {
			this.setLiveStatus(false, endedAt);
			this.ctx.danmakuCollector.clear(this.sub.roomId);
			if (this.ctx.isDisposed()) return;
			this.onMonitoringStopped();
			this.ctx.stopMonitoring("获取直播间信息失败，推送直播下播卡片失败", this.sub.roomId);
			return;
		}
		this.setLiveStatus(false, endedAt);
		this.ctx.logger.debug(
			`[stat] 开播时粉丝数：${this.masterInfo.liveOpenFollowerNum}，下播时粉丝数：${this.masterInfo.liveEndFollowerNum}，粉丝数变化：${this.masterInfo.liveFollowerChange}`,
		);

		this.liveTime = this.liveRoomInfo.live_time || DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
		const diffTime = precomputedDiffTime ?? (await this.ctx.getTimeDifference(this.liveTime));
		this.liveData.fansChanged = this.masterInfo.liveFollowerChange;
		const roomLink = buildRoomLink(this.liveRoomInfo);
		const messageLayout = this.sub.messageLayout ?? this.ctx.config.messageLayout;

		const liveEndMsg = this.ctx.templateRenderer.renderLiveEnd({
			sub: this.sub,
			globalCustom: this.ctx.config.customLiveMsg,
			master: this.masterInfo,
			diffTime,
			followerChange: this.masterInfo.liveFollowerChange,
			roomLink,
			omitLink: messageLayout !== undefined,
		});

		// 抓成局部变量再入闸:非空收窄进不了闭包,卡片也本就该反映发起时刻的状态。
		const liveRoomInfo = this.liveRoomInfo;
		const master = this.masterInfo;
		try {
			if (this.ctx.isSubscribed(this.sub, "liveEnd")) {
				await this.enqueuePush(() =>
					this.ctx.sendLiveNotifyCard({
						liveType: LiveType.StopBroadcast,
						liveData: this.liveData,
						liveRoomInfo,
						master,
						cardStyle: this.resolvedCardStyle("live"),
						cardLayout: this.sub.cardLayout,
						uid: this.sub.uid,
						notifyMsg: liveEndMsg,
						messageLayout,
						roomLink,
					}),
				);
			}
			await this.dispatchWordCloudAndSummary(
				this.sub.customLiveSummary.liveSummary || this.ctx.config.liveSummaryDefault,
			);
		} finally {
			this.ctx.danmakuCollector.clear(this.sub.roomId);
			this.ctx.danmakuCollector.registerRoom(this.sub.roomId);
		}
	}

	/**
	 * Run wordcloud + AI live-summary in parallel and dispatch whichever
	 * succeeded. Skipped entirely when neither feature is subscribed.
	 */
	protected async dispatchWordCloudAndSummary(customLiveSummary: string): Promise<void> {
		const wantWordcloud = this.ctx.isSubscribed(this.sub, "wordcloud");
		const wantSummary = this.ctx.isSubscribed(this.sub, "liveSummary");
		if (!wantWordcloud && !wantSummary) return;

		this.ctx.logger.debug(
			`[wordcloud] 开始制作下播总结 wordcloud=${wantWordcloud} summary=${wantSummary}`,
		);
		const snapshot = this.ctx.danmakuCollector.snapshot(this.sub.roomId);

		// per-UP 额外停用词:记词时按 bundled + 全局过滤,这里对该 UP 解析后的覆盖词再
		// 过滤一遍 sortedWords,使 per-UP 停用词在该 UP 的词云 / 总结热词上额外生效。
		const extra = parseStopWords(this.sub.wordcloudStopWords);
		const sortedWords = extra.length
			? snapshot.sortedWords.filter(([word]) => !extra.includes(word))
			: snapshot.sortedWords;

		const [img, summary] = await Promise.all([
			wantWordcloud
				? this.ctx.wordcloudGenerator.generate(
						sortedWords,
						this.masterInfo?.username ?? "",
						this.masterInfo?.userface,
					)
				: Promise.resolve(undefined),
			wantSummary
				? this.ctx.liveSummaryRequester.generate({
						senderRecord: snapshot.senderRecord,
						sortedWords,
						master: this.masterInfo,
						customLiveSummary,
						// per-UP persona/prompt 覆盖;adapter 未填则交由 CommentaryGenerator 用全局 config。
						aiOverride: this.sub.aiOverride,
					})
				: Promise.resolve(undefined),
		]);

		if (this.ctx.isDisposed()) return;
		const wcMsg = img ? this.ctx.contentBuilder.image(img, "image/jpeg") : undefined;
		const summaryMsg = summary ? this.ctx.contentBuilder.text(summary) : undefined;
		if (wcMsg) {
			await this.enqueuePush(() =>
				this.ctx.push.broadcastToTargets(this.sub.uid, wcMsg, LivePushType.WordCloudAndLiveSummary),
			);
		}
		if (summaryMsg) {
			await this.enqueuePush(() =>
				this.ctx.push.broadcastToTargets(this.sub.uid, summaryMsg, LivePushType.LiveSummary),
			);
		}
	}
}
