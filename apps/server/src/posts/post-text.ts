import type { Post } from "@bilibili-notify/internal";

/** `plain`:各段无前缀、换行拼接(过滤用);`labeled`:带「标题：」「视频标题：」「（转发自 X：…）」(给 AI 读)。 */
export type PostTextStyle = "plain" | "labeled";

const filled = (text: string | undefined): text is string => !!text && text.trim() !== "";

/** 一条作品自己的三段字,按拼出来的顺序;不含被转发的原作品。 */
function ownSections(post: Post, style: PostTextStyle): string[] {
	const title = filled(post.title) ? post.title : post.article?.title;
	const videoTitle = post.video?.title;
	if (style === "plain") return [post.text, title, videoTitle].filter(filled);
	return [
		filled(title) ? `标题：${title}` : undefined,
		post.text,
		filled(videoTitle) ? `视频标题：${videoTitle}` : undefined,
	].filter(filled);
}

/**
 * 整条作品的文字,所有来源同一个拼法(ADR-0028 决策 1)。过滤、AI 点评、摘要这些要整条文字的地方都经它,
 * 别处不许自己拼。只看正文、文章标题、视频标题与被转发的原作品;拼不出字回空串。
 */
export function postText(post: Post, style: PostTextStyle): string {
	const sections = ownSections(post, style);
	if (post.repost) {
		if (style === "plain") {
			const inner = postText(post.repost, style);
			if (inner !== "") sections.push(inner);
		} else {
			const inner = postText(post.repost, style).replaceAll("\n", " ");
			const name = filled(post.repost.creator.name) ? post.repost.creator.name : "未知";
			if (inner !== "") sections.push(`（转发自 ${name}：${inner}）`);
		}
	}
	const joined = sections.join("\n");
	return style === "plain" ? joined : joined.trim();
}
