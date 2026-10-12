/**
 * **作品装配**(ADR-0019 决策 66):一条作品进了核心之后的那一段 —— 现折这条订阅的设置 → 过滤(挡下的留痕)→
 * 出卡 → AI 点评 → 回问订阅还在不在 → 套模板 → 按版式装配 → 推送 → 图集。B 站动态与拓展作品共用这一份:
 * 两条流水线各记一份顺序的话,B 站那条以后加了什么,拓展那条会悄悄漏掉。
 *
 * 它**不认 uid、不读任何平台的原始数据**:来源只交一份中立的 `PostEvent`(图已是图库引用,来源交出之前就抓好 / 写好),
 * 核心入口(`PostQueue`,`post-queue.ts`)按订阅排队后调到这里。来源只负责生产 —— 过滤、出卡、点评、推送、图集、
 * 失败了怎么办,都是核心的事:发送抛错在这里往外抛,由入口接住、记日志、不重试(ADR-0019 决策 77;
 * 推送层发送失败本来就收成结果、记进历史,不会抛,抛的只是调用方写错这类意外)。
 */

import type { CommentaryCallOverride, CommentaryProvider } from "@bilibili-notify/ai";
import type { CardSkinChoice, ImageRenderer } from "@bilibili-notify/image";
import type {
	ImageRef,
	Logger,
	MessageKindLayout,
	MessagePartType,
	Post,
	PostEvent,
	PostImage,
} from "@bilibili-notify/internal";
import { assembleMessageGroups, interpolate, isBlockVisible } from "@bilibili-notify/internal";
import { bytesDataUrl } from "../images/image-data-url.js";
import { errorMessageOf } from "../util/error-message.js";
import { filterPost, type PostFilterRules } from "./post-filter";
import type { FilteredPost, PostPushAnchor, PushSegment } from "./post-push";
import { postText } from "./post-text";

/** AI 点评最多看几张图(决策 71:拓展作品与 B 站同一个数)。 */
export const POST_COMMENT_IMAGES_MAX = 4;

/**
 * 交给 AI 看的图,只有图库引用的那种单张多大就跳过(决策 71)。网址是服务商自己去拉,data URL 却要整张塞进请求体。
 *
 * 取 3 MiB(原始字节;编成 data URL 约 4 MiB):常见服务商对单张 base64 图的上限是 5 MB 上下
 * (Anthropic、智谱都是这个数),Gemini 内联数据整条请求 20 MB —— 四张都顶格时约 16 MiB,两头都放得下。
 * 抖音 CDN 的图多是几百 KB 的 webp,正常的作品碰不到这条线;碰到的多半是原图直出的大图,少看一张
 * 胜过整条点评被服务商 413 掉。
 */
export const POST_COMMENT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 这条订阅**折好的**作品设置(订阅覆盖与全局已折成一层,每条作品现折)。
 * 模板、图集、出图、AI 各格都是定值:全局那几格的兜底在折的那一头做完,这里不再有「留空继承」。
 */
export interface PostSettings {
	/** 过滤规则(折好的 `ContentFilters`)。 */
	filter: PostFilterRules;
	/** 消息版式的作品切片(块顺序 / 显隐 / 分条符 + 分隔符):文本模板以 url='' 渲染,链接独立成部件。 */
	messageLayout: MessageKindLayout;
	/** 是否出图片卡片。`false` 时不调渲染器,推送降级为纯文字。 */
	cardEnabled: boolean;
	/** 这条订阅生效的卡片皮肤 id(ADR-0014);undefined = 内置默认皮肤。 */
	cardSkin?: string;
	/**
	 * 这条订阅自己那层**皮肤旋钮覆盖**,按皮肤 id 分(ADR-0014 决策 17 的 🔗)。不折全局值:渲染器出图时与它 config
	 * 里的全局那份逐枚合并,所以快照不会把全局冻住。
	 */
	cardSkinKnobs?: CardSkinChoice["cardSkinKnobs"];
	/** 是否做 AI 点评。`false` 时不调 `CommentaryProvider.comment()`,推送只用模板文字。 */
	aiEnabled: boolean;
	/** 点评时允不允许联网搜索:搜索按次付费,自动路径必须主人亲手点亮;装配只把它翻成 override.webSearch。 */
	aiWebSearch: boolean;
	/** Per-UP AI 覆盖;undefined 时用生成器的全局配置。 */
	aiOverride?: CommentaryCallOverride;
	/** 非视频作品的推送文本模板,变量只有 `{name}`;链接是版式的独立部件,不是模板变量。 */
	template: string;
	/** 视频作品的推送文本模板,变量同上。 */
	videoTemplate: string;
	/**
	 * 图集推送。enabled=false 时不附图集;mergeForward=true 时多图走合并转发(单图永远不走:一张图包成
	 * 「聊天记录」卡片没有意义)。
	 */
	imageGroup: { enabled: boolean; mergeForward: boolean };
}

