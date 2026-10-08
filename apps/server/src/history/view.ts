import type { HistoryEntryView, HistoryRepushInfo } from "@bilibili-notify/contract";
import type { HistoryEntry, HistoryMessageResult } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { originalCount, unsentIndices } from "./repush.js";

/**
 * HistoryEntry → wire view。REST 列表与 WS 两个事件共用这一处投影 —— 面板上的行、
 * 小卡、时间线读的是同一个形状,不外泄 latency 这些内部字段。投递结果铺平在消息上(没送达带码与原话)。消息的 `kind` 是例外:过了保留期的老行图格被迁移
 * 拿掉后,面板要靠它知道「这条本来是图」才写得出「图已清理」。
 *
 * `repush`(能不能补)在这儿给的是**不查盘的那一半**(见 `repushOffer`):WS 推来的行就带这个;
 * 列表路由在它上面再问一次真的预检,不能补的换成带原因的那一支。
 */
export function toHistoryView(
	entry: HistoryEntry,
	opts?: {
		/** 图与重推原件清到哪一天(历史仓的水位线);行的日子在它及以前就是过了保留期。 */
		clearedThrough?: string;
	},
): HistoryEntryView {
	const pastRetention =
		opts?.clearedThrough !== undefined && entry.createdAt.slice(0, 10) <= opts.clearedThrough;
	const repush = repushOffer(entry);
	return {
		...(repush ? { repush } : {}),
		...(pastRetention ? { isPastRetention: true } : {}),
		id: entry.id,
		pushId: entry.pushId,
		createdAt: entry.createdAt,
		feature: entry.feature,
		status: entry.status,
		...(entry.filteredBy !== undefined ? { filteredBy: entry.filteredBy } : {}),
		identity: entry.identity,
		subscriptionId: entry.subscriptionId,
		targetId: entry.targetId,
		messages: entry.messages.map((m) => ({
			text: m.payload.text,
			kind: m.payload.kind,
			image: m.payload.image,
			role: m.role,
			...(m.repushOf !== undefined ? { repushOf: m.repushOf } : {}),
			...(m.result ? resultView(m.result) : m.isSilenced ? { isSilenced: true as const } : {}),
		})),
		nameSnapshot: entry.nameSnapshot,
		avatarSnapshot: entry.avatarSnapshot,
	};
}

/**
 * 这一行有没有得补、补几条(ADR-0017 决策 6)—— **只看行自己**:有目标,且行里还有没送到的或
 * 被挡下的消息(`unsentIndices`,与补发闸、原件去留同一个函数)。没有就不带这一格,面板据此不画按钮。
 *
 * 不查盘、不看配置:原件还在不在、路由里还有没有这个目标、目标停没停用、是不是正在补,这里一概
 * 不知道,所以给的一律是「能补」。刚落的行(WS)这总是对的;列表路由对每一行另问 `canRepush`。
 */
function repushOffer(entry: HistoryEntry): HistoryRepushInfo | undefined {
	// 被过滤的行只留痕:那条消息没有结果、也没被挡,按「还差哪几条」数它是「没发」,可它压根不是
	// 推送、没有原件。按状态显式排除,不靠「它的目标那一格恰好也空着」。
	if (entry.status === "filtered") return undefined;
	// 无目标行的消息全都没发,可它没有目标可补。
	if (entry.targetId === null) return undefined;
	const missing = unsentIndices(entry.messages).length;
	if (missing === 0) return undefined;
	return { can: true, total: originalCount(entry.messages), missing };
}

/** 盘上的投递结果 → 线上那几格:送达只说 `ok`(耗时不过线),没送达带码、原话与平台自己的码。 */
function resultView(result: HistoryMessageResult) {
	if (result.ok) return ok();
	return fail(
		result.code,
		result.message,
		result.upstreamCode !== undefined ? { upstreamCode: result.upstreamCode } : {},
	);
}
