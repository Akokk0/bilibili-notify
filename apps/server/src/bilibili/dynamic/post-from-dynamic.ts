/**
 * B 站原始动态 → 平台中立的作品 `Post`(㉑c 第 5 步,ADR-0021 决策 19–25)。
 *
 * **B 站原始数据到 `Post` 的全部翻译都在这里**:出卡器(`packages/image`)只认 `Post`,不认识任何 B 站字段。
 * 这里把接口给的东西一次翻成中立的格,翻不进去的(形状装不下的)就不带 —— 主人定的原则是「不加字段,形状装不下的
 * 就不画」(见 `packages/image` 里各卡的说明)。
 *
 * 翻译表:
 * - 作者 → `creator`(只有名字与大会员,**头像不给**:`Creator.avatar` 只收图库引用,B 站 3a 才存);
 * - 发布时间(秒)→ ISO 字符串;类型标签 → `label`(「投稿了视频」「投稿了专栏」),卡上由出图器拼回老位置;
 * - 正文:desc 与 opus 摘要合成一段(换行连接)→ `text`,富文本节点 → `richText` 五种片段(`mention` / `topic` /
 *   `link` / `emoji` / `text`);**不带图标与表情图**(它们只收图库引用);
 * - opus 标题:专栏 → `article.title`,别的(带标题的图文)→ `title`;
 * - 图文的图 → `images`(专栏的 → `article.images`);任何 AV archive → `video`(播放 / 弹幕 / 时长先成数字);
 * - 附加块 → `attachment`:预约卡与通用卡 → `card`,商品 → `goods`,引用的 UGC 视频 → `video`;
 * - 充电专属 → `locked`(`hint` 用作者名拼好);「暂时无法渲染」「原动态不可见」→ `notice`;
 * - 转发 → `repost`(内层不带互动数);互动数 → `stats`。
 *
 * **图只给 `url`、不给 `ref`**:这里是同步的翻译,不碰网络与图库。出卡前由 `bilibili/images.ts` 的
 * `fetchPostImages` 把配图、封面、商品图、徽标抓进图库,在图上加 `ref`(原地址还留着)。
 *
 * 翻出来的 `Post` 过一遍 {@link normalizePost}(片段的字拼起来必须等于 `text`,对不上就丢掉 `richText`)。
 * 这里的翻译保证对得上 —— 对不上被丢掉的话,正文里的高亮会无声消失,`post-from-dynamic.test.ts` 有一条直说原因的测试。
 *
 * **宽容**:接口缺什么格就少什么,不抛(唯一的例外是顶层的开播伪动态,见 {@link postFromDynamic})。
 */

import {
	type Attachment,
	normalizePost,
	type Post,
	type PostImage,
	type RichText,
	type RichTextSegment,
} from "@bilibili-notify/internal";
import { parseClock, parseCount } from "./bili-display-values";
import type { Dynamic } from "./types";

// ── 接口里用到的那几个字面量 ──────────────────────────────────────────────────

const DYNAMIC_TYPE_NONE = "DYNAMIC_TYPE_NONE";
const DYNAMIC_TYPE_FORWARD = "DYNAMIC_TYPE_FORWARD";
const DYNAMIC_TYPE_AV = "DYNAMIC_TYPE_AV";
const DYNAMIC_TYPE_PGC = "DYNAMIC_TYPE_PGC";
const DYNAMIC_TYPE_WORD = "DYNAMIC_TYPE_WORD";
const DYNAMIC_TYPE_DRAW = "DYNAMIC_TYPE_DRAW";
const DYNAMIC_TYPE_ARTICLE = "DYNAMIC_TYPE_ARTICLE";
const DYNAMIC_TYPE_MUSIC = "DYNAMIC_TYPE_MUSIC";
const DYNAMIC_TYPE_COMMON_SQUARE = "DYNAMIC_TYPE_COMMON_SQUARE";
const DYNAMIC_TYPE_LIVE = "DYNAMIC_TYPE_LIVE";
const DYNAMIC_TYPE_MEDIALIST = "DYNAMIC_TYPE_MEDIALIST";
const DYNAMIC_TYPE_COURSES_SEASON = "DYNAMIC_TYPE_COURSES_SEASON";
const DYNAMIC_TYPE_LIVE_RCMD = "DYNAMIC_TYPE_LIVE_RCMD";
const DYNAMIC_TYPE_UGC_SEASON = "DYNAMIC_TYPE_UGC_SEASON";

