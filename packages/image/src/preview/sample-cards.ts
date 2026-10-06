/**
 * **出厂示例卡片数据** —— 卡片皮肤编辑器实时预览用的那一套 props(ADR-0014)。用户在面板上
 * 改皮肤 JSON,服务端拿这里的示例数据走 `renderCardWithSkin` 画一张给他看。
 *
 * ⛔ **与 `__tests__/fixtures/card-fixtures.ts` 刻意各存一份,两边谁也不许 import 谁**。那份
 * 夹具钉着 23 张逐字节的基准快照,它的全部价值就是**冻住不动**;示例数据反过来要随产品的
 * 观感一起动(换文案、加场景、换占位图)。共用一份的话,以后调一句示例文案就会把那 23 张
 * 快照整片打红,而那片红没有任何含义 —— 所以「像但不是同一份」在这儿是刻意的。
 *
 * 三条硬约束:
 * - **确定性**:同样入参每次产出同一份 HTML。不读时钟、不摇随机数,时间一律写死字符串 ——
 *   预览是要拿去和上一版对着看的,自己会飘的话看不出是皮肤改动还是数据变了。
 * - **不联网**:头像 / 封面 / 徽章全是内联 SVG 的 `data:` URI(与 `routes/cards.ts` 的预览
 *   占位同款)。预览随手就会被连按十几次,每次都去 B 站取图既慢又会在无网环境下开天窗。
 * - **口吻统一**:一律「示例 xxx」,不编真实 UP 名、不编真实链接。
 *
 * 场景表(`CARD_PREVIEW_SCENES`)不在这儿,住在 `@bilibili-notify/internal` —— 面板也要读它
 * 画那排场景按钮,理由见那边的注释。
 */

import {
	type Attachment,
	type CardKind,
	formatCount,
	guardTierOf,
	type Post,
	type PostImage,
	resolvePreviewScene,
} from "@bilibili-notify/internal";
import type { CardPropsByKind } from "../blocks/frames";
import { buildMembershipCardView } from "../membership-view";
import { buildSuperchatCardView } from "../superchat-view";
import type { LiveCardView } from "../templates/live-card";
import { nodeFromPost } from "../templates/post-node";

/** 一份示例 props 就是该卡种的真 props。 */
type SampleProps<K extends CardKind> = CardPropsByKind[K];

// ── 占位图 ────────────────────────────────────────────────────────────────────
//
// 与 `apps/server/src/routes/cards.ts` 里那四个同款(那边是路由的私有常量,跨包 import 一个
// 路由文件的私有常量不成立,所以这里照抄一份)。第五个是舰长徽章:真卡上那是 B 站的徽章图
// (远端 URL),预览不许联网,拿一块同尺寸的色块顶上。

const SVG_COVER =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 338'%3E%3Crect width='600' height='338' fill='%23FB7299'/%3E%3Ctext x='50%25' y='50%25' fill='white' font-size='32' text-anchor='middle' dominant-baseline='middle'%3ECover%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_PINK =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23FB7299'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='28' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_BLUE =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%2300AEEC'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='30' text-anchor='middle' dominant-baseline='middle'%3EUP%3C/text%3E%3C/svg%3E";

const SVG_AVATAR_FAN =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='32' fill='%23fdcb6e'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='28' text-anchor='middle' dominant-baseline='middle'%3E粉%3C/text%3E%3C/svg%3E";

/** 上舰卡的徽章位(真卡上是 B 站的舰长图,175×175 当背景铺)。 */
const SVG_GUARD_BADGE =
	"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 175 175'%3E%3Ccircle cx='87' cy='87' r='72' fill='%234ebcec' opacity='0.85'/%3E%3Ctext x='50%25' y='52%25' fill='white' font-size='42' font-weight='bold' text-anchor='middle' dominant-baseline='middle'%3E舰长%3C/text%3E%3C/svg%3E";

/** 示例主播 / 示例 UP 主的公共身份,四种卡上是同一个人。 */
const MASTER = { name: "示例 UP 主", face: SVG_AVATAR_BLUE } as const;

// ── 直播卡 ────────────────────────────────────────────────────────────────────