/**
 * 出图连续失败的计数:连着失败只提醒主人一次,出图恢复后复位、下一串失败再提醒。
 *
 * 一个小对象(决策 66):B 站与拓展用的是同一个渲染器,两条路共用一份才不会同一次故障各提醒一遍。
 */
export interface CardFailureTracker {
	/** 连着失败了几次;0 = 上一次出卡是好的。 */
	readonly streak: number;
	/** 这一串失败已经提醒过主人了(告警发射出去就算)。 */
	readonly notified: boolean;
	/** 记一次失败,回记完之后连着失败的次数。 */
	recordFailure(): number;
	/**
	 * 领这一串的提醒 —— **发之前**领:还没提醒过、也没有别的提醒在路上,才给一张凭据,否则回 null
	 * (别发)。几条订阅各自并行出卡,「先看没提醒过、发完再记」的话,同一次故障并发的几条失败都
	 * 看见「没提醒过」,各发一遍。发完拿凭据报结果,见 {@link CardFailureNotice}。
	 */
	claimNotice(): CardFailureNotice | null;
	/** 记一次成功、复位,回复位前连着失败的次数(> 0 = 刚恢复)。 */
	recordSuccess(): number;
}

/** 领到的那一次提醒。 */
export interface CardFailureNotice {
	/**
	 * 报结果:发出去了 → 这一串算提醒过;发射同步抛了 → 放回去,下一次失败再领。出图恢复时
	 * (`recordSuccess` 复位过)这张凭据作废、报什么都不算 —— 记到下一串头上的话,下一串失败就一声不吭了。
	 */
	settle(delivered: boolean): void;
}

export function createCardFailureTracker(): CardFailureTracker {
	let streak = 0;
	let notified = false;
	// 在路上的那一次提醒;复位时丢掉,晚到的 settle 认不出自己就不算数。
	let pending: CardFailureNotice | null = null;
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
		claimNotice: () => {
			if (notified || pending) return null;
			const notice: CardFailureNotice = {
				settle: (delivered) => {
					if (pending !== notice) return;
					pending = null;
					if (delivered) notified = true;
				},
			};
			pending = notice;
			return notice;
		},
		recordSuccess: () => {
			const before = streak;
			streak = 0;
			notified = false;
			pending = null;
			return before;
		},
	};
}

/** 装配用到的协作者。渲染器 / AI 缺失时降级(纯文字 / 不点评);它们会被热换,所以是每次现取的读口。 */
export interface DeliverPostDeps {
	logger: Logger;
	/**
	 * 这条订阅此刻折好的作品设置;不该推(订阅不在 / 停用 / 作品开关关着 / 来源没在跑)回 `undefined`。
	 * **每次现折**:装配里问两次(开头与回问),入口也问一次。
	 */
	settings(subscriptionId: string): PostSettings | undefined;
	/** 渲染器会被热换:**每次现取**(读外层变量的闭包),别按值传。 */
	image(): ImageRenderer | undefined;
	/** AI 同上,每次现取。 */
	ai(): CommentaryProvider | undefined;
	/** 出图连续失败的计数;两条路传同一份。 */
	cardFailures: CardFailureTracker;
	/** 订阅资料里的头像引用,出卡那一刻现读(作品自己没带头像时用它)。 */
	avatar(subscriptionId: string): ImageRef | undefined;
	/** 图库引用 → 字节(AI 看只有引用的图用);图不在了回 `undefined`。 */
	readImage(ref: ImageRef): Promise<{ bytes: Uint8Array; mime: string } | undefined>;
	/**
	 * 绑到一条订阅上的推送口:一条作品只调一次,主卡(本体)与图集(附加项)是同一次推送的锚点,历史落同一行。
	 * 本体发完时返回;图集在推送层的后台接着发,发不出也不往这边抛。
	 */
	push(subscriptionId: string, anchors: PostPushAnchor[]): Promise<void>;
	/** 被过滤的作品在推送历史里留一行(只留痕,不是推送)。同步调、不等它;抛错只记 warn。 */
	recordFiltered(filtered: FilteredPost): void;
	/**
	 * 出图失败、这一串还没提醒过时发一次组件告警(`engine-error`):经主人私聊的限流通知器私聊一条,
	 * 同时点亮告警面板。同步;抛错 = 没发出去,下次失败再提醒。
	 */
	emitEngineError(message: string): void;
}

/** 有字才算有。 */
const filled = (text: string | undefined): text is string => !!text && text.trim() !== "";

/**
 * 渲染推送文本:`{name}` 插值 + `\n` 展开。链接是版式的独立部件,模板里没有链接变量
 * (2026-09 起不再替旧模板剥 `{url}`:写了就原样出现,请从模板里删掉)。
 */
