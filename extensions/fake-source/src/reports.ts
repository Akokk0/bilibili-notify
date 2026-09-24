import { createHash } from "node:crypto";
import type {
	SubscriptionLiveDetails,
	SubscriptionPost,
	SubscriptionProfile,
} from "@bilibili-notify/extension";
import { FAKE_AVATARS, FAKE_PROFILE_AVATARS, FAKE_SVG } from "./avatars.js";

/**
 * 假源那几颗上报按钮造的数据 —— **确定、可复现**:只吃序号、时刻与外部 id,不掷骰子。主人按第三下
 * 看见的就是「第 3 条」,出了毛病照着同一串按法能再现一次。
 *
 * 链接全落在 `.invalid` 上(RFC 2606 保留、永远解析不到),卡片上的链接点了也不会跑到别人家。
 */

/** data URL → 字节。 */
const bytesOf = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

/** 四张假头像的字节 —— 作品图与封面从这里轮着取。真 png,宿主按文件头认得出。 */
const PICTURES: readonly Uint8Array[] = FAKE_AVATARS.map(bytesOf);
/** 报资料的头像另有四张,与解析门候选的不重样(理由见 `FAKE_PROFILE_AVATARS`)。 */
const PROFILE_PICTURES: readonly Uint8Array[] = FAKE_PROFILE_AVATARS.map(bytesOf);

/** 第 `i` 张(轮着取)。 */
export function pictureAt(i: number): Uint8Array {
	return PICTURES[i % PICTURES.length] as Uint8Array;
}

const SVG_BYTES = new TextEncoder().encode(FAKE_SVG);

/** 分区轮着取。 */
const CATEGORIES = ["聊天", "游戏", "唱见"] as const;

/**
 * 外部 id 的一个短标签(摘要的前 12 位):拼进作品 id 与链接,两个人同一下报的不撞。不直接拼外部 id ——
 * 它最长 256 字、什么字符都可能有,拼进去再编码,作品 id 与链接就可能超宿主的上限。
 */
function tagOf(externalId: string): string {
	return createHash("sha256").update(externalId).digest("hex").slice(0, 12);
}

function postBase(externalId: string, n: number, now: number) {
	const tag = tagOf(externalId);
	return {
		id: `fake-${tag}-post-${n}`,
		url: `https://fake-source.invalid/${tag}/post/${n}`,
		publishedAt: now,
	};
}

/** 互动数照序号涨,交数字(宿主排版)。 */
function statsOf(n: number) {
	return { likes: n * 321, comments: n * 45, shares: n * 6 };
}

/**
 * 图文作品的正文,按序号轮着用。写成像真作品的话 —— 打开 AI 点评时,女仆点评的就是这段字,写成
 * 「这是第二行」一类自我介绍的测试文案,点评也只会跟着复述它。卡上要核的都照样在:序号(连按几下
 * 分得清哪张卡是哪一下报的)、第二行(正文保留换行)、`#假话题`(报了同名的话题,卡上正文上方出话题
 * 标签、正文里这几个字上色,ADR-0019 决策 55 的 09-24 🔗)。
 */
const PICTURE_POST_TEXTS: readonly ((n: number) => string)[] = [
	(n) => `旅行第 ${n} 天，去海边拍了三张\n风好大，帽子差点被吹跑 #假话题`,
	(n) => `第 ${n} 次挑战自己做饭，摆盘失败但味道还行\n第三张是饭后甜点 #假话题`,
	(n) => `连续第 ${n} 天下班路上拍晚霞\n明天也要加油呀 #假话题`,
];

/**
 * 一条作品:单数是图文(正文 + 三张图),双数是视频 —— 两种卡按两下就都看得见。
 *
 * 话题照契约报名字、不带 `#`:图文报「假话题」;视频报「城市散步」「vlog」,正文末尾只有
 * `#城市散步` —— 第二个在正文里找不到,演「只进名单、不上色,宿主照收不报错」。
 */
