import type {
	DeliveryResult,
	NotificationPayload,
	NotificationSink,
	PushTarget,
} from "@bilibili-notify/internal";
import type { SidecarEventQueue } from "./event-queue.js";
import { serializeNotificationPayload } from "./payload.js";

export const ASTRBOT_ADAPTER_ID = "11111111-1111-4111-8111-111111111112";
export const ASTRBOT_TARGET_ID = "11111111-1111-4111-8111-111111111111";

export const ASTRBOT_PUSH_TARGET: PushTarget = {
	id: ASTRBOT_TARGET_ID,
	name: "AstrBot",
	adapterId: ASTRBOT_ADAPTER_ID,
	platform: "koishi-bot",
	scope: "channel",
	enabled: true,
	session: {
		channelId: "astrbot",
	},
};

export interface CallbackSinkOptions {
	readonly events: SidecarEventQueue;
	readonly target?: PushTarget;
}

export function createCallbackSink(options: CallbackSinkOptions): NotificationSink {
	const target = options.target ?? ASTRBOT_PUSH_TARGET;

	const sendImpl = async (
		targetId: string,
		payload: NotificationPayload,
		privateMessage: boolean,
	): Promise<DeliveryResult> => {
		const startedAt = Date.now();
		if (targetId !== target.id || !target.enabled) {
			return {
				ok: false,
				latencyMs: Date.now() - startedAt,
				err: `target unavailable: ${targetId}`,
			};
		}
		const result: DeliveryResult = {
			ok: true,
			latencyMs: Date.now() - startedAt,
		};
		options.events.push({
			type: "notification",
			targetId,
			private: privateMessage,
			payload: serializeNotificationPayload(payload),
			result,
		});
		return result;
	};

	return {
		send: (targetId, payload) => sendImpl(targetId, payload, false),
		sendPrivate: (targetId, payload) => sendImpl(targetId, payload, true),
		resolve: (targetId) => (targetId === target.id ? target : undefined),
		isAvailable: (targetId) => targetId === target.id && target.enabled,
	};
}
