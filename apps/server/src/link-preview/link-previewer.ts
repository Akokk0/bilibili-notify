/**
 * 链接解析 —— 群里有人贴了某个集成的解析器认得的链接(今天是 B 站视频),机器人自动回一张卡片。
 * 门是平台中立的:通用网址正则挑候选、问在册解析器认不认、冷却限流、出卡回复;认哪些网址、
 * 怎么查都在各集成登记的解析器里。
 *
 * 与指令分发器并列挂在群消息上,但它**不是指令**:没有前缀、不认主人、群里谁贴都算。
 * 正因为谁都能触发,它默认关着、有冷却、失败不回话 —— 群里没人要求解析,失败了还回
 * 一句只是噪音,而且等于把「机器人在这个群里」广播出去。
 *
 * 回到来源群不走推送目标表:用收到这一帧的那条连接直接发,群不必配成推送目标。
 *
 * **只有一个入口** {@link LinkPreviewer.handleMessage}:进来的已经是 adapter 归一化好的群
 * 消息,平台的原始帧长什么样到这里已经不可见了 —— 桥后面那些平台我们连帧都没见过。
 */

import type { CardColorOptions, RenderPriority } from "@bilibili-notify/image";
import type { InboundGroupMessage } from "@bilibili-notify/internal";
import {
	type ConnectionCapabilities,
	type DeliveryResult,
	LINK_LIMITS,
	type LinkLimits,
	type LinkPreview,
	type LinkPreviewPolicy,
	type LinkPreviewSettings,
	type LinkResolver,
	type Logger,
	type NotificationPayload,
	type Post,
} from "@bilibili-notify/internal";
import { RecencyTable } from "../util/recency-table.js";
import { extractUrls } from "./extract-urls.js";
import { linkScopeKey } from "./link-scope.js";
import type { LinkResolverRegistry } from "./registry.js";

/**
 * 把正文与分享卡里的链接合成一串候选:`"nativeShare"` 的不收,其余每个来源各过一次通用网址正则
 * (剥末尾标点、只收网址安全字符),再按网址原文在整条消息范围内去重,先到先得,次序正文 → 卡。
 */
function linkCandidates(msg: InboundGroupMessage): string[] {
	const sources = [
		msg.text,
		...msg.sharedLinks.filter((link) => link.kind !== "nativeShare").map((link) => link.url),
	];
	return [...new Set(sources.flatMap((source) => extractUrls(source)))];
}

/** 一条消息里最多解析几个链接 —— 再多就是刷屏了,也没人真需要。 */
const MAX_LINKS_PER_MESSAGE = 3;

const BUDGET_WINDOW_MS = 60_000;

/**
 * 回复往哪儿发。**用哪个 adapter 由 `connectionId` 决定,不是消息里报的平台名** ——
 * 桥后面挂着 telegram 时平台报的是 `telegram`,而认领它的 adapter 声明的是 `bridge`。
 *
 * `address` 在 OneBot 是群号、在官机是群 openid、在桥那边是桥自己报的那套编号 ——
 * 三者都只要求「与用户在面板上填的是同一套」。
 */
export interface LinkReplyDestination {
	connectionId: string;
	address: string;
}

/** adapter 归一化好的一条群消息,再带上它从哪条连接来。 */
export interface InboundLinkMessage extends InboundGroupMessage {
	connectionId: string;
}

/** 一张链接卡的呈现;缺省项交给渲染器的全局配置兜底。 */
export interface LinkCardPresentation {
	colors?: CardColorOptions;
	/** 用哪套卡片皮肤(ADR-0014)。链接卡没有 UP 可言,吃的是全局那套。 */
	cardSkin?: string;
}

