import {
	BILIBILI_SOURCE_KEY,
	type Disposable,
	type MessageBus,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { HOUR_MS } from "../followers/cutoff.js";
import { classifyBiliDynamic } from "./bili-format.js";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的 **B 站适配**(ADR-0020 决策 17):把 B 站引擎已经在总线上的事件翻成记录器的中立调用。
 *
 * B 站的规矩只写在这里(与 `bili-format`):
 *   - `dynamic-detected` → 记成「有没有视频」的作品,开播那两种不记(不是作品,场次另从直播事件记);
 *     订阅的作品开关关着就不记(ADR-0027 决策 1,不动引擎);
 *   - `live-viewers-changed` → 总线上就是精确数(㉒d),直接报给记录器取本场最大值(不再解析「1.2万」);
 *   - `live-state-changed` → 开一场 / 关一场,开播时刻取 B 站的真实 `live_time`;
 *   - `auth-lost` / 删订阅 → 忘掉 / 删掉 B 站这头的在飞状态与文件;
 *   - **「来源在跑」= B 站登录有效**(ADR-0027 决策 2):定时(每 {@link BILI_SOURCE_CHECK_MS})看一眼登录状态,有效就给每条
 *     满足条件的订阅记当前小时的 `posts` / `live`;挂上时、`auth-restored` 时各立刻看一眼;登录无效不记。状态每次现读
 *     (`isLoggedIn`),事件只用来立刻补记一次,不拿它记状态;
 *   - `fans-refreshed` → 条目是 B 站订阅的、启用着的,记它采样所在小时的 `followers`(「这个小时拉资料成功过」)。
 *
 * **uid → 订阅 id 在这里换**(ADR-0020 决策 2 的 🔗):B 站引擎与总线照旧只带 uid,统计仓按
 * 订阅 id 分文件({@link statsFileKey})。找不到订阅的 uid 一样都不记 —— 改之前按 uid 照记,
 * 退订之后引擎补发的那帧下播会把刚删的文件重新写出来。同一个 uid 两条 B 站订阅(老版本留下的;
 * 写盘那一层不让新增)两条都记,与改之前两行共读一个 uid 文件同一个结果。
 */
export interface BiliStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	now: () => Date;
	/** 当前全部订阅(拓展的会被跳过)。按 uid 找订阅 id、看「在记」的开关用。 */
	subscriptions: () => readonly StatsSubscription[];
	/** B 站现在登录有效吗。每次现读。没绑好之前由调用方回 false。 */
	isLoggedIn: () => boolean;
}

/** 看一眼 B 站登录、给在记的订阅记当前小时的间隔:5 分钟(一小时里至少看十来次,漏一两次也不丢整点)。 */
export const BILI_SOURCE_CHECK_MS = 5 * 60_000;

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

export function attachBiliStatsSource(opts: BiliStatsSourceOptions): Disposable & { tick(): void } {
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
			const identity = subscriptionIdentityOf(sub);
			if (identity.sourceKey !== BILIBILI_SOURCE_KEY) continue;
			const ids = index.get(identity.externalId) ?? [];
			ids.push(statsFileKey(sub));
			index.set(identity.externalId, ids);
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

	/** 这个小时的账:登录有效才记,给每条满足条件的 B 站订阅记 `posts` / `live`。 */
	const tick = () => {
		if (!opts.isLoggedIn()) return;
		for (const sub of opts.subscriptions()) {
			if (subscriptionIdentityOf(sub).sourceKey !== BILIBILI_SOURCE_KEY) continue;
			const key = statsFileKey(sub);
			if (sub.recordsPosts) recorder.recordActive(key, "posts");
			if (sub.recordsLive) recorder.recordActive(key, "live");
		}
	};
	const timer = setInterval(tick, BILI_SOURCE_CHECK_MS);
	timer.unref?.();
	tick();

	handles.push(bus.on("auth-restored", tick));

	handles.push(
		bus.on("fans-refreshed", ({ entries }) => {
			const nowMs = now().getTime();
			const biliSubs = new Map<string, StatsSubscription>();
			for (const sub of opts.subscriptions()) {
				if (subscriptionIdentityOf(sub).sourceKey === BILIBILI_SOURCE_KEY)
					biliSubs.set(sub.id, sub);
			}
			for (const entry of entries) {
				if (biliSubs.get(entry.subscriptionId)?.enabled !== true) continue;
				// 条目的 `ts` 是这次采样的时刻;快照里没跟上这一轮的老条目(采样失败)不算「这个小时拉成功了」。
				const sampledAt = Date.parse(entry.ts);
				if (!Number.isFinite(sampledAt) || nowMs - sampledAt >= HOUR_MS) continue;
				recorder.recordActive(statsFileKey({ id: entry.subscriptionId }), "followers", sampledAt);
			}
		}),
	);

	handles.push(
		bus.on("dynamic-detected", (event) => {
			const post = classifyBiliDynamic(event.type);
			// 开播公告不是作品,直播按场次另记(见 `bili-format`)。
			if (!post) return;
			// 作品开关关着就不记(ADR-0027 决策 1):开关取现在的有效值,所以每次现查订阅清单(作品事件很稀疏)。
			const wanted = new Set(
				opts.subscriptions().flatMap((sub) => (sub.recordsPosts ? [statsFileKey(sub)] : [])),
			);
			for (const key of keysOf(event.uid)) {
				if (!wanted.has(key)) continue;
				recorder.recordPost(key, { id: event.id, hasVideo: post.hasVideo, publishedAt: event.ts });
			}
		}),
	);

	handles.push(
		bus.on("live-viewers-changed", ({ uid, viewers }) => {
			// 总线上就是精确数(㉒d),直接喂给记录器(不是有限的数由记录器自己不收,见 `reportViewers`)。
			for (const key of keysOf(uid)) {
				keys.add(key);
				recorder.reportViewers(key, viewers);
			}
		}),
	);

	handles.push(
		bus.on("live-state-changed", ({ uid, status, at: startedAt }) => {
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
			// 下播侧的 `at` 是**真实下播时刻**:走断流接续时它在进入挂起那刻就
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
		bus.on("subscription-changed", ({ ops }) => {
			// 事件到的时候订阅仓已经是改完的样子;uid → 订阅 id 的索引下次用到时重建。
			idsByUid = undefined;
			for (const op of ops) {
				// 拓展订阅的统计文件由拓展适配自己删(ADR-0020 S3);这里只管 B 站这一支。
				if (op.type !== "remove") continue;
				const identity = subscriptionIdentityOf(op.sub);
				if (identity.sourceKey !== BILIBILI_SOURCE_KEY) continue;
				const key = statsFileKey(op.sub);
				// 取消订阅就把这条订阅的统计文件一并删掉,与 FollowersStore 的处置一致 ——
				// 否则退订过的 UP 会在 stats 目录里永久留一份读不到、也删不掉的孤儿。
				openStart.delete(identity.externalId);
				keys.delete(key);
				recorder.drop(key);
			}
		}),
	);

	return {
		tick,
		dispose() {
			clearInterval(timer);
			for (const h of handles) h.dispose();
			handles.length = 0;
		},
	};
}
