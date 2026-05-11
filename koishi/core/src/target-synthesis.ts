import { randomUUID } from "node:crypto";
import type { PushAdapter, PushTarget } from "@bilibili-notify/internal";

/**
 * Synthesize a `koishi-bot` PushAdapter for a given `(botPlatform, selfId?)`
 * pair. The koishi shell stores these in {@link TargetRegistry} so the
 * standalone-side ConfigStore isn't needed.
 */
export function synthesizeKoishiBotAdapter(botPlatform: string, selfId?: string): PushAdapter {
	return {
		id: randomUUID(),
		name: selfId ? `${botPlatform}:${selfId}` : botPlatform,
		enabled: true,
		platform: "koishi-bot",
		config: {
			botPlatform,
			selfId,
		},
	};
}

/**
 * Synthesize a `koishi-bot` PushTarget bound to `adapter` for a group channel.
 */
export function synthesizeTargetsForFlatSub(adapter: PushAdapter, channelId: string): PushTarget {
	if (adapter.platform !== "koishi-bot") {
		throw new Error(`synthesizeTargetsForFlatSub requires a koishi-bot adapter`);
	}
	return {
		id: randomUUID(),
		name: `${adapter.config.botPlatform}:${channelId}`,
		adapterId: adapter.id,
		platform: "koishi-bot",
		scope: "group",
		enabled: true,
		session: { channelId },
	};
}

/**
 * Synthesize a `koishi-bot` PushTarget for the master account (private message).
 */
export function synthesizeMasterTarget(
	adapter: PushAdapter,
	userId: string,
	guildId?: string,
): PushTarget {
	if (adapter.platform !== "koishi-bot") {
		throw new Error(`synthesizeMasterTarget requires a koishi-bot adapter`);
	}
	return {
		id: randomUUID(),
		name: `master:${adapter.config.botPlatform}:${userId}`,
		adapterId: adapter.id,
		platform: "koishi-bot",
		scope: "private",
		enabled: true,
		session: { userId, guildId },
	};
}
