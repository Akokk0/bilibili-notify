/**
 * 订阅身份、保留 id 表与 UP 主强调色 —— 谁是谁、怎么取同一个人的颜色。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/identity` 取值。
 */

// ---------------------------------------------------------------------------
// UP 主强调色
// ---------------------------------------------------------------------------
//
// dashboard 的卡片 / 头像 / 图表线 / Tab 圆点,以及**服务端渲染的周报图片**都取自
// 这里 —— 同一位 UP 在页面上和推到群里的图片上必须是同一个颜色,两边各存一份调色板
// 迟早会漂。
//
// 住在这个零依赖模块而不是 `util/` 里,理由与 `texts/builtin/index.ts` 一样:`util/` 只能
// 从根入口拿,而根入口带 zod —— 页面为了一个调色板把整个 zod 拖进 bundle。

/**
 * 曾经只有 8 色,其中 `#FF6699` 与 `#FB7299` 的 ΔE2000 只有 2.4(肉眼就是同一个粉),
 * 实际可辨的只有 7 种;而分配是 `hash(uid) % 8`,按生日悖论**订阅 4 位就有约 65%
 * 概率撞色**,订阅 10 位几乎必然重复。
 *
 * **试过纯按 uid 连续取色(LCh 空间取点、不设调色板),结论是更差,别再回去。**
 * 完全同色确实没了,但「有点像、分不清哪个是哪个」的比例反而从 4.0% 涨到 7.4% ——
 * 调色板是人为按 ΔE 摆开的,随机撒点做不到;而且逐色相取最大彩度会在黄绿区扫出
 * 一片芥末色、橄榄色,不好看。指标上「ΔE<6 完全难分」是降了,但人眼看的是前一档。
 *
 * 这 24 色是在 CIE Lab 里按「两两 ΔE2000 ≥ 11」贪心挑出来的,明度锁在 L\* 64–81,
 * 且**黄到黄绿那段(Lab 色相 55–125°)强制 L\* ≥ 78** —— 那一段明度一低就发闷成
 * 芥末 / 橄榄,是上一版最招人嫌的地方。品牌粉 / 蓝 / 紫三色原样占位,保住辨识度。
 *
 * **调这里时注意**:头像是白色粗体首字母直接压在这个颜色上(见 web 的 `atoms.tsx`
 * Avatar 与周报卡),所以别往更浅走 —— 这一族对白字的对比度只有 1.65–2.78,是这套
 * 设计有意选的浅调,再浅白字就糊了。测试只锁「两两分得开」,明度与调性靠这段说明。
 */
export const UP_COLORS = [
	"#fb7299",
	"#ff6b6d",
	"#ff9c89",
	"#ff6e42",
	"#ffaf7b",
	"#ffb22e",
	"#e0bf20",
	"#b3cd2f",
	"#67ad1b",
	"#6cd557",
	"#01b355",
	"#03d98e",
	"#02b088",
	"#05d6bd",
	"#03ada8",
	"#03dfe7",
	"#01b9d2",
	"#00aeec",
	"#489dff",
	"#a29bfe",
	"#d7a9ff",
	"#bf7cff",
	"#ee66db",
	"#ff93d1",
] as const;

/**
 * Stable per-UP color derived from uid; gives every UP a recognisable accent.
 *
 * 哈希用 FNV-1a 而不是原来的 `h * 31 + c`:B 站 uid 是纯数字,字符只在 '0'–'9' 这
 * 十个码位里取值,多项式哈希在 24 这种模数下散得不够开(实测 2 万个随机 uid,
 * χ² 41.4 vs FNV 的 19.5)—— 那样加再多颜色也只会集中用到其中几个。
 */
export function colorFromSeed(seed: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		// imul 才是 32 位整数乘法;直接 `*` 会溢出成浮点,低位精度丢光。
		h = Math.imul(h, 0x01000193);
	}
	return UP_COLORS[(h >>> 0) % UP_COLORS.length] as string;
}