/**
 * 两个场景的差异全在这几项里(其余字段共用)。
 *
 * 示例直接写块吃的那一份({@link LiveCardView}):卡上那句时间写死,不读时钟。数据区跟着
 * 状态换:直播中报人气与当前粉丝数,下播报点赞与累计观看人数(ADR-0019 决策 76,
 * `blocks/live.tsx` 的 `statsLeft` / `followerText`)。
 */
type LiveSceneOverlay = Pick<LiveCardView, "status" | "time"> &
	Partial<Pick<LiveCardView, "currentViewers" | "likes" | "totalViewers" | "followers">>;

const LIVE_SCENES: Record<string, LiveSceneOverlay> = {
	streaming: {
		status: "streaming",
		time: "直播时长：2小时13分",
		currentViewers: formatCount(123_456),
		followers: formatCount(88_800),
	},
	ended: {
		status: "end",
		time: "开播时间：2026-09-13 20:00:00",
		likes: formatCount(20_133),
		totalViewers: formatCount(31_200),
	},
};

function liveSample(scene: string): LiveCardView {
	return {
		creatorName: MASTER.name,
		creatorAvatarUrl: MASTER.face,
		title: "【示例】周年庆典特别直播，今晚不见不散！",
		category: "虚拟主播",
		description: "这是一段示例直播间简介：每晚八点开播，周末加场。",
		// 「正在直播」那一档真机上铺的是实时关键帧;示例里两个场景是同一块占位图。
		cover: SVG_COVER,
		hasCover: true,
		currentViewers: "",
		likes: "",
		totalViewers: "",
		followers: "",
		followersDelta: "",
		...LIVE_SCENES[scene],
	};
}

// ── 动态卡 ────────────────────────────────────────────────────────────────────

/**
 * 动态卡的示例**直接写成 `Post`**(㉑c 第 5 步):出图器只认中立的作品,示例就是它吃的那份输入,经
 * `nodeFromPost` 造成块吃的节点 —— 与真出卡(`ImageRenderer.generatePostCard`)同一条路,预览与真出图只要
 * 各拼各的,迟早长成两副样子。
 *
 * 时间真机上由渲染器按时钟算,示例里写死「刚刚」—— 预览要的是稳定;数字走卡片同款的万 / 亿写法
 * (`formatCount`,在 `nodeFromPost` 里),免得示例上的数字和真卡长得不是一回事。
 *
 * 头像与真出卡走同一条路:`Creator.avatar` 是图库引用,示例放一个**内置的示例引用**({@link SAMPLE_AVATAR_REF}),
 * 解析口(这里就是一张写死的表)把它认成内置头像图 —— 示例要保持确定性、不联网、不依赖盘上有什么,所以认得它的
 * 是示例自己的解析口,不是服务端的图库(那里没有这张图)。
 */
const FMT = {
	time: () => "刚刚",
	imageUrl: (ref: string): string | undefined => SAMPLE_IMAGES[ref],
};

/** 示例视频本身。「视频投稿」与转发场面框里那条用的是同一个视频,只是外面那条动态不同。 */
const SAMPLE_VIDEO: NonNullable<Post["video"]> = {
	cover: { url: SVG_COVER },
	title: "【示例视频】这是一条用来预览卡片的示例投稿标题",
	description: "示例简介：这一行用来看视频小卡里的副标题。",
	durationSec: 967,
	views: 18_000,
	danmaku: 129,
};

/** 内置的示例头像引用:形状合规(`<sha256>.<扩展名>`)、不会与任何真图撞名;只有示例的解析口认得它。 */
export const SAMPLE_AVATAR_REF = `${"0".repeat(63)}1.png`;

/**
 * 醒目留言卡 / 会员卡示例里观众的头像引用。与真出卡同一条路(输入里的头像是图库引用,经示例的解析口认成内置图):
 * 真机上 B 站这条路到 3a 之前不给头像,示例照样画出来 —— 皮肤作者要对着看头像格,别的来源有头像时就是这个样子。
 */
const SAMPLE_FAN_AVATAR_REF = `${"0".repeat(63)}2.png`;
const SAMPLE_NEW_MEMBER_AVATAR_REF = `${"0".repeat(63)}3.png`;

/** 示例里用到的内置图:引用 → 图(与 `routes/cards.ts` 的预览占位同款 SVG)。 */
const SAMPLE_IMAGES: Readonly<Record<string, string>> = {
	[SAMPLE_AVATAR_REF]: SVG_AVATAR_BLUE,
	[SAMPLE_FAN_AVATAR_REF]: SVG_AVATAR_FAN,
	[SAMPLE_NEW_MEMBER_AVATAR_REF]: SVG_AVATAR_PINK,
};

