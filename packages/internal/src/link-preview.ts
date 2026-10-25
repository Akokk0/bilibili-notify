/**
 * 链接预览的跨平台接口(ADR-0029;形状全文在 `docs/1.0/subscription-sources.md`「横切接口」与
 * `docs/1.0/data-model.md`「链接预览」)。
 *
 * 群里贴了一条链接,核心先用通用网址正则挑出候选,再逐个问在册的解析器认不认(`matches`),认了的
 * 交给它 `resolve` 出一份作品。核心不认识任何平台:认哪些网址、怎么查、怎么翻成作品都归解析器。
 * 解析器由集成在自己的 `start(ctx)` 里经 `ctx.registerLinkResolver` 登记,键就是集成的键。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/link-preview` 取值。
 */

import type { NativeShare } from "./platform";
import type { Post } from "./post";
import type { Result } from "./result";

/** 解析器交回的一份预览:一个作品,加「这是哪一个」的规范 id,可选的原生分享描述。 */
export interface LinkPreview {
	/** 要出卡的作品;核心照常出图卡、吃皮肤。 */
	post: Post;
	/** 同一个东西不论链接换了什么写法都一样的 id(带参数、移动端域名、短链……),冷却按它去重。 */
	canonicalId: string;
	/**
	 * 原生分享卡的中立描述。有它、且发送的这条连接支持,才会回原生分享;没有或签不了就回图片。
	 * 描述只说「分享什么」,签名由适配器去签(解析器不碰任何平台的签名接口)。
	 */
	nativeShare?: NativeShare;
}

/** 一个平台的链接解析器。 */
export interface LinkResolver {
	/** 平台名(「B 站」),给日志与面板用。 */
	label: string;
	/** 这条网址归不归我。同步、不联网。 */
	matches(url: string): boolean;
	/** 查出这条网址的预览;失败回失败结果,不抛。`signal` 是进程关停的那个。 */
	resolve(url: string, signal: AbortSignal): Promise<Result<LinkPreview>>;
}

/**
 * 链接预览回什么,三档选一,没有「都发」:
 * - `image`:一张渲染出来的图片卡;
 * - `nativeShare`:原生分享卡(平台自己的分享卡,点开直接播放),要目标所在的连接能发出去
 *   (由适配器的能力说了算),发不了的回落图片卡;
 * - `text`:一段文字(作者名 + 作品文字,限长,不带链接),最轻的一档,不要渲染器也不问能力。
 */
export const LINK_REPLY_FORMS = ["image", "nativeShare", "text"] as const;

export type LinkReplyForm = (typeof LINK_REPLY_FORMS)[number];

/**
 * 链接解析的硬上限。**不进面板**:面板上那条冷却只防「同一个视频反复贴」,这几条防的是
 * 换着视频刷 —— 谁都能触发的功能,资源面得有个不靠主人调的底。
 *
 * 放在这里而不是服务端里:面板的说明文字要把这两个数字念给主人听(web 只能从这个零依赖
 * 子入口拿运行时值),各写一份的话调了上限、说明还在念旧数字,而且什么都不会红。
 */
export interface LinkLimits {
	/** 单个群每分钟最多出几张链接卡。 */
	groupPerMinute: number;
	/**
	 * 全局同时在处理(取信息 / 渲染 / 发送)的链接卡上限;超了直接放弃,不排队。
	 *
	 * 它管的是**积压量**,不是给推送卡让路 —— 让路由渲染队列的低优先级车道做(链接卡在
	 * 正常车道排空之前不渲染)。这个数只是别让一群人刷链接时攒下几十个悬着的请求。
	 */
	maxInflight: number;
	/** 冷却表 / 群额度表各自的容量,满了丢最久没碰的 —— 忘一条顶多多出一张卡,表不会越涨越慢。 */
	tableCap: number;
}

export const LINK_LIMITS: LinkLimits = { groupPerMinute: 6, maxInflight: 3, tableCap: 2000 };
