/**
 * **作品装配**(ADR-0019 决策 66):一条作品从「出卡」到「图集」的那一段 —— 出卡 → AI 点评 →
 * 再核一次还订阅着 → 套模板 → 按版式装配 → 推送 → 图集。B 站动态与拓展作品共用这一份:两条流水线
 * 各记一份顺序的话,B 站那条以后加了什么,拓展那条会悄悄漏掉。
 *
 * 它**不认 uid、不读任何平台的原始数据**:来源先把自己的数据翻成 {@link NeutralWork}(B 站动态引擎
 * 读 B 站原始动态,拓展读上报的作品),带上这条订阅折好的设置与绑到这条订阅上的发送交进来。过滤、
 * 时间线闸、统计事件、失败了怎么办,都是来源自己的事。
 */

import { randomUUID } from "node:crypto";
import type { AIScene, CommentaryCallOverride } from "@bilibili-notify/ai";
import type { CardColorOptions, ImageRenderer } from "@bilibili-notify/image";
import type { ForwardImage, Logger } from "@bilibili-notify/internal";
import { assembleMessageGroups, interpolate } from "@bilibili-notify/internal";
import { resolveDynamicColorOptions } from "./card-style";
import type { DynamicBroadcastOptions, PushKind, PushSegment, SubItemView } from "./push-like";

/** AI 点评生成器(宿主注入 `CommentaryGenerator`,这里只认用到的那一个方法)。 */
export interface CommentaryClient {
	comment(
		content: string,
		scene?: AIScene,
		imageUrls?: string[],
		override?: CommentaryCallOverride,
	): Promise<string>;
}

/** AI 点评最多看几张图(决策 71:拓展作品与 B 站同一个数)。来源交多了,装配截前这么多张。 */
export const WORK_COMMENT_IMAGES_MAX = 4;

/**
 * 推送文本模板的内建兜底,仅在宿主没填全局模板时用(独立端恒从 `globals.defaults.templates`
 * 填)。与 `@bilibili-notify/internal` 的 `DEFAULT_TEMPLATES.dynamic/.dynamicVideo` 保持一致。
 * 变量只有 `{name}`;链接是消息版式的独立部件,不是模板变量。
 */
const DEFAULT_DYNAMIC_TEXT = {
	dynamic: "{name}发布了一条动态",
	video: "{name}发布了新视频",
} as const;

/**
 * 渲染推送文本:`{name}` 插值 + `\n` 展开。链接是版式的独立部件,模板里没有链接变量
 * (2026-09 起不再替旧模板剥 `{url}`:写了就原样出现,请从模板里删掉)。
 */
function renderDynamicText(template: string, name: string): string {
	return interpolate(template, { name }).replaceAll("\\n", "\n");
}

/**
 * 一条**平台中立的作品**。这几样今天在 B 站那头读原始动态得来,拓展那头读上报的作品得来;
 * 装配只认这里的格。
 */
export interface NeutralWork {
	/**
	 * 怎么出这张卡:拿给的渲染器、按这条订阅的样式与皮肤出。B 站包 `image.generateDynamicCard(raw, …)`,
	 * 拓展包 `image.generateNeutralDynamicCard(node, …)`。**要不要出**(渲染器在不在、出图开没开、版式
	 * 露不露卡片)是装配的事,这里只管怎么出;抛错 = 这一次出图失败,装配降级成纯文字。
	 */
	renderCard(image: ImageRenderer, colorOptions: CardColorOptions): Promise<Buffer>;
	/** 链接部件的内容(不带前缀文案);空串 = 没有链接部件。 */
	link: string;
	/** 模板里的 `{name}`,也进 AI 提示词。 */
	name: string;
	/** 算不算视频:套视频模板还是动态模板。 */
	isVideo: boolean;
	/** AI 点评要的正文;空串 = 没有可点评的,不调 AI。 */
	commentText: string;
	/** AI 点评要的图(网址或 data URL);只看前 {@link WORK_COMMENT_IMAGES_MAX} 张。 */
	commentImages: readonly string[];
	/** AI 提示词里「××发布了一条{postNoun}」的叫法:B 站「动态」,拓展按平台(决策 71)。 */
	postNoun: string;
	/** 图集的图;空 = 不附图集(开关开着也不附)。 */
	gallery: readonly ForwardImage[];
}

