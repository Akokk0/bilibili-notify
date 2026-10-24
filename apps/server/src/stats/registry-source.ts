import type { Disposable, MessageBus } from "@bilibili-notify/internal";
import type { SourceRegistry } from "../subscriptions/registry.js";

/**
 * 统计的登记表适配:来源登录丢了就忘掉它在飞的直播场次。
 *
 * 统计口径的在跑多看一眼登录(ADR-0027 决策 13);作品入口的闸与女仆查直播用 `SourceStatusReader`
 * (在册即在跑),运行状态读口归第 4 期(对拍 N15)。
 */
export interface RegistryStatsSourceOptions {
	bus: MessageBus;
	sources: Pick<SourceRegistry, "get">;
	forgetOpenSessions: (sourceKey: string) => void;
}

export function attachRegistryStatsSource(opts: RegistryStatsSourceOptions): Disposable {
	return opts.bus.on("subscription-auth-changed", ({ sourceKey }) => {
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
}
