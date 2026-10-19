import type { Post, PostEvent } from "@bilibili-notify/internal";
import { clip, postText } from "../posts/post-text.js";
import type { PostEntry } from "./store.js";

/**
 * 作品行多收的五格(ADR-0027 决策 4 / 12;规矩在 `docs/agents/conventions/stats-collection.md`),从**链接 + 中立的 `Post`** 取。
 *
 * 链接不在 `Post` 上、在信封上(`docs/1.0/data-model.md`:`PostReport { postId, url, post }`、`PostEvent { …, postId, url, post }`),
 * 所以入参是 `{ url, post }`:B 站与拓展两支都经 {@link postEntryFromEvent} 拿 `PostEvent.url` 与 `PostEvent.post` 来调,
 * 两个来源不各写一套取法。
 *
 * - `summary`:唯一的取段函数 `postText` 的 AI 拼法(`"labeled"`,ADR-0028 决策 1),按字符截 {@link POST_SUMMARY_MAX_CHARS};
 * - `title`:作品自己的标题 → 文章标题 → 视频标题,截 {@link POST_TITLE_MAX_CHARS}(规矩没有长度,取个够用的上限);
 * - `topic`、`videoDurationSec`:`Post` 上现成的;
 * - 没有的格不写(规矩 5:不编默认值)。
 */

/** 摘要的字符数上限(按码点数,不是 UTF-16 单元)。 */
export const POST_SUMMARY_MAX_CHARS = 200;
/** 标题的字符数上限。 */
export const POST_TITLE_MAX_CHARS = 100;

export type PostEntryExtras = Pick<
	PostEntry,
	"url" | "title" | "summary" | "topic" | "videoDurationSec"
>;

const filled = (text: string | undefined): text is string =>
	text !== undefined && text.trim() !== "";

/**
 * `post-detected` → 作品行:B 站与拓展两支都吃同一份事件,判据只有作品自己 —— `hasVideo` 取 `post.video`、
 * 发布时间取 `post.publishedAt`、多收的五格走 {@link postEntryExtras}。文件键(`subscriptionId`)由调用方取。
 */
export function postEntryFromEvent(event: PostEvent): PostEntry {
	return {
		id: event.postId,
		hasVideo: event.post.video !== undefined,
		publishedAt: event.post.publishedAt,
		...postEntryExtras({ url: event.url, post: event.post }),
	};
}

export function postEntryExtras(input: { url: string; post: Post }): PostEntryExtras {
	const { url, post } = input;
	const out: PostEntryExtras = {};
	if (filled(url)) out.url = url;
	const title = [post.title, post.article?.title, post.video?.title].find(filled);
	if (title !== undefined) out.title = clip(title, POST_TITLE_MAX_CHARS);
	const summary = postText(post, "labeled");
	if (filled(summary)) out.summary = clip(summary, POST_SUMMARY_MAX_CHARS);
	if (filled(post.topic)) out.topic = post.topic;
	const duration = post.video?.durationSec;
	if (typeof duration === "number" && Number.isFinite(duration)) out.videoDurationSec = duration;
	return out;
}