const ADDITIONAL_TYPE_RESERVE = "ADDITIONAL_TYPE_RESERVE";
const ADDITIONAL_TYPE_GOODS = "ADDITIONAL_TYPE_GOODS";
const ADDITIONAL_TYPE_COMMON = "ADDITIONAL_TYPE_COMMON";
const ADDITIONAL_TYPE_UGC = "ADDITIONAL_TYPE_UGC";

const TYPE_AT = "RICH_TEXT_NODE_TYPE_AT";
const TYPE_TOPIC = "RICH_TEXT_NODE_TYPE_TOPIC";
/** 翻成 `link` 的富文本节点:BV / AV 号、抽奖、网页、专栏、商品、投票、番剧。 */
const LINK_NODE_TYPES: ReadonlySet<string> = new Set([
	"RICH_TEXT_NODE_TYPE_BV",
	"RICH_TEXT_NODE_TYPE_AV",
	"RICH_TEXT_NODE_TYPE_LOTTERY",
	"RICH_TEXT_NODE_TYPE_WEB",
	"RICH_TEXT_NODE_TYPE_CV",
	"RICH_TEXT_NODE_TYPE_TAOBAO",
	"RICH_TEXT_NODE_TYPE_GOODS",
	"RICH_TEXT_NODE_TYPE_VOTE",
	"RICH_TEXT_NODE_TYPE_OGV_SEASON",
	"RICH_TEXT_NODE_TYPE_OGV_EP",
]);

/** 预约卡的按钮写着这句,就是「不可用」。 */
const RESERVE_ENDED_TEXT = "已结束";
/** 投稿视频的徽标文字:只有它才贴「投稿了视频」。 */
const ARCHIVE_BADGE_UPLOAD = "投稿视频";

// ── 接口里读到的形状(宽松:接口缺什么就读不到什么) ──────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: B 站接口按类型变形,这里只按字段名读
type Loose = any;

type RawNode = {
	type?: string;
	text?: string;
	jump_url?: string;
	rid?: string | number;
	emoji?: unknown;
};

// ── 入口 ──────────────────────────────────────────────────────────────────────

/**
 * 一条 B 站动态 → 一份 `Post`。
 *
 * 顶层的**开播伪动态**(`DYNAMIC_TYPE_LIVE_RCMD`)抛「直播开播动态，不做处理」:开播走直播卡那条路,
 * 动态引擎在过滤与出卡之前就按类型把顶层的它跳过了(ADR-0019 决策 66),撞到这里的只剩卡片页的真实预览
 * (按序号取某位 UP 的一条动态,可能正好是它)。**转发**里的原动态是它时不抛 —— 引擎跳不掉转发,
 * 抛了整张转发卡都出不来,当一句提示。
 */
export function postFromDynamic(item: Dynamic): Post {
	return normalizePost(translate(item, false));
}

