import type { NeutralWork } from "@bilibili-notify/dynamic";
import {
	BLOCKED_IMG_PLACEHOLDER,
	buildPlainText,
	type DynamicNode,
	type DynamicVideo,
	formatCardTime,
	type GalleryImage,
	numberToStr,
} from "@bilibili-notify/image";
import {
	readImageSize,
	type SubscriptionReportValue,
	sniffImageFormat,
} from "@bilibili-notify/internal";
import { type ExtensionCardAuthor, imageDataUrl } from "./extension-push-common.js";
import { formatDuration } from "./video-card.js";

/**
 * **拓展报的作品 → 平台中立的作品**(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77):装配(`deliverWork`)
 * 只认 {@link NeutralWork},卡片只认 `DynamicNode` —— 这里把拓展交的那张表翻过去,出卡之后那一段与
 * B 站动态同一份。
 *
 * 纯函数:作者(名字与头像)由调用方先按决策 54 取好(`extension-push-common.ts`),这里不碰订阅、
 * 资料缓存与头像文件。
 */

type Post = SubscriptionReportValue<"post">;

/** 卡里铺几张图 —— 与 B 站同一个上限(图廊的九宫格),其余折进最后一格的 `+N`(决策 77)。 */
export const POST_CARD_IMAGES_MAX = 9;

/**
 * 交给 AI 看的图,单张多大就跳过(决策 71)。网址是服务商自己去拉,data URL 却要整张塞进请求体。
 *
 * 取 3 MiB(原始字节;编成 data URL 约 4 MiB):常见服务商对单张 base64 图的上限是 5 MB 上下
 * (Anthropic、智谱都是这个数),Gemini 内联数据整条请求 20 MB —— 四张都顶格时约 16 MiB,两头都放得下。
 * 抖音 CDN 的图多是几百 KB 的 webp,正常的作品碰不到这条线;碰到的多半是原图直出的大图,少看一张
 * 胜过整条点评被服务商 413 掉。
 */
export const POST_COMMENT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** AI 看的图最多几张(与 `deliverWork` 同一个数,决策 71)。 */
const POST_COMMENT_IMAGES_MAX = 4;

const DYNAMIC_TYPE_AV = "DYNAMIC_TYPE_AV";
const DYNAMIC_TYPE_DRAW = "DYNAMIC_TYPE_DRAW";
const DYNAMIC_TYPE_WORD = "DYNAMIC_TYPE_WORD";

/**
 * 套进 B 站哪种动态类型(决策 69):带视频 → 视频动态(视频与图都带也算它 —— B 站的视频动态本来就
 * 没有图廊);不带视频、有图 → 图文;只有正文 → 文字。类型用在皮肤契约、选模板、图集、类型过滤、
 * 统计五处,套进去之后那五处一行不用改。
 */
export function extensionPostType(post: Post): string {
	if (post.video) return DYNAMIC_TYPE_AV;
	if (post.images && post.images.length > 0) return DYNAMIC_TYPE_DRAW;
	return DYNAMIC_TYPE_WORD;
}

/** 有字才算有。 */
const filled = (text: string | undefined): text is string => !!text && text.trim() !== "";

/**
 * 过滤看的文字(决策 70):作品正文 + 视频标题。只看内容 —— 四个类型开关对拓展作品一律不看,那是
 * 调用方只过 `filterByText` 的事。
 */
export function extensionPostFilterText(post: Post): string {
	return [post.text, post.video?.title].filter(filled).join("\n");
}

/**
 * 图廊:前 {@link POST_CARD_IMAGES_MAX} 张转成 data URL、带上 BN 读出来的宽高(判长图),gif 标动图
 * (拓展的图是 data URL,B 站「看网址结尾」那一招对它不成立);其余只占着张数 —— `buildGallery` 按
 * 列表的长度数 `+N`,不画的图白编一遍 base64 不值。
 */
function galleryOf(images: readonly Uint8Array[]): GalleryImage[] {
	return images.map((bytes, i) => {
		if (i >= POST_CARD_IMAGES_MAX) return { url: "" };
		return {
			url: imageDataUrl(bytes) ?? BLOCKED_IMG_PLACEHOLDER,
			...readImageSize(bytes),
			animated: sniffImageFormat(bytes) === "gif",
		};
	});
}

