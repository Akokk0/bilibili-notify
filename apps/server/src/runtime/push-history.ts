import {
	BILIBILI_SOURCE_KEY,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { PushSendInfo } from "@bilibili-notify/push";
import type { NewHistoryEntry } from "../history/store.js";

export interface PushHistoryLookups {
	/**
	 * 订阅 id → 订阅本身与当时的名字 / 头像(SubRuntimeStore 的 cachedProfile:`avatar` 是拓展订阅存进图库的头像引用,
	 * `avatarUrl` 是 B 站订阅的远端网址)。查不到 = 推送中途被退订。一次查完:订阅表是线性扫的,两个回调就要扫两遍。
	 */
	subscriptionOf(subscriptionId: string):
		| {
				subscription: Subscription;
				profile?: { name?: string; avatar?: string; avatarUrl?: string };
		  }
		| undefined;
}

/**
 * `BilibiliPush.onSend` 的一次回调 → 历史仓的一次 `record`。
 *
 * 推送层只知道订阅 id / feature / 目标 / 消息与结果;历史行还要「替谁发的」、以及 UP
 * 当时的名字头像快照(订阅以后被删,面板上仍显示得出「当时是谁」)。无目标那次照记
 * (target: null),附加项的 role 与逐条结果原样带过去。查不到订阅就不记 —— 那条推送
 * 发起时订阅还在,落地时已经被删了,历史里挂在谁名下都不对。
 *
 * 「替谁发的」就是订阅的身份(`identity`:来源键 + 外部 id,B 站行与拓展行同一种形状):两格一起比,
 * 外部 id 恰好等于某个 B 站 uid 时,订阅删掉之后也不会被认成那位 B 站 UP(ADR-0019 决策 73)。
 *
 * 头像快照只装图库引用(ADR-0022 决策 9 下 10-04「⑳ 开片」的 🔗;⑳d 起取代 ADR-0019 决策 74 的「拓展行不存头像
 * 快照」—— 那时头像是订阅一删就没的相对地址,现在是历史行自己引用着的图库里的图):拓展行抄资料里的 `avatar`
 * (历史仓写行前先续期);**B 站行不带** —— 服务端不抓 B 站头像,抓图服务在 3a。
 *
 * 拓展行的名字快照走决策 77 的名字链(少了事件里的作者名那一层,这里拿不到):资料里的名字 → 主人填的
 * 别名(订阅的 `name`)。拓展没报过资料时订阅上没有资料名字,不退到别名的话这一行就没有「当时是谁」。
 * `notes` 是自由文字,不当名字用。B 站行照旧只认资料里的名字。
 */
export function historyRecordFromSend(
	info: PushSendInfo,
	lookups: PushHistoryLookups,
): NewHistoryEntry | null {
	const found = lookups.subscriptionOf(info.subscriptionId);
	if (found === undefined) return null;
	const { subscription, profile } = found;
	const identity = subscriptionIdentityOf(subscription);
	const fromBilibili = identity.sourceKey === BILIBILI_SOURCE_KEY;
	const nameSnapshot = fromBilibili ? profile?.name : filled(profile?.name);
	return {
		pushId: info.pushId,
		feature: info.feature,
		identity,
		subscriptionId: info.subscriptionId,
		targetId: info.target?.id ?? null,
		// 推送层那条消息与历史那条消息本就是同一个形状(payload / role / 可选 result),
		// 逐条重建只是把字段抄一遍,还多一处「加字段记得同步」的维护点。
		messages: info.messages,
		nameSnapshot,
		...(!fromBilibili && profile?.avatar ? { avatarSnapshot: profile.avatar } : {}),
	};
}

/** 有字才算有:空串、只有空白的都不算。 */
function filled(text: string | undefined): string | undefined {
	return text !== undefined && text.trim() !== "" ? text : undefined;
}
