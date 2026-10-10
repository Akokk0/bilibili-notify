/**
 * 作品模型(ADR-0021 决策 19–25、ADR-0028 决策 1;形状全文在 `docs/1.0/data-model.md`「作品」)。
 *
 * 所有来源交上来的作品都是这一个形状,核心不认识任何平台。3a 建 `posts/` 时整个搬过去。
 */

import type { ImageRef } from "./constants";

/** 出卡认 `ref`;`url` 给「查看原图」;抓不到图库的图(B 站抓图失败)时出卡仍靠它画。 */
export interface PostImage {
	ref?: ImageRef;
	url?: string;
	width?: number;
	height?: number;
	isAnimated?: boolean;
}

export interface Creator {
	name: string;
	avatar?: ImageRef;
	isPremium?: boolean;
}

/**
 * 正文的一个片段,只用来出卡高亮。五种,全中立:换行留在 `text` 里当 `\n`;`topic.name` 不带 `#`;
 * `emoji.text` 是「[doge]」这种代码,没图时当文字画。卡片只画片段的 `text`(有图标就画图标)。
 */
export type RichTextSegment =
	| { kind: "text"; text: string }
	| { kind: "mention"; text: string; userId?: string }
	| { kind: "topic"; text: string; name: string }
	| { kind: "link"; text: string; url: string; icon?: ImageRef }
	| { kind: "emoji"; text: string; image?: ImageRef };

export type RichText = RichTextSegment[];

/** 附加块:封闭联合,出图器按种类直接画。 */
export type Attachment =
	| {
			kind: "card";
			eyebrow?: string;
			cover?: PostImage;
			title: string;
			lines?: { text: string; icon?: ImageRef }[];
			button?: { text: string; enabled: boolean };
	  }
	| { kind: "video"; cover: PostImage; title: string; durationSec?: number; subtitle?: string }
	| {
			kind: "goods";
			eyebrow?: string;
			items: { cover: PostImage; name: string; price?: string }[];
	  };

export interface Post {
	creator: Creator;
	/** ISO 时间。 */
	publishedAt: string;
	/** 「投稿了视频」这类说明,来源给。 */
	label?: string;
	topic?: string;
	/** 有这格就按文章排版;`images` 是文章配图。 */
	article?: { title: string; images?: PostImage[] };
	/** 有标题、但不是文章的作品(带标题的图文、笔记)的标题:画在正文上方,排版照普通作品。 */
	title?: string;
	/** 纯文本,只放正文;标题、视频标题、被转发的原作品各在自己的格里。 */
	text: string;
	/** 片段的 `text` 拼起来必须等于 `text`,见 {@link normalizePost}。 */
	richText?: RichText;
	/** BN 自己说的一句,画在正文后面。 */
	notice?: string;
	/** 专属内容锁,替掉正文。 */
	locked?: { icon?: PostImage; title: string; hint: string };
	/** 只表示图集。 */
	images?: PostImage[];
	/**
	 * 作品本身就是这个视频。播放与弹幕是视频自己的展示数字,点赞评论转发在 `stats`。
	 * 时长选填(与 `Attachment.video` 一致):直播回放、首映这类没有时长,缺了就不画时长角标。
	 */
	video?: {
		cover: PostImage;
		title: string;
		description: string;
		durationSec?: number;
		views?: number;
		danmaku?: number;
	};
	attachment?: Attachment;
	/** 被转发的原作品。 */
	repost?: Post;
	stats?: { shares?: number; comments?: number; likes?: number };
}

/**
 * 作品被过滤挡下的原因(六种)。过滤本体(`filterPost`)住在服务端,词表住这儿:历史行的 `filteredBy`
 * 记的就是它(`schema/history.ts`),面板按它写「屏蔽关键词」「未命中白名单」这些字。
 * 前五种是屏蔽规则命中,最后一种是有白名单而没命中 —— 总称「过滤」,不叫「屏蔽」。
 */
export const PostFilterReason = {
	BlockedKeyword: "blocked-keyword",
	BlockedReposts: "blocked-reposts",
	BlockedArticles: "blocked-articles",
	BlockedImages: "blocked-images",
	BlockedVideos: "blocked-videos",
	AllowlistUnmatched: "allowlist-unmatched",
} as const;
export type PostFilterReason = (typeof PostFilterReason)[keyof typeof PostFilterReason];

const richTextMatches = (post: Post): boolean =>
	post.richText === undefined || post.richText.map((s) => s.text).join("") === post.text;

/**
 * 收件口的整理:片段的字拼起来不等于正文就丢掉 `richText`、只用 `text`(所有来源同一套),被转发的原作品一起查。
 * 没有要整理的就回原对象。
 */
export function normalizePost(post: Post): Post {
	const repost = post.repost && normalizePost(post.repost);
	const keepRichText = richTextMatches(post);
	if (keepRichText && repost === post.repost) return post;
	const { richText, ...rest } = post;
	return {
		...rest,
		...(keepRichText && richText !== undefined ? { richText } : {}),
		...(repost ? { repost } : {}),
	};
}
