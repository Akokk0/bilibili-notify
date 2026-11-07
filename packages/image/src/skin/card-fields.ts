/**
 * 内部 props → **对外数据契约**(ADR-0014 决策 14)。
 *
 * 皮肤包里的占位符 `{a.b.c}` 与 `showIf` 指的都是 `CARD_SKIN_FIELDS`(住在
 * `@bilibili-notify/internal` 的 `schema/card-skin.ts`)里那张表;这一层负责把各卡模板自己的
 * props(`templates/*.tsx` 的 `*CardProps`)翻译成那张表的形状。
 *
 * 三条纪律:
 * - **产出与字段表一一对应**:多一个字段 = 皮肤引用不到的死数据,少一个 = 皮肤写了取不到值。
 *   `__tests__/card-fields.test.ts` 逐 kind 对表钉死(路径集合与每个值的 typeof 都对)。
 * - **永不 undefined**:缺数据一律回落成空串 / 0 / false,占位符替换时不会冒出 "undefined"。
 * - **已格式化的文本直接给**(「1.2 万」「已开播 1 小时」),占位符不带过滤器。
 */

import type { CardKind } from "@bilibili-notify/internal";
import type { LiveCardView } from "../templates/live-card";
import type { MembershipCardView } from "../templates/membership-card";
import type { PostCardView } from "../templates/post-card";
import type { RoastBoardCardInput, RoastSoloCardInput } from "../templates/roast-card";
import type { SuperchatCardView } from "../templates/superchat-card";
import type { WordCloudCardInput } from "../templates/wordcloud-card";

/** 契约里一个字段的值。对应 `CardSkinFieldType`:`text` / `image` → string。 */
export type CardFieldValue = string | number | boolean;

/**
 * 一张卡的契约数据。恰好两层 —— 外层是字段路径的第一段(`creator` / `live` / `stats`…),
 * 内层是第二段。字段路径只有两段,所以这里不需要更深的嵌套。
 */
export type CardFields = Record<string, Record<string, CardFieldValue>>;

// ── 小工具 ────────────────────────────────────────────────────────────────────

/** 任意值 → 契约里的 text / image(缺席一律空串,绝不让 "undefined" 进模板)。 */
function str(v: unknown): string {
	return v === undefined || v === null ? "" : String(v);
}

/** 任意值 → 契约里的 number(非有限数一律 0)。 */
function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ── live ─────────────────────────────────────────────────────────────────────

/**
 * 直播卡的数据全从 {@link LiveCardView} 取 —— 与块库(`blocks/live.tsx`)吃的是同一份,
 * 判据也同一套:开播与直播中是同一种样子(`isStreaming`),下播是另一种(`isEnded`)。
 */
function liveFields(p: LiveCardView): CardFields {
	const onAir = p.status === "start" || p.status === "streaming";
	const ended = p.status === "end";
	const followersDelta = str(p.followersDelta);
	return {
		creator: { name: str(p.creatorName), avatar: str(p.creatorAvatarUrl) },
		live: {
			title: str(p.title),
			category: str(p.category),
			time: str(p.time),
			// 视图里的简介已经是纯文本(B 站那头剥过富文本)。
			description: str(p.description),
			// 生效的那张(自定义直播封面已经盖上去了)—— 与封面块画的是同一张。没有真封面时
			// 视图里已经是占位图(没写 `showIf` 的皮肤也不会裂图),真不真由 `hasCover` 如实说。
			cover: str(p.cover),
			hasCover: !!p.hasCover,
			isStreaming: onAir,
			isEnded: ended,
		},
		// 每格只装名字说的那一样,不该有值的状态下是空串(字段表规定永不 undefined)。四格的分支与 `blocks/live.tsx`
		// 的 `statsLeft` / `followerText` 同一套(下播是点赞与累计观看,决策 76),只是不带「人气：」这类前缀
		// (前缀归皮肤的模板写)。
		stats: {
			currentViewers: ended ? "" : str(p.currentViewers),
			likes: ended ? str(p.likes) : "",
			followers: onAir ? str(p.followers) : "",
			totalViewers: ended ? str(p.totalViewers) : "",
			// 默认卡不画它(决策 76,它进下播文案),契约照给 —— 自己做皮肤的人想画就能画。
			followersDelta,
			hasFollowersDelta: followersDelta !== "",
		},
	};
}

// ── dynamic ──────────────────────────────────────────────────────────────────

/**
 * 作品卡的数据**全从 node 取**(ADR-0019 决策 68)。
 *
 * 块画什么、契约就说什么,判据只有一份:视频那一组读 `node.video`(五个视频块画的就是它),
 * 图廊那一组读 `node.images`(`images` 块拿它现画)。从前后两样要回头
 * 去 B 站原始数据里刨,出卡入口因此得另收一份原始数据 —— 拓展的作品没有那份东西;而各刨
 * 各的,判据迟早分叉(从前拿「标题非空」当 `hasVideo`,一条没标题的投稿会画出封面,却告诉
 * 皮肤的 `showIf` 说没视频)。
 */