function renderText(template: string, name: string): string {
	return interpolate(template, { name }).replaceAll("\\n", "\n");
}

/**
 * AI 看的图(决策 71):候选按 配图 → 文章配图 → 视频封面(只看最外层)。有公网网址的给网址(服务商自己去拉,
 * 与 B 站从前给的是同一批地址);只有图库引用的读出字节、不超过 {@link POST_COMMENT_IMAGE_MAX_BYTES} 才编成
 * data URL,太大或已不在图库的跳过、让后面的顶上;凑够 {@link POST_COMMENT_IMAGES_MAX} 张就停。
 */
async function commentImagesOf(post: Post, deps: DeliverPostDeps): Promise<string[]> {
	const candidates: PostImage[] = [
		...(post.images ?? []),
		...(post.article?.images ?? []),
		...(post.video ? [post.video.cover] : []),
	];
	const urls: string[] = [];
	for (const image of candidates) {
		if (urls.length >= POST_COMMENT_IMAGES_MAX) break;
		// 经 as-cast 进来的字段运行时可能是对象:`typeof === string` 守卫,杜绝对象被当网址喂给多模态 AI。
		if (typeof image.url === "string" && image.url) {
			urls.push(image.url);
			continue;
		}
		if (image.ref === undefined) continue;
		try {
			const found = await deps.readImage(image.ref);
			if (found && found.bytes.byteLength <= POST_COMMENT_IMAGE_MAX_BYTES) {
				urls.push(bytesDataUrl(found.mime, found.bytes));
			}
		} catch (e) {
			deps.logger.debug(`[post] 读图库里的图失败,这张不给 AI 看:${errorMessageOf(e)}`);
		}
	}
	return urls;
}

/**
 * 把一条作品装配好推出去。
 *
 * 块隐藏的部件直接跳过其生产成本:卡片块藏起来不出卡,文字块藏起来不调 AI。出图失败降级为纯文字、
 * 连着失败只提醒一次;AI 失败回退到模板;图集是主卡的附属物,发不出就算了(见下)。
 * 主卡发送抛错**往外抛**,由入口接住(不重试)。
 */
