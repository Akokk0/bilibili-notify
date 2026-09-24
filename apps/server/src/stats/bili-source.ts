import { type Disposable, isBiliSubscription, type MessageBus } from "@bilibili-notify/internal";
import { classifyBiliDynamic, parseBiliViewers } from "./bili-format.js";
import { type KeyedSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的 **B 站适配**(ADR-0020 决策 17):把 B 站引擎已经在总线上的事件翻成记录器的中立调用。
 *
 * B 站的规矩只写在这里(与 `bili-format`):
 *   - `dynamic-detected` → 类型分成 `video` / `post`,开播那两种记成 `live`(不是作品,只当活动证据);
 *   - `live-viewers-changed` → 「1.2万」解析成数字,报给记录器取本场最大值;
 *   - `live-state-changed` → 开一场 / 关一场,开播时刻取 B 站的真实 `live_time`;
 *   - `auth-lost` / 删订阅 → 忘掉 / 删掉 B 站这头的在飞状态与文件。
 *
 * **uid → 订阅 id 在这里换**(ADR-0020 决策 2 的 🔗):B 站引擎与总线照旧只带 uid,统计仓按
 * 订阅 id 分文件({@link statsFileKey})。找不到订阅的 uid 一样都不记 —— 改之前按 uid 照记,
 * 退订之后引擎补发的那帧下播会把刚删的文件重新写出来。同一个 uid 两条 B 站订阅(服务端不判重,
 * 只有面板挡着)两条都记,与改之前两行共读一个 uid 文件同一个结果。
 */
export interface BiliStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	now: () => Date;
	/** 当前全部订阅(拓展的会被跳过)。按 uid 找订阅 id 用;订阅一变就重查。 */
	subscriptions: () => readonly KeyedSubscription[];
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

export function attachBiliStatsSource(opts: BiliStatsSourceOptions): Disposable {
	const { bus, recorder, now } = opts;
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
	/**
	 * 交给过记录器的文件键(订阅 id)。`auth-lost` 只忘这些 —— 记录器是各来源共用的,B 站 cookie 失效
	 * 只说明 B 站这头没人在看了,别的来源在飞的场次不该跟着被忘掉。
	 */
	const keys = new Set<string>();
	const handles: Disposable[] = [];

	/**
	 * uid → 这个 uid 名下的 B 站订阅 id。惰性建、订阅一变(`subscription-changed`)就作废 ——
	 * 观看数每 2 秒一帧,不能每帧都把整份订阅深拷一遍。uid 是订阅的身份、改不动(ADR-0019
	 * 决策 50),所以只有增删会让它变。查不到时再重建一次:刚加的订阅不必等作废通知也认得出。
	 */
	let idsByUid: Map<string, string[]> | undefined;
	const buildIndex = () => {
		const index = new Map<string, string[]>();
		for (const sub of opts.subscriptions()) {
			if (!isBiliSubscription(sub)) continue;
			const ids = index.get(sub.uid) ?? [];
			ids.push(statsFileKey(sub));
			index.set(sub.uid, ids);
		}
		return index;
	};
	const keysOf = (uid: string): readonly string[] => {
		idsByUid ??= buildIndex();
		let ids = idsByUid.get(uid);
		if (!ids) {
			idsByUid = buildIndex();
			ids = idsByUid.get(uid);
		}
		return ids ?? [];
	};

	handles.push(
		bus.on("dynamic-detected", (event) => {
			const kind = classifyBiliDynamic(event.type);
			for (const key of keysOf(event.uid)) {
				recorder.recordPost(key, { id: event.id, kind, ts: event.ts });
			}
		}),
	);

	handles.push(
		bus.on("live-viewers-changed", (uid, viewers) => {
			const value = parseBiliViewers(viewers);
			if (!Number.isFinite(value)) return;
			for (const key of keysOf(uid)) {
				keys.add(key);
				recorder.reportViewers(key, value);
			}
		}),
	);

	handles.push(
		bus.on("live-state-changed", (uid, status, startedAt) => {
			const at = now();
			const ts = at.toISOString();
			const targets = keysOf(uid);
			for (const key of targets) keys.add(key);
			if (status === "live") {
				// live_time 可用即以它为准;只有它用不了时才沿用本场记住的值,免得
				// 回退到「此刻」的那条路径每观测一次就换一个身份(顺序见 openStart)。
				const startIso = liveStartIso(startedAt, at) ?? openStart.get(uid) ?? ts;
				openStart.set(uid, startIso);
				for (const key of targets) recorder.openSession(key, startIso);
				return;
			}
			// 这一场到此为止,下一场重新认身份。
			openStart.delete(uid);
			// 下播侧的第三个参数是**真实下播时刻**:走断流接续时它在进入挂起那刻就
			// 定格了,而事件要等 N 分钟窗口到期才发得出来。用 `ts`(收到事件的此刻)
			// 会把整个 grace 窗口算进直播时长,与下播卡上的时长对不上。缺省才回退。
			const endIso = liveStartIso(startedAt, at) ?? ts;
			for (const key of targets) recorder.closeSession(key, endIso);
		}),
	);

	handles.push(
		// cookie 失效 → LiveEngine.teardown() 把所有 listener 拆掉,但**不发 idle**
		// (disposeAll 只 cancel,发 idle 的只有 stopForUid)。从这一刻起 B 站这头没有任何人在
		// 观测直播,在飞的场次身份 / 峰值都不再作数 —— 留着的话,重新登录后(可能隔了
		// 几天)开的新一场会被按到旧身份上,两场并成一场超长直播。
		//
		// 不在这里补 end 帧:真实下播时刻我们无从得知,补一个假的比留空更糟。留空时
		// aggregate 侧 `current && isLive` 均为假,这一场不计入时长,不会无界增长。
		bus.on("auth-lost", () => {
			openStart.clear();
			for (const key of keys) recorder.forget(key);
			keys.clear();
		}),
	);

	handles.push(
		bus.on("subscription-changed", (ops) => {
			// 事件到的时候订阅仓已经是改完的样子;uid → 订阅 id 的索引下次用到时重建。
			idsByUid = undefined;
			for (const op of ops) {
				// 拓展订阅的统计文件由拓展适配自己删(ADR-0020 S3);这里只管 B 站这一支。
				if (op.type !== "remove" || !isBiliSubscription(op.sub)) continue;
				const key = statsFileKey(op.sub);
				// 取消订阅就把这条订阅的统计文件一并删掉,与 FansStore 的处置一致 ——
				// 否则退订过的 UP 会在 stats 目录里永久留一份读不到、也删不掉的孤儿。
				openStart.delete(op.sub.uid);
				keys.delete(key);
				recorder.drop(key);
			}
		}),
	);

	return {
		dispose() {
			for (const h of handles) h.dispose();
			handles.length = 0;
		},
	};
}