/**
 * 这条订阅**折好的**设置(宿主按 per-UP 覆盖折叠)。模板与图集两格留空时由
 * {@link WorkDeliveryConfig} 兜底;B 站的 {@link SubItemView} 结构上就是它。
 */
export type WorkSubscriptionSettings = Pick<
	SubItemView,
	| "messageLayout"
	| "customCardStyle"
	| "cardSkin"
	| "cardSkinKnobs"
	| "aiOverride"
	| "imageGroupEnable"
	| "imageGroupForward"
	| "customDynamicTemplate"
	| "customVideoTemplate"
>;

/** 引擎级(全局)的那几样 —— 订阅的设置里留空时兜底。 */
export interface WorkDeliveryConfig {
	/**
	 * 非视频的推送文本模板,变量只有 `{name}`。链接不是模板变量:它是消息版式的独立部件,要不要带、
	 * 放在哪由版式决定。缺省时回退到内建文案。宿主通常用 `globals.defaults.templates.dynamic` 填充。
	 */
	dynamicTemplate?: string;
	/**
	 * 视频的推送文本模板,变量同上。缺省时回退到内建文案。宿主通常用
	 * `globals.defaults.templates.dynamicVideo` 填充。
	 */
	videoTemplate?: string;
	/**
	 * 图集推送。enable=false 时不附图集,只发文本/卡片。forward=true 时走合并转发(聊天记录卡片,
	 * 走 OneBot send_group_forward_msg,部分 OneBot 实现/NapCat 长消息通道不稳);forward=false
	 * 多图合并到一条普通 send_group_msg。单图永远不走合并转发。
	 */
	imageGroup: {
		enable: boolean;
		forward: boolean;
	};
	/**
	 * 是否出图片卡片。`false` 时不调渲染器,推送降级为纯文字。缺省视为 true。宿主通常用
	 * `globals.defaults.cardStyle.enabled` 填充。
	 */
	imageEnabled?: boolean;
	/**
	 * 是否做 AI 点评。`false` 时不调 `CommentaryClient.comment()`,推送只用模板文字。缺省视为 true。
	 * 宿主通常用 `globals.defaults.ai.enabled` 填充。
	 */
	aiEnabled?: boolean;
	/**
	 * 点评时允不允许联网搜索。缺省 false —— 搜索按次付费,自动路径必须主人亲手点亮。宿主用
	 * `globals.defaults.ai.search.engines.dynamic` 填充;装配只把它翻成 override.webSearch,
	 * 执行器在不在是生成器的事。
	 */
	aiWebSearch?: boolean;
}

/**
 * 绑到这条订阅上的发送 —— `PushLike` 的两个广播口去掉 uid:B 站按 uid 绑,拓展按订阅 id 绑。
 *
 * `kind`:主卡 `dynamic`、图集 `dynamic-images`;推送层据它把图集当附加项、抑制 @全体
 * (`broadcastOptsForDynamicKind`)。主卡与图集带同一个 pushId,历史落同一行。
 */
export interface BoundWorkPush {
	/** 一条消息。 */
	broadcast(segments: PushSegment[], kind: PushKind, opts?: DynamicBroadcastOptions): Promise<void>;
	/** 消息版式分条:一次推送拆成多条消息的序列(语义见 `PushLike.broadcastDynamicSequence`)。 */
	broadcastSequence(
		messages: PushSegment[][],
		kind: PushKind,
		opts?: DynamicBroadcastOptions,
	): Promise<void>;
}

/**
 * 出图连续失败的计数:连着失败只提醒主人一次,出图恢复后复位、下一串失败再提醒。
 *
 * 从动态引擎实例上搬出来成一个小对象(决策 66):B 站与拓展用的是同一个渲染器,两条路共用
 * 一份才不会同一次故障各提醒一遍。
 */
export interface CardFailureTracker {
	/** 连着失败了几次;0 = 上一次出卡是好的。 */
	readonly streak: number;
	/** 这一串失败已经提醒过主人了(提醒**送达**才算)。 */
	readonly notified: boolean;
	/** 记一次失败,回记完之后连着失败的次数。 */
	recordFailure(): number;
	/** 这一串的提醒送达了,同一串之后不再提醒。 */
	markNotified(): void;
	/** 记一次成功、复位,回复位前连着失败的次数(> 0 = 刚恢复)。 */
	recordSuccess(): number;
}

