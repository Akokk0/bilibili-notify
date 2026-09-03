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
	type INBOUND_CAPABLE_PLATFORMS,
	LINK_LIMITS,
	type LinkLimits,
	type LinkParsingConfig,
	type Logger,
	type NotificationPayload,
	type VideoLinkRef,
	videoLinkKey,
} from "@bilibili-notify/internal";
import { extractGroupMessage, type InboundGroupMessage } from "./inbound-message.js";
import { videoToDynamic } from "./video-card.js";

/** 一条消息里最多解析几个链接 —— 再多就是刷屏了,也没人真需要。 */
const MAX_LINKS_PER_MESSAGE = 3;

const BUDGET_WINDOW_MS = 60_000;

/**
 * 有容量上限的「最近碰过」表。Map 按插入序遍历,每次 set 先 delete 再 set,最久没碰的永远
 * 在最前 —— 满了就丢它。容量是上限不是触发点:满了照样能装,只是装一个丢一个。
 */
class RecencyTable<V> {
	private readonly map = new Map<string, V>();
	constructor(private readonly cap: number) {}
	get(key: string): V | undefined {
		return this.map.get(key);
	}
	set(key: string, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.cap) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
	}
}

/**
 * 链接从哪个平台来 —— 就是「我们真的收得到入站消息」的那批平台,别另立一份名单:
 * 加第三个平台时只改一处的话,它能审批却解析不了群链接,而且哪儿都不报错。
 */
export type LinkSourcePlatform = (typeof INBOUND_CAPABLE_PLATFORMS)[number];

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
	/** 硬上限,缺省 {@link LINK_LIMITS};测试用小数字把边界拉到眼前。 */
	limits?: Partial<LinkLimits>;
}

export interface LinkParser {
	/** 喂一帧 OneBot 事件。不是群消息就静默返回,是则交给 {@link handleMessage}。 */
	handle(frame: Record<string, unknown>, meta: { adapterId: string }): Promise<void>;
	/** 喂一条**已经解析好**的群消息。功能关着、没有链接、自己发的,都静默返回;**永不抛**。 */
	handleMessage(msg: InboundLinkMessage): Promise<void>;
}

/** `renderer()` 交出来的那个东西 —— 取一次传下去,一次处理里不重复现取。 */
type Renderer = NonNullable<ReturnType<LinkParserOptions["renderer"]>>;