/** 示例作者:大会员,名字走粉色那一支,皮肤里这条最容易被写死的前景色吃掉。 */
const SAMPLE_CREATOR = { name: MASTER.name, isPremium: true, avatar: SAMPLE_AVATAR_REF } as const;
const SAMPLE_PUBLISHED_AT = "2027-01-15T08:00:00.000Z";

const SAMPLE_TOPIC = "示例话题";
const SAMPLE_TEXT = "这是一段示例动态正文，用来看正文块的字号、行距与留白。";

/**
 * 附加内容块在默认皮肤里是独立一块,不给的话预览里整块是空的 —— 皮肤作者就看不到自己给它写的样式。
 */
const SAMPLE_ATTACHMENT: Attachment = {
	kind: "card",
	title: "示例预约：周年庆典直播",
	lines: [{ text: "预计 09-20 20:00 直播" }, { text: "2.3万人预约" }],
	button: { text: "预约", enabled: true },
};

/**
 * 字段最全的那条动态:正文 + 视频卡 + 话题 + 附加内容 + 互动数。
 *
 * **它自己不再是一个场面**(2026-09-19 拍板):四场按主媒体分,而它在出图端与「视频投稿」
 * 是同一种卡。留着是因为另外两处照它长:**转发场面框里那条原动态**就是它(内层那张卡
 * 一次把各块都占上,转发那一层才看得出内外同源),以及下面的 `SAMPLE_TEXT_POST` ——
 * 纯文字那条 = 它去掉视频。
 */
const SAMPLE_AV_POST: Post = {
	creator: SAMPLE_CREATOR,
	publishedAt: SAMPLE_PUBLISHED_AT,
	label: "投稿了视频",
	topic: SAMPLE_TOPIC,
	text: SAMPLE_TEXT,
	richText: [{ kind: "text", text: SAMPLE_TEXT }],
	video: SAMPLE_VIDEO,
	attachment: SAMPLE_ATTACHMENT,
	stats: { shares: 128, comments: 456, likes: 7890 },
};

/**
 * 「纯文字」场面(**默认**)—— 没有主媒体的那一条:正文 + 话题 + 附加内容 + 互动数。
 * 它是底档 —— 正文、话题、附加内容这三块只有在这一场才一次看得全(视频那场三样都没有)。
 *
 * 除了视频,每一样都照 `SAMPLE_AV_POST` 取:各写一份的话两条示例迟早会漂,而「同一段正文在两种卡上
 * 长什么样」正是写皮肤的人要对着看的。
 */
const SAMPLE_TEXT_POST: Post = {
	creator: SAMPLE_CREATOR,
	publishedAt: SAMPLE_PUBLISHED_AT,
	topic: SAMPLE_TOPIC,
	text: SAMPLE_TEXT,
	richText: [{ kind: "text", text: SAMPLE_TEXT }],
	attachment: SAMPLE_ATTACHMENT,
	stats: { shares: 128, comments: 456, likes: 7890 },
};

/**
 * 「视频投稿」场面 —— 真机上 UP 发视频推过来的那张:B 站给的这类动态通常**没有**动态正文、
 * 话题与附加内容(视频的简介在视频卡里),只有作者、视频卡、互动数。与 `runtime/video-card.ts`
 * 为链接解析造出来的那条同一个形状。
 */
const SAMPLE_VIDEO_POST: Post = {
	creator: SAMPLE_CREATOR,
	publishedAt: SAMPLE_PUBLISHED_AT,
	label: "投稿了视频",
	text: "",
	video: SAMPLE_VIDEO,
	stats: { shares: 32, comments: 214, likes: 3456 },
};

/**
 * 图文场面的九张占位图:编了号、两色相间,一眼看得出排列顺序。第 5 张是**长图**(高超过
 * 宽的两倍),好让九宫格里那个「长图」角标也有地方露面 —— 皮肤作者要给它写样式。
 */
