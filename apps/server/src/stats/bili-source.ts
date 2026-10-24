import { BILIBILI_SOURCE_KEY, type Disposable, type MessageBus } from "@bilibili-notify/internal";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的 **B 站适配**(ADR-0020 决策 17):记 B 站的「来源在跑」与登录失效后的在飞场次。
 *
 * B 站的规矩只写在这里。作品行不在这里:B 站与拓展共用 `recorder.ts` 里的 `post-detected` 监听。
 *   - 直播场次不在这里:所有来源都走中立监听(`live-source.ts`)的 `live-session-changed`;
 *   - `auth-lost` → 忘掉 B 站这头在飞的场次(删订阅的统计文件由中立的记录器处理);
 *   - **「来源在跑」= B 站登录有效**(ADR-0027 决策 2):定时(每 {@link BILI_SOURCE_CHECK_MS})看一眼登录状态,有效就给每条
 *     满足条件的订阅记当前小时的 `posts` / `live`;挂上时、`auth-restored` 时各立刻看一眼;登录无效不记。状态每次现读
 *     (`isLoggedIn`),事件只用来立刻补记一次,不拿它记状态;
 *   - 粉丝「在记」由中立的资料刷新引擎记,这里不按快照再记一遍。
 *
 * 直播文件也按订阅 id 分;登录失效时只忘 B 站来源名下的场次,别的来源在飞的场次不受影响。
 */
export interface BiliStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	/** 当前全部订阅(拓展的会被跳过)。筛 B 站订阅、看 posts / live 的开关用。 */
	subscriptions: () => readonly StatsSubscription[];
	/** B 站现在登录有效吗。每次现读。没绑好之前由调用方回 false。 */
	isLoggedIn: () => boolean;
	/** 忘掉 B 站来源名下在飞的统计场次(中立监听持有这份内存状态)。 */
	forgetOpenSessions: (sourceKey: string) => void;
}

/** 看一眼 B 站登录、给在记的订阅记当前小时的间隔:5 分钟(一小时里至少看十来次,漏一两次也不丢整点)。 */
export const BILI_SOURCE_CHECK_MS = 5 * 60_000;

export function attachBiliStatsSource(opts: BiliStatsSourceOptions): Disposable & { tick(): void } {
	const { bus, recorder } = opts;
	const handles: Disposable[] = [];

	/** 这个小时的账:登录有效才记,给每条满足条件的 B 站订阅记 `posts` / `live`。 */
	const tick = () => {
		if (!opts.isLoggedIn()) return;
		for (const sub of opts.subscriptions()) {
			if (sub.identity.sourceKey !== BILIBILI_SOURCE_KEY) continue;
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

	return {
		tick,
		dispose() {
			clearInterval(timer);
			for (const h of handles) h.dispose();
			handles.length = 0;
		},
	};
}