/** 视频那一格照 B 站排:时长 `m:ss` / `h:mm:ss`、播放数「1.2万」。没报的格空着,播放数没报就不带。 */
function videoOf(video: NonNullable<Post["video"]>): DynamicVideo {
	return {
		cover: (video.cover && imageDataUrl(video.cover)) || BLOCKED_IMG_PLACEHOLDER,
		title: video.title ?? "",
		duration: video.duration === undefined ? "" : formatDuration(video.duration),
		desc: video.description ?? "",
		...(video.plays === undefined ? {} : { views: numberToStr(video.plays) }),
	};
}

/** 互动数照 B 站卡排;没报的那一项空串(卡上那一项不画),三样都没报就没有互动数。 */
function statsOf(stats: Post["stats"]): DynamicNode["stats"] {
	if (!stats) return undefined;
	const cell = (n: number | undefined) => (n === undefined ? "" : numberToStr(n));
	const out = {
		like: cell(stats.likes),
		comment: cell(stats.comments),
		forward: cell(stats.shares),
	};
	return out.like || out.comment || out.forward ? out : undefined;
}

/**
 * 出卡的 node。发布时间照 B 站卡的写法,视频动态在后面接「· 投稿了视频」(B 站外层卡就是这么贴的)。
 *
 * 话题(决策 55 的 09-24 🔗)照 B 站卡的两种画法:第一个进正文上方那一行标签(`topic`,皮肤契约的
 * `dynamic.topic` / `hasTopic` 也从这里来);正文里照报的名字找到的 `#名字#` / `#名字` 画成富文本话题
 * 那一种 span。
 */
function postNode(post: Post, author: ExtensionCardAuthor): DynamicNode {
	const type = extensionPostType(post);
	const time = formatCardTime(Math.floor(post.publishedAt / 1000));
	return {
		avatarUrl: author.avatarUrl,
		upName: author.name,
		upIsVip: false,
		pubTime: type === DYNAMIC_TYPE_AV ? `${time} · 投稿了视频` : time,
		type,
		topic: post.topics?.[0],
		text: buildPlainText(post.text ?? "", post.topics),
		images: galleryOf(post.images ?? []),
		video: post.video ? videoOf(post.video) : undefined,
		stats: statsOf(post.stats),
	};
}

/** AI 的正文(决策 71):作品正文 +「视频标题：…」,拼法与 B 站那条同款。拼不出字是空串(不点评)。 */
function commentTextOf(post: Post): string {
	const parts: string[] = [];
	if (filled(post.text)) parts.push(post.text);
	if (filled(post.video?.title)) parts.push(`视频标题：${post.video.title}`);
	return parts.join("\n").trim();
}

/** AI 的图(决策 71):作品图 + 视频封面,太大的跳过、让后面的顶上,前 4 张转成 data URL。 */
function commentImagesOf(post: Post): string[] {
	return [...(post.images ?? []), ...(post.video?.cover ? [post.video.cover] : [])]
		.filter((bytes) => bytes.byteLength <= POST_COMMENT_IMAGE_MAX_BYTES)
		.slice(0, POST_COMMENT_IMAGES_MAX)
		.map(imageDataUrl)
		.filter((url): url is string => url !== undefined);
}

export interface ExtensionPostWorkOptions {
	/** 卡上的作者,名字也就是模板的 `{name}`(`extensionCardAuthor` 取好的)。 */
	author: ExtensionCardAuthor;
	/** 平台对作品的叫法(清单 `display.postNoun`);不给就叫「动态」(决策 5)。 */
	postNoun?: string;
}

/**
 * 一条作品 → 装配吃的中立作品。
 *
 * - 卡:`renderCard` 被调到才造 node(关了出图、版式藏起卡片时九张图不必编 base64),交给
 *   `generateNeutralDynamicCard`;
 * - 链接部件是事件的 `url`(决策 77);
 * - 不附图集(决策 72:图集载荷只带网址,拓展交的是字节);
 * - AI 的图同理,点评真要看时才编(`commentImages` 是个只算一次的 getter)。
 */
export function extensionPostWork(post: Post, opts: ExtensionPostWorkOptions): NeutralWork {
	let commentImages: string[] | undefined;
	return {
		renderCard: (image, colorOptions) =>
			image.generateNeutralDynamicCard(postNode(post, opts.author), colorOptions),
		link: post.url,
		name: opts.author.name,
		isVideo: post.video !== undefined,
		commentText: commentTextOf(post),
		get commentImages() {
			commentImages ??= commentImagesOf(post);
			return commentImages;
		},
		postNoun: filled(opts.postNoun) ? opts.postNoun : "动态",
		gallery: [],
	};
}
