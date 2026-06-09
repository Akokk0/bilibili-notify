import type {
	AstrBotAdapter,
	AstrBotPushTarget,
	DeliveryResult,
	NotificationPayload,
	NotificationSink,
} from "@bilibili-notify/internal";
import type { SidecarDeliveryQueue, SidecarEventQueue } from "./event-queue.js";
import { serializeNotificationPayload } from "./payload.js";

export const ASTRBOT_ADAPTER_ID = "11111111-1111-4111-8111-111111111112";
export const ASTRBOT_TARGET_ID = "11111111-1111-4111-8111-111111111111";
export const ASTRBOT_DEFAULT_UNIFIED_MSG_ORIGIN = "astrbot://default";

export const ASTRBOT_PUSH_ADAPTER: AstrBotAdapter = {
	id: ASTRBOT_ADAPTER_ID,
	name: "AstrBot",
	platform: "astrbot",
	enabled: true,
	config: {},
};

export const ASTRBOT_PUSH_TARGET: AstrBotPushTarget = {
	id: ASTRBOT_TARGET_ID,
	name: "AstrBot",
	adapterId: ASTRBOT_ADAPTER_ID,
	platform: "astrbot",
	scope: "channel",
	enabled: true,
	session: {
		unified_msg_origin: ASTRBOT_DEFAULT_UNIFIED_MSG_ORIGIN,
		platform: "astrbot",
		messageType: "channel",
		sessionName: "AstrBot",
	},
};

export interface CallbackSinkOptions {
	readonly events: SidecarEventQueue;
	readonly deliveries: SidecarDeliveryQueue;
	readonly target?: AstrBotPushTarget;
	readonly targets?: () => readonly AstrBotPushTarget[];
}

export function createCallbackSink(options: CallbackSinkOptions): NotificationSink {
	const resolveTarget = (targetId: string): AstrBotPushTarget | undefined => {
		// 不回退到隐藏 fallback target：真实 targets 为空时返回 undefined（不投递），
		// 避免隐藏的 ASTRBOT_PUSH_TARGET 经默认 sink 漏出真实投递（死代码与新设计相悖）。
		const targets = options.targets?.() ?? (options.target ? [options.target] : []);
		return targets.find((target) => target.id === targetId);
	};

	const sendImpl = async (
		targetId: string,
		payload: NotificationPayload,
		privateMessage: boolean,
	): Promise<DeliveryResult> => {
		const startedAt = Date.now();
		const target = resolveTarget(targetId);
		if (!target?.enabled) {
			return {
				ok: false,
				latencyMs: Date.now() - startedAt,
				err: `target unavailable: ${targetId}`,
			};
		}
		const serializablePayload = serializeNotificationPayload(payload);
		let job: ReturnType<SidecarDeliveryQueue["enqueue"]>;
		try {
			job = options.deliveries.enqueue({
				target,
				private: privateMessage,
				payload: serializablePayload,
			});
		} catch (error) {
			return {
				ok: false,
				latencyMs: Date.now() - startedAt,
				err: error instanceof Error ? error.message : String(error),
			};
		}
		const result: DeliveryResult = {
			ok: true,
			latencyMs: Date.now() - startedAt,
		};
		options.events.push({
			type: "notification",
			deliveryId: job.deliveryId,
			targetId,
			private: privateMessage,
			payload: serializablePayload,
			result,
		});
		return result;
	};

	return {
		send: (targetId, payload) => sendImpl(targetId, payload, false),
		sendPrivate: (targetId, payload) => sendImpl(targetId, payload, true),
		resolve: (targetId) => resolveTarget(targetId),
		isAvailable: (targetId) => Boolean(resolveTarget(targetId)?.enabled),
	};
}
