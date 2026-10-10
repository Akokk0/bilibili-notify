import type { Post } from "@bilibili-notify/internal";
import { postText } from "../posts/post-text.js";
import type { PostEntry } from "./store.js";

/**
 * 作品行多收的五格(ADR-0027 决策 4 / 12;规矩在 `docs/agents/conventions/stats-collection.md`),从**链接 + 中立的 `Post`** 取。
 *
 * 链接不在 `Post` 上、在信封上(`docs/1.0/data-model.md`:`PostReport { postId, url, post }`、`PostEvent { …, postId, url, post }`),
 * 所以入参是 `{ url, post }`:拓展适配今天拿上报的 `url` 与翻好的 `Post` 来调,3a 之后 B 站适配拿 `PostEvent.url` 与
 * `PostEvent.post` 调同一个函数 —— 两个来源不各写一套取法。
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

/** 按码点截到 `max` 个字符,不截断代理对。作品摘要的截法只此一份(推送历史里被过滤的作品留痕也用它)。 */
export function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : chars.slice(0, max).join("");
}

const filled = (text: string | undefined): text is string =>
	text !== undefined && text.trim() !== "";

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
