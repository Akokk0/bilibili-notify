import type {
	DeliveryResult,
	KoishiBotAdapterConfig,
	KoishiBotSession,
	NotificationPayload,
	NotificationSink,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { Context, Logger } from "koishi";
import { type Bot, h, Universal } from "koishi";
import { type BotLike, botResolutionWarning, resolveKoishiBot } from "./bot-resolve";

/** Factory for creating the Koishi-side NotificationSink. */
export interface KoishiSinkOptions {
	ctx: Context;
	/** Function to resolve a PushTarget by id. */
	resolveTarget: (id: string) => PushTarget | undefined;
	/** Function to resolve a PushAdapter by id. */
	resolveAdapter: (id: string) => PushAdapter | undefined;
	/** Logger — used to surface actionable platform-misconfig warnings (master 选错平台等)。 */
	logger: Logger;
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
	const { ctx, resolveTarget, resolveAdapter, logger } = opts;

	/** 同一 (reason, 配置平台, 在线平台集) 的告警只打一次,避免热路径(per-tick 可达性
	 * 探测 / per-retry)刷屏。sink 生命周期内有效;reload 新建 sink 自然重置。 */
	const warnedKeys = new Set<string>();

	/**
	 * 解析 target/adapter 对应的在线 koishi bot。精确匹配失败时按「唯一在线平台」
	 * 回退(消除 master 选错平台导致的「目标不可达」),并打一条可操作告警(去重)。
	 */
	function resolveBot(adapterCfg: KoishiBotAdapterConfig, label: string): Bot | undefined {
		const all = [...ctx.bots] as unknown as BotLike[];
		const res = resolveKoishiBot(
			all,
			{ botPlatform: adapterCfg.botPlatform, selfId: adapterCfg.selfId },
			Universal.Status.ONLINE,
		);
		const warning = botResolutionWarning(label, adapterCfg.botPlatform, res);
		if (warning) {
			const key = `${res.reason}:${adapterCfg.botPlatform}:${res.onlinePlatforms.join(",")}`;
			if (!warnedKeys.has(key)) {
				warnedKeys.add(key);
				logger.warn(warning);
			}
		}
		return res.bot as unknown as Bot | undefined;
	}

	/** 告警里用来标识 target 的人话标签:私聊目标即 master,其余用 target 名。 */
	function labelFor(target: PushTarget): string {
		return target.scope === "private" ? "master" : target.name;
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
				const images = payload.images.map((img) => h.image(img.url));
				// payload.forward 由 dynamic engine config 的 imageGroup.forward 决定:
				//   true  → 合并转发(koishi onebot adapter 看到 forward:true 调
				//           sendGroupForwardMsg → NapCat SsoSendLongMsg,部分部署不稳)
				//   false → 多张 image 合并到一条普通 message(send_group_msg 多 image,稳)
				if (payload.forward) {
					const nodes = images.map((img) => h("message", [img]));
					return h("message", { forward: true }, nodes);
				}
				return h("message", images);
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
		const bot = resolveBot(adapterCfg, labelFor(target));

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
			const bot = resolveBot(cfg, labelFor(target));
			return bot?.status === Universal.Status.ONLINE;
		},
	};
}
