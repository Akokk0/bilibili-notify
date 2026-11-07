import { createHash } from "node:crypto";
import type {
	CreatorProfileReport,
	ExtensionLiveDetails,
	ExtensionPostReport,
	ExtensionRichText,
	ExtensionSourceContext,
	ImageRef,
} from "@bilibili-notify/extension";
import { FAKE_AVATARS, FAKE_PROFILE_AVATARS } from "./avatars.js";

/**
 * 假源那几颗上报按钮造的数据 —— **确定、可复现**:只吃序号、时刻与外部 id,不掷骰子。主人按第三下
 * 看见的就是「第 3 条」,出了毛病照着同一串按法能再现一次。
 *
 * 链接全落在 `.invalid` 上(RFC 2606 保留、永远解析不到),卡片上的链接点了也不会跑到别人家。
 */

/** 四张假头像的字节 —— 作品图与封面从这里轮着取。真 png,图库按内容嗅探认得出。 */
const PICTURES: readonly Uint8Array[] = FAKE_AVATARS;
/** 报资料的头像另有四张,与解析门候选的不重样(理由见 `FAKE_PROFILE_AVATARS`)。 */
const PROFILE_PICTURES: readonly Uint8Array[] = FAKE_PROFILE_AVATARS;

/** 第 `i` 张(轮着取)。 */
function pictureAt(i: number): Uint8Array {
	return PICTURES[i % PICTURES.length] as Uint8Array;
}

/**
 * 把一张图存进图库、回引用。上报里的图一律交图库引用,不交字节(契约:图先 `ctx.storeImage`)。
 * 存不下抛一句带原因的错 —— 按钮的失败面板上就是这句话。
 */
export type StorePicture = (bytes: Uint8Array) => Promise<ImageRef>;

/** 用来源上下文的 `storeImage` 造一个 {@link StorePicture};`signal` 中止时存图跟着停。 */
export function pictureStore(
	ctx: Pick<ExtensionSourceContext, "storeImage">,
	signal?: AbortSignal,
): StorePicture {
	return async (bytes) => {
		const stored = await ctx.storeImage(bytes, signal === undefined ? undefined : { signal });
		if (!stored.ok) throw new Error(`存图失败(${stored.code}):${stored.message}`);
		return stored.ref;
	};
}

/** 分区轮着取。 */
const CATEGORIES = ["聊天", "游戏", "唱见"] as const;

/**
 * 外部 id 的一个短标签(摘要的前 12 位):拼进作品 id 与链接,两个人同一下报的不撞。不直接拼外部 id ——
 * 它最长 256 字、什么字符都可能有,拼进去再编码,作品 id 与链接就可能超宿主的上限。
 */
function tagOf(externalId: string): string {
	return createHash("sha256").update(externalId).digest("hex").slice(0, 12);
}

