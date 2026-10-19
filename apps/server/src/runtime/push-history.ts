import { randomUUID } from "node:crypto";
import {
	type PostFilterReason,
	type Subscription,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import type { PushSendResult } from "@bilibili-notify/push";
import type { NewHistoryEntry } from "../history/store.js";
import { clip } from "../posts/post-text.js";
import { POST_SUMMARY_MAX_CHARS } from "../stats/post-entry-extras.js";

export interface PushHistoryReader {
	/**
	 * 订阅 id → 订阅本身与当时的名字 / 头像(SubRuntimeStore 的 cachedProfile:`avatar` 是存进图库的头像引用,
	 * `avatarUrl` 是它的来源地址)。查不到 = 推送中途被退订。一次查完:订阅表是线性扫的,两个回调就要扫两遍。
	 */
	subscriptionOf(subscriptionId: string):
		| {
				subscription: Subscription;
				profile?: { name?: string; avatar?: string; avatarUrl?: string };
		  }
		| undefined;
}

/**
 * `PushRouter.onSend` 的一次回调 → 历史仓的一次 `record`。
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
 * 快照」—— 那时头像是订阅一删就没的相对地址,现在是历史行自己引用着的图库里的图):两支订阅的行都抄资料里的 `avatar`
 * (历史仓写行前先续期);B 站头像抓进图库后(3a-35)B 站行也有,资料里还没有 `avatar` 的行缺这一格。
 *
 * 拓展行的名字快照走决策 77 的名字链(少了事件里的作者名那一层,这里拿不到):资料里的名字 → 主人填的
 * 别名(订阅的 `name`)。拓展没报过资料时订阅上没有资料名字,不退到别名的话这一行就没有「当时是谁」。
 * `notes` 是自由文字,不当名字用。B 站行照旧只认资料里的名字。
 */
export function historyRecordFromSend(
	info: PushSendResult,
	lookups: PushHistoryReader,
): NewHistoryEntry | null {
	const row = rowIdentityOf(info.subscriptionId, lookups);
	if (row === null) return null;
	return {
		pushId: info.pushId,
		feature: info.feature,
		identity: row.identity,
		subscriptionId: info.subscriptionId,
		targetId: info.target?.id ?? null,
		// 推送层那条消息与历史那条消息本就是同一个形状(payload / role / 可选 result),
		// 逐条重建只是把字段抄一遍,还多一处「加字段记得同步」的维护点。
		messages: info.messages,
		nameSnapshot: row.nameSnapshot,
		...(row.avatarSnapshot ? { avatarSnapshot: row.avatarSnapshot } : {}),
	};
}

/**
 * 一条被过滤挡下的作品 → 历史仓的一次 `record`(ADR-0021 决策 34 的 🔗「被过滤的作品也留痕」)。
 *
 * **一条订阅一行**:目标那一格空着(过滤是订阅的规则挡下的,按目标拆没有信息量),行上 `filteredBy` 记原因,
 * 历史仓据此把状态算成 `filtered`。它不是推送,所以有自己的 `pushId`(只给这一行用)、特性恒为作品。
 * 行里一条文字:摘要 + 换行 + 原帖地址;没有地址就只有摘要。「替谁」与名字 / 头像快照的取法同上面那一支,
 * 查不到订阅同样不记。
 *
 * `text` 是整条文字(`postText(post, "plain")`,来源那头交来的、没截过),摘要在这儿截:B 站动态与拓展作品
 * 两条路都经这一处,截法只有一份(`clip`,与统计那边的作品摘要同一个函数、同一个上限)。
 */
export function historyRecordFromFilteredPost(
	filtered: { subscriptionId: string; filteredBy: PostFilterReason; text: string; url?: string },
	lookups: PushHistoryReader,
): NewHistoryEntry | null {
	const row = rowIdentityOf(filtered.subscriptionId, lookups);
	if (row === null) return null;
	const summary = filled(filtered.text) ? clip(filtered.text, POST_SUMMARY_MAX_CHARS) : undefined;
	const text = [summary, filled(filtered.url)].filter((part) => part !== undefined).join("\n");
	return {
		pushId: randomUUID(),
		feature: "post",
		identity: row.identity,
		subscriptionId: filtered.subscriptionId,
		targetId: null,
		filteredBy: filtered.filteredBy,
		messages: [{ payload: { kind: "text", text }, role: "main" }],
		nameSnapshot: row.nameSnapshot,
		...(row.avatarSnapshot ? { avatarSnapshot: row.avatarSnapshot } : {}),
	};
}

/** 一行历史「替谁」那几格:订阅的身份、当时的名字与头像快照。查不到订阅回 null。两种行同一种取法。 */
function rowIdentityOf(
	subscriptionId: string,
	lookups: PushHistoryReader,
): Pick<NewHistoryEntry, "identity" | "nameSnapshot" | "avatarSnapshot"> | null {
	const found = lookups.subscriptionOf(subscriptionId);
	if (found === undefined) return null;
	const { subscription, profile } = found;
	const identity = subscriptionIdentityOf(subscription);
	return {
		identity,
		nameSnapshot: filled(profile?.name),
		...(profile?.avatar ? { avatarSnapshot: profile.avatar } : {}),
	};
}

/** 有字才算有:空串、只有空白的都不算。 */
function filled(text: string | undefined): string | undefined {
	return text !== undefined && text.trim() !== "" ? text : undefined;
}
