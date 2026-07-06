import { deterministicUuid, type PushAdapter, type PushTarget } from "@bilibili-notify/internal";

/**
 * Synthesize a `koishi-bot` PushAdapter for a given `(botPlatform, selfId?)`
 * pair. The koishi shell stores these in {@link TargetRegistry} so the
 * standalone-side ConfigStore isn't needed.
 *
 * id 用 `deterministicUuid("adapter:koishi-bot:<platform>[:<selfId>]")`,保证 reload
 * 跨次稳定;history / 持久化引用了 adapter id 时不会变成孤儿。
 */
export function synthesizeKoishiBotAdapter(botPlatform: string, selfId?: string): PushAdapter {
	// 去首尾空格:平台名要 byte 级匹配 koishi bot.platform,用户配置里误带的空格会让
	// 匹配永远失败(master「目标不可达」的隐性诱因之一)。selfId 同理。
	botPlatform = botPlatform.trim();
	selfId = selfId?.trim();
	const seed = selfId
		? `adapter:koishi-bot:${botPlatform}:${selfId}`
		: `adapter:koishi-bot:${botPlatform}`;
	return {
		id: deterministicUuid(seed),
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
 *
 * id 用 `deterministicUuid("target:<adapterId>:<channelId>")`,保证 reload 稳定。
 */
export function synthesizeTargetsForFlatSub(adapter: PushAdapter, channelId: string): PushTarget {
	if (adapter.platform !== "koishi-bot") {
		throw new Error(`synthesizeTargetsForFlatSub requires a koishi-bot adapter`);
	}
	channelId = channelId.trim();
	return {
		id: deterministicUuid(`target:${adapter.id}:${channelId}`),
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
 *
 * id 用 `deterministicUuid("target:master:<adapterId>:<userId>[:<guildId>]")`,
 * reload 稳定。
 */
export function synthesizeMasterTarget(
	adapter: PushAdapter,
	userId: string,
	guildId?: string,
): PushTarget {
	if (adapter.platform !== "koishi-bot") {
		throw new Error(`synthesizeMasterTarget requires a koishi-bot adapter`);
	}
	userId = userId.trim();
	guildId = guildId?.trim() || undefined;
	const seed = guildId
		? `target:master:${adapter.id}:${userId}:${guildId}`
		: `target:master:${adapter.id}:${userId}`;
	return {
		id: deterministicUuid(seed),
		name: `master:${adapter.config.botPlatform}:${userId}`,
		adapterId: adapter.id,
		platform: "koishi-bot",
		scope: "private",
		enabled: true,
		session: { userId, guildId },
	};
}