export function createLinkParser(opts: LinkParserOptions): LinkParser {
	const now = opts.now ?? (() => Date.now());
	const limits: LinkLimits = { ...LINK_LIMITS, ...opts.limits };
	/** `平台:adapterId:群:视频` → 上次开始处理的时刻。冷却关着(0)时不碰它。 */
	const lastSeen = new RecencyTable<number>(limits.tableCap);
	/** `平台:adapterId:群` → 最近一分钟里开始处理的时刻。 */
	const groupStarts = new RecencyTable<number[]>(limits.tableCap);
	/** 全局正在处理(取信息 / 渲染 / 发送)的链接数。 */
	let inflight = 0;

	const coolingDown = (key: string, cooldownMs: number): boolean => {
		if (cooldownMs <= 0) return false;
		const prev = lastSeen.get(key);
		return prev !== undefined && now() - prev < cooldownMs;
	};
	const markCooldown = (key: string, cooldownMs: number): void => {
		if (cooldownMs > 0) lastSeen.set(key, now());
	};
	const groupExhausted = (scope: string): boolean => {
		const t = now();
		const recent = (groupStarts.get(scope) ?? []).filter((ts) => t - ts < BUDGET_WINDOW_MS);
		groupStarts.set(scope, recent);
		return recent.length >= limits.groupPerMinute;
	};
	const recordGroupStart = (scope: string): void => {
		groupStarts.set(scope, [...(groupStarts.get(scope) ?? []), now()]);
	};

	/** 冷却键里的「视频」段:直链按视频号;短链先按短链本身,解出视频号后再按视频号补一道。 */
	const videoKey = (ref: VideoRef): string => ("bvid" in ref ? ref.bvid : `av${ref.aid}`);

	/** 已经带着视频号的那两种直接成形;短链还没解,给不出。 */
	const directRef = (ref: VideoLinkRef): VideoRef | null =>
		ref.kind === "bvid" ? { bvid: ref.bvid } : ref.kind === "aid" ? { aid: ref.aid } : null;

	async function toVideoRef(ref: VideoLinkRef): Promise<VideoRef | null> {
		if (ref.kind !== "short") return directRef(ref);
		const target = await opts.api.resolveShortLink(ref.url);
		if (!target) return null;
		const [resolved] = extractVideoLinks(target);
		return resolved ? directRef(resolved) : null;
	}

	async function replyWithCard(renderer: Renderer, dest: LinkReplyDestination, ref: VideoRef) {
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
			// 闸门按代价从低到高排:群里每一句话都进这儿(官机开着「全部消息」时尤其如此),
			// 先用一个正则把没链接的放走,再读配置(整份深拷贝)、再看有没有渲染器;网络与
			// 冷却留到每个链接自己那一轮。
			// 自己发的消息不解析 —— 机器人自己发的东西里若有链接,那是它自己贴的。
			if (msg.selfId !== undefined && msg.userId === msg.selfId) return;
			const refs = extractVideoLinks(msg.text).slice(0, MAX_LINKS_PER_MESSAGE);
			if (refs.length === 0) return;
			const config = opts.config();
			if (!config.enabled) return;
			const renderer = opts.renderer();
			if (!renderer) return;
			const dest: LinkReplyDestination = {
				platform: msg.platform,
				adapterId: msg.adapterId,
				groupId: msg.groupId,
			};
			const scope = `${msg.platform}:${msg.adapterId}:${msg.groupId}`;
			const cooldownMs = config.cooldownSeconds * 1000;
			for (const linkRef of refs) {
				try {
					// 三道闸先看不动手,都过了才一起记账:在冷却里的链接不该吃群额度,因为忙而放弃的
					// 链接也不该被记成「处理过」—— 那样它再贴一次就要等整个冷却。
					const rawKey = `${scope}:${videoLinkKey(linkRef)}`;
					if (coolingDown(rawKey, cooldownMs)) continue;
					if (inflight >= limits.maxInflight) {
						opts.logger.debug(
							`[link] 同时在处理的链接卡已满(${limits.maxInflight}),放弃 group=${msg.groupId}`,
						);
						break;
					}
					if (groupExhausted(scope)) {
						opts.logger.debug(
							`[link] 群一分钟额度已用完(${limits.groupPerMinute}),放弃 group=${msg.groupId}`,
						);
						break;
					}
					// 冷却从**开始处理**起算,不是发出去才算:一条坏链接被反复贴,不该每次都去打
					// 接口 —— 短链的那一跳也是接口,所以短链先按它自己吃一道,解出视频号后再按
					// 视频号吃一道(短链与直链指着同一个视频时只出一张)。
					markCooldown(rawKey, cooldownMs);
					recordGroupStart(scope);
					inflight++;
					try {
						const ref = await toVideoRef(linkRef);
						if (!ref) continue;
						if (linkRef.kind === "short") {
							const vKey = `${scope}:${videoKey(ref)}`;
							if (coolingDown(vKey, cooldownMs)) continue;
							markCooldown(vKey, cooldownMs);
						}
						await replyWithCard(renderer, dest, ref);
					} finally {
						inflight--;
					}
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
			// 帧再怪也不能让这个被 void 掉的 promise 变成 rejection —— 独立端装了 unhandledRejection
			// 处理器,那会变成一次进程退出。所以连拆帧这一步也裹起来,不只裹 handleMessage。
			let msg: InboundGroupMessage | null;
			try {
				msg = extractGroupMessage(frame);
			} catch (e) {
				opts.logger.error(`[link] 拆入站帧失败: ${String(e)}`);
				return;
			}
			if (!msg) return;
			await handleMessage({ platform: "onebot", adapterId: meta.adapterId, ...msg });
		},
		handleMessage,
	};
}
