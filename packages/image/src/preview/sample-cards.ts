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

import { GuardLevel } from "@bilibili-notify/blive";
import { type CardSkinKind, resolvePreviewScene } from "@bilibili-notify/internal";
import type { CardPropsByKind } from "../blocks/frames";
import { numberToStr } from "../format";
import { BG_COLORS, getSCLevel, SC_COLORS, SC_LEVELS } from "../styles";
import { buildDynamicNode, type NodeFormatters } from "../templates/dynamic-content";
import type { Dynamic, RichTextNode } from "../types";

/**
 * 一份示例 props = 该卡种的真 props **减去已退役的字段**:玻璃两项(2026-09-14 退成皮肤
 * 旋钮)与渐变起 / 止色(决策 15 起皮肤路径压根不读,外框的底色归皮肤 CSS)。写进来等于
 * 复活一条死路 —— 照着示例数据写皮肤的人会以为这些字段还管用。
 *
 * 卡种之间字段名不同(词云叫 `colorStart`),一并摘掉。`Omit` 对不存在的键是空操作。
 */
type SampleProps<K extends CardSkinKind> = Omit<
	CardPropsByKind[K],
	"cardColorStart" | "cardColorEnd" | "colorStart" | "colorEnd" | "glassOpacity" | "glassClear"
>;

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
 * 三个场景的差异全在这几项里(其余字段共用)。
 *
 * `liveStatus` 是**卡上角标**用的那一档(1 = 直播中、2 = 已下播),不是 B 站接口原值 ——
 * `ImageRenderer.generateLiveCard` 会先把接口那套映射过来再传给卡片,示例数据照它的产物写。
 * 粉丝行也跟着换:直播中报当前粉丝数、下播报累计观看人数(`blocks/live.tsx` 的 `followerText`)。
 */
type LiveSceneOverlay = Pick<SampleProps<"live">, "titleStatus" | "liveTime" | "liveStatus"> &
	Partial<Pick<SampleProps<"live">, "onlineNum" | "likedNum" | "watchedNum" | "fansNum">>;

const LIVE_SCENES: Record<string, LiveSceneOverlay> = {
	streaming: {
		titleStatus: "正在直播",
		liveTime: "直播时长：2小时13分",
		liveStatus: 1,
		onlineNum: numberToStr(123_456),
		fansNum: numberToStr(88_800),
	},
	start: {
		titleStatus: "开播啦",
		liveTime: "开播时间：2026-09-13 20:00:00",
		liveStatus: 1,
		onlineNum: numberToStr(8_642),
		fansNum: numberToStr(88_600),
	},
	ended: {
		titleStatus: "下播啦",
		liveTime: "开播时间：2026-09-13 20:00:00",
		liveStatus: 2,
		onlineNum: numberToStr(96_210),
		watchedNum: numberToStr(31_200),
	},
};

function liveSample(scene: string): SampleProps<"live"> {
	return {
		data: {
			title: "【示例】周年庆典特别直播，今晚不见不散！",
			area_name: "虚拟主播",
			user_cover: SVG_COVER,
			// 「正在直播」那一档真机上铺的是实时关键帧;示例里两张是同一块占位图。
			keyframe: SVG_COVER,
			description: "这是一段示例直播间简介：每晚八点开播，周末加场。",
			online: 123_456,
		},
		username: MASTER.name,
		userface: MASTER.face,
		cover: true,
		onlineNum: "",
		likedNum: "",
		watchedNum: "",
		fansNum: "",
		fansChanged: "",
		...LIVE_SCENES[scene],
	};
}

// ── 动态卡 ────────────────────────────────────────────────────────────────────

/**
 * 时间 / 数字的格式化器。真机上时间由渲染器按时钟算,示例里写死 —— 预览要的是稳定。
 * 数字仍走卡片同款的万 / 亿写法,免得示例上的数字和真卡长得不是一回事。
 */
const FMT: NodeFormatters = { time: () => "刚刚", num: (n: number) => numberToStr(n) };

