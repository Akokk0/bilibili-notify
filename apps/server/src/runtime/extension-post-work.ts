import type { Post, SubscriptionReportValue } from "@bilibili-notify/internal";
import { type NeutralWork, WORK_COMMENT_IMAGES_MAX } from "../bilibili/dynamic/index.js";
import { postText } from "../posts/post-text.js";
import { imageDataUrl } from "./extension-push-common.js";

/**
 * **拓展报的作品 → 平台中立的作品**(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77):装配(`deliverWork`)
 * 只认 {@link NeutralWork} —— 这里把拓展交的上报原件与它翻好的 `Post`({@link postFromReport})包成装配要的那几格,
 * 出卡之后那一段与 B 站动态同一份。
 *
 * 翻译(`postFromReport`)由调用方(`extension-posts.ts`)做一次,**过滤、AI 点评的文字、出卡共用同一份 `Post`**
 * (ADR-0021 决策 43);图的写盘推迟到出卡那一刻({@link ExtensionPostWorkOptions.commitImages}),被屏蔽的 /
 * 关了出图的 / 版式藏起卡片的作品不为图写盘。AI 的文字走 `postText(post, "labeled")`(ADR-0028 决策 1,
 * 取段只此一份);AI 看的图仍取上报原件的字节(出卡用的是图库引用,点评要的是 data URL)。
 *
 * 作者名与头像引用由调用方先按决策 54 取好、翻进 `Post` 里;这里不碰订阅与资料缓存。
 */

type Reported = SubscriptionReportValue<"post">;

/**
 * 交给 AI 看的图,单张多大就跳过(决策 71)。网址是服务商自己去拉,data URL 却要整张塞进请求体。
 *
 * 取 3 MiB(原始字节;编成 data URL 约 4 MiB):常见服务商对单张 base64 图的上限是 5 MB 上下
 * (Anthropic、智谱都是这个数),Gemini 内联数据整条请求 20 MB —— 四张都顶格时约 16 MiB,两头都放得下。
 * 抖音 CDN 的图多是几百 KB 的 webp,正常的作品碰不到这条线;碰到的多半是原图直出的大图,少看一张
 * 胜过整条点评被服务商 413 掉。
 */
export const POST_COMMENT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** 有字才算有。 */
const filled = (text: string | undefined): text is string => !!text && text.trim() !== "";

/** AI 的图(决策 71):作品图 + 视频封面,太大的跳过、让后面的顶上,前 4 张转成 data URL。 */
function commentImagesOf(post: Reported): string[] {
	return [...(post.images ?? []), ...(post.video?.cover ? [post.video.cover] : [])]
		.filter((bytes) => bytes.byteLength <= POST_COMMENT_IMAGE_MAX_BYTES)
		.slice(0, WORK_COMMENT_IMAGES_MAX)
		.map(imageDataUrl)
		.filter((url): url is string => url !== undefined);
}

export interface ExtensionPostWorkOptions {
	/** 平台对作品的叫法(清单 `display.postNoun`);不给就叫「动态」(决策 5)。 */
	postNoun?: string;
	/** 把翻译时推迟的图真正写进图库(`deferImageWrites` 的 `commit`);出卡前调,多次调只写一次。 */
	commitImages(): Promise<void>;
}

/**
 * 一条作品 → 装配吃的中立作品。
 *
 * - 卡:`renderCard` 被调到才先 `commitImages()` 把图写进图库、再把翻好的那份 `Post` 交给 `generatePostCard`
 *   (抛错 = 这一次出图失败,装配降级成纯文字);
 * - 链接部件是事件的 `url`(决策 77);
 * - 不附图集(决策 72:图集载荷只带网址,拓展交的是字节);
 * - AI 的文字是 `postText(post, "labeled")`;AI 的图同理,点评真要看时才编(`commentImages` 是个只算一次的 getter)。
 */
export function extensionPostWork(
	report: Reported,
	post: Post,
	opts: ExtensionPostWorkOptions,
): NeutralWork {
	let commentImages: string[] | undefined;
	return {
		renderCard: async (image, colorOptions) => {
			await opts.commitImages();
			return image.generatePostCard(post, colorOptions);
		},
		link: report.url,
		name: post.creator.name,
		isVideo: post.video !== undefined,
		commentText: postText(post, "labeled"),
		get commentImages() {
			commentImages ??= commentImagesOf(report);
			return commentImages;
		},
		postNoun: filled(opts.postNoun) ? opts.postNoun : "动态",
		gallery: [],
	};
}
