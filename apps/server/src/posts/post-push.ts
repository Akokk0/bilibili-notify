/**
 * 作品推送的平台中立片段:一次作品推送里的锚点与它装的消息段。装配(`deliver-post.ts`)产出它们,
 * 宿主把它们交给推送层(`boundPostPush`)。
 */

import type {
	ExtraKey,
	PostFilterReason,
	PostImage,
	PushMessageRole,
} from "@bilibili-notify/internal";

/**
 * 一条被过滤挡下的作品,交给宿主留痕(推送历史里的一行 `filtered`,ADR-0021 决策 34 的 🔗)。它不是推送:
 * 不出卡、不调 AI、不往外发任何东西,所以不走推送口,走装配依赖里的 `recordFiltered`。
 */
export interface FilteredPost {
	subscriptionId: string;
	/** 被哪一类规则挡下的。 */
	filteredBy: PostFilterReason;
	/** 这条作品的整条文字:`postText(post, "plain")`,过滤看的就是这一份。没截过,摘要由宿主截。 */
	text: string;
	/** 原帖地址。 */
	url: string;
}

/** 渲染好的图片缓冲（无 mime/扩展信息时默认 image/jpeg）。 */
export interface PushImagePart {
	kind: "image";
	buffer: Buffer;
	mime: string;
}

/** 文本片段。 */
export interface PushTextPart {
	kind: "text";
	text: string;
}

/** 用于「专题」转发图集等需要折叠成 forward message 的多段图片。 */
export interface PushImageGroup {
	kind: "image-group";
	mergeForward: boolean;
	/** 图集单图(url + 可选 B站原始尺寸,透传给需要尺寸的平台如 QQ 原生 markdown)。 */
	images: PostImage[];
}

export type PushSegment = PushImagePart | PushTextPart | PushImageGroup;

/**
 * 一次作品推送里的一个锚点 —— 推送层 `PushAnchor` 在作品装配这一侧的样子:本体(主卡,可能按消息
 * 版式分成几条),或一个附加项(图集)。锚点按先后发;附加项永不带 @全体,所以一条图文动态
 * 不会在主卡和图集各 @ 一次。
 */
export interface PostPushAnchor {
	/** 本体(`main`)还是附加项(`extra`)。 */
	role: PushMessageRole;
	/** 附加项的键:给了按那张三态表筛目标;不给(图集)发给路由里所有启用的目标。只对 `extra` 有意义。 */
	extra?: ExtraKey;
	/**
	 * 这个锚点的消息,只收一串:一条消息就是单元素,几条是分条序列(同一目标顺序发、一条失败
	 * 中止该目标这个锚点里的后续条)。也可以是一个「等会儿给」的约定;最后为空就跳过。
	 */
	messages: PushSegment[][] | Promise<PushSegment[][] | undefined>;
	/**
	 * 同一个锚点的 AI 写的那一份(ADR-0032 决策 2),形状同 `messages`。只有本体会带:`messages` 是模板版,
	 * 推送层按目标在两份里挑。没有就是没做 AI 版,所有目标用 `messages`。
	 */
	aiMessages?: PushSegment[][] | Promise<PushSegment[][] | undefined>;
}
