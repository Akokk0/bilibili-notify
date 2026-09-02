/**
 * 链接解析 —— 群里有人贴 B 站视频链接,机器人自动回一张视频卡片。
 *
 * 与指令分发器并列挂在 OneBot 入站帧上,但它**不是指令**:没有前缀、不认主人、
 * 群里谁贴都算。正因为谁都能触发,它默认关着、有冷却、失败不回话 —— 群里没人
 * 要求解析,失败了还回一句只是噪音,而且等于把「机器人在这个群里」广播出去。
 *
 * 回到来源群不走推送目标表:用收到这一帧的那个 adapter 直接发,群不必配成推送目标。
 *
 * 两个平台两个入口:OneBot 的原始帧走 {@link LinkParser.handle},官机网关已经解析好的群消息
 * 走 {@link LinkParser.handleMessage} —— 同一套闸门与流程,只有「怎么拿到文本」不同。
 */

import type { VideoInfo, VideoRef } from "@bilibili-notify/api";
import type { CardColorOptions, Dynamic } from "@bilibili-notify/image";
import {
	type CardBlock,
	type DeliveryResult,
	extractVideoLinks,
	type LinkParsingConfig,
	type Logger,
	type NotificationPayload,
	type VideoLinkRef,
} from "@bilibili-notify/internal";
import { extractGroupMessage } from "./inbound-message.js";
import { videoToDynamic } from "./video-card.js";

/** 一条消息里最多解析几个链接 —— 再多就是刷屏了,也没人真需要。 */
const MAX_LINKS_PER_MESSAGE = 3;
/** 冷却表膨胀到这个数就顺手清一次过期项。 */
const COOLDOWN_PRUNE_AT = 500;

export type LinkSourcePlatform = "onebot" | "qq-official";

/** 回复往哪儿发:平台决定用哪个适配器,`groupId` 在 OneBot 是群号、在官机是群 openid。 */
export interface LinkReplyDestination {
	platform: LinkSourcePlatform;
	adapterId: string;
	groupId: string;
}

/** 已经解析好的一条群消息 —— 平台差异到此为止。 */
export interface InboundLinkMessage {
	platform: LinkSourcePlatform;
	adapterId: string;
	groupId: string;
	userId: string;
	/** 收到这条消息的 bot 自己的号(OneBot 有);与 userId 相同就是自己发的,不解析。 */
	selfId?: string;
	text: string;
}

export interface LinkParserOptions {
	logger: Logger;
	/** 面板上那份配置。**现读**,不快照 —— 主人关掉立刻生效。 */
	config: () => LinkParsingConfig;
	api: {
		getVideoInfo(ref: VideoRef): Promise<VideoInfo>;
		resolveShortLink(url: string): Promise<string | null>;
	};
	/** 推送用的卡片渲染器;`null` = 没有 Chrome,整个功能静默不动。**每次现取**,别攥着。 */
	renderer: () => {
		generateDynamicCard(
			data: Dynamic,
			colors?: CardColorOptions,
			layout?: CardBlock[],
		): Promise<Buffer>;
	} | null;
	/**
	 * 全局默认的动态卡版式(`defaults.cardLayout.dynamic`),**现读**。推送的动态卡吃的是
	 * 它(per-UP 覆盖 ?? 全局),链接解析没有 UP 可言,就吃全局这份 —— 不传的话渲染器退回
	 * 出厂版式,主人在编辑器里排的顺序在这张卡上就丢了。
	 */
	layout: () => CardBlock[] | undefined;
	/** 往来源群发 —— 由接线层用收到这一帧的那个 adapter 实现。 */
	send: (dest: LinkReplyDestination, payload: NotificationPayload) => Promise<DeliveryResult>;
	now?: () => number;
}

export interface LinkParser {
	/** 喂一帧 OneBot 事件。不是群消息就静默返回,是则交给 {@link handleMessage}。 */
	handle(frame: Record<string, unknown>, meta: { adapterId: string }): Promise<void>;
	/** 喂一条**已经解析好**的群消息。功能关着、没有链接、自己发的,都静默返回;**永不抛**。 */
	handleMessage(msg: InboundLinkMessage): Promise<void>;
}