function samplePic(n: number, long: boolean): PostImage {
	const width = 400;
	const height = long ? 1000 : 400;
	const fill = n % 2 === 1 ? "%23FB7299" : "%2300AEEC";
	return {
		url: `data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='${width}' height='${height}' fill='${fill}'/%3E%3Ctext x='50%25' y='50%25' fill='white' font-size='96' text-anchor='middle' dominant-baseline='middle'%3E${n}%3C/text%3E%3C/svg%3E`,
		width,
		height,
	};
}

/**
 * 「图文」场面(场景 id 为 `pics`)—— 一段正文 + 九张图(图廊最满的样子)。图在 `images`,
 * 渲染器与契约的 `pics.*` 都从这里取。
 */
const SAMPLE_PICS_TEXT = "这是一段示例图文正文，下面是九张示例图，第 5 张是长图。";
const SAMPLE_DRAW_POST: Post = {
	creator: SAMPLE_CREATOR,
	publishedAt: SAMPLE_PUBLISHED_AT,
	text: SAMPLE_PICS_TEXT,
	richText: [{ kind: "text", text: SAMPLE_PICS_TEXT }],
	images: Array.from({ length: 9 }, (_, i) => samplePic(i + 1, i === 4)),
	stats: { shares: 64, comments: 128, likes: 2048 },
};

/**
 * 转发场面的那条动态 —— 示例转发者转了上面那条投稿。
 *
 * 转发框里是**另一整张卡**(同一批块、同一份皮肤),而它在编辑器里原本一眼都看不到:
 * 动态卡从前只有一个场面,示例数据里没有转发。`repost` 直接指字段最全那条
 * (`SAMPLE_AV_POST`),不另写一份 —— 两份示例迟早会漂,而「内层画的和外层是同一套
 * 东西」正是这个场面要给人看的,内层块占得越满越看得出来。
 */
const SAMPLE_FORWARD_TEXT = "这是一段示例转发语，下面那张是被转发的原动态。";
const SAMPLE_FORWARD_POST: Post = {
	creator: { name: "示例转发者", isPremium: false, avatar: SAMPLE_AVATAR_REF },
	publishedAt: SAMPLE_PUBLISHED_AT,
	text: SAMPLE_FORWARD_TEXT,
	richText: [{ kind: "text", text: SAMPLE_FORWARD_TEXT }],
	repost: SAMPLE_AV_POST,
	stats: { shares: 12, comments: 34, likes: 567 },
};

const DYNAMIC_SCENES: Record<string, Post> = {
	text: SAMPLE_TEXT_POST,
	video: SAMPLE_VIDEO_POST,
	pics: SAMPLE_DRAW_POST,
	forward: SAMPLE_FORWARD_POST,
};

function dynamicSample(scene: string): SampleProps<"post"> {
	return { node: nodeFromPost(DYNAMIC_SCENES[scene] ?? SAMPLE_TEXT_POST, FMT) };
}

// ── 醒目留言卡 ────────────────────────────────────────────────────────────────

function scSample(): SampleProps<"superchat"> {
	// 档由来源按平台规矩算好、随输入带来(B 站那头在 `superchatEventFromLiveEvent`:100 元落第 3 档、挂 300 秒);
	// 示例直接写算好的档,颜色与时长的排版走真出卡同一条路(`buildSuperchatCardView`),不手抄一份。
	return buildSuperchatCardView(
		{
			viewer: { name: "示例粉丝", avatar: SAMPLE_FAN_AVATAR_REF },
			creator: SAMPLE_CREATOR,
			text: "主播加油！这是一条示例醒目留言，用来看留言块的换行与留白。",
			amount: 100,
			currency: "CNY",
			tier: { rank: 3, durationSec: 300 },
		},
		{ imageUrl: FMT.imageUrl },
	);
}

// ── 上舰卡 ────────────────────────────────────────────────────────────────────

function guardSample(): SampleProps<"membership"> {
	// 档的各项取自档位表(档色与宣告语哪天调了,预览不会还停在老样子);徽章换成内联的色块 —— 真卡上那是远端图,
	// 预览不许联网。
	const captain = guardTierOf(3);
	if (!captain) throw new Error("档位表里没有 guard_level 3 这一档");
	return buildMembershipCardView(
		{
			viewer: { name: "示例粉丝", avatar: SAMPLE_NEW_MEMBER_AVATAR_REF },
			creator: SAMPLE_CREATOR,
			tier: {
				name: captain.name,
				rank: captain.rank,
				color: captain.color,
				colorEnd: captain.colorEnd,
				announcement: captain.announcement,
				icon: { url: SVG_GUARD_BADGE },
			},
		},
		{ imageUrl: FMT.imageUrl },
	);
}

