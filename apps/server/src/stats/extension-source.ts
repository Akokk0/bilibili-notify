import type { Disposable, MessageBus } from "@bilibili-notify/internal";
import { type StatsSubscription, statsFileKey } from "./file-key.js";
import { followersSampleGapMs } from "./followers-sample-gap.js";
import type { StatsRecorderCore } from "./recorder.js";

/**
 * 统计的**拓展适配**(ADR-0020 决策 17):把订阅源拓展的上报翻成记录器的中立调用,按 **订阅 id**
 * 记(决策 2 / 16)。平台的规矩只写在这里:
 *
 *   - **记谁**(决策 4):订阅在、启用着就记,**与推送开关无关** —— 统计记的是「UP 做了什么」。停用的不记,
 *     哪怕它的资料照样报上来(ADR-0019 决策 62:资料更新的投递含停用的订阅)。
 *   - 作品行不在这里:拓展作品经核心入口发 `post-detected`,B 站与拓展共用 `recorder.ts` 里的那一个监听
 *     (有没有视频、发布时刻、同一条报几次只留一行,都在那边与 store)。
 *   - 直播场次不在这里:所有来源都走中立监听(`live-source.ts`)的 `live-session-changed`。
 *   - 资料里的粉丝数 → 粉丝时序(决策 8),不密过资料刷新的间隔({@link followersSampleGapMs})。
 *   - 「来源在跑」= 这个小时收到过这条订阅的任何上报(ADR-0027 决策 2):按开关记当前小时的 `posts` /
 *     `live`;资料里带粉丝数(不管被不被稀释掉)记 `followers`。作品开关关着不落作品行;直播类开关都关着不开新场次。
 *   - 订阅删了 → 四份文件由记录器的中立监听删;停用的留着(决策 10)。
 */
export interface ExtensionStatsSourceOptions {
	bus: MessageBus;
	recorder: StatsRecorderCore;
	/** 当前全部订阅。按它判「这条拓展订阅还在、启用着」;订阅一变就重查。 */
	subscriptions: () => readonly StatsSubscription[];
	/** 资料刷新的 cron(`globals.profileRefreshCron`,现取)。 */
	profileRefreshCron: () => string;
}

export function attachExtensionStatsSource(opts: ExtensionStatsSourceOptions): Disposable {
	const { bus, recorder } = opts;
	const handles: Disposable[] = [];

	/**
	 * 订阅 id → 这条订阅(启用着没有、两格「在记」条件)。惰性建、订阅或设置一变就作废
	 * (开关是订阅覆盖合并全局默认之后的有效值,全局改了也要重算);查不到时重建一次(刚加的不必等作废通知)。
	 * 资料更新可能一口气报一百条,不能每条都重算一遍。
	 */
	let subById: Map<string, StatsSubscription> | undefined;
	const buildIndex = () => {
		const index = new Map<string, StatsSubscription>();
		for (const sub of opts.subscriptions()) {
			index.set(sub.id, sub);
		}
		return index;
	};
	const subOf = (id: string): StatsSubscription | undefined => {
		subById ??= buildIndex();
		if (!subById.has(id)) subById = buildIndex();
		return subById.get(id);
	};
	handles.push(
		bus.on("subscription-reported", (delivery) => {
			const { report } = delivery;
			for (const id of delivery.subscriptionIds) {
				const sub = subOf(id);
				if (sub?.enabled !== true) continue;
				const key = statsFileKey({ id });
				// 收到上报 = 来源这个小时在跑,按开关记。
				if (sub.recordsPosts) recorder.recordActive(key, "posts");
				if (sub.recordsLive) recorder.recordActive(key, "live");
				// 作品行不在这里:拓展作品经核心入口发 `post-detected`,由 `recorder.ts` 的监听记。
				switch (report.kind) {
					case "profile":
						if (report.value.fans !== undefined) {
							// 这个小时拉资料成功过(不管粉丝样本被不被稀释掉)。
							recorder.recordActive(key, "followers");
							recorder.recordReportedFollowers(
								key,
								report.value.fans,
								followersSampleGapMs(opts.profileRefreshCron()),
							);
						}
						break;
					// 直播那三种不在这里:场次与本场累计观看由中立的 `live-session-changed` 统一记。
				}
			}
		}),
	);

	// 开关是有效值,全局默认改了(`config-changed`)订阅清单里的两格也跟着变,别吃旧的。
	handles.push(bus.on("config-changed", () => (subById = undefined)));

	handles.push(
		bus.on("subscription-changed", () => {
			subById = undefined;
		}),
	);

	return {
		dispose() {
			for (const h of handles) h.dispose();
			handles.length = 0;
		},
	};
}
