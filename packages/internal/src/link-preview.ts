/**
 * 链接预览的跨平台接口(ADR-0029;形状全文在 `docs/1.0/subscription-sources.md`「横切接口」与
 * `docs/1.0/data-model.md`「链接预览」)。
 *
 * 群里贴了一条链接,核心先用通用网址正则挑出候选,再逐个问在册的解析器认不认(`matches`),认了的
 * 交给它 `resolve` 出一份作品。核心不认识任何平台:认哪些网址、怎么查、怎么翻成作品都归解析器。
 * 解析器由集成在自己的 `start(ctx)` 里经 `ctx.registerLinkResolver` 登记,键就是集成的键。
 */
import type { Result } from "./constants";
import type { NativeShare } from "./platform";
import type { Post } from "./post";

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
