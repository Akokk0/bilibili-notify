import type { Disposable, LiveSessionChange, MessageBus } from "@bilibili-notify/internal";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的**中立直播监听**(ADR-0020 决策 6 / 17):所有来源的场次都吃核心引擎发的同一份
 * `live-session-changed`,不再从 B 站形状或拓展形状的事件各翻一支。
 *
 * - 开始,或登录失效 / 重启之后手里没有这一场时再见到 resume / tick / 在播 status,记一场;
 * - 结束只认 `end`,峰值与结束时刻都取变化里的;其余变化不是场次的头尾;
 * - 订阅不在了不补文件(删文件跟 `subscription-changed` 走),只忘掉内存;
 * - B 站登录失效时由 B 站适配叫 {@link LiveStatsSource.forgetOpenSessions},忘掉之后这一场的 end 不写;
 *   登录恢复后再见到同一开播时刻,按 `startedAt` 把它接回来。
 */
export interface LiveStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	now: () => Date;
	/** 当前全部订阅;按订阅 id 判它还在不在、要不要记直播。 */
	subscriptions: () => readonly StatsSubscription[];
}

export interface LiveStatsSource extends Disposable {
	/**
	 * 忘掉这个来源名下仍在统计里的场次(只动内存):之后它们的 `end` 不再写。
	 * B 站 cookie 失效时调用;别的来源在飞的场次不受影响。
	 */
	forgetOpenSessions(sourceKey: string): void;
}

/**
 * 取本场的开播时刻:优先用来源给的真实开播时刻,拿不到才退回「我们发现的时刻」。
 *
 * 这个区分是「服务器在 UP 已开播时启动」这一场景的全部要害 —— 记成发现时刻的话,
 * 已经播掉的那几个小时会被整段吞掉,「直播时长 Top」直到下播都是空的。
 *
 * 两种情况必须拒绝上游值:解析不出来(脏数据),以及**晚于现在**(时钟漂移 / 上游抽风)。
 * 后者若放行,统计会算出负时长。
 */
function liveStartIso(raw: string | undefined, at: Date): string | undefined {
	if (!raw) return undefined;
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms) || ms > at.getTime()) return undefined;
	return new Date(ms).toISOString();
}

export function attachLiveStatsSource(opts: LiveStatsSourceOptions): LiveStatsSource {
	const { bus, recorder } = opts;
	/** 订阅 id → 来源键。只留统计已经开过、还没结束或被忘掉的场次。 */
	const open = new Map<string, string>();

	const subscriptionOf = (id: string): StatsSubscription | undefined =>
		opts.subscriptions().find((sub) => sub.id === id);

	/**
	 * 来源给得出开播时刻时,它**就是**这一场的身份,没有第二个说法;身份由核心引擎那一场定
	 * (引擎按开播时刻分场),统计这里不再自己记闩。曾经在统计里另记「上一次的开播时刻」兜底,
	 * 结果隔天重登后的一场被旧值改写,两场各约 3 小时被并成一场 27 小时,还写进了只追加的文件、
	 * 事后无法修。所以不许在这里再加那种兜底。
	 */
	const recognize = (change: Extract<LiveSessionChange, { session: unknown }>): void => {
		const { session } = change;
		if (!session) return;
		// 在播场次每 2 秒一帧:已经在手上的 tick / 在播 status 先走,不能每帧都把整份订阅现折一遍。
		if (change.kind !== "start" && open.has(change.subscriptionId)) return;
		const sub = subscriptionOf(change.subscriptionId);
		// 直播类开关都关着不开新场次;已经开着的一场仍由 end 正常收尾。
		if (sub?.enabled !== true || !sub.recordsLive) return;
		// 再认只补手里没有的那一场。已经开着的一条订阅不会被同一场的 tick / status 重复开场。
		const key = statsFileKey(sub);
		const startedAt = liveStartIso(session.startedAt, opts.now()) ?? session.detectedAt;
		open.set(change.subscriptionId, session.sourceKey);
		recorder.openSession(key, startedAt);
	};

	const handle = bus.on("live-session-changed", (change) => {
		switch (change.kind) {
			case "start":
			case "resume":
			case "tick":
				recognize(change);
				return;
			case "status":
				if (change.isLive) recognize(change);
				return;
			case "end": {
				if (!open.delete(change.subscriptionId)) return;
				const key = statsFileKey({ id: change.subscriptionId });
				if (subscriptionOf(change.subscriptionId) === undefined) {
					// 文件随订阅一起删;这一帧不能把它重新写出来。
					recorder.forget(key);
					return;
				}
				recorder.closeSession(key, change.endedAt, change.session.peakTotalViewers);
				return;
			}
			case "ending":
			case "unmatched-end":
				return;
		}
	});

	const forgetOpenSessions = (sourceKey: string): void => {
		for (const [id, keySource] of [...open]) {
			if (keySource !== sourceKey) continue;
			open.delete(id);
			recorder.forget(statsFileKey({ id }));
		}
	};

	return {
		forgetOpenSessions,
		dispose() {
			handle.dispose();
			open.clear();
		},
	};
}
