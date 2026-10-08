import type { HistoryEntryView, HistoryRepushInfo } from "@bilibili-notify/contract";
import type { HistoryEntry, HistoryMessageResult } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";

/**
 * HistoryEntry → wire view。REST 列表与 WS 两个事件共用这一处投影 —— 面板上的行、
 * 小卡、时间线读的是同一个形状,不外泄 latency 这些内部字段。投递结果铺平在消息上(没送达带码与原话)。消息的 `kind` 是例外:过了保留期的老行图格被迁移
 * 拿掉后,面板要靠它知道「这条本来是图」才写得出「图已清理」。
 */
export function toHistoryView(
	entry: HistoryEntry,
	opts?: {
		repush?: HistoryRepushInfo;
		/** 图与重推原件清到哪一天(历史仓的水位线);行的日子在它及以前就是过了保留期。 */
		clearedThrough?: string;
	},
): HistoryEntryView {
	const pastRetention =
		opts?.clearedThrough !== undefined && entry.createdAt.slice(0, 10) <= opts.clearedThrough;
	return {
		...(opts && "repush" in opts ? { repush: opts.repush } : {}),
		...(pastRetention ? { isPastRetention: true } : {}),
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

/** 盘上的投递结果 → 线上那几格:送达只说 `ok`(耗时不过线),没送达带码、原话与平台自己的码。 */
function resultView(result: HistoryMessageResult) {
	if (result.ok) return ok();
	return fail(
		result.code,
		result.message,
		result.upstreamCode !== undefined ? { upstreamCode: result.upstreamCode } : {},
	);
}