export interface LinkPreviewerOptions {
	logger: Logger;
	/** 面板上那份链接预览设置。**现读**,不快照 —— 主人关掉立刻生效。 */
	settings: () => LinkPreviewSettings;
	/**
	 * 这个群的答案:解不解析、回什么,键见 {@link linkScopeKey}。默认行与逐群例外怎么对上
	 * 入站帧里的群(引用目标、停用、悬空、陌生群)全在 `link-preview/link-scope.ts`,这里只查表。
	 * 与 `settings` 一样每条消息现读 —— 主人改一格立刻生效。
	 */
	policyFor: (key: string) => LinkPreviewPolicy;
	/**
	 * 在册的链接解析器(各集成在自己的 `start(ctx)` 里登的)。**每条消息现读**:集成可以来去。
	 * 认哪些网址、怎么查、怎么翻成作品都归解析器,这里只问「认不认」。两个解析器都认同一条链接时,先登记的答。
	 */
	linkResolvers: Pick<LinkResolverRegistry, "entries">;
	/** 交给 `resolve` 的取消信号:进程关停的那个,不另加超时。 */
	signal: AbortSignal;
	/** 推送用的卡片渲染器;`null` = 没有 Chrome,整个功能静默不动。**每次现取**,别攥着。 */
	renderer: () => {
		generatePostCard(
			post: Post,
			colors?: CardColorOptions,
			options?: { priority?: RenderPriority },
		): Promise<Buffer>;
	} | null;
	/**
	 * 这张卡怎么画:配色(含图廊轮到的那张背景)+ 皮肤。**每张卡取一次**,由引擎按推送
	 * 动态卡在没有 per-UP 覆盖时的同一条规则算出来 —— 链接解析没有 UP 可言,吃的就是
	 * 全局那份。各算一份的话,主人在卡片页给「动态」调的样式只有推送卡认。
	 */
	presentation: () => LinkCardPresentation;
	/** 往来源群发 —— 由接线层经出口咽喉(`TargetDispatcher.sendToAddress`)实现。 */
	send: (dest: LinkReplyDestination, payload: NotificationPayload) => Promise<DeliveryResult>;
	/**
	 * 目的地那条连接上、那个平台的能力(探测结果的缓存);没有能力概念的平台(官机)回 undefined =
	 * 什么都发不了。形式选了小程序卡时据它决定发小程序卡还是回落图片卡。
	 */
	capabilities: (dest: LinkReplyDestination) => ConnectionCapabilities | undefined;
	/** 还没探出来时主动探一次(零副作用);不实现就当探不了。 */
	probeCapabilities?: (dest: LinkReplyDestination) => Promise<ConnectionCapabilities | undefined>;
	now?: () => number;
	/** 硬上限,缺省 {@link LINK_LIMITS};测试用小数字把边界拉到眼前。 */
	limits?: Partial<LinkLimits>;
}

export interface LinkPreviewer {
	/** 喂一条 adapter 归一化好的群消息。功能关着、没有链接、自己发的,都静默返回;**永不抛**。 */
	handleMessage(msg: InboundLinkMessage): Promise<void>;
}

