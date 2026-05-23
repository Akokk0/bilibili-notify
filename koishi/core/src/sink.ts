import type {
	DeliveryResult,
	KoishiBotAdapterConfig,
	KoishiBotSession,
	NotificationPayload,
	NotificationSink,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { Context } from "koishi";
import { type Bot, h, Universal } from "koishi";

/** Factory for creating the Koishi-side NotificationSink. */
export interface KoishiSinkOptions {
	ctx: Context;
	/** Function to resolve a PushTarget by id. */
	resolveTarget: (id: string) => PushTarget | undefined;
	/** Function to resolve a PushAdapter by id. */
	resolveAdapter: (id: string) => PushAdapter | undefined;
}

/**
 * Translates a platform-neutral NotificationPayload into koishi h(...) elements
 * and delivers them via bot.sendMessage / bot.sendPrivateMessage.
 *
 * Only handles `koishi-bot` platform. The bound adapter carries
 * `{ botPlatform, selfId? }` which selects a koishi `ctx.bots[*]` entry; the
 * target's session carries the actual `{ channelId, guildId, userId }`.
 *
 * Scope mapping:
 *   - "group"   → bot.sendMessage(channelId, content, guildId?)
 *   - "channel" → bot.sendMessage(channelId, content, guildId?)
 *   - "private" → bot.sendPrivateMessage(userId, content, guildId?)
 */
export function createKoishiSink(opts: KoishiSinkOptions): NotificationSink {
	const { ctx, resolveTarget, resolveAdapter } = opts;

	function getBot(botPlatform: string, selfId?: string): Bot | undefined {
		return ctx.bots.find(
			(b: Bot) => b.platform === botPlatform && (!selfId || selfId === "" || b.selfId === selfId),
		) as Bot | undefined;
	}

	function payloadToKoishi(payload: NotificationPayload): unknown {
		switch (payload.kind) {
			case "text":
				return h.text(payload.text);
			case "image": {
				const img = h.image(payload.image.buffer, payload.image.mime);
				if (payload.caption) {
					return h("message", [img, h.text(payload.caption)]);
				}
				return h("message", [img]);
			}
			case "composite": {
				const parts = payload.segments.map((seg) => {
					if (seg.type === "text") return h.text(seg.text);
					if (seg.type === "image") return h.image(seg.buffer, seg.mime);
					if (seg.type === "link") return h.text(seg.title ? `${seg.title} ${seg.href}` : seg.href);
					if (seg.type === "at-all") return h("at", { type: "all" });
					return h.text("");
				});
				return h("message", parts);
			}
			case "forward-images": {
				// 命名遗留:c3ee457 包成 forward 容器,但 NapCat 的长消息通道经常超时
				// 并阻塞后续 sendMsg。改为多 image 合并到一条普通 message,与 koishi
				// onebot adapter 默认行为一致(多图自然合并,不走 forward 容器)。
				return h(
					"message",
					payload.urls.map((url) => h.image(url)),
				);
			}
		}
	}

	async function deliver(
		targetId: string,
		payload: NotificationPayload,
		forcePrivate: boolean,
	): Promise<DeliveryResult> {
		const t0 = Date.now();

		const target = resolveTarget(targetId);
		if (!target) {
			return { ok: false, latencyMs: 0, err: `target ${targetId} not found` };
		}
		if (!target.enabled) {
			return { ok: false, latencyMs: 0, err: `target ${targetId} is disabled` };
		}
		if (target.platform !== "koishi-bot") {
			return {
				ok: false,
				latencyMs: 0,
				err: `unsupported platform ${target.platform} for KoishiSink`,
			};
		}

		const adapter = resolveAdapter(target.adapterId);
		if (!adapter || adapter.platform !== "koishi-bot") {
			return {
				ok: false,
				latencyMs: 0,
				err: `adapter ${target.adapterId} not found or wrong platform`,
			};
		}
		if (!adapter.enabled) {
			return { ok: false, latencyMs: 0, err: `adapter ${adapter.id} is disabled` };
		}

		const adapterCfg = adapter.config as KoishiBotAdapterConfig;
		const session = target.session as KoishiBotSession;
		const bot = getBot(adapterCfg.botPlatform, adapterCfg.selfId);

		if (!bot) {
			return {
				ok: false,
				latencyMs: 0,
				err: `no bot found for platform ${adapterCfg.botPlatform}`,
			};
		}

		if (bot.status !== Universal.Status.ONLINE) {
			return {
				ok: false,
				latencyMs: 0,
				err: `bot ${bot.selfId} is not online`,
			};
		}

		const content = payloadToKoishi(payload);
		const isPrivate = forcePrivate || target.scope === "private";

		try {
			if (isPrivate) {
				if (!session.userId) {
					return { ok: false, latencyMs: 0, err: `private target ${targetId} missing userId` };
				}
				await bot.sendPrivateMessage(
					session.userId,
					content as Parameters<typeof bot.sendPrivateMessage>[1],
					session.guildId,
				);
			} else {
				if (!session.channelId) {
					return { ok: false, latencyMs: 0, err: `group target ${targetId} missing channelId` };
				}
				await bot.sendMessage(
					session.channelId,
					content as Parameters<typeof bot.sendMessage>[1],
					session.guildId,
				);
			}
			return { ok: true, latencyMs: Date.now() - t0 };
		} catch (e) {
			const err = e instanceof Error ? e.message : String(e);
			return { ok: false, latencyMs: Date.now() - t0, err };
		}
	}

	return {
		send(targetId, payload) {
			return deliver(targetId, payload, false);
		},
		sendPrivate(targetId, payload) {
			return deliver(targetId, payload, true);
		},
		resolve(targetId) {
			return resolveTarget(targetId);
		},
		isAvailable(targetId) {
			const target = resolveTarget(targetId);
			if (!target?.enabled || target.platform !== "koishi-bot") return false;
			const adapter = resolveAdapter(target.adapterId);
			if (!adapter || adapter.platform !== "koishi-bot" || !adapter.enabled) return false;
			const cfg = adapter.config as KoishiBotAdapterConfig;
			const bot = getBot(cfg.botPlatform, cfg.selfId);
			return bot?.status === Universal.Status.ONLINE;
		},
	};
}
