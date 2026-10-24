import { BILIBILI_SOURCE_KEY, type Disposable, type MessageBus } from "@bilibili-notify/internal";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的 **B 站适配**(ADR-0020 决策 17):记 B 站的「来源在跑」。
 *
 * B 站的规矩只写在这里。作品行不在这里:B 站与拓展共用 `recorder.ts` 里的 `post-detected` 监听。
 *   - 直播场次不在这里:所有来源都走中立监听(`live-source.ts`)的 `live-session-changed`;
 *   - **「来源在跑」= B 站登录有效**(ADR-0027 决策 2):定时(每 {@link BILI_SOURCE_CHECK_MS})看一眼登录状态,有效就给每条
 *     满足条件的订阅记当前小时的 `posts` / `live`;挂上时、`auth-restored` 时各立刻看一眼;登录无效不记。状态每次现读
 *     (`isLoggedIn`),事件只用来立刻补记一次,不拿它记状态;
 *   - 粉丝「在记」由中立的资料刷新引擎记,这里不按快照再记一遍。
 *
 * 直播文件也按订阅 id 分;来源登录丢了时,由登记表适配叫中立监听忘掉它名下的场次。
 */
export interface BiliStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	/** 当前全部订阅(拓展的会被跳过)。筛 B 站订阅、看 posts / live 的开关用。 */
	subscriptions: () => readonly StatsSubscription[];
	/** B 站现在登录有效吗。每次现读。没绑好之前由调用方回 false。 */
	isLoggedIn: () => boolean;
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

	return {
		tick,
		dispose() {
			clearInterval(timer);
			for (const h of handles) h.dispose();
			handles.length = 0;
		},
	};
}
