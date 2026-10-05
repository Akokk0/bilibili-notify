/** @jsxImportSource vue */

/**
 * `Post` → 动态卡的节点(`DynamicNode`)(㉑c 第 5 步)。
 *
 * 出图器只认中立的 `Post`,不认识任何平台的原始字段。这一层把一份作品造成卡片块吃的呈现态:皮肤契约要的
 * 那几格(动态类型、图廊张数 / 首图、转发内层那一份)都记在节点上。**同一份节点**也是拓展作品那条路的旧入口
 * (`generateNeutralDynamicCard(node)`)吃的 —— 拓展那条路到 ㉑d 才切过来,所以节点类型留着。
 *
 * 几条「出卡时照旧拼回去」的约定(形状不逼的字节一个都不动,留给 ㉔):
 * - 发布时间与 `label` 在模型里是分开的:外层卡拼成「时间 · 投稿了视频」,被转发的内层卡把 `label` 接在作者名后;
 * - `dynamic.type`(皮肤契约的 `DYNAMIC_TYPE_*`)从形状推,见 {@link dynamicTypeOf};
 * - `title` 与 `article` 是两种画法:专栏(有 `article`)走 innerHTML 那条五行截断的路,`title` 是带标题的
 *   普通作品,画在正文上方,排版照普通作品;
 * - `notice` 画成紧跟正文之后的一句 `<p>`,正文没有字时只剩这句 `<p>`;
 * - 互动数只有外层卡画。
 *
 * 头像:`Creator.avatar` 只收图库引用,出图器要到 ㉑d 才会按引用取图,目前不画头像。图也一样 ——
 * 目前只认 `PostImage.url`,没有 `url` 的(只有 `ref`)那一张不画。
 */

import { formatClock, formatCount, type Post, type PostImage } from "@bilibili-notify/internal";
import type { VNode } from "vue";
import { renderRichText } from "../rich-text";
import { attachmentNode } from "./attachment";
import type { DynamicNode, DynamicVideo, GalleryImage } from "./dynamic-content";

/** 注入的格式化器:时间按机器本地时区排,由出图器给(行为不变)。 */
export interface PostNodeFormatters {
	/** unix 秒 → 卡上的时间字符串。 */
	time: (seconds: number) => string;
}

const DYNAMIC_TYPE_AV = "DYNAMIC_TYPE_AV";
const DYNAMIC_TYPE_FORWARD = "DYNAMIC_TYPE_FORWARD";
const DYNAMIC_TYPE_ARTICLE = "DYNAMIC_TYPE_ARTICLE";
const DYNAMIC_TYPE_DRAW = "DYNAMIC_TYPE_DRAW";
const DYNAMIC_TYPE_WORD = "DYNAMIC_TYPE_WORD";

/**
 * 皮肤契约的 `dynamic.type` 从形状推:有视频 → AV,有被转发的原作品 → FORWARD,专栏 → ARTICLE,有图集 → DRAW,
 * 其余 → WORD。「暂时无法渲染」那一族(收藏夹、番剧、直播预约…)的原值在 `Post` 里不存在,按其余算(默认皮肤不引用它)。
 */
function dynamicTypeOf(post: Post): string {
	if (post.video) return DYNAMIC_TYPE_AV;
	if (post.repost) return DYNAMIC_TYPE_FORWARD;
	if (post.article) return DYNAMIC_TYPE_ARTICLE;
	if ((post.images?.length ?? 0) > 0) return DYNAMIC_TYPE_DRAW;
	return DYNAMIC_TYPE_WORD;
}

/** 出卡认 `PostImage.url`(`ref` 要到 ㉑d 才有图库可取);没有地址的那张不画。 */
function galleryOf(images: readonly PostImage[] | undefined): GalleryImage[] {
	const out: GalleryImage[] = [];
	for (const image of images ?? []) {
		if (image.url === undefined) continue;
		out.push({
			url: image.url,
			width: image.width,
			height: image.height,
			animated: image.isAnimated,
		});
	}
	return out;
}