export function fakePost(externalId: string, n: number, now: number): SubscriptionPost {
	const base = postBase(externalId, n, now);
	if (n % 2 === 1) {
		return {
			...base,
			text: PICTURE_POST_TEXTS[((n - 1) / 2) % PICTURE_POST_TEXTS.length]?.(n),
			images: [pictureAt(n), pictureAt(n + 1), pictureAt(n + 2)],
			topics: ["假话题"],
			stats: statsOf(n),
		};
	}
	return {
		...base,
		text: `第 ${n} 支视频来啦，这次拍了一整天的城市散步，喜欢的话点个赞 #城市散步`,
		topics: ["城市散步", "vlog"],
		video: {
			cover: pictureAt(n),
			title: `城市散步 vlog · 第 ${n} 期`,
			duration: 120 + n,
			description: "从早走到晚，两万多步，记下了沿路的小店和街景。",
			plays: n * 1_234,
		},
		stats: statsOf(n),
	};
}

/** 带坏图的作品:三张图里第二张是 SVG —— 宿主应只丢那一张,其余照收(决策 59)。 */
export function fakePostWithBadImage(externalId: string, n: number, now: number): SubscriptionPost {
	return {
		...postBase(externalId, n, now),
		text: `第 ${n} 条：随手拍了三张，第二张好像传坏了`,
		images: [pictureAt(n), SVG_BYTES, pictureAt(n + 1)],
	};
}

/**
 * 多一格的作品:多带一格作品表里没有的「弹幕数」(契约明说不收的那一格)—— 演拓展照更新的契约写、
 * 却把要的契约小号写低了,宿主应整条拒(决策 59)。
 */
export function fakePostWithExtraField(
	externalId: string,
	n: number,
	now: number,
): SubscriptionPost & { danmaku: number } {
	return {
		...postBase(externalId, n, now),
		text: `假源的第 ${n} 条作品:多带了一格「弹幕数」—— BN 不认识,应整条拒。`,
		danmaku: n * 12,
	};
}

/** 假源手里的一场直播(一次作用于所有开着的订阅,所以只有一场)。 */
export interface FakeLiveSession {
	/** 第几场。 */
	n: number;
	/** 开播时刻,毫秒。 */
	startedAt: number;
	/** 此刻在线。 */
	viewers: number;
	/** 本场累计观看 —— 与在线差一个数量级,首页那一列(画的是它)一眼认得出不是在线。 */
	totalViewers: number;
}

/** 直播间链接。 */
export function fakeLiveUrl(externalId: string): string {
	return `https://live.fake-source.invalid/${tagOf(externalId)}`;
}

/** 这一场在直播那张表里的格(开播、直播状态、下播共用)。 */
export function fakeLiveDetails(
	session: FakeLiveSession,
): SubscriptionLiveDetails & { startedAt: number } {
	return {
		startedAt: session.startedAt,
		title: `假直播 · 第 ${session.n} 场`,
		cover: pictureAt(session.n),
		category: CATEGORIES[session.n % CATEGORIES.length] as string,
		viewers: session.viewers,
		totalViewers: session.totalViewers,
		likes: session.viewers * 2,
		description: `假源造的第 ${session.n} 场直播。`,
	};
}

/**
 * 资料更新:名字带版次(外加外部 id 的短标签,两个人同一下不同名)、粉丝数照版次涨、头像在报资料专用的
 * 四张里轮 —— 相邻两版一定不同,第一版也不会撞上建订阅时候选的那张,宿主「摘要不同才覆盖」那一道才看得见在换。
 */
export function fakeProfile(externalId: string, n: number): SubscriptionProfile {
	return {
		name: `假名字 · 第 ${n} 版(${tagOf(externalId).slice(0, 4)})`,
		fans: n * 1_111,
		avatar: PROFILE_PICTURES[(n - 1) % PROFILE_PICTURES.length] as Uint8Array,
	};
}
