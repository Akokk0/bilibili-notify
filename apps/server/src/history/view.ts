import type { HistoryEntryView, HistoryRepushInfo } from "@bilibili-notify/contract";
import type { HistoryEntry } from "@bilibili-notify/internal";

/**
 * HistoryEntry → wire view。REST 列表与 WS 两个事件共用这一处投影 —— 面板上的行、
 * 小卡、时间线读的是同一个形状,不外泄 payload.kind / latency 这些内部字段。
 */
export function toHistoryView(
	entry: HistoryEntry,
	opts?: { repush?: HistoryRepushInfo },
): HistoryEntryView {
	return {
		...(opts && "repush" in opts ? { repush: opts.repush } : {}),
		id: entry.id,
		pushId: entry.pushId,
		createdAt: entry.createdAt,
		feature: entry.feature,
		status: entry.status,
		identity: entry.identity,
		subscriptionId: entry.subscriptionId,
		targetId: entry.targetId,
		messages: entry.messages.map((m) => ({
			text: m.payload.text,
			imageRef: m.payload.imageRef,
			role: m.role,
			...(m.repushOf !== undefined ? { repushOf: m.repushOf } : {}),
			...(m.result ? { ok: m.result.ok, err: m.result.err } : {}),
		})),
		nameSnapshot: entry.nameSnapshot,
		uavatarSnapshot: entry.uavatarSnapshot,
	};
}
