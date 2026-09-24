import { isBiliSubscription, type Subscription } from "@bilibili-notify/internal";
import type { PushSendInfo } from "@bilibili-notify/push";
import type { HistoryRecordInput } from "../history/store.js";

export interface PushHistoryLookups {
	/**
	 * 订阅 id → 订阅本身与当时的名字 / 头像(SubRuntimeStore 的 cachedProfile)。
	 * 查不到 = 推送中途被退订。一次查完:订阅表是线性扫的,两个回调就要扫两遍。
	 */
	subscriptionOf(
		subscriptionId: string,
	): { subscription: Subscription; profile?: { name?: string; avatar?: string } } | undefined;
}

/**
 * `BilibiliPush.onSend` 的一次回调 → 历史仓的一次 `record`。
 *
 * 推送层只知道订阅 id / feature / 目标 / 消息与结果;历史行还要「替谁发的」、推送类型、以及 UP
 * 当时的名字头像快照(订阅以后被删,面板上仍显示得出「当时是谁」)。无目标那次照记
 * (target: null),附加项的 role 与逐条结果原样带过去。查不到订阅就不记 —— 那条推送
 * 发起时订阅还在,落地时已经被删了,历史里挂在谁名下都不对。
 *
 * 「替谁发的」分两支(ADR-0019 决策 73):B 站行记 uid;拓展行记拓展 id + 外部 id、不记 uid ——
 * 外部 id 恰好等于某个 B 站 uid 时,记进 uid 就会在订阅删掉之后被认成那位 B 站 UP。拓展行只存
 * 名字快照、不存头像快照(决策 74):它的头像是面板里的相对地址,订阅一删文件就没了。
 *
 * 拓展行的名字快照走决策 77 的名字链(少了事件里的作者名那一层,这里拿不到):资料里的名字 → 主人填的
 * 别名(订阅的 `name`)。拓展没报过资料时订阅上没有资料名字,不退到别名的话这一行就没有「当时是谁」。
 * `notes` 是自由文字,不当名字用。B 站行照旧只认资料里的名字。
 */
export function historyRecordFromSend(
	info: PushSendInfo,
	lookups: PushHistoryLookups,
): HistoryRecordInput | null {
	const found = lookups.subscriptionOf(info.subscriptionId);
	if (found === undefined) return null;
	const { subscription, profile } = found;
	const who = isBiliSubscription(subscription)
		? { uid: subscription.uid, uavatarSnapshot: profile?.avatar }
		: { extensionId: subscription.extensionId, externalId: subscription.externalId };
	const unameSnapshot = isBiliSubscription(subscription)
		? profile?.name
		: (filled(profile?.name) ?? filled(subscription.name));
	return {
		pushId: info.pushId,
		kind: info.kind,
		...who,
		subscriptionId: info.subscriptionId,
		target: info.target?.id ?? null,
		// 推送层那条消息与历史那条消息本就是同一个形状(payload / role / 可选 result),
		// 逐条重建只是把字段抄一遍,还多一处「加字段记得同步」的维护点。
		messages: info.messages,
		unameSnapshot,
	};
}

/** 有字才算有:空串、只有空白的都不算。 */
function filled(text: string | undefined): string | undefined {
	return text !== undefined && text.trim() !== "" ? text : undefined;
}
