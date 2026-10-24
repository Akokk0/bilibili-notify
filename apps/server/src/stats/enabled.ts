import type { Disposable, MessageBus, StatsSettings } from "@bilibili-notify/internal";

/**
 * 数据统计总开关(`stats.enabled`,ADR-0027 决策 9)的**缓存读口**。
 *
 * 设置每读一次是整份深拷贝,而观看人数约两秒一帧、粉丝样本与「在记」也密,不能每次现读。这里留一个布尔,
 * 核心设置变了(总线上 `config-changed` 的 `globals`)才作废,下一次读按新值 —— 改开关不用重启。
 * 记录器(装配处注入)与资料刷新共用同一个,两边对「现在开没开」没有第二份说法。
 */
export interface StatsEnabled extends Disposable {
	isEnabled(): boolean;
}

export function createStatsEnabled(opts: {
	bus: MessageBus;
	getGlobals: () => { stats: StatsSettings };
}): StatsEnabled {
	let cached: boolean | undefined;
	const subscription = opts.bus.on("config-changed", ({ scope }) => {
		if (scope === "globals") cached = undefined;
	});
	return {
		isEnabled() {
			cached ??= opts.getGlobals().stats.enabled;
			return cached;
		},
		dispose() {
			subscription.dispose();
		},
	};
}