/** 视频投稿动态 —— 七种卡里字段最全的一条:正文 + 视频卡 + 话题 + 附加内容 + 互动数。 */
const SAMPLE_AV_DYNAMIC = {
	basic: { is_only_fans: false },
	id_str: "1000000000000000001",
	type: "DYNAMIC_TYPE_AV",
	visible: true,
	modules: {
		module_author: {
			avatar: {},
			face: MASTER.face,
			face_nft: false,
			following: true,
			jump_url: "",
			label: "",
			mid: 2233,
			name: MASTER.name,
			pub_action: "",
			pub_action_text: "",
			pub_location_text: "IP属地：上海",
			pub_time: "刚刚",
			pub_ts: 1_800_000_000,
			type: "AUTHOR_TYPE_NORMAL",
			// 大会员:名字走粉色那一支,皮肤里这条最容易被写死的前景色吃掉。
			vip: { type: 1 },
		},
		module_dynamic: {
			topic: { id: 1, name: "示例话题", jump_url: "" },
			desc: {
				text: "这是一段示例动态正文。",
				rich_text_nodes: [
					{
						type: "RICH_TEXT_NODE_TYPE_TEXT",
						orig_text: "这是一段示例动态正文，用来看正文块的字号、行距与留白。",
						text: "这是一段示例动态正文，用来看正文块的字号、行距与留白。",
					},
				] as RichTextNode,
			},
			major: {
				type: "MAJOR_TYPE_ARCHIVE",
				archive: {
					badge: { text: "投稿视频" },
					cover: SVG_COVER,
					duration_text: "16:07",
					title: "【示例视频】这是一条用来预览卡片的示例投稿标题",
					desc: "示例简介：这一行用来看视频小卡里的副标题。",
					stat: { play: "1.8万", danmaku: "129" },
					bvid: "",
					jump_url: "",
				},
			},
			// 附加内容块在默认皮肤里是独立一块,不给的话预览里整块是空的 —— 皮肤作者就看不到
			// 自己给它写的样式。
			additional: {
				type: "ADDITIONAL_TYPE_RESERVE",
				reserve: {
					title: "示例预约：周年庆典直播",
					desc1: { text: "预计 09-20 20:00 直播" },
					desc2: { text: "2.3万人预约" },
					button: { uncheck: { text: "预约" }, check: { text: "已预约" }, type: 1 },
				},
			},
		},
		module_stat: {
			forward: { count: 128 },
			comment: { count: 456 },
			like: { count: 7890 },
		},
	},
} as unknown as Dynamic;

/**
 * 转发场面的那条动态 —— 示例转发者转了上面那条投稿。
 *
 * 转发框里是**另一整张卡**(同一批块、同一份皮肤),而它在编辑器里原本一眼都看不到:
 * 动态卡从前只有一个场面,示例数据里没有转发。`orig` 直接指上面那条,不另写一份 ——
 * 两份示例迟早会漂,而「内层画的和外层是同一套东西」正是这个场面要给人看的。
 */
const SAMPLE_FORWARD_DYNAMIC = {
	basic: { is_only_fans: false },
	id_str: "1000000000000000002",
	type: "DYNAMIC_TYPE_FORWARD",
	visible: true,
	modules: {
		module_author: {
			avatar: {},
			face: SVG_AVATAR_BLUE,
			face_nft: false,
			following: true,
			jump_url: "",
			label: "",
			mid: 4455,
			name: "示例转发者",
			pub_action: "",
			pub_action_text: "",
			pub_location_text: "IP属地：北京",
			pub_time: "刚刚",
			pub_ts: 1_800_000_000,
			type: "AUTHOR_TYPE_NORMAL",
			vip: { type: 0 },
		},
		module_dynamic: {
			desc: {
				text: "这是一段示例转发语。",
				rich_text_nodes: [
					{
						type: "RICH_TEXT_NODE_TYPE_TEXT",
						orig_text: "这是一段示例转发语，下面那张是被转发的原动态。",
						text: "这是一段示例转发语，下面那张是被转发的原动态。",
					},
				] as RichTextNode,
			},
		},
		module_stat: {
			forward: { count: 12 },
			comment: { count: 34 },
			like: { count: 567 },
		},
	},
	orig: SAMPLE_AV_DYNAMIC,
} as unknown as Dynamic;

const DYNAMIC_SCENES: Record<string, Dynamic> = {
	default: SAMPLE_AV_DYNAMIC,
	forward: SAMPLE_FORWARD_DYNAMIC,
};

