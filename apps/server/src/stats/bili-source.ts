import {
	BILIBILI_SOURCE_KEY,
	type Disposable,
	type MessageBus,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { HOUR_MS } from "../followers/cutoff.js";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的 **B 站适配**(ADR-0020 决策 17):记 B 站的「来源在跑」、粉丝与登录失效后的在飞场次。
 *
 * B 站的规矩只写在这里。作品行不在这里:B 站与拓展共用 `recorder.ts` 里的 `post-detected` 监听。
 *   - 直播场次不在这里:所有来源都走中立监听(`live-source.ts`)的 `live-session-changed`;
 *   - `auth-lost` / 删订阅 → 忘掉 / 删掉 B 站这头的在飞状态与文件;
 *   - **「来源在跑」= B 站登录有效**(ADR-0027 决策 2):定时(每 {@link BILI_SOURCE_CHECK_MS})看一眼登录状态,有效就给每条
 *     满足条件的订阅记当前小时的 `posts` / `live`;挂上时、`auth-restored` 时各立刻看一眼;登录无效不记。状态每次现读
 *     (`isLoggedIn`),事件只用来立刻补记一次,不拿它记状态;
 *   - `fans-refreshed` → 条目是 B 站订阅的、启用着的,记它采样所在小时的 `followers`(「这个小时拉资料成功过」)。
 *
 * 直播文件也按订阅 id 分;登录失效时只忘 B 站来源名下的场次,别的来源在飞的场次不受影响。
 */
export interface BiliStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	now: () => Date;
	/** 当前全部订阅(拓展的会被跳过)。筛 B 站订阅、看「在记」与粉丝的开关用。 */
	subscriptions: () => readonly StatsSubscription[];
	/** B 站现在登录有效吗。每次现读。没绑好之前由调用方回 false。 */
	isLoggedIn: () => boolean;
	/** 忘掉 B 站来源名下在飞的统计场次(中立监听持有这份内存状态)。 */
	forgetOpenSessions: (sourceKey: string) => void;
}

/** 看一眼 B 站登录、给在记的订阅记当前小时的间隔:5 分钟(一小时里至少看十来次,漏一两次也不丢整点)。 */
export const BILI_SOURCE_CHECK_MS = 5 * 60_000;

export function attachBiliStatsSource(opts: BiliStatsSourceOptions): Disposable & { tick(): void } {
	const { bus, recorder, now } = opts;
	const handles: Disposable[] = [];

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
		// cookie 失效 → B 站来源把所有 listener 拆掉,但**不发 idle**
		// (disposeAll 只 cancel,发 idle 的只有 stopForUid)。从这一刻起 B 站这头没有任何人在
		// 观测直播,在飞的场次不再作数 —— 留着的话,重新登录后(可能隔了几天)开的新一场
		// 会被旧场接住,两场并成一场超长直播。
		//
		// 不在这里补 end 帧:真实下播时刻我们无从得知,补一个假的比留空更糟。只忘掉中立监听
		// 手里的这一场,之后引擎再发它的 end 也不写;登录恢复后再观测到同一开播时刻时按状态再认出。
		bus.on("auth-lost", () => {
			opts.forgetOpenSessions(BILIBILI_SOURCE_KEY);
		}),
	);

	handles.push(
		bus.on("subscription-changed", ({ ops }) => {
			for (const op of ops) {
				// 拓展订阅的统计文件由拓展适配自己删(ADR-0020 S3);这里只管 B 站这一支。
				if (op.kind !== "remove") continue;
				const identity = subscriptionIdentityOf(op.sub);
				if (identity.sourceKey !== BILIBILI_SOURCE_KEY) continue;
				const key = statsFileKey(op.sub);
				// 取消订阅就把这条订阅的统计文件一并删掉,与 FollowersStore 的处置一致 ——
				// 否则退订过的 UP 会在 stats 目录里永久留一份读不到、也删不掉的孤儿。
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