/**
 * 拓展那一支的「人」取色用的那一串(ADR-0019 决策 73):拓展 id + 冒号 + 外部 id。带着冒号和拓展名,
 * 永远不会等于一个纯数字的 uid,不会和某位 B 站 UP 撞成同一个人的颜色。**只用来取色** —— 查订阅不拼串
 * (外部 id 是不透明字符串,拼就得选分隔符)。
 */
export function extensionColorSeed(extensionId: string, externalId: string): string {
	return `${extensionId}:${externalId}`;
}

// ---- 订阅的身份(ADR-0021 决策 14)-------------------------------------------------
//
// 「这条订阅订的是谁」只看两格:哪个来源、来源那头的 id。分派、查找、取色都从这里取,不再按订阅
// 的两支分别读 `uid` 或 `extensionId` + `externalId`。

/** 订阅来源的键:`bilibili` 或拓展 id,不加前缀(拓展 id 不许用保留 id,见 {@link RESERVED_INTEGRATION_KEYS})。 */
export type SourceKey = string;

/**
 * B 站这个来源的键。长期只用在保留 id 表里;核心里拿它判「是不是 B 站」做分派是过渡写法(替掉原来的
 * `isBiliSubscription`),第 3a 期 B 站搬进 `bilibili/`、核心只问登记表以后就没有了(「B 站替身」棘轮盯着)。
 */
export const BILIBILI_SOURCE_KEY = "bilibili";

/**
 * 保留 id:内置集成的键 —— B 站这个来源与三个内置平台适配器。拓展 id 不许用它们:订阅身份与登记表的键
 * 不加前缀,拓展叫 `bilibili` 就会和 B 站的订阅撞成同一个人。
 */
export const RESERVED_INTEGRATION_KEYS: readonly string[] = [
	BILIBILI_SOURCE_KEY,
	"onebot",
	"qq-official",
	"webhook",
];

/**
 * 拓展 id 不许用的名字:内置集成的键,加上 `core`、`image`、`ai`。这三个是核心自己的名字(日志等级里核心那三格
 * 的键;`core` 还是设置文件 `core.json`),**不是集成** —— 所以不进上面那张表(那张表被当「内置集成有哪些」读:
 * 开存储、导备份都照它数)。拓展叫了它们,会和核心的出图、AI、核心本体共用一格日志等级。
 */
export const RESERVED_EXTENSION_IDS: readonly string[] = [
	...RESERVED_INTEGRATION_KEYS,
	"core",
	"image",
	"ai",
];

/** 一条订阅订的是谁。判重看这两格是否都相等。 */
export interface Identity {
	sourceKey: SourceKey;
	/** 来源那头的 id,BN 不解读;B 站就是 uid。 */
	externalId: string;
}

/**
 * 这条订阅订的是谁 —— 全仓唯一的读法,别处一律经它取(ADR-0023:取订阅身份的函数叫这个名字)。
 */
export function subscriptionIdentityOf(sub: { identity: Identity }): Identity {
	return sub.identity;
}

/** 两个身份是不是同一个人。 */
export function sameIdentity(a: Identity, b: Identity): boolean {
	return a.sourceKey === b.sourceKey && a.externalId === b.externalId;
}

/**
 * 这个人的颜色 —— 跟着人走,不跟着订阅走(ADR-0019 决策 73)。B 站的种子就是外部 id(uid):改成别的种子,
 * 主人屏幕上每位 B 站 UP 的颜色都会变,所以这一支按来源单独留着。其他来源按 {@link extensionColorSeed}。
 * 删了再加订阅 id 变了,颜色不变。面板与服务端出图共用这一份(ADR-0020 决策 15)。
 */
export function identityColor(identity: Identity): string {
	return identity.sourceKey === BILIBILI_SOURCE_KEY
		? colorFromSeed(identity.externalId)
		: colorFromSeed(extensionColorSeed(identity.sourceKey, identity.externalId));
}