async function dynamicSample(scene: string): Promise<SampleProps<"dynamic">> {
	// 正文结构树由**真正的构建器**造(不是这儿手写一份):预览与真出图只要各拼各的,迟早
	// 长成两副样子,而两边都说不出哪儿错了。
	return { node: await buildDynamicNode(DYNAMIC_SCENES[scene] ?? SAMPLE_AV_DYNAMIC, false, FMT) };
}

// ── 醒目留言卡 ────────────────────────────────────────────────────────────────

function scSample(): SampleProps<"sc"> {
	const price = 100;
	// 档位(配色 + 保留时长)由价格算,与 `generateSCCard` 同一条路:手抄一份配色的话,
	// 哪天档位表调了,预览还停在老色上。
	const level = getSCLevel(price * 10);
	return {
		senderFace: SVG_AVATAR_FAN,
		senderName: "示例粉丝",
		masterName: MASTER.name,
		masterAvatarUrl: MASTER.face,
		text: "主播加油！这是一条示例醒目留言，用来看留言块的换行与留白。",
		price,
		duration: Object.values(SC_LEVELS)[level].duration,
		bgColor: SC_COLORS[level],
	};
}

// ── 上舰卡 ────────────────────────────────────────────────────────────────────

function guardSample(): SampleProps<"guard"> {
	return {
		captainImgUrl: SVG_GUARD_BADGE,
		guardLevel: GuardLevel.Captain,
		uname: "示例粉丝",
		face: SVG_AVATAR_PINK,
		isAdmin: 0,
		masterAvatarUrl: MASTER.face,
		masterName: MASTER.name,
		bgColor: BG_COLORS[GuardLevel.Captain],
	};
}

// ── 锐评卡 ────────────────────────────────────────────────────────────────────

/**
 * 真机上每位 UP 的强调色由 `colorFromUid` 按 uid 算(与面板上同一位 UP 同色);示例里没有
 * uid,直接写死三个分得开的色。
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
		up: SAMPLE_UPS.first,
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
	return { masterName: MASTER.name, masterAvatarUrl: MASTER.face };
}

// ── 出口 ──────────────────────────────────────────────────────────────────────

/** 动态那份要 await(正文由真正的构建器造),别的都是同步 —— 出口那头统一 await 一次。 */
const SAMPLES: {
	[K in CardSkinKind]: (scene: string) => SampleProps<K> | Promise<SampleProps<K>>;
} = {
	live: liveSample,
	dynamic: dynamicSample,
	sc: scSample,
	guard: guardSample,
	roastBoard: roastBoardSample,
	roastSolo: roastSoloSample,
	wordcloud: wordCloudSample,
};

/**
 * 某种卡 + 某个场景的示例数据。`scene` 缺省或不认识 → 用该卡种的**第一个**场景
 * (不报错:场景名是从 URL / 请求体来的,面板换了一版、链接被人存过书签都会送来旧名字,
 * 为这个给用户一张错误页不值)。
 *
 * **异步**是因为动态卡的正文只能由 `buildDynamicNode` 造,而它是 async。唯一的消费方
 * (预览路由)本来就在 async 里,所以这里跟着 async,而不是反过来去改那个出图共用的
 * 模板模块 —— 它在 23 张基准快照那条线上,少一个碰它的理由就少一分风险。
 *
 * **`raw` 要跟着一起交出去**:契约里视频卡与图廊那两组字段在 `node` 里已经被画进正文的
 * VNode、拆不回来,渲染器只能从原始动态取。它是可选参数,预览这条路从前一直没传 ——
 * 类型全绿、七种卡照样画得出来,只有皮肤作者写下 `{video.title}` 才发现那儿永远是空的。
 *
 * 两样一起喂 `renderCardWithSkin(kind, props, manifest, { raw })`。
 */
export async function sampleCard(
	kind: CardSkinKind,
	scene?: string,
): Promise<{ props: unknown; raw?: Dynamic }> {
	const picked = resolvePreviewScene(kind, scene);
	const props = await (SAMPLES[kind] as (s: string) => unknown | Promise<unknown>)(picked.id);
	if (kind !== "dynamic") return { props };
	return { props, raw: DYNAMIC_SCENES[picked.id] ?? SAMPLE_AV_DYNAMIC };
}