export async function deliverPost(event: PostEvent, deps: DeliverPostDeps): Promise<void> {
	const { logger } = deps;
	const { post, subscriptionId } = event;
	const tag = `sub=${subscriptionId}`;

	// 现折:在串行闸里排了一阵才跑到,订阅可能已停用 / 删掉 / 换了设置。这一份用到装配结束。
	const settings = deps.settings(subscriptionId);
	if (settings === undefined) {
		logger.debug(`[post] ${tag} 已停用 / 已删 / 不该推,作品 ${event.postId} 不推`);
		return;
	}

	// 过滤:吃中立的 `Post`,一份实现所有来源同一个。挡下的只在推送历史里留一行,不出卡、不点评、不推。
	const filtered = filterPost(post, settings.filter, logger);
	if (filtered.blocked && filtered.reason) {
		logger.debug(`[post] ${tag} 的作品 ${event.postId} 被过滤,原因:${filtered.reason}`);
		// best-effort:记不下就算了,绝不因此让装配往外抛。
		try {
			deps.recordFiltered({
				subscriptionId,
				filteredBy: filtered.reason,
				text: postText(post, "plain"),
				url: event.url,
			});
		} catch (e) {
			logger.warn(`[post] 被过滤的作品留痕失败(忽略): ${errorMessageOf(e)}`);
		}
		return;
	}

	const layout = settings.messageLayout;
	const wantPart = (t: MessagePartType): boolean => isBlockVisible(layout, t);

	// 出卡
	let card: Buffer | undefined;
	const image = deps.image();
	if (image && settings.cardEnabled && wantPart("card")) {
		try {
			// 外层作者头像:作品自己没带才用订阅资料里的(出卡这一刻现读、零网络);不改入参。
			const avatar = post.creator.avatar ?? deps.avatar(subscriptionId);
			const forCard: Post =
				avatar === undefined || avatar === post.creator.avatar
					? post
					: { ...post, creator: { ...post.creator, avatar } };
			// 皮肤 id 与这条订阅的旋钮覆盖恒要带上。
			card = await image.generatePostCard(forCard, {
				cardSkin: settings.cardSkin,
				cardSkinKnobs: settings.cardSkinKnobs,
			});
		} catch (e) {
			noteCardFailure(e, deps);
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
	const ai = deps.ai();
	if (ai && settings.aiEnabled && wantPart("text")) {
		const commentText = postText(post, "labeled");
		if (commentText) {
			const imageUrls = await commentImagesOf(post, deps);
			logger.debug(
				`[ai] 开始生成动态点评，文本长度=${commentText.length}，图片数=${imageUrls.length}${settings.aiOverride ? "，命中 per-UP override" : ""}`,
			);
			try {
				aiComment = await ai.comment(
					`${post.creator.name}发布了一条${filled(event.postNoun) ? event.postNoun : "作品"}，内容如下：\n${commentText}`,
					"dynamic",
					imageUrls,
					// 联网搜索是全局开关,盖在 per-UP 覆盖之上(per-UP 没有这一项)。
					settings.aiWebSearch ? { ...settings.aiOverride, webSearch: true } : settings.aiOverride,
				);
				logger.debug(`[ai] 动态点评生成完毕，长度=${aiComment?.length ?? 0}`);
			} catch (e) {
				logger.error(`[ai] AI 点评生成失败：${errorMessageOf(e)}，回退到普通文字`);
			}
		} else {
			logger.debug("[ai] 动态无可提取文本，跳过 AI 点评");
		}
	}

	// 回问:跨出卡 / 点评几个 await 之后,订阅可能已停用 / 删掉 / 来源停了。给已退订的推送是打扰。
	// 模板与版式仍用开头折的那一份(拿陈旧的设置推也不对,但这一条已经装配到这儿了)。
	if (deps.settings(subscriptionId) === undefined) {
		logger.debug(`[post] ${tag} 在本条处理途中停用 / 删掉了,作品 ${event.postId} 没发`);
		return;
	}

	// 文字在「有卡」「没卡」两种情况下完全一致:有 AI 点评用点评,否则按模板渲染。
	// 链接独立成部件,顺序 / 显隐 / 分条全由版式决定。
	const template = post.video !== undefined ? settings.videoTemplate : settings.template;
	const text = wantPart("text") ? (aiComment ?? renderText(template, post.creator.name)) : "";
	const messages: PushSegment[][] = assembleMessageGroups(layout, { card, text, link: event.url });
	// 这一条作品 = 一次推送:主卡(可能分条)是本体,图集是排在它后面的附加项锚点,一起交出去 ——
	// 宿主的历史落同一行。开关、静音与免扰就在交出去的这一刻判一次。
	const anchors: PostPushAnchor[] = [];
	if (messages.length === 0) {
		logger.debug(`[push] ${tag} 消息版式所有部件隐藏/缺失,本条不推送`);
	} else {
		anchors.push({ role: "main", messages });
	}

	// 图集:从外层 `post.images` 推出来,只有带公网网址的图进(只有图库引用的,适配器没有链接可给)。
	// 元素只取 url / 宽 / 高三格(宽高透传给需要原始尺寸的平台,如 QQ 原生 markdown 多图)。
	const gallery: PostImage[] = [];
	for (const img of post.images ?? []) {
		if (img.url) gallery.push({ url: img.url, width: img.width, height: img.height });
	}
	if (settings.imageGroup.enabled && gallery.length > 0) {
		// 单张图永远不走合并转发(1 张图包成「聊天记录」卡片无意义)。
		const mergeForward = settings.imageGroup.mergeForward && gallery.length > 1;
		// 图集是主卡的**附属物**:附加项锚点永不带 @全体,在推送层的后台发。它走 forward/NapCat
		// 长消息通道(不稳),发不出只记在那个目标的历史里,不往这边抛。
		anchors.push({
			role: "extra",
			messages: [[{ kind: "image-group", mergeForward, images: gallery }]],
		});
	}
	if (anchors.length > 0) await deps.push(subscriptionId, anchors);
}

/**
 * 出图失败:软降级(这一条走纯文字),并在连续失败的**头一次**提醒主人 —— 长时间没有卡片又不刷屏。
 * 提醒就是发一次组件告警(`engine-error`,经主人私聊的限流通知器 + 面板红条),不再另发直聊:
 * 发射是同步的,没有「在路上」与「没送达」,所以发射完就算提醒过;只有发射同步抛了才放回去、下一次失败再试。
 * 提醒在发之前领(`claimNotice`),并发的几条失败只有一条发。
 */
function noteCardFailure(err: unknown, deps: DeliverPostDeps): void {
	const streak = deps.cardFailures.recordFailure();
	const reason = errorMessageOf(err);
	deps.logger.error(`[image] 生成动态图片失败 (连续 ${streak} 次): ${reason}`);
	const notice = deps.cardFailures.claimNotice();
	if (!notice) return;
	try {
		deps.emitEngineError(`生成动态图片失败：${reason}，已降级为纯文字推送，请检查图片插件状态`);
		notice.settle(true);
	} catch (notifyErr) {
		notice.settle(false);
		deps.logger.warn(`[image] 失败告警发射失败,下轮将重试: ${errorMessageOf(notifyErr)}`);
	}
}