export function createLinkPreviewer(opts: LinkPreviewerOptions): LinkPreviewer {
	const now = opts.now ?? (() => Date.now());
	const limits: LinkLimits = { ...LINK_LIMITS, ...opts.limits };
	/**
	 * 冷却键 → 上次开始处理的时刻。冷却关着(0)时不碰它。每条链接记两把:联网之前按「群 + 解析器 + 链接原文」
	 * ({@link rawCooldownKey}),`resolve` 成功后再按「群 + 解析器 + 规范 id」({@link canonicalCooldownKey})。
	 */
	const lastSeen = new RecencyTable<number>(limits.tableCap);
	/** `平台:connectionId:群` → 最近一分钟里开始处理的时刻。 */
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

	/** 联网之前的一把:坏链接、短链本身反复贴也只打一次接口。段之间用不会出现在 id 里的 `\n` 隔开。 */
	const rawCooldownKey = (scope: string, resolverKey: string, url: string): string =>
		`${scope}\n${resolverKey}\nurl\n${url}`;
	/** `resolve` 成功后的一把:同一个东西换了写法重贴,只出一张。 */
	const canonicalCooldownKey = (scope: string, resolverKey: string, canonicalId: string): string =>
		`${scope}\n${resolverKey}\nid\n${canonicalId}`;

	/** 谁认这条网址:按登记先后问,先认的答;没人认是 `undefined`。 */
	const claimedBy = (url: string): { key: string; resolver: LinkResolver } | undefined => {
		for (const [key, resolver] of opts.linkResolvers.entries()) {
			if (resolver.matches(url)) return { key, resolver };
		}
		return undefined;
	};

	/**
	 * 解析器交的中立原生分享描述 → 今天的小程序卡载荷(五格一一对应;载荷改名是后面的事,这里不动盘)。
	 * `appId` / `iconUrl` 今天的载荷没有位置,适配器按自己的对照表签。
	 */
	function miniAppCardOf(share: NonNullable<LinkPreview["nativeShare"]>): NotificationPayload {
		return {
			kind: "miniapp-card",
			title: share.title,
			desc: share.description,
			picUrl: share.imageUrl,
			path: share.pagePath,
			jumpUrl: share.webUrl,
		};
	}

	/**
	 * 这个目的地现在能不能发小程序卡。还没探出来就先探一次(空参数探接口,零副作用);
	 * 探完仍未知按不能算 —— 不拿一张注定发不出去的卡去试,那一趟是真向腾讯要卡。
	 *
	 * 「探不出来的适配器别被反复问」的节流在适配器那一层(缓存与失效规则都在那儿),
	 * 这里放心问就是。
	 */
	async function canSendMiniAppCard(dest: LinkReplyDestination): Promise<boolean> {
		let caps = opts.capabilities(dest);
		if (caps?.miniAppCard.state === "unknown" && opts.probeCapabilities) {
			caps = await opts.probeCapabilities(dest);
		}
		return caps?.miniAppCard.state === "supported";
	}

	/** 日志里「在哪个群」那一段,各处共用。 */
	const whereOf = (dest: LinkReplyDestination): string => `group=${dest.address}`;

	/**
	 * 发什么:小程序卡(形式 × 能力由调用方算好)发失败就回落图片卡,群里不会空着。
	 * 缓存翻不翻由适配器自己定(只有再收到 1404 才翻),这里不猜。
	 */
	async function reply(dest: LinkReplyDestination, preview: LinkPreview, useMiniApp: boolean) {
		// 解析器没交原生分享描述就没有小程序卡可发,直接走图片卡。
		if (useMiniApp && preview.nativeShare) {
			const where = whereOf(dest);
			const result = await opts.send(dest, miniAppCardOf(preview.nativeShare));
			if (result.ok) {
				opts.logger.info(
					`[link] 已回复小程序卡 ${where} ${preview.canonicalId}(${result.latencyMs}ms)`,
				);
				return;
			}
			opts.logger.warn(
				`[link] 小程序卡发送失败 ${where} ${preview.canonicalId}: ${result.message},回落图片卡`,
			);
		}
		await replyWithImageCard(dest, preview);
	}

	async function replyWithImageCard(dest: LinkReplyDestination, preview: LinkPreview) {
		const renderer = opts.renderer();
		if (!renderer) return;
		// 低优先级:谁都能触发的卡,不能排在开播 / 动态卡前面。让路由渲染队列按车道做
		// (渲染器那级与浏览器闸那级都认),不靠这里数自己发了几张。
		const { colors, cardSkin } = opts.presentation();
		// 作品里的图(封面等)已由解析器抓进图库,这里直接出卡。
		const buffer = await renderer.generatePostCard(
			preview.post,
			{ ...colors, cardSkin },
			{ priority: "low" },
		);
		const result = await opts.send(dest, { kind: "image", image: { buffer, mime: "image/jpeg" } });
		const where = whereOf(dest);
		if (!result.ok) {
			opts.logger.warn(
				`[link] 链接卡片发送失败 ${where} ${preview.canonicalId}: ${result.message}`,
			);
			return;
		}
		// 成功也留一行:群里没回话只有两种解释(没触发 / 发失败),日志得能分清。
		opts.logger.info(
			`[link] 已回复链接卡片 ${where} ${preview.canonicalId}(${result.latencyMs}ms)`,
		);
	}

	async function handleMessage(msg: InboundLinkMessage): Promise<void> {
		try {
			// 闸门按代价从低到高排:群里每一句话都进这儿(官机开着「全部消息」时尤其如此),
			// 先用一个正则把没链接的放走,再读配置(整份深拷贝)、再看有没有渲染器;网络与
			// 冷却留到每个链接自己那一轮。
			// 自己发的消息不解析 —— 机器人自己发的东西里若有链接,那是它自己贴的。
			if (msg.selfId !== undefined && msg.senderId === msg.selfId) return;
			// 正文里的与分享卡里的一起找;卡片链接排在正文之后,与消息里的先后一致。
			// `"nativeShare"` 的链接刻意不读:进来的本身就是一张能点开播放的原生分享卡,再回一张
			// (图片卡也算)都是重复 —— 主人 2026-09-07 拍板一律不回,而且不留痕(不记冷却),
			// 随后有人把同一条链接以文字贴出来照常出卡。
			// 先用通用网址正则挑候选,再问在册的解析器认不认,取前几个被认领的;没人认就在读配置之前返回。
			const claimed: { url: string; key: string; resolver: LinkResolver }[] = [];
			for (const url of linkCandidates(msg)) {
				const owner = claimedBy(url);
				if (owner) claimed.push({ url, ...owner });
				if (claimed.length >= MAX_LINKS_PER_MESSAGE) break;
			}
			if (claimed.length === 0) return;
			const settings = opts.settings();
			if (!settings.enabled) return;
			// 逐群答案在渲染器之前、记账之前:不解析的群什么都不该留下 —— 冷却也不记,
			// 主人随后把群打开,刚才那条链接再贴一次就该出卡。
			const scope = linkScopeKey(msg.connectionId, msg.address);
			const policy = opts.policyFor(scope);
			if (!policy.isOn) return;
			const dest: LinkReplyDestination = {
				connectionId: msg.connectionId,
				address: msg.address,
			};
			const where = whereOf(dest);
			// 这条消息里的链接真能发出什么:小程序卡要形式选了且这条连接签得了,签不了就
			// 回落图片卡 —— 而图片卡又没渲染器(没装 Chrome)的话,一张也发不出来,整条静默
			// 走人。问在记账之前:什么都发不出去的链接不该白吃冷却与群额度,不然连接一恢复,
			// 同一条链接还得等冷却过去。形式是图片卡时短路,不会为它去问适配器。
			const useMiniApp = policy.replyForm === "nativeShare" && (await canSendMiniAppCard(dest));
			if (!useMiniApp && !opts.renderer()) return;
			const cooldownMs = settings.cooldownSec * 1000;
			// 这条消息里已经回过的「解析器键 + 规范 id」:同一个东西的几种写法在一条消息里只出一张,
			// 冷却关着(0)时也一样。只活在这次处理里,与冷却表无关、不占它的格子。
			const repliedHere = new Set<string>();
			for (const { url, key: resolverKey, resolver } of claimed) {
				try {
					// 三道闸先看不动手,都过了才一起记账:在冷却里的链接不该吃群额度,因为忙而放弃的
					// 链接也不该被记成「处理过」—— 那样它再贴一次就要等整个冷却。
					const rawKey = rawCooldownKey(scope, resolverKey, url);
					if (coolingDown(rawKey, cooldownMs)) continue;
					if (inflight >= limits.maxInflight) {
						opts.logger.debug(`[link] 同时在处理的链接卡已满(${limits.maxInflight}),放弃 ${where}`);
						break;
					}
					if (groupExhausted(scope)) {
						opts.logger.debug(`[link] 群一分钟额度已用完(${limits.groupPerMinute}),放弃 ${where}`);
						break;
					}
					// 冷却从**开始处理**起算,不是发出去才算:一条坏链接被反复贴,不该每次都去打
					// 接口 —— 所以联网之前先按链接原文吃一道,查出规范 id 后再按它吃一道
					// (短链与直链、不同写法指着同一个东西时只出一张,代价是每种写法各问一次解析器)。
					markCooldown(rawKey, cooldownMs);
					recordGroupStart(scope);
					inflight++;
					try {
						const resolved = await resolver.resolve(url, opts.signal);
						if (!resolved.ok) {
							opts.logger.warn(`[link] ${resolver.label}没查出来 ${where}: ${resolved.message}`);
							continue;
						}
						const hereKey = `${resolverKey}\n${resolved.canonicalId}`;
						if (repliedHere.has(hereKey)) continue;
						repliedHere.add(hereKey);
						const canonicalKey = canonicalCooldownKey(scope, resolverKey, resolved.canonicalId);
						if (coolingDown(canonicalKey, cooldownMs)) continue;
						markCooldown(canonicalKey, cooldownMs);
						await reply(dest, resolved, useMiniApp);
					} finally {
						inflight--;
					}
				} catch (e) {
					// 单个链接失败不回话、不影响同一条消息里的下一个。
					opts.logger.warn(`[link] 解析失败 ${where}:${String(e)}`);
				}
			}
		} catch (e) {
			// 这是在入站回调里被调的,抛出去就是一个 unhandledRejection。
			opts.logger.error(`[link] 处理入站消息失败: ${String(e)}`);
		}
	}

	return { handleMessage };
}
