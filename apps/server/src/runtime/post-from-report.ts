/**
 * **拓展上报的作品 → 平台中立的作品 `Post`**(ADR-0021 决策 22 下 2026-10-05 的 🔗,㉑d;ADR-0019 决策 55 / 69 / 77)。
 *
 * 拓展交的是 v2 的 `SubscriptionPost`:毫秒时间、字节图、`topics[]`。出图器只认 `Post`(图只收图库引用),
 * 所以这里一次翻好:
 *
 * - 配图、视频封面(以及随事件带来的作者头像)的字节经 `postImages` **存进图库**,`PostImage` / `Creator` 只放引用;
 *   BN 读文件头拿宽高(判长图)、认 gif(标动图)—— 拓展的图是字节,B 站「看网址结尾」那一招对它不成立;
 * - 只存**前 {@link GALLERY_MAX_IMAGES} 张**(图廊只铺这么多,余下的折进 `+N`):后面的不画,不必存,
 *   只占着张数(`PostImage` 里什么地址都没有);
 * - 图库不收的图(格式不认、超限)那张**没有 `ref` 也没有 `url`**,出图器画占位 —— 与从前「换成占位图」同一个可见行为;
 * - `topics[0]` → `topic`(正文上方那一行标签);正文里照报的名字找到的 `#名字#` / `#名字` 切成 `RichText` 的
 *   `topic` 片段,其余是 `text` 片段(不在名单里的 `#` 一律当文字,BN 不按 `#` 猜);
 * - 有视频就带 `video` 且 `label: "投稿了视频"`(出图器据此把「· 投稿了视频」接在发布时间后,B 站卡就是这么贴的);
 * - 时间毫秒 → ISO;互动数照搬成数字(排版归出图器);
 * - 一个字都没有(空串 / 只有空白)的正文是空串,卡上正文块收起。
 *
 * 过一遍 `normalizePost`:片段的字拼起来必须等于 `text`,这里的切法保证对得上。
 *
 * 过滤用的字与 AI 用的字**不在这里**(仍是 `extension-post-work.ts` 的 `extensionPostFilterText` / `commentTextOf`),
 * ㉑e 统一换成 `postText`。
 */

import { GALLERY_MAX_IMAGES } from "@bilibili-notify/image";
import {
	type ImageRef,
	normalizePost,
	type Post,
	type PostImage,
	type Result,
	type RichText,
	readImageSize,
	type SubscriptionReportValue,
	sniffImageFormat,
} from "@bilibili-notify/internal";

type ReportedPost = SubscriptionReportValue<"post">;

/** 往图库存一张图的口(`AppRuntime.postImages` 的存图那一半)。 */
export interface PostImageSink {
	put(bytes: Uint8Array): Promise<Result<{ ref: ImageRef }>>;
}

export interface PostFromReportOptions {
	/** 卡上的作者名(`extensionSubscriptionName` 取好的,也是模板的 `{name}`)。 */
	authorName: string;
	/** 订阅资料里存进图库的头像引用;事件没带头像(或带的不是图库收的图)时用它。 */
	profileAvatar?: ImageRef;
	/** 存图的口。 */
	images: PostImageSink;
}

/** 字母或数字(任何文字的)—— `#名字` 后面紧跟着它,就不是这个话题。 */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * 纯文本按话题名切成富文本片段:话题一段是 `topic` 片段,其余是 `text` 片段。只在 `#` 所在的位置上试。
 *
 * - `#名字` 后面紧跟的不能是字母或数字:报了「cat」,`#category` 里不抠出一个 `#cat`;报了「旅行」,
 *   `#旅行今天` 也不算(与话题平台自己切话题的办法一致)。`#名字#` 自己带着边界,后面跟什么都行。
 * - 同一处能对上几种写法时:名字长的先(「旅行日记」与「旅行」都报了,`#旅行日记` 整个是话题),同一个
 *   名字 `#名字#` 先于 `#名字`(收尾的 `#` 算进话题)—— **除非**收尾的那个 `#` 正是下一个话题 `#别的`
 *   的开头(`#旅行#美食`,两个都报了):那就取 `#名字`,把 `#` 让给下一个,两个都上色。
 *
 * 片段的 `text` 拼起来恒等于传进来的 `text`。
 */
