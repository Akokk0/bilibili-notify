import { z } from "zod";

export const HistorySourceSchema = z.enum([
	"dynamic",
	"live",
	"sc",
	"guard",
	"special-danmaku",
	"special-enter",
	"live-summary",
]);
export type HistorySource = z.infer<typeof HistorySourceSchema>;

export const HistoryPayloadSchema = z.object({
	kind: z.enum(["text", "image", "composite"]),
	text: z.string().optional(),
	/** 图片相对引用，存放于 `<dataDir>/history/img/<imageRef>`；独立端展示时直接读 */
	imageRef: z.string().optional(),
});
export type HistoryPayload = z.infer<typeof HistoryPayloadSchema>;

/** 单 PushTarget 的发送结果。 */
export const HistoryDeliverySchema = z.object({
	targetId: z.uuid(),
	ok: z.boolean(),
	err: z.string().optional(),
	latencyMs: z.number().nonnegative(),
});
export type HistoryDelivery = z.infer<typeof HistoryDeliverySchema>;

export const HistoryEntrySchema = z.object({
	id: z.uuid(),
	ts: z.string(),
	source: HistorySourceSchema,
	uid: z.string(),
	subscriptionId: z.uuid(),
	targetIds: z.array(z.uuid()),
	result: z.object({
		ok: z.boolean(),
		per: z.array(HistoryDeliverySchema),
	}),
	payload: HistoryPayloadSchema,
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
