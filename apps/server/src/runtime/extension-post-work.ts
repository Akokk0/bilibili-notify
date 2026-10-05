import { type NeutralWork, WORK_COMMENT_IMAGES_MAX } from "@bilibili-notify/dynamic";
import type { ImageRef, SubscriptionReportValue } from "@bilibili-notify/internal";
import { imageDataUrl } from "./extension-push-common.js";
import { type PostImageSink, postFromReport } from "./post-from-report.js";

/**
 * **拓展报的作品 → 平台中立的作品**(ADR-0019 决策 55 / 66 / 69 / 71 / 72 / 77):装配(`deliverWork`)
 * 只认 {@link NeutralWork} —— 这里把拓展交的那张表翻过去,出卡之后那一段与 B 站动态同一份。
 *
 * 卡:`renderCard` 被调到才把上报翻成 `Post`({@link postFromReport},图存进图库)再交给出图器的
 * `generatePostCard`;出图器按引用从图库取图。过滤用的字与 AI 用的字仍在这里拼(㉑e 统一换成 `postText`)。
 *
 * 作者名与头像引用由调用方先按决策 54 取好(`extension-posts.ts`);这里不碰订阅与资料缓存。
 */

type Post = SubscriptionReportValue<"post">;

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

/**
 * 过滤看的文字(决策 70):作品正文 + 视频标题。只看内容 —— 四个类型开关对拓展作品一律不看,那是
 * 调用方只过 `filterByText` 的事。
 */
export function extensionPostFilterText(post: Post): string {
	return [post.text, post.video?.title].filter(filled).join("\n");
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
		.slice(0, WORK_COMMENT_IMAGES_MAX)
		.map(imageDataUrl)
		.filter((url): url is string => url !== undefined);
}

export interface ExtensionPostWorkOptions {
	/** 卡上的作者名,也就是模板的 `{name}`(`extensionSubscriptionName` 取好的)。 */
	authorName: string;
	/** 订阅资料里存进图库的头像引用(事件没带头像时用它)。 */
	profileAvatar?: ImageRef;
	/** 往图库存图的口(`AppRuntime.postImages`):配图、封面、事件带来的头像经它存。 */
	images: PostImageSink;
	/** 平台对作品的叫法(清单 `display.postNoun`);不给就叫「动态」(决策 5)。 */
	postNoun?: string;
}

/**
 * 一条作品 → 装配吃的中立作品。
 *
 * - 卡:`renderCard` 被调到才翻成 `Post`、把图存进图库(关了出图、版式藏起卡片时不必白写盘),交给
 *   `generatePostCard`;
 * - 链接部件是事件的 `url`(决策 77);
 * - 不附图集(决策 72:图集载荷只带网址,拓展交的是字节);
 * - AI 的图同理,点评真要看时才编(`commentImages` 是个只算一次的 getter)。
 */
export function extensionPostWork(post: Post, opts: ExtensionPostWorkOptions): NeutralWork {
	let commentImages: string[] | undefined;
	return {
		renderCard: async (image, colorOptions) =>
			image.generatePostCard(
				await postFromReport(post, {
					authorName: opts.authorName,
					profileAvatar: opts.profileAvatar,
					images: opts.images,
				}),
				colorOptions,
			),
		link: post.url,
		name: opts.authorName,
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
