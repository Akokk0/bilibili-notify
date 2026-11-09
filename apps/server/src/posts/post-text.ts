import type { Post } from "@bilibili-notify/internal";
import { t as serverText } from "../i18n/index.js";

/** `plain`:无前缀(过滤用);`labeled`:当前语言标签(给人看);`prompt`:同一取段逻辑、固定中文标签(给模型)。 */
export type PostTextStyle = "plain" | "labeled" | "prompt";

const filled = (text: string | undefined): text is string => !!text && text.trim() !== "";

/** 一条作品自己的三段字,按拼出来的顺序;不含被转发的原作品。 */
function ownSections(post: Post, style: PostTextStyle): string[] {
	const title = filled(post.title) ? post.title : post.article?.title;
	const videoTitle = post.video?.title;
	if (style === "plain") return [post.text, title, videoTitle].filter(filled);
	return [
		filled(title)
			? style === "prompt"
				? `标题：${title}`
				: serverText("service.posts.post-text.text.1", { value0: title })
			: undefined,
		post.text,
		filled(videoTitle)
			? style === "prompt"
				? `视频标题：${videoTitle}`
				: serverText("service.posts.post-text.text.2", { value0: videoTitle })
			: undefined,
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
			const name = filled(post.repost.creator.name)
				? post.repost.creator.name
				: style === "prompt"
					? "未知"
					: serverText("service.posts.post-text.text.3");
			if (inner !== "")
				sections.push(
					style === "prompt"
						? `（转发自 ${name}：${inner}）`
						: serverText("service.posts.post-text.text.4", { value0: name, value1: inner }),
				);
		}
	}
	const joined = sections.join("\n");
	return style === "plain" ? joined : joined.trim();
}

/** 按码点截到 `max` 个字符,不截断代理对。作品摘要、推送历史里被过滤的作品留痕与链接预览的回文字共用这一份截法。 */
export function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : chars.slice(0, max).join("");
}