export function createCardFailureTracker(): CardFailureTracker {
	let streak = 0;
	let notified = false;
	return {
		get streak() {
			return streak;
		},
		get notified() {
			return notified;
		},
		recordFailure: () => {
			streak++;
			return streak;
		},
		markNotified: () => {
			notified = true;
		},
		recordSuccess: () => {
			const before = streak;
			streak = 0;
			notified = false;
			return before;
		},
	};
}

/** 装配用到的服务。渲染器 / AI 缺失时降级(纯文字 / 不点评)。 */
export interface WorkDeliveryDeps {
	logger: Logger;
	image?: ImageRenderer;
	ai?: CommentaryClient;
	/** 出图连续失败的计数;两条路传同一份。 */
	cardFailures: CardFailureTracker;
	/** 出图失败、这一串还没提醒过时私聊主人一句。抛错 = 没送达,下次失败再提醒。 */
	sendErrorMsg(text: string): Promise<void>;
	/** 同一次提醒点亮告警面板(`engine-error`)。 */
	emitEngineError(message: string): void;
}

export interface DeliverWorkArgs {
	work: NeutralWork;
	/** 这条订阅折好的设置。 */
	settings: WorkSubscriptionSettings;
	/** 绑到这条订阅上的发送。 */
	push: BoundWorkPush;
	/**
	 * 还订阅着吗 —— 出卡、点评几个 await 之后、发送之前回问一次。期间被退订(或被换成另一条订阅)
	 * 就不发:给已退订的推送是打扰,拿陈旧的设置推也不对。
	 */
	stillSubscribed(): boolean;
	config: WorkDeliveryConfig;
	deps: WorkDeliveryDeps;
	/** 日志里怎么称呼这条订阅(B 站 `UID=…`)。只进日志。 */
	logLabel: string;
}

/**
 * `delivered` = 走完了(含版式全藏起来一条都没发);`unsubscribed` = 发送前发现已退订,没发。
 * 主卡发送失败**往外抛**,由来源决定怎么办(B 站:时间线不前移、下一轮再来;拓展:不重放,决策 77)。
 */
export type WorkDeliveryOutcome = "delivered" | "unsubscribed";

/**
 * 把一条作品装配好推出去。
 *
 * 块隐藏的部件直接跳过其生产成本:卡片块藏起来不出卡,文字块藏起来不调 AI。出图失败降级为纯文字、
 * 连着失败只提醒一次;AI 失败回退到模板;图集是主卡的附属物,发不出就算了(见下)。
 */
