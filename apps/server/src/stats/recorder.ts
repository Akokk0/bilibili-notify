import type { Disposable, Logger, MessageBus } from "@bilibili-notify/internal";
import type { StatsStore } from "./store.js";

/**
 * 采集层唯一的 bus 消费者 —— 把「UP 产出」类事件落进 {@link StatsStore}。
 *
 * 之所以整个采集都长在 apps/server 而非 packages/live、packages/dynamic 里:
 * 需要的三条事件(`dynamic-detected` / `live-state-changed` /
 * `live-viewers-changed`)本来就已经在总线上了,业务包不必为统计再开一个出口。
 *
 * **本层不做语义归类**:动态事件原样透传,「哪些算投稿」留给 aggregate 层。
 */
export interface StatsRecorderOptions {
	bus: MessageBus;
	store: StatsStore;
	logger: Logger;
	/** 注入时钟,测试用;缺省取系统时间。 */
	now?: () => Date;
}

/**
 * 把 B 站的累计观看字符串解析成数字,用于跨帧比大小。
 *
 * 上游给的是**预格式化**的中文压缩串("1.2万" / "3.5亿"),直接字符串比较会
 * 把 "9500" 判成大于 "1.2万"。这里只为取本场最大值而解析,落盘存的仍是原始
 * 字符串 —— 前端要照原样展示,不能被我们的往返转换改写精度。
 */
function parseViewers(raw: string): number {
	const text = raw.trim();
	const m = text.match(/^([\d.]+)\s*(万|亿)?$/);
	if (!m) return Number.NaN;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return Number.NaN;
	if (m[2] === "万") return n * 10_000;
	if (m[2] === "亿") return n * 100_000_000;
	return n;
}

/**
 * 取本场的开播时刻:优先用 B 站给的真实 `live_time`,拿不到才退回「我们发现的时刻」。
 *
 * 这个区分是「服务器在 UP 已开播时启动」这一场景的全部要害 —— 记成发现时刻的话,
 * 已经播掉的那几个小时会被整段吞掉,「直播时长 Top」直到下播都是空的。
 *
 * 两种情况必须拒绝上游值:解析不出来(脏数据),以及**晚于现在**(时钟漂移 / 上游
 * 抽风)。后者若放行,`summarizeLiveSessions` 会算出负时长。
 */
function liveStartIso(raw: string | undefined, at: Date): string | undefined {
	if (!raw) return undefined;
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms) || ms > at.getTime()) return undefined;
	return new Date(ms).toISOString();
}

/** Recorder 句柄:除了解绑,还要在关服前把在播的场次收尾。 */
export interface StatsRecorderHandle extends Disposable {
	/**
	 * 给当前仍在播的场次补一帧下播,时刻取「现在」。**关服前调用**。
	 *
	 * 关服路径(`teardown` / `stop` / `cancel`)都不翻 `liveStatus`,所以不会有
	 * 真实的下播事件 —— 对统计来说服务器是「人间蒸发」而不是「下播」。不补这一帧
	 * 的话,这一场永远等不到 end,已经观测到的那几个小时就白丢了。
	 *
	 * 补的是**观测截止时刻**,不是真实下播时刻(那个我们无从得知)。若服务在同一
	 * 场直播期间重启回来,`listLiveSessions` 会按 `startedAt` 认出是同一场并让更晚
	 * 的 end 覆盖上去,时长自动修正回完整值。
	 */
	closeOpenSessions(): Promise<void>;
}

