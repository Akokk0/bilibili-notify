/**
 * 平台中立的推送出口接口与最小订阅视图。
 *
 * dynamic-engine 不直接 import `@bilibili-notify/push`;宿主(独立端 runtime)在装配
 * DynamicEngine 时实现 PushLike,并桥接到 BilibiliPush 的 channel 路由。
 *
 * 这里的接口仅声明 dynamic-engine 实际调用到的方法;任何字段/方法的扩展应该先在
 * 业务代码中显现需求,再回填到此接口,避免接口与实现脱节。
 */

import type { CommentaryCallOverride } from "@bilibili-notify/ai";
import type { CardSkinChoice } from "@bilibili-notify/image";
import type { ForwardImage, MessageKindLayout } from "@bilibili-notify/internal";
import type { DynamicFilterConfig } from "./types";

/** dynamic-engine 渲染好的图片缓冲（无 mime/扩展信息时默认 image/jpeg）。 */
export interface PushImagePart {
	type: "image";
	buffer: Buffer;
	mime: string;
}

/** 文本片段。 */
export interface PushTextPart {
	type: "text";
	text: string;
}

/** 用于「专题」转发图集等需要折叠成 forward message 的多段图片。 */
export interface PushImageGroup {
	type: "image-group";
	forward: boolean;
	/** 图集单图(url + 可选 B站原始尺寸,透传给需要尺寸的平台如 QQ 原生 markdown)。 */
	images: ForwardImage[];
}

export type PushSegment = PushImagePart | PushTextPart | PushImageGroup;

/**
 * dynamic-engine 仅需以下三类语义化推送动作。
 * 业务核心调用前已经决定好「此次推送的目标维度」（通过 uid + PushKind），
 * adapter 负责把它翻译为具体平台的 channel 列表 / atAll / 图片折叠等行为。
 */
export type PushKind =
	| /** 主体动态卡片：可能携带图片 + 文本 */ "dynamic"
	| /** 动态附图（DYNAMIC_TYPE_DRAW 的多张原图，转发消息形式） */ "dynamic-images";

/** 一次广播的身份:主卡与图集共用同一个 pushId,宿主的历史落同一行。 */
export interface DynamicBroadcastOptions {
	pushId?: string;
}

/**
 * 一次 `broadcastDynamic` 交给推送层(`BilibiliPush.broadcastToFeature`)的选项。
 *
 * 背景:一条 DYNAMIC_TYPE_DRAW 图文动态(开启图集推送时)会发**两次** —— 主卡片
 * (`kind="dynamic"`)与图集附图(`kind="dynamic-images"`),两者都映射到
 * `feature="dynamic"`,而且是**同一次推送**:图集是主卡片的附加项(`role: "extra"`,
 * 历史里追加到同一行),并且显式抑制 @全体 —— 若都进 @全体 分支,接收端会被**重复
 * 艾特全体**(主卡片 @ 一次、图集又 @ 一次)。主卡片只带 pushId,维持「按 feature
 * 决定」的 @全体。没有 pushId(屏蔽提示这类独立小推送)就什么都不带,推送层自己起一个。
 *
 * 抑制 @全体 是「图集」这个身份带来的,与有没有 pushId 无关 —— 两者绑在一起时,一次不带
 * pushId 的图集广播会悄悄把 @全体 放回来,正是这个函数存在的理由。
 */
export function broadcastOptsForDynamicKind(
	kind: PushKind,
	pushId: string | undefined,
): { pushId?: string; allowAtAll?: false; role?: "extra" } | undefined {
	if (kind === "dynamic-images") return { pushId, allowAtAll: false, role: "extra" };
	return pushId === undefined ? undefined : { pushId };
}

export interface PushLike {
	/**
	 * 向某个 UP 主对应的全部订阅频道广播一段消息。
	 * - kind="dynamic"：主卡片消息，包含 image + text 段。
	 * - kind="dynamic-images"：DYNAMIC_TYPE_DRAW 的图集，adapter 通常以 forward message 投递。
	 */
	broadcastDynamic(
		uid: string,
		segments: PushSegment[],
		kind: PushKind,
		opts?: DynamicBroadcastOptions,
	): Promise<void>;

	/**
	 * 消息版式分条:一次推送拆成多条消息的序列广播。语义要求(由 BilibiliPush 的
	 * payload 序列实现):同一 target 内按序发送;某条失败即中止该 target 的后续条;
	 * @全体(若启用)只跟随序列首条之前发一次。
	 */
	broadcastDynamicSequence(
		uid: string,
		messages: PushSegment[][],
		kind: PushKind,
		opts?: DynamicBroadcastOptions,
	): Promise<void>;

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
	dynamic?: boolean;
	customCardStyle?: {
		enable?: boolean;
		// 🪦 `backgroundImage` / `backgroundImages` 2026-09-20 随整条链删掉 —— 背景图归皮肤
		// 自己的 `image` 旋钮(`--bn-knob-wallpaper`),不再从样式覆盖里透传。
		/**
		 * 字体家族名;透传给 generateDynamicCard 的 colorOptions(缺省回退全局)。
		 * 此前整条链都漏着,per-UP 换字体选了等于没选。
		 */
		font?: string;
		/** 主人自带字体的资产 id(独立端专属);设了优先于 `font`,缺省回退全局。 */
		fontAsset?: string;
	};
	/** Per-UP 动态过滤覆盖；undefined 时使用 engine 的全局 filter。 */
	filter?: DynamicFilterConfig & { notify?: boolean };
	/** Per-UP AI 覆盖；undefined 时使用 CommentaryGenerator 的全局 config。 */
	aiOverride?: CommentaryCallOverride;
	/**
	 * Per-UP 是否推送动态图集图片;undefined 继承 engine config `imageGroup.enable`。
	 * Adapter 折叠 `Subscription.overrides.imageGroup.enable` 后填入。
	 */
	imageGroupEnable?: boolean;
	/**
	 * Per-UP 图集合并转发开关;undefined 继承 engine config `imageGroup.forward`。
	 * 单图永远不走合并转发(在 engine 内已守卫)。
	 */
	imageGroupForward?: boolean;
	/**
	 * Per-UP 非视频动态文本模板;undefined 继承 engine config `dynamicTemplate`。
	 * Adapter 折叠 `Subscription.overrides.templates.dynamic` 后填入。
	 */
	customDynamicTemplate?: string;
	/**
	 * Per-UP 视频投稿文本模板;undefined 继承 engine config `videoTemplate`。
	 * Adapter 折叠 `Subscription.overrides.templates.dynamicVideo` 后填入。
	 */
	customVideoTemplate?: string;
	/**
	 * Per-UP 生效的**卡片皮肤 id**(ADR-0014)。宿主折叠 `eff.cardSkin` 后填入;
	 * undefined = 内置默认皮肤。dynamic-engine 渲染时透传给 generateDynamicCard 的
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
	 * `eff.messageLayout.dynamic` 后填入。引擎按版式装配消息:文本模板以 url='' 渲染
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
	| { type: "add"; sub: SubItemView }
	| { type: "delete"; uid: string }
	| {
			type: "update";
			uid: string;
			changes: Array<{ scope: string; dynamic?: boolean }>;
	  };