/** 内部仍按毫秒记时刻,交给宿主的入口才换成本地契约要的带时区 ISO。 */
function isoAt(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * 正文末尾那个 `#话题` 片段化:前面是文字、末尾是话题片段(`text` 带 `#`,`name` 不带),片段拼起来正好
 * 等于正文。宿主据此给话题上色(第 3 版里话题上色靠 `richText`,不再由宿主从正文里找 `#`)。
 */
function withTrailingTopic(text: string, name: string): ExtensionRichText {
	const tag = `#${name}`;
	const at = text.lastIndexOf(tag);
	return [
		...(at > 0 ? [{ kind: "text" as const, text: text.slice(0, at) }] : []),
		{ kind: "topic" as const, text: tag, name },
	];
}

function postBase(externalId: string, n: number) {
	const tag = tagOf(externalId);
	return {
		postId: `fake-${tag}-post-${n}`,
		url: `https://fake-source.invalid/${tag}/post/${n}`,
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
 * 话题照契约报名字、不带 `#`,且一条作品只报一个(`topic`):图文报「假话题」,视频报「城市散步」,
 * 正文末尾也是 `#城市散步`。第 3 版契约把话题从列表收成单个,原来视频那个「正文里找不到、只进名单」的
 * 第二话题(`vlog`)没有位置了。
 */
export async function fakePost(
	externalId: string,
	n: number,
	now: number,
	store: StorePicture,
): Promise<ExtensionPostReport> {
	const base = postBase(externalId, n);
	if (n % 2 === 1) {
		const text = PICTURE_POST_TEXTS[((n - 1) / 2) % PICTURE_POST_TEXTS.length]?.(n) as string;
		return {
			...base,
			post: {
				publishedAt: isoAt(now),
				text,
				richText: withTrailingTopic(text, "假话题"),
				images: [
					await store(pictureAt(n)),
					await store(pictureAt(n + 1)),
					await store(pictureAt(n + 2)),
				],
				topic: "假话题",
				stats: statsOf(n),
			},
		};
	}
	const text = `第 ${n} 支视频来啦，这次拍了一整天的城市散步，喜欢的话点个赞 #城市散步`;
	return {
		...base,
		post: {
			publishedAt: isoAt(now),
			text,
			richText: withTrailingTopic(text, "城市散步"),
			topic: "城市散步",
			video: {
				cover: await store(pictureAt(n)),
				title: `城市散步 vlog · 第 ${n} 期`,
				durationSec: 120 + n,
				description: "从早走到晚，两万多步，记下了沿路的小店和街景。",
				views: n * 1_234,
			},
			stats: statsOf(n),
		},
	};
}

/**
 * 一条把契约开放的五种正文片段都走一遍的作品。链接图标与表情图也按真作品的路走:
 * 现造的 png 字节先存进图库,上报里只交 `storeImage` 交回的引用。
 */
export async function fakeRichPost(
	externalId: string,
	n: number,
	now: number,
	store: StorePicture,
): Promise<ExtensionPostReport> {
	const icon = await store(pictureAt(n));
	const emoji = await store(pictureAt(n + 1));
	const richText: ExtensionRichText = [
		{ kind: "text", text: `第 ${n} 条五种片段：` },
		{ kind: "mention", text: "@假朋友", externalId: `fake-user-${tagOf(externalId)}` },
		{ kind: "text", text: " 在 " },
		{ kind: "topic", text: "#假话题", name: "假话题" },
		{ kind: "text", text: " 里看到一个 " },
		{
			kind: "link",
			text: "网页",
			url: `https://fake-source.invalid/${tagOf(externalId)}/rich/${n}`,
			icon,
		},
		{ kind: "text", text: " " },
		{ kind: "emoji", text: "[doge]", image: emoji },
		{ kind: "text", text: "，都看懂了。" },
	];
	return {
		...postBase(externalId, n),
		post: {
			publishedAt: isoAt(now),
			text: richText.map((segment) => segment.text).join(""),
			richText,
			topic: "假话题",
			stats: statsOf(n),
		},
	};
}

/** 一个不合形状的图库引用。 */
export const BAD_IMAGE_REF = "not-a-ref";

/**
 * 带坏图的作品:三张图里第二张交一个不合形状的引用(`"not-a-ref"`,不是 `<sha256>.<png|jpg|gif|webp>`)——
 * 宿主应只丢那一格(点名 `images[1]`),其余照收(决策 59)。第 3 版里图一律是图库引用,「混进一张 SVG」
 * 已经没有地方放了:SVG 字节在 `storeImage` 那一步就被图库拒掉,根本到不了上报。
 */
export async function fakePostWithBadImage(
	externalId: string,
	n: number,
	now: number,
	store: StorePicture,
): Promise<ExtensionPostReport> {
	return {
		...postBase(externalId, n),
		post: {
			publishedAt: isoAt(now),
			text: `第 ${n} 条：随手拍了三张，第二张好像传坏了`,
			images: [await store(pictureAt(n)), BAD_IMAGE_REF, await store(pictureAt(n + 1))],
		},
	};
}

/**
 * 多一格的作品:作品里多带一格作品表里没有的「弹幕数」(契约明说不收的那一格)—— 演拓展照更新的契约写、
 * 却把要的契约小号写低了,宿主应整条拒(决策 59)。
 */
export function fakePostWithExtraField(
	externalId: string,
	n: number,
	now: number,
): ExtensionPostReport & { post: { danmaku: number } } {
	return {
		...postBase(externalId, n),
		post: {
			publishedAt: isoAt(now),
			text: `假源的第 ${n} 条作品:多带了一格「弹幕数」—— BN 不认识,应整条拒。`,
			danmaku: n * 12,
		},
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

/**
 * 这一场在直播那张表里的格(开播、直播状态、下播、拉取式直播状态共用)。开播时刻不在这里 ——
 * 它在上报信封上(`startedAt`)。封面先存进图库、交引用。
 */
export async function fakeLiveDetails(
	externalId: string,
	session: FakeLiveSession,
	store: StorePicture,
): Promise<ExtensionLiveDetails> {
	return {
		url: fakeLiveUrl(externalId),
		title: `假直播 · 第 ${session.n} 场`,
		cover: await store(pictureAt(session.n)),
		category: CATEGORIES[session.n % CATEGORIES.length] as string,
		currentViewers: session.viewers,
		totalViewers: session.totalViewers,
		likes: session.viewers * 2,
		description: `假源造的第 ${session.n} 场直播。`,
	};
}

/**
 * 资料更新:名字带版次(外加外部 id 的短标签,两个人同一下不同名)、粉丝数照版次涨、头像在报资料专用的
 * 四张里轮 —— 相邻两版一定不同,第一版也不会撞上建订阅时候选的那张,宿主「摘要不同才覆盖」那一道才看得见在换。
 */
export async function fakeProfile(
	externalId: string,
	n: number,
	store: StorePicture,
): Promise<CreatorProfileReport> {
	return {
		name: `假名字 · 第 ${n} 版(${tagOf(externalId).slice(0, 4)})`,
		followers: n * 1_111,
		avatar: await store(PROFILE_PICTURES[(n - 1) % PROFILE_PICTURES.length] as Uint8Array),
	};
}

/**
 * 按钮每次按下的资料版次,以及每个人最后报出去的那一份。按钮与拉取式资料共用这一份:
 * `fetchProfile` 对报过的人必须交回宿主已经收下的同一个对象,没报过的才现编拉取版。
 */
export function createFakeProfiles() {
	let version = 0;
	const reported = new Map<string, CreatorProfileReport>();
	return {
		nextVersion(): number {
			return ++version;
		},
		record(externalId: string, profile: CreatorProfileReport): void {
			reported.set(externalId, profile);
		},
		reported(externalId: string): CreatorProfileReport | undefined {
			return reported.get(externalId);
		},
	};
}

/** 没被资料按钮报过的人现编一份确定的拉取版,名字与按钮的「第 N 版」一眼分得开。 */
export async function fakeFetchedProfile(
	externalId: string,
	store: StorePicture,
): Promise<CreatorProfileReport> {
	return {
		name: `假名字 · 拉取版(${tagOf(externalId).slice(0, 4)})`,
		followers: 0,
		avatar: await store(PROFILE_PICTURES[0] as Uint8Array),
	};
}
