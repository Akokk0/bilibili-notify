import { type Disposable, isLoggedIn, type MessageBus } from "@bilibili-notify/internal";
import type { SourceRegistry } from "../subscriptions/registry.js";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的登记表适配,管两件事:
 *
 *   1. 来源登录丢了就忘掉它在飞的直播场次;
 *   2. 「这个小时在记」由核心对所有在册来源记(取代从前的 B 站适配 + 登录读口回填)。
 *
 * 统计口径的在跑多看一眼登录(ADR-0027 决策 13);作品入口的闸与女仆查直播用 `SourceStatusReader`
 * (在册即在跑),运行状态读口归第 4 期(对拍 N15)。统计口径的「在跑」只住在这里、不开口给别处。
 *
 * **「在跑」的算法**:订阅的来源在登记表里 ∧(来源没有登录口,或登录口现读是 `logged-in`)。
 * `confirming`(开机还没确认上、或已扫等手机确认)不算登录,统计不记。登记表里没有的键一律不记 ——
 * 拓展订阅今天不在登记表里,由拓展适配(`extension-source.ts`)按上报记,不能被核心多记。
 * 两格开关(`recordsPosts` / `recordsLive`)已在装配处算好、含「启用」,这里不认配置。
 *
 * 边界:3b-42 把拓展来源登进登记表之后,没有登录口的拓展会被这里当成「在册即在跑」,与
 * 「拓展没连上不算在跑」不一致,3b-42 要定拓展来源的在跑怎么算。
 */
export interface RegistryStatsSourceOptions {
	bus: MessageBus;
	sources: Pick<SourceRegistry, "get">;
	forgetOpenSessions: (sourceKey: string) => void;
	/** 记「这个小时在记」。总开关关着时由记录器核心自己挡,这里不重复判。 */
	recorder: Pick<StatsRecorderCore, "recordActive">;
	/** 当前全部订阅。现取。 */
	subscriptions: () => readonly StatsSubscription[];
}

/**
 * 看一眼登记表、给在记的订阅记当前小时的间隔:1 分钟(一小时里看几十次,漏几次也不丢整点)。
 *
 * 为什么是定时看、而不是等信号:来源登记那一刻没有任何信号告诉统计(`subscription-auth-changed`
 * 登记时不补发),所以开机后来源登进登记表,最多要等下一轮定时才记上。主人 10-24 定缩到 1 分钟、
 * 不给登记表开 `onChange`。
 */
export const RECORDING_CHECK_MS = 60_000;

export function attachRegistryStatsSource(opts: RegistryStatsSourceOptions): Disposable {
	/** 这个小时的账:在册且(没有登录口或已登录)的来源,给它名下每条订阅按两格开关记 `posts` / `live`。 */
	const tick = () => {
		for (const sub of opts.subscriptions()) {
			const view = opts.sources.get(sub.identity.sourceKey);
			if (!view) continue;
			if (view.auth && !isLoggedIn(view.auth.state())) continue;
			const key = statsFileKey(sub);
			if (sub.recordsPosts) opts.recorder.recordActive(key, "posts");
			if (sub.recordsLive) opts.recorder.recordActive(key, "live");
		}
	};
	const timer = setInterval(tick, RECORDING_CHECK_MS);
	timer.unref?.();
	// 挂上时看一眼:记录器建在运行时里,那会儿登记表还空(来源要等数据那一代就位才登记,ADR-0022 决策 2 ——
	// 建运行时那会儿不许碰盘),所以这一下什么都不写;来源登记之后由定时或登录事件记上。
	tick();

	const handle = opts.bus.on("subscription-auth-changed", ({ sourceKey }) => {
		// 事件只当扳机:状态现读。已登录的立刻补记一次,不等下一轮定时。
		tick();
		const auth = opts.sources.get(sourceKey)?.auth;
		if (!auth) return;
		const { status } = auth.state();
		if (status !== "expired" && status !== "logged-out") return;

		// 来源不在跑了 = 没人在观测它的直播。B 站这边的由来:cookie 失效 → B 站来源把所有 listener
		// 拆掉,但**不发 idle**
		// (disposeAll 只 cancel,发 idle 的只有 stopForUid)。从这一刻起 B 站这头没有任何人在
		// 观测直播,在飞的场次不再作数 —— 留着的话,重新登录后(可能隔了几天)开的新一场
		// 会被旧场接住,两场并成一场超长直播。
		//
		// 不在这里补 end 帧:真实下播时刻我们无从得知,补一个假的比留空更糟。只忘掉中立监听
		// 手里的这一场,之后引擎再发它的 end 也不写;登录恢复后再观测到同一开播时刻时按状态再认出。
		opts.forgetOpenSessions(sourceKey);
	});
	return {
		dispose() {
			clearInterval(timer);
			handle.dispose();
		},
	};
}