export function plainTextSegments(text: string, topics: readonly string[]): RichText {
	const names = [...new Set(topics)]
		.filter((name) => name !== "")
		.sort((a, b) => b.length - a.length);
	/** 从 `at` 起是不是 `#名字`、而且后面没被字接着。 */
	const openAt = (at: number, name: string): boolean => {
		if (!text.startsWith(`#${name}`, at)) return false;
		const next = text.codePointAt(at + name.length + 1);
		return next === undefined || !WORD_CHAR.test(String.fromCodePoint(next));
	};
	const hitAt = (at: number): { text: string; name: string } | undefined => {
		for (const name of names) {
			if (text.startsWith(`#${name}#`, at)) {
				const closing = at + name.length + 1;
				return names.some((other) => openAt(closing, other))
					? { text: `#${name}`, name }
					: { text: `#${name}#`, name };
			}
			if (openAt(at, name)) return { text: `#${name}`, name };
		}
		return undefined;
	};
	const segments: RichText = [];
	const pushText = (part: string) => {
		if (part) segments.push({ kind: "text", text: part });
	};
	let plainFrom = 0;
	let at = names.length > 0 ? text.indexOf("#") : -1;
	while (at !== -1) {
		const hit = hitAt(at);
		if (hit) {
			pushText(text.slice(plainFrom, at));
			segments.push({ kind: "topic", text: hit.text, name: hit.name });
			plainFrom = at + hit.text.length;
			at = text.indexOf("#", plainFrom);
		} else {
			at = text.indexOf("#", at + 1);
		}
	}
	pushText(text.slice(plainFrom));
	return segments;
}

/** 毫秒 → ISO;不是有效时刻落在纪元(别让一个坏时间把整张卡弄抛)。 */
function isoOfMillis(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/**
 * 一张图的字节 → 存进图库,回装了引用的 `PostImage`(带宽高与动图标记)。图库不收就没有 `ref`(出图器画占位),
 * 宽高与动图标记照样带 —— 那是字节自己的事。磁盘写失败是抛错(这一次出卡失败,装配降级成纯文字)。
 */
async function storeImage(bytes: Uint8Array, images: PostImageSink): Promise<PostImage> {
	const stored = await images.put(bytes);
	return {
		...(stored.ok ? { ref: stored.ref } : {}),
		...readImageSize(bytes),
		isAnimated: sniffImageFormat(bytes) === "gif",
	};
}

export async function postFromReport(
	report: ReportedPost,
	opts: PostFromReportOptions,
): Promise<Post> {
	// 作者头像:事件带了字节且图库收就存、用它;否则用订阅资料里的引用;都没有就没有头像(头像块收起)。
	let avatar: ImageRef | undefined;
	if (report.author?.avatar) {
		const stored = await opts.images.put(report.author.avatar);
		if (stored.ok) avatar = stored.ref;
	}
	avatar ??= opts.profileAvatar;

	const text = (report.text ?? "").replace(/\r\n?/g, "\n");
	const post: Post = {
		creator: { name: opts.authorName, ...(avatar === undefined ? {} : { avatar }) },
		publishedAt: isoOfMillis(report.publishedAt),
		text: text.trim() === "" ? "" : text,
	};

	const topics = report.topics ?? [];
	if (topics[0] !== undefined) post.topic = topics[0];

	if (post.text !== "") {
		const segments = plainTextSegments(post.text, topics);
		// 一个话题都没找到:一整段 `text` 片段与 `text` 本身没有区别,不必带。
		if (segments.some((segment) => segment.kind === "topic")) post.richText = segments;
	}

	// 配图:前几张存图库,其余只占着张数。
	const bytes = report.images ?? [];
	if (bytes.length > 0) {
		post.images = await Promise.all(
			bytes.map((one, i) => (i < GALLERY_MAX_IMAGES ? storeImage(one, opts.images) : {})),
		);
	}

	if (report.video) {
		const cover = report.video.cover ? await storeImage(report.video.cover, opts.images) : {};
		post.label = "投稿了视频";
		post.video = {
			cover,
			title: report.video.title ?? "",
			description: report.video.description ?? "",
			...(report.video.duration === undefined ? {} : { durationSec: report.video.duration }),
			...(report.video.plays === undefined ? {} : { views: report.video.plays }),
		};
	}

	if (report.stats) {
		const stats: NonNullable<Post["stats"]> = {};
		if (report.stats.shares !== undefined) stats.shares = report.stats.shares;
		if (report.stats.comments !== undefined) stats.comments = report.stats.comments;
		if (report.stats.likes !== undefined) stats.likes = report.stats.likes;
		if (Object.keys(stats).length > 0) post.stats = stats;
	}

	return normalizePost(post);
}