export async function deliverWork(args: DeliverWorkArgs): Promise<WorkDeliveryOutcome> {
	const { work, settings, push, config, deps, logLabel } = args;
	const { logger } = deps;
	const layout = settings.messageLayout;
	const wantPart = (t: string): boolean => layout.blocks.some((b) => b.visible && b.type === t);

	// 出卡
	let card: Buffer | undefined;
	if (deps.image && config.imageEnabled !== false && wantPart("card")) {
		try {
			// 样式覆盖没启用时 resolveDynamicColorOptions 回 undefined(= 吃渲染器的全局配置);
			// 皮肤 id 与这条订阅的旋钮覆盖都与它无关,恒要带上 —— 几件事混在一个对象里传,展开的顺序决定了「没启用」
			// 不会把一份禁用的样式漏出去。
			card = await work.renderCard(deps.image, {
				...resolveDynamicColorOptions(settings.customCardStyle),
				cardSkin: settings.cardSkin,
				cardSkinKnobs: settings.cardSkinKnobs,
			});
		} catch (e) {
			await noteCardFailure(e as Error, deps);
			card = undefined;
		}
	}
	// 出图成功后复位失败计数,恢复之后的下一串失败才能再提醒。
	if (card) {
		const before = deps.cardFailures.recordSuccess();
		if (before > 0) logger.info(`[image] 图片渲染已恢复（之前连续失败 ${before} 次）`);
	}

	// AI 点评 —— per-UP 的 aiOverride 只对这一次调用生效;缺失时走生成器的全局配置。
	let aiComment: string | undefined;
	if (deps.ai && config.aiEnabled !== false && wantPart("text")) {
		if (work.commentText) {
			const imageUrls = work.commentImages.slice(0, WORK_COMMENT_IMAGES_MAX);
			logger.debug(
				`[ai] 开始生成动态点评，文本长度=${work.commentText.length}，图片数=${imageUrls.length}${settings.aiOverride ? "，命中 per-UP override" : ""}`,
			);
			try {
				aiComment = await deps.ai.comment(
					`${work.name}发布了一条${work.postNoun}，内容如下：\n${work.commentText}`,
					"dynamic",
					imageUrls,
					// 联网搜索是引擎级开关,盖在 per-UP 覆盖之上(per-UP 没有这一项)。
					config.aiWebSearch ? { ...settings.aiOverride, webSearch: true } : settings.aiOverride,
				);
				logger.debug(`[ai] 动态点评生成完毕，长度=${aiComment?.length ?? 0}`);
			} catch (e) {
				logger.error(`[ai] AI 点评生成失败：${(e as Error).message}，回退到普通文字`);
			}
		} else {
			logger.debug("[ai] 动态无可提取文本，跳过 AI 点评");
		}
	}

	// 跨出卡 / 点评几个 await 之后重校:期间可能已退订。
	if (!args.stillSubscribed()) {
		logger.debug(`[detector] ${logLabel} 在本轮处理中已退订/被替换，跳过推送`);
		return "unsubscribed";
	}

	// 文字在「有卡」「没卡」两种情况下完全一致:有 AI 点评用点评,否则按模板
	// (per-UP ?? 全局 ?? 内建兜底)渲染。链接独立成部件,顺序 / 显隐 / 分条全由版式决定。
	const template = work.isVideo
		? (settings.customVideoTemplate ?? config.videoTemplate ?? DEFAULT_DYNAMIC_TEXT.video)
		: (settings.customDynamicTemplate ?? config.dynamicTemplate ?? DEFAULT_DYNAMIC_TEXT.dynamic);
	const text = wantPart("text") ? (aiComment ?? renderDynamicText(template, work.name)) : "";
	const messages: PushSegment[][] = assembleMessageGroups(layout, { card, text, link: work.link });
	// 这一条作品 = 一次推送:主卡(可能分条)与后面的图集共用一个 pushId,宿主的历史落同一行、
	// 图集是追加上去的附加项。
	const pushId = randomUUID();
	if (messages.length === 0) {
		logger.debug(`[push] ${logLabel} 消息版式所有部件隐藏/缺失,本条不推送`);
	} else if (messages.length === 1) {
		await push.broadcast(messages[0] as PushSegment[], "dynamic", { pushId });
	} else {
		await push.broadcastSequence(messages, "dynamic", { pushId });
	}

	// 图集 —— per-UP 的开关优先,留空继承全局。
	const galleryEnabled = settings.imageGroupEnable ?? config.imageGroup.enable;
	if (galleryEnabled && work.gallery.length > 0) {
		const forwardWanted = settings.imageGroupForward ?? config.imageGroup.forward;
		// 单张图永远不走合并转发(1 张图包成「聊天记录」卡片无意义)。
		const forward = forwardWanted && work.gallery.length > 1;
		// 图集是主卡的**附属物**,主卡此时已成功发出。它走 forward/NapCat 长消息通道(不稳),
		// reject 很现实。绝不能往外抛:B 站那头会因此不推进时间线,下轮整条重判、主卡以
		// kind='dynamic' 重发,而 dynamic 不抑制 @全体 → 每 tick 重复 @全体。发不出就算了。
		try {
			await push.broadcast(
				[{ type: "image-group", forward, images: [...work.gallery] }],
				"dynamic-images",
				{ pushId },
			);
		} catch (e) {
			logger.warn(
				`[push] ${logLabel} 图组发送失败(忽略,不重试以免重发主卡): ${(e as Error).message}`,
			);
		}
	}
	return "delivered";
}

/**
 * 出图失败:软降级(这一条走纯文字),并在连续失败的**头一次**提醒主人 —— 长时间没有卡片又不刷屏。
 * 提醒送达才算提醒过:发不出去的话,下一次失败再试。
 */
async function noteCardFailure(err: Error, deps: WorkDeliveryDeps): Promise<void> {
	const streak = deps.cardFailures.recordFailure();
	deps.logger.error(`[image] 生成动态图片失败 (连续 ${streak} 次): ${err.message}`);
	if (deps.cardFailures.notified) return;
	try {
		await deps.sendErrorMsg(
			`生成动态图片失败：${err.message}，已降级为纯文字推送，请检查图片插件状态`,
		);
		deps.emitEngineError(`生成动态图片失败：${err.message}`);
		deps.cardFailures.markNotified();
	} catch (notifyErr) {
		deps.logger.warn(`[image] 失败通知发送失败,下轮将重试通知: ${(notifyErr as Error).message}`);
	}
}
