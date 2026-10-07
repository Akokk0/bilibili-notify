/** @jsxImportSource vue */

/**
 * `Post` → 作品卡的节点(`PostNode`)(㉑c 第 5 步)。
 *
 * 出图器只认中立的 `Post`,不认识任何平台的原始字段。这一层把一份作品造成卡片块吃的呈现态:皮肤契约要的
 * 那几格(图廊张数 / 首图、转发内层那一份)都记在节点上。B 站动态与拓展作品都是先翻成 `Post`
 * 再走这一层,出图器内部只剩这一种入口。
 *
 * 几条「出卡时照旧拼回去」的约定:
 * - 发布时间与 `label` 在模型里是分开的,在节点上也是分开的(`time` 只有时间、`label` 单独一格,内外层卡都填);
 *   外层卡拼成「时间 · 投稿了视频」、被转发的内层卡把 `label` 接在作者名后,那是默认皮肤的块的事(见 `blocks/post.tsx`);
 * - `title` 与 `article` 是两种画法:专栏(有 `article`)走 innerHTML 那条五行截断的路,`title` 是带标题的
 *   普通作品,画在正文上方,排版照普通作品;
 * - `notice` 画成紧跟正文之后的一句 `<p>`,正文没有字时只剩这句 `<p>`;
 * - 互动数只有外层卡画。
 *
 * **图只认引用与地址**(㉑d):`PostImage.ref` / `Creator.avatar` / `RichText` 的 `link.icon` · `emoji.image` / 附加块
 * `lines[].icon` 都是图库引用,由调用方给的 {@link PostNodeFormatters.imageUrl} 解析成可画的地址(出图器不读盘、
 * 不联网)。`ref` 与 `url` 都有时认 `ref`;只有 `url` 的(B 站出卡前抓进图库,抓不到的)照旧画 `url`;两样都没有、或引用解析不到
 * (图已被清扫)画占位,不抛。没有 `Creator.avatar` 就不画头像(头像块整块收起)。
 */

import { formatClock, formatCount, type Post, type PostImage } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { type ImageUrlOf, renderRichText } from "../rich-text";
import { BLOCKED_IMG_PLACEHOLDER } from "../skin/render-skin";
import { attachmentNode } from "./attachment";
import { pictureUrl } from "./picture-url";
import type { GalleryImage, PostNode, PostNodeVideo } from "./post-content";

/** 注入的格式化器:时间按机器本地时区排,由出图器给(行为不变)。 */
export interface PostNodeFormatters {
	/** unix 秒 → 卡上的时间字符串。 */
	time: (seconds: number) => string;
	/**
	 * 图库引用 → 可画的地址(调用方事先把这张作品里用到的引用都解析好,这里同步查)。不给或解析不到的引用画占位。
	 */
	imageUrl?: ImageUrlOf;
}

/**
 * 图廊:每张图一格,地址见 {@link pictureUrl}(没有地址与引用解析不到的画占位)。张数照实数 —— 图廊自己按
 * 上限只铺前几格、余下的折进 `+N`,所以排在后面、来源没往图库存的图可以什么地址都没有。
 */
function galleryOf(
	images: readonly PostImage[] | undefined,
	imageUrl: ImageUrlOf | undefined,
): GalleryImage[] {
	return (images ?? []).map((image) => ({
		url: pictureUrl(image, imageUrl),
		width: image.width,
		height: image.height,
		animated: image.isAnimated,
	}));
}

/** 视频那张卡的数据。播放 / 弹幕 / 时长是数字,统一由 internal 排版;缺了哪一格就不带哪一格。 */
function videoOf(
	video: NonNullable<Post["video"]>,
	imageUrl: ImageUrlOf | undefined,
): PostNodeVideo {
	return {
		cover: pictureUrl(video.cover, imageUrl),
		duration: video.durationSec === undefined ? "" : formatClock(video.durationSec),
		title: video.title,
		description: video.description,
		...(video.views === undefined ? {} : { views: formatCount(video.views) }),
		...(video.danmaku === undefined ? {} : { danmaku: formatCount(video.danmaku) }),
	};
}

