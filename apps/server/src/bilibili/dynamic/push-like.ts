/**
 * 平台中立的推送出口接口与最小订阅视图。
 *
 * dynamic-engine 不直接 import `@bilibili-notify/push`;宿主(独立端 runtime)在装配
 * DynamicEngine 时实现 PushLike,并桥接到 PushRouter 的 channel 路由。
 *
 * 这里的接口仅声明 dynamic-engine 实际调用到的方法;任何字段/方法的扩展应该先在
 * 业务代码中显现需求,再回填到此接口,避免接口与实现脱节。
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import type { CardSkinChoice } from "@bilibili-notify/image";
import type {
	ExtraKey,
	MessageKindLayout,
	PostFilterReason,
	PostImage,
	PushMessageRole,
} from "@bilibili-notify/internal";
import type { PostFilterSettings } from "./post-filter";

/** dynamic-engine 渲染好的图片缓冲（无 mime/扩展信息时默认 image/jpeg）。 */
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
 * 一次作品推送里的一个锚点 —— 推送层 `PushAnchor` 在引擎这一侧的样子:本体(主卡,可能按消息
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
}

/**
 * 一次作品推送,整个交给宿主:主卡加图集是同一次(历史落同一行)。特性恒为作品,所以没有
 * 特性那一格;`uid` 由宿主换成订阅 id。
 */
export interface PostPush {
	uid: string;
	/** 按顺序排好的锚点。本体至多一个,有的话排第一个。 */
	anchors: PostPushAnchor[];
}

/**
 * 一条被过滤挡下的作品,交给宿主留痕(推送历史里的一行 `filtered`,ADR-0021 决策 34 的 🔗)。它不是推送:
 * 不出卡、不抓图、不调 AI,所以不走 {@link PushLike},走引擎选项里的 `onPostFiltered`。`uid` 由宿主换成订阅 id。
 */
export interface FilteredPost {
	uid: string;
	/** 被哪一类规则挡下的。 */
	filteredBy: PostFilterReason;
	/** 这条作品的整条文字:`postText(post, "plain")`,过滤看的就是这一份。没截过,摘要由宿主截。 */
	text: string;
	/** 原帖地址(动态页)。 */
	url: string;
}

export interface PushLike {
	/**
	 * 把一次作品推送交给推送层。开关、静音与免扰在交出去那一刻判一次;本体发完时返回,
	 * 附加项在后台按锚点先后接着发。
	 */
	push(push: PostPush): Promise<void>;

	/** 私信发送给配置的管理员账号（master）。adapter 端校验启用状态与 bot 在线性。 */
	sendPrivateMsg(content: string): Promise<void>;

	/** 与 sendPrivateMsg 等价，但 adapter 应当在内部把内容追加到 error 日志。 */
	sendErrorMsg(reason: string): Promise<void>;
}

/**
 * 平台中立的订阅条目最小视图。宿主折叠 `Subscription.overrides` 后填入。
 *
 * `filter` / `aiOverride` 为 per-UP 覆盖(可选);缺失时 engine 回退到
 * `DynamicEngineConfig.filter` / 全局 CommentaryGenerator 配置。
 */
export interface SubItemView {
	uid: string;
	uname: string;
	/**
	 * 这条订阅在核心里的 id(`Subscription.id`),由宿主 `buildDynamicSubViewSingle` 填。引擎认人靠 `uid`,
	 * 出卡时按它向宿主现读资料里的头像(`avatarOf`)。
	 */
	subscriptionId: string;
	post?: boolean;
	customCardStyle?: {
		enable?: boolean;
		// 🪦 `backgroundImage` / `backgroundImages` 2026-09-20 随整条链删掉 —— 背景图归皮肤
		// 自己的 `image` 旋钮(`--bn-knob-wallpaper`),不再从样式覆盖里透传。
		/**
		 * 字体家族名;透传给 generatePostCard 的 colorOptions(缺省回退全局)。
		 * 此前整条链都漏着,per-UP 换字体选了等于没选。
		 */
		font?: string;
		/** 主人自带字体的资产 id(独立端专属);设了优先于 `font`,缺省回退全局。 */
		fontAsset?: string;
	};
	/** Per-UP 作品过滤覆盖(折好的 `ContentFilters`);undefined 时使用 engine 的全局 filter。 */
	filter?: PostFilterSettings;
	/** Per-UP AI 覆盖；undefined 时使用 CommentaryGenerator 的全局 config。 */
	aiOverride?: CommentaryCallOverride;
	/**
	 * Per-UP 是否推送动态图集图片;undefined 继承 engine config `imageGroup.enabled`。
	 * Adapter 折叠 `Subscription.overrides.imageGroup.enabled` 后填入。
	 */
	imageGroupEnabled?: boolean;
	/**
	 * Per-UP 图集合并转发开关;undefined 继承 engine config `imageGroup.mergeForward`。
	 * 单图永远不走合并转发(在 engine 内已守卫)。
	 */
	imageGroupMergeForward?: boolean;
	/**
	 * Per-UP 非视频动态文本模板;undefined 继承 engine config `dynamicTemplate`。
	 * Adapter 折叠 `Subscription.overrides.templates.post` 后填入。
	 */
	customDynamicTemplate?: string;
	/**
	 * Per-UP 视频投稿文本模板;undefined 继承 engine config `videoTemplate`。
	 * Adapter 折叠 `Subscription.overrides.templates.postVideo` 后填入。
	 */
	customVideoTemplate?: string;
	/**
	 * Per-UP 生效的**卡片皮肤 id**(ADR-0014)。宿主折叠 `eff.cardSkin` 后填入;
	 * undefined = 内置默认皮肤。dynamic-engine 渲染时透传给 generatePostCard 的
	 * colorOptions —— 版式住皮肤包里,不再逐块下发。
	 */
	cardSkin?: string;
	/**
	 * Per-UP 自己那层**皮肤旋钮覆盖**,按皮肤 id 分(`overrides.cardSkinKnobs` 原样,ADR-0014
	 * 决策 17 的 🔗)。undefined = 一枚都没单独拧。与 `cardSkin` 一起透传给出卡的 colorOptions,
	 * 渲染器在出图时与全局那份逐枚合并 —— 所以这里不折全局值,快照也就不会把全局冻住。
	 */
	cardSkinKnobs?: CardSkinChoice["cardSkinKnobs"];
	/**
	 * Per-UP 解析后的**消息版式**动态切片(块顺序 / 显隐 / 分条符 + 分隔符)。宿主折叠
	 * `eff.messageLayout.post` 后填入。引擎按版式装配消息:文本模板以 url='' 渲染
	 * (模板里没有链接变量),链接独立成部件。
	 */
	messageLayout: MessageKindLayout;
}

export type SubscriptionsView = Record<string, SubItemView>;
export type SubManagerView = Map<string, SubItemView>;

/**
 * 宿主提供给 engine 的增量操作描述:独立端在 SubscriptionStore 写入后转译为
 * SubscriptionOpView 列表,交给 engine.applyOps。
 */
export type SubscriptionOpView =
	| { kind: "add"; sub: SubItemView }
	| { kind: "delete"; uid: string }
	| {
			kind: "update";
			uid: string;
			changes: Array<{ scope: string; post?: boolean }>;
	  };