function postFields(p: PostCardView): CardFields {
	const node = p.node;
	const images = node.images ?? [];
	const video = node.video;
	return {
		creator: {
			name: str(node.creatorName),
			avatar: str(node.creatorAvatarUrl),
			isPremium: !!node.creatorIsPremium,
		},
		// `time` 只是时间,`label` 是动作标签,内外层卡各有各的值(默认皮肤的时间块把两样拼回「时间 · 标签」那一行)。
		post: {
			label: str(node.label),
			time: str(node.time),
			topic: str(node.topic),
			hasTopic: !!node.topic,
			hasRepost: !!node.repost,
			hasAttachment: !!node.attachment,
			hasVideo: !!video,
			hasImages: images.length > 0,
		},
		video: {
			title: str(video?.title),
			description: str(video?.description),
			cover: str(video?.cover),
			duration: str(video?.duration),
			// 接口给的播放 / 弹幕数可能已是格式化字符串("6.5万"),`videoOf` 原样转了文本。
			// 播放数、弹幕数都选填(拓展作品不收弹幕数、播放数选填),缺了就是空串。
			views: str(video?.views),
			danmaku: str(video?.danmaku),
		},
		images: { count: images.length, first: str(images[0]?.url) },
		stats: {
			shares: str(node.stats?.shares),
			comments: str(node.stats?.comments),
			likes: str(node.stats?.likes),
		},
	};
}

// ── sc ───────────────────────────────────────────────────────────────────────

/**
 * 醒目留言卡的数据全从 {@link SuperchatCardView} 取 —— 与块库(`blocks/superchat.tsx`)吃的是同一份。金额与时长都是视图里
 * 排好的文字(`formatAmount` / `formatDuration`,时长缺了是空串);`rank` 是夹进 1–6 的有效档位,与取色用的是同一个值。
 */
function superchatFields(p: SuperchatCardView): CardFields {
	return {
		viewer: { name: str(p.viewerName), avatar: str(p.viewerAvatarUrl) },
		creator: { name: str(p.creatorName), avatar: str(p.creatorAvatarUrl) },
		superchat: {
			amount: str(p.amount),
			amountValue: num(p.amountValue),
			duration: str(p.duration),
			rank: num(p.rank),
			text: str(p.text),
		},
	};
}

// ── guard ────────────────────────────────────────────────────────────────────

/**
 * 会员卡的数据全从 {@link MembershipCardView} 取。`rank` 是档位(1 最低),没有 rank 的档是 0(`rank` 本身从 1 起,
 * 0 不会与真档混淆 —— 契约里数字类型的字段「缺了」就是 0);宣告语是视图里已经填好的那一句,没声明就是空串。
 */
function membershipFields(p: MembershipCardView): CardFields {
	return {
		viewer: { name: str(p.viewerName), avatar: str(p.viewerAvatarUrl) },
		creator: { name: str(p.creatorName), avatar: str(p.creatorAvatarUrl) },
		membership: {
			rank: num(p.rank),
			tierName: str(p.tierName),
			icon: str(p.iconUrl),
			announcement: str(p.announcement),
		},
	};
}

// ── roast / wordcloud ────────────────────────────────────────────────────────

/** 榜单周报不属于任何单个创作者,契约里没有创作者那两格。 */
function roastBoardFields(p: RoastBoardCardInput): CardFields {
	return { report: { days: num(p.days) } };
}

function roastSoloFields(p: RoastSoloCardInput): CardFields {
	return {
		creator: { name: str(p.creator?.name), avatar: str(p.creator?.avatar) },
		report: { days: num(p.days) },
	};
}

function wordCloudFields(p: WordCloudCardInput): CardFields {
	return { creator: { name: str(p.creatorName), avatar: str(p.creatorAvatarUrl) } };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export function cardFieldsOf(kind: "live", props: LiveCardView): CardFields;
export function cardFieldsOf(kind: "post", props: PostCardView): CardFields;
export function cardFieldsOf(kind: "superchat", props: SuperchatCardView): CardFields;
export function cardFieldsOf(kind: "membership", props: MembershipCardView): CardFields;
export function cardFieldsOf(kind: "roastBoard", props: RoastBoardCardInput): CardFields;
export function cardFieldsOf(kind: "roastSolo", props: RoastSoloCardInput): CardFields;
export function cardFieldsOf(kind: "wordcloud", props: WordCloudCardInput): CardFields;
/**
 * 把一张卡的 props 翻成它那份契约数据。产出的路径集合与 `CARD_SKIN_FIELDS[kind]` 一字不差。
 */
export function cardFieldsOf(
	kind: CardKind | "roastSolo" | "wordcloud",
	props: unknown,
): CardFields {
	switch (kind) {
		case "live":
			return liveFields(props as LiveCardView);
		case "post":
			return postFields(props as PostCardView);
		case "superchat":
			return superchatFields(props as SuperchatCardView);
		case "membership":
			return membershipFields(props as MembershipCardView);
		case "roastBoard":
			return roastBoardFields(props as RoastBoardCardInput);
		case "roastSolo":
			return roastSoloFields(props as RoastSoloCardInput);
		case "wordcloud":
			return wordCloudFields(props as WordCloudCardInput);
	}
}

/**
 * 原型链上的名字。皮肤包是第三方写的文本,`{constructor.name}` 这种路径必须取不到东西 ——
 * 否则占位符替换就成了一扇读宿主运行时内部状态的窗。
 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 按字段路径取值。只认 `a.b` 两段、只认自有属性,取不到回 undefined(调用方决定怎么兜)。
 */
export function readCardField(data: CardFields, path: string): CardFieldValue | undefined {
	const parts = path.split(".");
	if (parts.length !== 2) return undefined;
	const [group, key] = parts;
	if (FORBIDDEN_SEGMENTS.has(group) || FORBIDDEN_SEGMENTS.has(key)) return undefined;
	if (!Object.hasOwn(data, group)) return undefined;
	const bucket = data[group];
	if (typeof bucket !== "object" || bucket === null) return undefined;
	if (!Object.hasOwn(bucket, key)) return undefined;
	const value = bucket[key];
	const t = typeof value;
	return t === "string" || t === "number" || t === "boolean" ? value : undefined;
}