/** 互动数:某一项空串 = 没有这一项(那一格连图标一起不画);三项都没有就整个没有。 */
function statsOf(stats: Post["stats"]): PostNode["stats"] {
	if (!stats) return undefined;
	const cell = (n: number | undefined) => (n === undefined ? "" : formatCount(n));
	const out = {
		shares: cell(stats.shares),
		comments: cell(stats.comments),
		likes: cell(stats.likes),
	};
	return out.shares || out.comments || out.likes ? out : undefined;
}

/**
 * 正文:有 `article` 走专栏那条路(五行截断,全文转义拼进 innerHTML),标题是 `article.title`;否则是普通正文,
 * 标题是 `title`,画在正文上方。没有字也没有标题就不画。
 */
function bodyOf(post: Post, imageUrl: ImageUrlOf | undefined): VNode | null {
	const asArticle = post.article !== undefined;
	const title = (asArticle ? post.article?.title : post.title) || undefined;
	const segments =
		post.richText ?? (post.text === "" ? [] : [{ kind: "text" as const, text: post.text }]);
	if (segments.length === 0 && !title) return null;
	return renderRichText(segments, title, asArticle, imageUrl);
}

/** 充电专属占位:徽标图(有地址才画)+ 标题 + 说明。颜色是出卡器自己的(B 站粉 / 灰),不动。 */
function lockedNode(locked: NonNullable<Post["locked"]>, imageUrl: ImageUrlOf | undefined): VNode {
	const hasIcon = locked.icon?.ref !== undefined || locked.icon?.url !== undefined;
	return (
		<div class="flex flex-col items-center justify-center gap-[8px] py-[20px] text-center">
			{hasIcon ? (
				<img class="w-[28px] h-[28px]" src={pictureUrl(locked.icon, imageUrl)} alt="" />
			) : null}
			<div class="text-[14px] font-bold [color:var(--bn-accent)]" style="--bn-accent: #FB7299;">
				{locked.title}
			</div>
			<div class="text-[12px] [color:var(--bn-ink-faint)]" style="--bn-ink-faint: #999;">
				{locked.hint}
			</div>
		</div>
	);
}

/** 正文那一格:充电专属替掉正文;`notice` 紧跟在正文之后(正文没字时只剩这一句)。 */
function textOf(post: Post, imageUrl: ImageUrlOf | undefined): VNode | null {
	if (post.locked) return lockedNode(post.locked, imageUrl);
	const body = bodyOf(post, imageUrl);
	if (post.notice === undefined) return body;
	return body ? (
		<>
			{body}
			<p>{post.notice}</p>
		</>
	) : (
		<p>{post.notice}</p>
	);
}

function build(post: Post, fmt: PostNodeFormatters, isRepost: boolean): PostNode {
	const seconds = Math.floor(Date.parse(post.publishedAt) / 1000);
	const time = fmt.time(seconds);
	const node: PostNode = {
		creatorName: post.creator.name,
		creatorIsPremium: post.creator.isPremium === true,
		// 时间只是时间;动作标签单独一格,内外层卡都填(画在哪由块定)。
		time,
		topic: post.topic || undefined,
		attachment: post.attachment ? attachmentNode(post.attachment, fmt.imageUrl) : null,
		// 内层不展示互动数(版式上 stats 块自动收起)。
		stats: isRepost ? undefined : statsOf(post.stats),
	};
	if (post.label) node.label = post.label;
	if (isRepost) node.isReposted = true;
	// 头像:有引用就画(解析不到画占位,留一块空的头像位),没有引用头像块整块收起。
	if (post.creator.avatar !== undefined) {
		node.creatorAvatarUrl = fmt.imageUrl?.(post.creator.avatar) ?? BLOCKED_IMG_PLACEHOLDER;
	}
	const text = textOf(post, fmt.imageUrl);
	if (text) node.text = text;
	const images = galleryOf(post.article ? post.article.images : post.images, fmt.imageUrl);
	if (images.length > 0) node.images = images;
	if (post.video) node.video = videoOf(post.video, fmt.imageUrl);
	if (post.repost) node.repost = build(post.repost, fmt, true);
	return node;
}

/** 一份 `Post` → 作品卡的节点。被转发的原作品(`repost`)递归成 `node.repost`。 */
export function nodeFromPost(post: Post, fmt: PostNodeFormatters): PostNode {
	return build(post, fmt, false);
}