/** 视频那张卡的数据。播放 / 弹幕 / 时长是数字,统一由 internal 排版;缺了哪一格就不带哪一格。 */
function videoOf(video: NonNullable<Post["video"]>): DynamicVideo {
	return {
		cover: video.cover.url ?? "",
		duration: video.durationSec === undefined ? "" : formatClock(video.durationSec),
		title: video.title,
		desc: video.description,
		...(video.views === undefined ? {} : { views: formatCount(video.views) }),
		...(video.danmaku === undefined ? {} : { danmaku: formatCount(video.danmaku) }),
	};
}

/** 互动数:某一项空串 = 没有这一项(那一格连图标一起不画);三项都没有就整个没有。 */
function statsOf(stats: Post["stats"]): DynamicNode["stats"] {
	if (!stats) return undefined;
	const cell = (n: number | undefined) => (n === undefined ? "" : formatCount(n));
	const out = {
		forward: cell(stats.shares),
		comment: cell(stats.comments),
		like: cell(stats.likes),
	};
	return out.forward || out.comment || out.like ? out : undefined;
}

/**
 * 正文:有 `article` 走专栏那条路(五行截断,全文转义拼进 innerHTML),标题是 `article.title`;否则是普通正文,
 * 标题是 `title`,画在正文上方。没有字也没有标题就不画。
 */
function bodyOf(post: Post): VNode | null {
	const asArticle = post.article !== undefined;
	const title = (asArticle ? post.article?.title : post.title) || undefined;
	const segments =
		post.richText ?? (post.text === "" ? [] : [{ kind: "text" as const, text: post.text }]);
	if (segments.length === 0 && !title) return null;
	return renderRichText(segments, title, asArticle);
}

/** 充电专属占位:徽标图(有地址才画)+ 标题 + 说明。颜色是出卡器自己的(B 站粉 / 灰),不动。 */
function lockedNode(locked: NonNullable<Post["locked"]>): VNode {
	return (
		<div class="flex flex-col items-center justify-center gap-[8px] py-[20px] text-center">
			{locked.icon?.url ? <img class="w-[28px] h-[28px]" src={locked.icon.url} alt="" /> : null}
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
function textOf(post: Post): VNode | null {
	if (post.locked) return lockedNode(post.locked);
	const body = bodyOf(post);
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

function build(post: Post, fmt: PostNodeFormatters, isRepost: boolean): DynamicNode {
	const seconds = Math.floor(Date.parse(post.publishedAt) / 1000);
	const time = fmt.time(seconds);
	const node: DynamicNode = {
		upName: post.creator.name,
		upIsVip: post.creator.isPremium === true,
		// 外层卡:类型标签接在发布时间后;被转发的内层卡:接在作者名后(`headerLabel`)。
		pubTime: !isRepost && post.label ? `${time} · ${post.label}` : time,
		type: dynamicTypeOf(post),
		topic: post.topic || undefined,
		additional: post.attachment ? attachmentNode(post.attachment) : null,
		// 内层不展示互动数(版式上 stats 块自动收起)。
		stats: isRepost ? undefined : statsOf(post.stats),
	};
	if (isRepost && post.label) node.headerLabel = post.label;
	const text = textOf(post);
	if (text) node.text = text;
	const images = galleryOf(post.article ? post.article.images : post.images);
	if (images.length > 0) node.images = images;
	if (post.video) node.video = videoOf(post.video);
	if (post.repost) node.forward = build(post.repost, fmt, true);
	return node;
}

/** 一份 `Post` → 动态卡的节点。被转发的原作品(`repost`)递归成 `node.forward`。 */
export function nodeFromPost(post: Post, fmt: PostNodeFormatters): DynamicNode {
	return build(post, fmt, false);
}