function translate(item: Dynamic, isRepost: boolean): Post {
	// 残条(转发的原动态被删,接口只剩 tombstone,整段 modules 缺席)也得翻得过去:引擎现在先翻译再过滤,
	// 翻译抛了就是整条动态没法判。
	const modules = (item.modules ?? {}) as Loose;
	const author = modules.module_author ?? {};
	const mod = modules.module_dynamic ?? {};
	const stat = modules.module_stat;
	const name: string = author.name ?? "";

	const post: Post = {
		creator: { name, isPremium: (author.vip?.type ?? 0) !== 0 },
		publishedAt: isoOfSeconds(author.pub_ts),
		text: "",
	};
	const topic = mod.topic?.name;
	if (topic) post.topic = topic;
	// 内层(被转发的原动态)不展示互动数。
	if (!isRepost && stat) {
		post.stats = {
			shares: countOf(stat.forward),
			comments: countOf(stat.comment),
			likes: countOf(stat.like),
		};
	}
	const attachment = attachmentOf(mod.additional);
	if (attachment) post.attachment = attachment;

	// 充电专属且未充电:接口把 module_dynamic 整体清空,不管外层 type 是什么,落进下面任何一个分支都只会
	// 画出空白正文。在类型分发之前短路,画占位 —— 递归到被转发的原动态时同样生效。
	if (isChargeOnlyLocked(item)) {
		const badge = author.icon_badge;
		post.locked = {
			...(badge?.icon ? { icon: { url: badge.icon } } : {}),
			title: badge?.text || "充电专属内容",
			hint: `为 ${name} 充电即可查看完整内容`,
		};
		return post;
	}

	switch (item.type) {
		case DYNAMIC_TYPE_WORD:
		case DYNAMIC_TYPE_DRAW: {
			applyBody(post, mod);
			setImages(post, opusImages(mod));
			return post;
		}

		case DYNAMIC_TYPE_FORWARD: {
			// 转发本身不带图(接口给的 major 是空的),照样取一遍,真有也不丢。
			applyBody(post, mod);
			setImages(post, opusImages(mod));
			if (item.orig) {
				post.repost = translate(item.orig, true);
			} else {
				post.notice = `${name}转发了一条动态，但原动态已不可见`;
			}
			return post;
		}

		case DYNAMIC_TYPE_AV: {
			applyBody(post, mod);
			const archive = mod.major?.archive;
			if (archive) post.video = videoOf(archive);
			if (archive?.badge?.text === ARCHIVE_BADGE_UPLOAD) post.label = "投稿了视频";
			return post;
		}

		case DYNAMIC_TYPE_ARTICLE: {
			applyBody(post, mod, { asArticle: true });
			post.label = "投稿了专栏";
			return post;
		}

		case DYNAMIC_TYPE_LIVE:
			return notice(post, `${name}发起了直播预约，我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_MEDIALIST:
			return notice(post, `${name}分享了收藏夹，我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_PGC:
			return notice(post, `${name}发布了剧集（番剧、电影、纪录片），我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_MUSIC:
			return notice(post, `${name}发行了新歌，我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_COMMON_SQUARE:
			return notice(post, `${name}发布了装扮｜剧集｜点评｜普通分享，我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_COURSES_SEASON:
			return notice(post, `${name}发布了新课程，我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_UGC_SEASON:
			return notice(post, `${name}更新了合集，我暂时无法渲染，请自行查看`);
		case DYNAMIC_TYPE_NONE:
			return notice(post, `${name}发布了一条无效动态`);
		case DYNAMIC_TYPE_LIVE_RCMD:
			if (!isRepost) throw new Error("直播开播动态，不做处理");
			return notice(post, `${name}发布了一条开播动态，我暂时无法渲染，请自行查看`);
		default:
			return notice(post, `${name}发布了一条我无法识别的动态，请自行查看`);
	}
}

/** 「我暂时无法渲染」那一类:只有一句 BN 自己说的话;没有可拆的附加内容,清掉以免空块占位。 */
function notice(post: Post, text: string): Post {
	post.notice = text;
	delete post.attachment;
	return post;
}

// ── 时间与数字 ────────────────────────────────────────────────────────────────

/** 接口的发布时间是 unix 秒(数字或数字字符串);缺了或不是数就落在纪元。 */
function isoOfSeconds(raw: unknown): string {
	const seconds = typeof raw === "string" ? Number(raw) : raw;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
		return new Date(0).toISOString();
	}
	const date = new Date(Math.floor(seconds) * 1000);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** `{ count }` 形状的互动数;没有就是 0(三项恒有,缺了当没人点)。 */
function countOf(stat: Loose): number {
	return parseCount(stat?.count) ?? 0;
}

// ── 充电专属 ──────────────────────────────────────────────────────────────────

/**
 * 是否「充电专属且当前不可见」:`basic.is_only_fans` 为真,且 module_dynamic 被接口整体清空(desc / major /
 * topic / additional 全缺席)。已充电用户拉到的同一条动态 `is_only_fans` 也是 true,但内容齐全,不会命中 ——
 * 按内容有无判定,不按 type,避免漏判某个具体的 DYNAMIC_TYPE_* 变体。
 */
function isChargeOnlyLocked(item: Dynamic): boolean {
	const basic = item.basic as Loose;
	if (!basic?.is_only_fans) return false;
	const mod = (item.modules as Loose | undefined)?.module_dynamic;
	return !mod?.desc && !mod?.major && !mod?.topic && !mod?.additional;
}

// ── 正文 ──────────────────────────────────────────────────────────────────────

/** desc 与摘要两件合成一段时,夹在中间的那个换行。 */
const JOIN_NEWLINE: RichTextSegment = { kind: "text", text: "\n" };

/** 一个接口富文本节点 → 一个中立片段。图标与表情图不带(只收图库引用),表情当文字。 */
function segmentOf(node: RawNode): RichTextSegment {
	const text = node.text ?? "";
	if (node.emoji) return { kind: "emoji", text };
	if (node.type === TYPE_AT) {
		const userId = node.rid === undefined || node.rid === "" ? undefined : String(node.rid);
		return { kind: "mention", text, ...(userId === undefined ? {} : { userId }) };
	}
	if (node.type === TYPE_TOPIC) return { kind: "topic", text, name: text.replace(/^#|#$/g, "") };
	if (node.type !== undefined && LINK_NODE_TYPES.has(node.type)) {
		return { kind: "link", text, url: node.jump_url ?? "" };
	}
	return { kind: "text", text };
}

/**
 * 正文:desc 与 opus 摘要合成一段(换行连接)、一个 `richText`,`text` 是片段的字拼起来 —— 对得上
 * {@link normalizePost} 的校验。标题(`opus.title`)专栏进 `article.title`,别的进 `title`。
 */
function applyBody(post: Post, mod: Loose, options: { asArticle?: boolean } = {}): void {
	const descNodes: RawNode[] | undefined = mod.desc?.rich_text_nodes;
	const summaryNodes: RawNode[] | undefined = mod.major?.opus?.summary?.rich_text_nodes;
	const segments: RichText = [
		...(descNodes ?? []).map(segmentOf),
		...(descNodes?.length && summaryNodes?.length ? [JOIN_NEWLINE] : []),
		...(summaryNodes ?? []).map(segmentOf),
	];
	post.text = segments.map((segment) => segment.text).join("");
	if (segments.length > 0) post.richText = segments;

	const title: string | undefined = mod.major?.opus?.title || undefined;
	if (options.asArticle) {
		post.article = { title: title ?? "" };
		const images = opusImages(mod);
		if (images.length > 0) post.article.images = images;
	} else if (title) {
		post.title = title;
	}
}

// ── 图 ────────────────────────────────────────────────────────────────────────

function setImages(post: Post, images: PostImage[]): void {
	if (images.length > 0) post.images = images;
}

/** 图文 / 专栏的图。B 站的缩放后缀与动图判据都留在这里,出卡器只看 `isAnimated`。 */
function opusImages(mod: Loose): PostImage[] {
	const pics: Loose[] = mod.major?.opus?.pics ?? [];
	return pics.map((pic) => ({
		url: pic.url,
		width: pic.width,
		height: pic.height,
		isAnimated: isAnimatedPic(pic),
	}));
}

/**
 * B 站的这张图会不会动。两条判据取并集:`live_url` 非空(B 站给动图带的播放地址)**或** URL 后缀是 `.gif`。
 * 真实 URL 常带处理后缀和 query(`….gif@1280w_80q_1s.webp?from=dyn`),先把这两截削掉再看结尾。
 */
function isAnimatedPic(pic: Loose): boolean {
	if (pic.live_url) return true;
	const path = String(pic.url ?? "")
		.split("?")[0]
		?.split("@")[0];
	return (path ?? "").toLowerCase().endsWith(".gif");
}

// ── 视频 ──────────────────────────────────────────────────────────────────────

/** 投稿视频那张卡。播放 / 弹幕 / 时长是接口排好的字,先解析成数字(认不得的那一格不带)。 */
function videoOf(archive: Loose): NonNullable<Post["video"]> {
	const durationSec = parseClock(archive.duration_text);
	const views = parseCount(archive.stat?.play);
	const danmaku = parseCount(archive.stat?.danmaku);
	return {
		cover: { url: archive.cover },
		title: archive.title ?? "",
		description: archive.desc ?? "",
		...(durationSec === undefined ? {} : { durationSec }),
		...(views === undefined ? {} : { views }),
		...(danmaku === undefined ? {} : { danmaku }),
	};
}

// ── 附加块 ────────────────────────────────────────────────────────────────────

/** 附加块 → `Attachment`。形状装不下的(按钮、小标签、「起」、标题上方的说明)不带。 */
function attachmentOf(additional: Loose): Attachment | undefined {
	if (!additional) return undefined;
	switch (additional.type) {
		case ADDITIONAL_TYPE_RESERVE:
			return reserveCard(additional.reserve);
		case ADDITIONAL_TYPE_GOODS:
			return goodsOf(additional.goods);
		case ADDITIONAL_TYPE_COMMON:
			return commonCard(additional.common);
		case ADDITIONAL_TYPE_UGC:
			// type 说是 UGC 但 ugc 缺席的情况真实存在(接口降级),没内容就当没附加块。
			return additional.ugc ? ugcVideo(additional.ugc) : undefined;
		default:
			return undefined;
	}
}

/** 预约卡 → `card`:desc1 / desc2 / desc3 各一行;按钮写着「已结束」就是不可用。 */
function reserveCard(reserve: Loose): Attachment | undefined {
	if (!reserve) return undefined;
	const lines = [reserve.desc1, reserve.desc2, reserve.desc3]
		.filter((desc) => typeof desc?.text === "string")
		.map((desc) => ({ text: desc.text as string }));
	const buttonText: string | undefined = reserve.button?.uncheck?.text;
	return {
		kind: "card",
		title: reserve.title ?? "",
		lines,
		...(reserve.button
			? { button: { text: buttonText ?? "", enabled: buttonText !== RESERVE_ENDED_TEXT } }
			: {}),
	};
}

/** 通用卡 → `card`:头部说明、封面、标题、desc1 / desc2 两行、按钮。 */
function commonCard(common: Loose): Attachment | undefined {
	if (!common) return undefined;
	const lines = [common.desc1, common.desc2]
		.filter((text) => !!text)
		.map((text) => ({ text: String(text) }));
	const buttonText: string | undefined = common.button?.jump_style?.text;
	return {
		kind: "card",
		...(common.head_text ? { eyebrow: String(common.head_text) } : {}),
		// 封面恒有:接口里通用卡就是带封面的那种版式(没有封面的是预约卡)。
		cover: { url: common.cover },
		title: common.title ?? "",
		lines,
		...(buttonText ? { button: { text: buttonText, enabled: true } } : {}),
	};
}

/** 商品 → `goods`。 */
function goodsOf(goods: Loose): Attachment | undefined {
	if (!goods) return undefined;
	const items: Loose[] = goods.items ?? [];
	return {
		kind: "goods",
		...(goods.head_text ? { eyebrow: String(goods.head_text) } : {}),
		items: items.map((item) => ({
			cover: { url: item.cover },
			name: item.name ?? "",
			...(item.price === undefined || item.price === null ? {} : { price: String(item.price) }),
		})),
	};
}

/**
 * 引用的 UGC 视频 → `video`。`desc_second` 是接口拼好的整句(「2654观看 102弹幕」),原样进 `subtitle`
 * 不拆;时长是接口排好的字,先解析成秒。
 */
function ugcVideo(ugc: Loose): Attachment {
	const durationSec = parseClock(ugc.duration);
	return {
		kind: "video",
		cover: { url: ugc.cover },
		title: ugc.title ?? "",
		...(durationSec === undefined ? {} : { durationSec }),
		...(ugc.desc_second ? { subtitle: String(ugc.desc_second) } : {}),
	};
}
