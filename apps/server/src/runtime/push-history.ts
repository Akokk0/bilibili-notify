import type { PushSendInfo } from "@bilibili-notify/push";
import type { HistoryRecordInput } from "../history/store.js";

export interface PushHistoryLookups {
	/** uid → 订阅 id;查不到 = 推送中途被退订。 */
	subscriptionIdOf(uid: string): string | undefined;
	/** uid → 当时的名字 / 头像(SubRuntimeStore 的 cachedProfile)。 */
	profileOf(uid: string): { name?: string; avatar?: string } | undefined;
}

/**
 * `BilibiliPush.onSend` 的一次回调 → 历史仓的一次 `record`。
 *
 * 推送层只知道 uid / feature / 目标 / 消息与结果;历史行还要订阅 id、推送类型、以及 UP
 * 当时的名字头像快照(订阅以后被删,面板上仍显示得出「当时是谁」)。无目标那次照记
 * (target: null),附加项的 role 与逐条结果原样带过去。查不到订阅就不记 —— 那条推送
 * 发起时订阅还在,落地时已经被删了,历史里挂在谁名下都不对。
 */
export function historyRecordFromSend(
	info: PushSendInfo,
	lookups: PushHistoryLookups,
): HistoryRecordInput | null {
	const subscriptionId = lookups.subscriptionIdOf(info.uid);
	if (subscriptionId === undefined) return null;
	const profile = lookups.profileOf(info.uid);
	return {
		pushId: info.pushId,
		kind: info.kind,
		uid: info.uid,
		subscriptionId,
		target: info.target?.id ?? null,
		messages: info.messages.map((m) =>
			"result" in m
				? { payload: m.payload, role: m.role, result: m.result }
				: { payload: m.payload, role: m.role },
		),
		unameSnapshot: profile?.name,
		uavatarSnapshot: profile?.avatar,
	};
}