export function createStatsRecorder(opts: StatsRecorderOptions): StatsRecorderHandle {
	const now = opts.now ?? (() => new Date());
	/** per-UID 本场峰值。开播时清空,下播时取走 —— 天然不跨场、不跨 UP 串味。 */
	const peaks = new Map<string, { raw: string; value: number }>();
	/** 当前仍在播的 UID。关服时据此补下播帧;正常下播会把它摘掉。 */
	const openLive = new Set<string>();
	/**
	 * per-UID 本场已经用过的 `startedAt` —— 只在 **live_time 用不了** 时兜底。
	 *
	 * 正常情况下引擎给的是 B 站 live_time,同一场无论被观测多少次都是同一个值。
	 * 但 live_time 缺失 / 解析不出时两侧都回退到「此刻」,而同一场会被重连核对、
	 * 重启 bootstrap 反复观测到 —— 两个「此刻」差着几秒,store 按 startedAt 精确
	 * 认场次,这一场就裂成两条区间重叠的记录,场次数与总时长一起虚高。
	 *
	 * **它排在 live_time 之后,不是之前。** 曾经反过来写(先查闩再解析),于是闩
	 * 一旦过期就会把新一场按到旧一场的身份上:auth-lost 走 `LiveEngine.teardown()`
	 * → `disposeAll()`,逐个 cancel 但**不发 idle**(只有 stopForUid 才发),闩就留
	 * 在了原地;隔天重新登录后 bootstrap 带着新的 live_time 发 live,却被闩改写回
	 * 昨天那个身份 —— 两场各约 3 小时被并成一场 27 小时,还是写进 append-only 文件,
	 * 事后无法修。live_time 拿得到时它**就是**这一场的身份,没有第二个说法。
	 *
	 * 只在进程内有效;`auth-lost` 时一并清掉(那之后没人在观测,记着的都不作数)。
	 */
	const openStart = new Map<string, string>();
	const handles: Disposable[] = [];

	/**
	 * 落盘一律 fire-and-forget:bus handler 是同步签名,而这些写入都不在任何
	 * 关键路径上。统计写失败只该丢一条统计,绝不能把异常冒泡回推送链路。
	 */
	const swallow = (what: string) => (err: unknown) =>
		opts.logger.warn(`[stats-recorder] ${what} failed: ${String(err)}`);

	// 采集一开始就把水位线钉下来。**这里就是「采集开始」的定义** —— recorder
	// 在位才有人往盘上写活动。
	//
	// 留给首次 overview 请求去惰性创建的话,盖下的是「第一次有人打开统计页」的
	// 时刻:升级后过几天才点开,这几天真采到的活动全部落在水位线之前,被判成
	// 「无记录」—— 数据在盘上,界面上却是空白,而且水位线一旦落下就恒定,这段
	// 永远显示不出来。
	opts.store.recordingSince().catch(swallow("recordingSince"));

	handles.push(
		opts.bus.on("dynamic-detected", (event) => {
			opts.store
				.appendDynamic(event.uid, { id: event.id, type: event.type, ts: event.ts })
				.catch(swallow(`appendDynamic ${event.uid}`));
		}),
	);

	handles.push(
		opts.bus.on("live-viewers-changed", (uid, viewers) => {
			const value = parseViewers(viewers);
			if (!Number.isFinite(value)) return;
			const cur = peaks.get(uid);
			if (!cur || value > cur.value) peaks.set(uid, { raw: viewers, value });
		}),
	);

	handles.push(
		opts.bus.on("live-state-changed", (uid, status, startedAt) => {
			const at = now();
			const ts = at.toISOString();
			if (status === "live") {
				peaks.delete(uid);
				openLive.add(uid);
				// live_time 可用即以它为准;只有它用不了时才沿用本场记住的值,免得
				// 回退到「此刻」的那条路径每观测一次就换一个身份(顺序见 openStart)。
				const startIso = liveStartIso(startedAt, at) ?? openStart.get(uid) ?? ts;
				openStart.set(uid, startIso);
				opts.store.openLiveSession(uid, startIso).catch(swallow(`openLiveSession ${uid}`));
				return;
			}
			const peak = peaks.get(uid);
			peaks.delete(uid);
			openLive.delete(uid);
			// 这一场到此为止,下一场重新认身份。
			openStart.delete(uid);
			// 下播侧的第三个参数是**真实下播时刻**:走断流接续时它在进入挂起那刻就
			// 定格了,而事件要等 N 分钟窗口到期才发得出来。用 `ts`(收到事件的此刻)
			// 会把整个 grace 窗口算进直播时长,与下播卡上的时长对不上。缺省才回退。
			opts.store
				.closeLiveSession(uid, liveStartIso(startedAt, at) ?? ts, peak?.raw)
				.catch(swallow(`closeLiveSession ${uid}`));
		}),
	);

	handles.push(
		// cookie 失效 → LiveEngine.teardown() 把所有 listener 拆掉,但**不发 idle**
		// (disposeAll 只 cancel,发 idle 的只有 stopForUid)。从这一刻起没有任何人在
		// 观测直播,在飞的场次身份 / 峰值都不再作数 —— 留着的话,重新登录后(可能隔了
		// 几天)开的新一场会被按到旧身份上,两场并成一场超长直播。
		//
		// 不在这里补 end 帧:真实下播时刻我们无从得知,补一个假的比留空更糟。留空时
		// aggregate 侧 `current && isLive` 均为假,这一场不计入时长,不会无界增长。
		opts.bus.on("auth-lost", () => {
			openStart.clear();
			openLive.clear();
			peaks.clear();
		}),
	);

	handles.push(
		opts.bus.on("subscription-changed", (ops) => {
			for (const op of ops) {
				if (op.type !== "remove") continue;
				// 取消订阅就把该 UP 的统计文件一并删掉,与 FansStore 的处置一致 ——
				// 否则退订过的 UP 会在 stats 目录里永久留一份读不到、也删不掉的孤儿。
				peaks.delete(op.uid);
				// `openLive` 也要摘掉。留着的话,关服时 closeOpenSessions 会给这位
				// 已退订的 uid 再 append 一帧 end,把 dropUid 刚 unlink 掉的
				// jsonl 整个重新创建出来 —— 从此是一份没人会读、也没人会再清的孤儿
				// (dropUid 只在 remove 时调,而他已经不在订阅列表里了)。
				openLive.delete(op.uid);
				openStart.delete(op.uid);
				opts.store.dropUid(op.uid).catch(swallow(`dropUid ${op.uid}`));
			}
		}),
	);

	return {
		async closeOpenSessions() {
			const ts = now().toISOString();
			// 这里**要 await**:关服写盘不是 fire-and-forget,进程随后就退出了。
			// serviceCtx.dispose() 会逐个 await onDispose 钩子,所以等得到。
			await Promise.all(
				[...openLive].map((uid) =>
					opts.store
						.closeLiveSession(uid, ts, peaks.get(uid)?.raw)
						.catch(swallow(`closeLiveSession(shutdown) ${uid}`)),
				),
			);
			openLive.clear();
			peaks.clear();
		},

		dispose() {
			for (const h of handles) h.dispose();
			handles.length = 0;
			peaks.clear();
			openLive.clear();
		},
	};
}
