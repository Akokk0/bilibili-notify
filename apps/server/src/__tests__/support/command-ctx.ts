import { fail, type NotificationPayload, ok } from "@bilibili-notify/internal";
import type { CommandReplyHandler } from "../../runtime/command-dispatcher.js";

/**
 * 指令测试用的 `ctx`:`reply` 把文字回话记进 `texts`、其余载荷(图)记进 `payloads`,
 * 并回一个送达的结果。`ok: false` 时模拟「没送到」。
 */
export function recordingCtx(
	texts: string[],
	opts: { ok?: boolean; payloads?: NotificationPayload[] } = {},
): { reply: CommandReplyHandler } {
	return {
		reply: async (payload) => {
			if (typeof payload === "string") texts.push(payload);
			else if (payload.kind === "text") texts.push(payload.text);
			else opts.payloads?.push(payload);
			return opts.ok === false ? fail("unavailable", "测试里没送到") : ok({ latencyMs: 0 });
		},
	};
}