export function createLinkParser(opts: LinkParserOptions): LinkParser {
	const now = opts.now ?? (() => Date.now());
	/** `adapterId:groupId:视频` → 上次开始处理的时刻。 */
	const lastSeen = new Map<string, number>();

	function inCooldown(key: string, cooldownMs: number): boolean {
		const t = now();
		const prev = lastSeen.get(key);
		if (prev !== undefined && cooldownMs > 0 && t - prev < cooldownMs) return true;
		if (lastSeen.size >= COOLDOWN_PRUNE_AT) {
			for (const [k, v] of lastSeen) if (t - v >= cooldownMs) lastSeen.delete(k);
		}
		lastSeen.set(key, t);
		return false;
	}

	async function toVideoRef(ref: VideoLinkRef): Promise<VideoRef | null> {
		if (ref.kind === "bvid") return { bvid: ref.bvid };
		if (ref.kind === "aid") return { aid: ref.aid };
		const target = await opts.api.resolveShortLink(ref.url);
		if (!target) return null;
		const [resolved] = extractVideoLinks(target);
		if (!resolved || resolved.kind === "short") return null;
		return resolved.kind === "bvid" ? { bvid: resolved.bvid } : { aid: resolved.aid };
	}

	async function replyWithCard(dest: LinkReplyDestination, ref: VideoRef, cooldownMs: number) {
		const renderer = opts.renderer();
		if (!renderer) return;
		const key = `${dest.platform}:${dest.adapterId}:${dest.groupId}:${"bvid" in ref ? ref.bvid : `av${ref.aid}`}`;
		// 冷却从**开始处理**起算,不是发出去才算:一条坏链接被反复贴,不该每次都去打接口。
		if (inCooldown(key, cooldownMs)) return;
		const info = await opts.api.getVideoInfo(ref);
		const buffer = await renderer.generateDynamicCard(
			videoToDynamic(info),
			undefined,
			opts.layout(),
		);
		const result = await opts.send(dest, { kind: "image", image: { buffer, mime: "image/jpeg" } });
		if (!result.ok) {
			opts.logger.warn(`[link] 视频卡片发送失败 group=${dest.groupId} ${info.bvid}: ${result.err}`);
			return;
		}
		// 成功也留一行:群里没回话只有两种解释(没触发 / 发失败),日志得能分清。
		opts.logger.info(
			`[link] 已回复视频卡片 group=${dest.groupId} ${info.bvid}(${result.latencyMs}ms)`,
		);
	}

	async function handleMessage(msg: InboundLinkMessage): Promise<void> {
		try {
			const config = opts.config();
			if (!config.enabled) return;
			// 自己发的消息不解析 —— 机器人自己发的东西里若有链接,那是它自己贴的。
			if (msg.selfId !== undefined && msg.userId === msg.selfId) return;
			const refs = extractVideoLinks(msg.text).slice(0, MAX_LINKS_PER_MESSAGE);
			if (refs.length === 0) return;
			const dest: LinkReplyDestination = {
				platform: msg.platform,
				adapterId: msg.adapterId,
				groupId: msg.groupId,
			};
			const cooldownMs = config.cooldownSeconds * 1000;
			for (const linkRef of refs) {
				try {
					const ref = await toVideoRef(linkRef);
					if (!ref) continue;
					await replyWithCard(dest, ref, cooldownMs);
				} catch (e) {
					// 单个链接失败不回话、不影响同一条消息里的下一个。
					opts.logger.warn(`[link] 解析失败 group=${msg.groupId}: ${String(e)}`);
				}
			}
		} catch (e) {
			// 这是在入站回调里被调的,抛出去就是一个 unhandledRejection。
			opts.logger.error(`[link] 处理入站消息失败: ${String(e)}`);
		}
	}

	return {
		async handle(frame, meta) {
			const msg = extractGroupMessage(frame);
			if (!msg) return;
			await handleMessage({ platform: "onebot", adapterId: meta.adapterId, ...msg });
		},
		handleMessage,
	};
}