// ── 锐评卡 ────────────────────────────────────────────────────────────────────

/**
 * 真机上每位 UP 的强调色由 `upColor` 按人算(B 站按 uid、拓展按「拓展 id:外部 id」,与面板上同一位 UP
 * 同色);示例里没有真人,直接写死三个分得开的色。
 */
const SAMPLE_UPS = {
	first: { name: "示例 UP 主·甲", color: "#fb7299", avatar: SVG_AVATAR_PINK },
	second: { name: "示例 UP 主·乙", color: "#2ac864" },
	third: { name: "示例 UP 主·丙", color: "#0984e3", avatar: SVG_AVATAR_BLUE },
} as const;

function roastBoardSample(): SampleProps<"roastBoard"> {
	return {
		days: 30,
		pigeon: { ...SAMPLE_UPS.first, reason: "示例理由：整整一个月就发了一条，还是转发。" },
		// 不给头像那一位是**故意**的:卡片会退成首字母圆牌,皮肤得连那一支一起看过。
		diligent: { ...SAMPLE_UPS.second, reason: "示例理由：周更三条，选题还都没塌。" },
		roast: [
			{ ...SAMPLE_UPS.first, comment: "示例锐评：鸽子精本精，建议改名叫月更。" },
			{ ...SAMPLE_UPS.second, comment: "示例锐评：稳得可怕，就是标题一期比一期长。" },
		],
		// 刻意不按分数排 —— 卡片自己会排,顺带证明预览走的是真排版。
		scores: [
			{ ...SAMPLE_UPS.first, score: 41 },
			{ ...SAMPLE_UPS.second, score: 96 },
			{ ...SAMPLE_UPS.third, score: 12 },
		],
	};
}

function roastSoloSample(): SampleProps<"roastSolo"> {
	return {
		days: 7,
		creator: SAMPLE_UPS.first,
		verdict: "示例锐评：这周唯一的产出是一条「在剪了」，剪了七天，还在剪。",
		score: 32,
		highlights: [
			{ label: "涨粉", comment: "示例：掉了两千，主要掉在周三那条动态之后。" },
			{ label: "互动", comment: "示例：评论区比视频热闹，值得一看。" },
		],
	};
}

// ── 词云卡 ────────────────────────────────────────────────────────────────────

function wordCloudSample(): SampleProps<"wordcloud"> {
	// 画布上的词由 `wordCloudInitScript` 另行追加(几百 KB 的脚本),卡壳这一半不带词 ——
	// 预览里那块画布是空的,皮肤能改的也正是卡壳这一半。
	return { creatorName: MASTER.name, creatorAvatarUrl: MASTER.face };
}

// ── 出口 ──────────────────────────────────────────────────────────────────────

/** 动态那份要 await(正文由真正的构建器造),别的都是同步 —— 出口那头统一 await 一次。 */
const SAMPLES: {
	[K in CardKind]: (scene: string) => SampleProps<K> | Promise<SampleProps<K>>;
} = {
	live: liveSample,
	post: dynamicSample,
	superchat: scSample,
	membership: guardSample,
	roastBoard: roastBoardSample,
	roastSolo: roastSoloSample,
	wordcloud: wordCloudSample,
};

/**
 * 某种卡 + 某个场景的示例数据。`scene` 缺省或不认识 → 用该卡种的**第一个**场景
 * (不报错:场景名是从 URL / 请求体来的,面板换了一版、链接被人存过书签都会送来旧名字,
 * 为这个给用户一张错误页不值)。
 *
 * 签名保持 **async**:唯一的消费方(预览路由)本来就在 async 里,别的卡种的示例也可能需要异步取东西。
 *
 * 喂 `renderCardWithSkin(kind, props, manifest)`。契约里视频 / 图廊那两组字段、动态类型都
 * 跟着 `node` 走(ADR-0019 决策 68),不再另交原始动态。
 */
export async function sampleCard(kind: CardKind, scene?: string): Promise<{ props: unknown }> {
	const picked = resolvePreviewScene(kind, scene);
	const props = await (SAMPLES[kind] as (s: string) => unknown | Promise<unknown>)(picked.id);
	return { props };
}
