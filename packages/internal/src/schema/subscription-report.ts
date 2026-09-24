import { z } from "zod";
import type { SubscriptionEventKind } from "./extension-manifest";
import { SUBSCRIPTION_AVATAR_MAX_CHARS } from "./extension-subscription";
import { EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX } from "./subscriptions";

/**
 * 订阅源拓展的**上报**(ADR-0019 决策 4 / 7 / 55–57 / 62):三种**事件**(作品 `post`、开播 `liveStart`、
 * 下播 `liveEnd`,触发推送)与两种**不触发推送**的上报(资料更新 `profile`、直播状态 `liveStatus`)。
 *
 * 宿主收下之前先过 {@link checkSubscriptionReport},规矩全在它身上(决策 59):
 * - **不认识的字段整条拒** —— 只可能是拓展照更新的契约写的(装的时候契约小号那道闸本该拦住);
 * - **必填坏了整条拒**;
 * - **认识的选填格值坏了只丢那一格**(一张图解不开 / 超大小、互动数为负、字符串超长 —— 平台那边真会
 *   发生,主人宁可收一张少一张图的卡),并交回丢了什么、为什么。
 *
 * 字段只收**通用的**(决策 4):哪个平台缺一样东西,就加进这张表、BN 发一版(并抬契约小号)。
 *
 * 🔴 `@bilibili-notify/extension` 的根入口有一份手写镜像(`SubscriptionPost` 等,拓展照它写),两份由宿主
 * 那头的类型断言**双向严格相等**地钉住(`apps/server/src/extensions/subscription-shape-pin.ts`)。
 *
 * 🔴 **图一律交字节**(`Uint8Array`,决策 6 / 62),按文件头的魔数认格式、不信拓展说的;收下的是 BN
 * 自己拷的一份 —— 调用在核完之后就返回(不等出卡),之后拓展再动它手里那几块字节,BN 这份不跟着变。
 */

// ---- 上限 ----------------------------------------------------------------------------------

const MiB = 1024 * 1024;

/**
 * 单张图(作品图、视频 / 直播封面)的字节上限。与 BN 从 B 站取图那一道同一个数
 * (`packages/image` 的 `fetchOnce`):卡片与图集吃的是同一种图。
 */
export const SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES = 8 * MiB;

/**
 * 一条作品最多几张图。抖音图文一次最多 30 张(开放平台「创建图文」文档:「每次最多上传 30 张图片」;
 * App 里选图也是最多勾 30 张)。多出来的丢掉、说一声 —— 前面那些照收。
 */
export const SUBSCRIPTION_POST_IMAGES_MAX = 30;

/**
 * 一条上报里所有图(作品图、封面、头像)加起来的字节上限。估的:抖音 CDN 的图多是几百 KB 的 webp,
 * 三十张大图平均 2 MiB 也装得下;挡的是一条事件在内存里驮几百 MB(单张 8 MiB × 30 张)。
 * 装不下的那几张丢掉、说一声。
 */
export const SUBSCRIPTION_REPORT_IMAGES_TOTAL_MAX_BYTES = 64 * MiB;

/**
 * 头像的字节上限 —— 与解析门候选那把尺子(`SUBSCRIPTION_AVATAR_MAX_CHARS`,data URL 的字数)同一口径:
 * 这么多字节编成 data URL(最长的前缀 `data:image/jpeg;base64,`)正好不超那个字数,存头像文件走的
 * 是那一道(决策 49),报上来收下了、存的时候却被拒,是最难查的那种。约 96 KiB。
 */
export const SUBSCRIPTION_AVATAR_MAX_BYTES =
	Math.floor((SUBSCRIPTION_AVATAR_MAX_CHARS - "data:image/jpeg;base64,".length) / 4) * 3;

/** 正文、简介这类长文本的字数上限。 */
export const SUBSCRIPTION_REPORT_TEXT_MAX = 10_000;
/** 标题、分区的字数上限。 */
export const SUBSCRIPTION_REPORT_TITLE_MAX = 256;
/** 名字的字数上限 —— 与解析门候选的 `name` 同一把尺子。 */
export const SUBSCRIPTION_REPORT_NAME_MAX = 128;
/** 链接的字数上限。 */
export const SUBSCRIPTION_REPORT_URL_MAX = 2048;

/**
 * 时刻一律是**毫秒**时间戳(与视图里 `{ time }` 那一格同一个单位,`Date.now()` / `getTime()` 直接给)。
 * 早于 2000 年的一概不收:平台接口常给**秒**,交错了是 1970 年,这一道把它当场点出来。
 */
const TIME_MIN = Date.UTC(2000, 0, 1);
/** `Date` 表示得了的最晚时刻。 */
const TIME_MAX = 8_640_000_000_000_000;

// ---- 图:按文件头认 ---------------------------------------------------------------------------

export type ReportImageFormat = "png" | "jpeg" | "webp" | "gif";

/** 上限念给人听:整 MiB 的念 MiB,别的念 KiB(头像那个数不是整 MiB)。 */
function formatBytes(bytes: number): string {
	return bytes % MiB === 0 ? `${bytes / MiB} MiB` : `${Math.floor(bytes / 1024)} KiB`;
}

function startsWith(bytes: Uint8Array, head: readonly number[], at = 0): boolean {
	return bytes.length >= at + head.length && head.every((byte, i) => bytes[at + i] === byte);
}

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");

/** 按开头那几个字节认图的格式;认不出(SVG、空的、残缺的)是 `undefined`。只看魔数,不解码。 */
export function sniffImageFormat(bytes: Uint8Array): ReportImageFormat | undefined {
	if (startsWith(bytes, PNG_MAGIC)) return "png";
	if (startsWith(bytes, JPEG_MAGIC)) return "jpeg";
	if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "webp";
	if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "gif";
	return undefined;
}

/** 一张图的宽高(像素)。 */
export interface ImageSize {
	width: number;
	height: number;
}

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) =>
	((b[at] << 24) | (b[at + 1] << 16) | u16be(b, at + 2)) >>> 0;

/**
 * JPEG 的帧头(SOF)标记:C0–CF 里除了 C4(哈夫曼表)、C8(保留)、CC(算术编码表)。基线、渐进式、
 * 无损都在里面,宽高都写在同一个位置。
 */
const isJpegFrameMarker = (marker: number) =>
	marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** 逐段走到帧头。段长含它自己那两个字节;段之间可能塞着填充的 0xff。 */
function jpegSize(b: Uint8Array): ImageSize | undefined {
	let at = 2;
	while (at + 1 < b.length) {
		if (b[at] !== 0xff) return undefined;
		const marker = b[at + 1];
		if (marker === 0xff) {
			at++;
			continue;
		}
		// 没有长度的独立标记:SOI、RST0–7、TEM。走到图像数据结束(EOI)或扫描开始(SOS)还没见到帧头
		// 就是没有。
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			at += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return undefined;
		if (at + 3 >= b.length) return undefined;
		if (isJpegFrameMarker(marker)) {
			if (at + 8 >= b.length) return undefined;
			return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
		}
		at += 2 + u16be(b, at + 2);
	}
	return undefined;
}

/** WebP 的第一块:有损 `VP8 `、无损 `VP8L`、扩展 `VP8X`(动图 / 带透明)各写各的。 */
function webpSize(b: Uint8Array): ImageSize | undefined {
	const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
	switch (chunk) {
		case "VP8 ":
			// 3 字节帧标记之后是起始码 9d 01 2a,再是宽、高各 14 位(高两位是缩放,不算)。
			if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
			return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
		case "VP8L": {
			// 签名 0x2f 之后 4 字节小端:前 14 位是宽 - 1,再 14 位是高 - 1。
			if (b.length < 25 || b[20] !== 0x2f) return undefined;
			const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		case "VP8X":
			// 画布宽 - 1、高 - 1 各 3 字节小端。
			if (b.length < 30) return undefined;
			return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
		default:
			return undefined;
	}
}

/**
 * 按文件头读图的宽高,只读头、不解码(ADR-0019 决策 55:拓展只交字节,宽高 BN 自己读 —— 卡片的图廊
 * 判「长图」要用)。四种位图认得出;SVG、残缺的、宽高读出来是 0 的一律 `undefined`(出卡照样出,
 * 只是不判长图)。
 */
export function readImageSize(bytes: Uint8Array): ImageSize | undefined {
	let size: ImageSize | undefined;
	switch (sniffImageFormat(bytes)) {
		case "png":
			// 签名之后第一块必是 IHDR:宽、高各 4 字节大端。
			if (bytes.length < 24 || !startsWith(bytes, ascii("IHDR"), 12)) return undefined;
			size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
			break;
		case "jpeg":
			size = jpegSize(bytes);
			break;
		case "webp":
			size = webpSize(bytes);
			break;
		case "gif":
			// 逻辑屏幕的宽高,小端。
			if (bytes.length < 10) return undefined;
			size = { width: u16le(bytes, 6), height: u16le(bytes, 8) };
			break;
		default:
			return undefined;
	}
	return size && size.width > 0 && size.height > 0 ? size : undefined;
}

/**
 * 一张图:`Uint8Array`(Buffer 也是),封顶,格式按文件头认。
 *
 * 用 `z.custom<Uint8Array>` 而不是 `z.instanceof(Uint8Array)`:后者推出来的是 `Uint8Array<ArrayBuffer>`,
 * 拓展手里的 Buffer(`ArrayBufferLike`)在类型上就交不进来。
 *
 * 三条规矩收在**一个** custom 里、报错文案现算,不接 `.refine()`:每接一个 refine 就多一层 `_zod.parent`,
 * 契约形状的守卫替这一格写形状时用的钩子(`_zod.toJSONSchema`)碰上 parent 链会在 zod 里炸掉。
 */
function imageSchema(formats: readonly ReportImageFormat[], maxBytes: number) {
	const problem = (value: unknown): string | undefined => {
		if (!(value instanceof Uint8Array))
			return "图要交 Uint8Array(图的字节)—— 不收地址、不收 data URL";
		if (value.byteLength > maxBytes) return `超过 ${formatBytes(maxBytes)}`;
		const format = sniffImageFormat(value);
		if (format === undefined || !formats.includes(format)) {
			return `只收 ${formats.join(" / ")}(按文件头认),这张都不是`;
		}
		return undefined;
	};
	return z.custom<Uint8Array>((value) => problem(value) === undefined, {
		error: (issue) => problem(issue.input),
	});
}

/**
 * 作品图、视频封面、直播封面。
 *
 * 导出只为契约形状的守卫(`extension-contract-shape.test.ts`):`z.custom` 转不成 JSON Schema,守卫要
 * 认得出这两份字节格,替它们写一份形状。
 */
export const SubscriptionReportPictureSchema = imageSchema(
	["png", "jpeg", "webp", "gif"],
	SUBSCRIPTION_REPORT_IMAGE_MAX_BYTES,
);
/**
 * 头像只收位图、不收 gif(决策 49 / 62):报资料时它会存成文件、从同源地址按声明的类型发出去,与解析门
 * 候选那道规矩同一条。导出的缘故同上。
 */
export const SubscriptionReportAvatarSchema = imageSchema(
	["png", "jpeg", "webp"],
	SUBSCRIPTION_AVATAR_MAX_BYTES,
);

// ---- 其余几种格 -----------------------------------------------------------------------------

const text = (max: number) => z.string({ error: "要是字符串" }).max(max, `超过 ${max} 字`);
const NameSchema = text(SUBSCRIPTION_REPORT_NAME_MAX).min(1, "不能是空串");
const TitleSchema = text(SUBSCRIPTION_REPORT_TITLE_MAX);
const LongTextSchema = text(SUBSCRIPTION_REPORT_TEXT_MAX);
const UrlSchema = z
	.url({ protocol: /^https?$/, error: "要是 http:// 或 https:// 开头的地址" })
	.max(SUBSCRIPTION_REPORT_URL_MAX, `超过 ${SUBSCRIPTION_REPORT_URL_MAX} 字`);
const TimeSchema = z
	.number({ error: "要是毫秒时间戳(数字)" })
	.int("要是整数毫秒")
	.min(TIME_MIN, "早于 2000 年 —— 是不是交成了秒?要毫秒")
	.max(TIME_MAX, "不是一个表示得了的时刻");
/** 互动数、人数、粉丝数:BN 自己排版(「1.2 万」),交数字。 */
const CountSchema = z.number({ error: "要是数字" }).int("要是整数").nonnegative("不能是负的");

/** 选填格的列表(作品图)最多几项 —— 走格子的时候照它截,多出来的丢掉。 */
const LIST_MAX = new WeakMap<z.ZodType, number>();
function list<T extends z.ZodType>(item: T, max: number) {
	const schema = z.array(item).max(max, `最多 ${max} 项`).readonly();
	LIST_MAX.set(schema, max);
	return schema;
}

// ---- 五张表 ---------------------------------------------------------------------------------

/** 作者(决策 54):出卡优先用事件里的,没带的那一样用订阅资料。事件不改资料。 */
const AuthorSchema = z.strictObject({
	name: NameSchema.optional(),
	avatar: SubscriptionReportAvatarSchema.optional(),
});

/** 作品(决策 55)。必填:平台自己的作品 id、链接、发布时刻。 */
export const SubscriptionPostSchema = z.strictObject({
	/** 平台自己的作品 id,原样存。 */
	id: z
		.string({ error: "要是字符串" })
		.min(1, "不能是空串")
		.max(
			EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX,
			`超过 ${EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX} 字`,
		),
	url: UrlSchema,
	publishedAt: TimeSchema,
	/** 纯文本,保留换行。 */
	text: LongTextSchema.optional(),
	images: list(SubscriptionReportPictureSchema, SUBSCRIPTION_POST_IMAGES_MAX).optional(),
	video: z
		.strictObject({
			cover: SubscriptionReportPictureSchema.optional(),
			title: TitleSchema.optional(),
			/** 秒。 */
			duration: z.number({ error: "要是数字(秒)" }).nonnegative("不能是负的").optional(),
			description: LongTextSchema.optional(),
			plays: CountSchema.optional(),
		})
		.optional(),
	stats: z
		.strictObject({
			likes: CountSchema.optional(),
			comments: CountSchema.optional(),
			shares: CountSchema.optional(),
		})
		.optional(),
	author: AuthorSchema.optional(),
});

/** 直播那张表里除了 url / 开播时刻之外的格(决策 56)—— 三种直播上报共用。 */
const liveDetails = {
	title: TitleSchema.optional(),
	cover: SubscriptionReportPictureSchema.optional(),
	/** 分区。 */
	category: TitleSchema.optional(),
	/**
	 * 人数是两格(决策 75),平台有哪个报哪个:`viewers` 是**此刻在线**(「直播中」那张卡的人气格),
	 * `totalViewers` 是**本场累计观看**(下播卡、「正在直播」文案的 `{watched}`、首页在播那一列、统计的
	 * 峰值)—— 与 B 站的两个数一一对上。
	 */
	viewers: CountSchema.optional(),
	totalViewers: CountSchema.optional(),
	likes: CountSchema.optional(),
	/** 纯文本。 */
	description: LongTextSchema.optional(),
	author: AuthorSchema.optional(),
};

/** 开播(决策 56):必填直播间链接与开播时刻。 */
export const SubscriptionLiveStartSchema = z.strictObject({
	url: UrlSchema,
	startedAt: TimeSchema,
	...liveDetails,
});

/**
 * 下播(决策 56):同一张表,只有 url 必填 —— 开播时刻 BN 自己记着(决策 57),BN 中途重启过才要
 * 拓展补。
 */
export const SubscriptionLiveEndSchema = z.strictObject({
	url: UrlSchema,
	startedAt: TimeSchema.optional(),
	...liveDetails,
});

/**
 * 直播状态(决策 57):不触发推送。每轮查询都可以报,开机第一轮查基线时也报;BN 拿它做首页在播、
 * 周期「正在直播」、重启补推、下播补开播时刻 —— 后两样要照它出卡,所以直播那张表的格它都可以带。
 */
export const SubscriptionLiveStatusSchema = z.strictObject({
	live: z.boolean({ error: "要是 true / false" }),
	url: UrlSchema.optional(),
	startedAt: TimeSchema.optional(),
	...liveDetails,
});

/** 资料更新(决策 7 / 62):不触发推送,名字 / 头像 / 粉丝数都选填。 */
export const SubscriptionProfileSchema = z.strictObject({
	name: NameSchema.optional(),
	avatar: SubscriptionReportAvatarSchema.optional(),
	fans: CountSchema.optional(),
});

const REPORT_SCHEMAS = {
	post: SubscriptionPostSchema,
	liveStart: SubscriptionLiveStartSchema,
	liveEnd: SubscriptionLiveEndSchema,
	profile: SubscriptionProfileSchema,
	liveStatus: SubscriptionLiveStatusSchema,
} as const;

/** 五种上报。前三种是事件(与清单的 `contributes.subscription.events` 同一套词),后两种不触发推送。 */
export type SubscriptionReportKind = keyof typeof REPORT_SCHEMAS;

/** 某一种上报核过之后的样子。 */
export type SubscriptionReportValue<K extends SubscriptionReportKind> = z.infer<
	(typeof REPORT_SCHEMAS)[K]
>;

/** 核过的一条上报:种类 + 内容。 */
export type SubscriptionReport = {
	[K in SubscriptionReportKind]: { kind: K; value: SubscriptionReportValue<K> };
}[SubscriptionReportKind];

/**
 * 核过、对上了订阅的一条上报 —— bus 上 `subscription-reported` 的载荷。
 *
 * `subscriptionIds`:这个拓展名下指向这个人的订阅(同一个人可能有几条)。**事件与直播状态只含开着的**
 * (停用的收下不推、也不进首页在播,决策 62);**资料更新含全部**(停用的订阅照样该有名字与头像)。
 * 一条都没有就不发。
 */
export interface SubscriptionReportDelivery {
	/** 哪个拓展报的 —— 宿主从 ctx 认,不由拓展说。 */
	extensionId: string;
	/** 拓展报的外部 id,原样。 */
	externalId: string;
	subscriptionIds: string[];
	report: SubscriptionReport;
}

// ---- 走格子 ---------------------------------------------------------------------------------

export type SubscriptionReportCheck<K extends SubscriptionReportKind> =
	| { ok: true; value: SubscriptionReportValue<K>; dropped: string[] }
	| { ok: false; reason: string };

interface WalkState {
	/** 丢掉的每一格一句:哪一格、为什么。 */
	dropped: string[];
	/** 这条上报里还能收多少字节的图。 */
	imageBytesLeft: number;
}

/**
 * 一格的结果。`fatal`:整条拒(不认识的字段,在哪一层都一样);不 fatal 的坏只算**这一格**坏 —— 必填的
 * 由上一层升成整条拒,选填的丢掉。
 */
type CellOutcome = { ok: true; value: unknown } | { ok: false; fatal: boolean; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array)
	);
}

const at = (path: string, key: string | number) =>
	typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;

function walkObject(
	shape: Record<string, z.ZodType>,
	raw: Record<string, unknown>,
	path: string,
	state: WalkState,
): CellOutcome {
	const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(shape, key));
	if (unknown.length > 0) {
		return {
			ok: false,
			fatal: true,
			reason: `BN 不认识这几格:${unknown.map((key) => at(path, key)).join("、")}(这一版 BN 的上报表里没有)`,
		};
	}
	const out: Record<string, unknown> = {};
	for (const [key, schema] of Object.entries(shape)) {
		const where = at(path, key);
		const optional = schema instanceof z.ZodOptional;
		const value = raw[key];
		if (value === undefined) {
			if (!optional) return { ok: false, fatal: false, reason: `缺必填的 ${where}` };
			continue;
		}
		const cell = walkCell(optional ? (schema.unwrap() as z.ZodType) : schema, value, where, state);
		if (cell.ok) {
			out[key] = cell.value;
		} else if (cell.fatal || !optional) {
			return cell;
		} else {
			state.dropped.push(cell.reason);
		}
	}
	return { ok: true, value: out };
}

function walkCell(schema: z.ZodType, value: unknown, where: string, state: WalkState): CellOutcome {
	if (schema instanceof z.ZodObject) {
		if (!isRecord(value)) return { ok: false, fatal: false, reason: `${where}:要是一个对象` };
		return walkObject(schema.shape as Record<string, z.ZodType>, value, where, state);
	}
	if (schema instanceof z.ZodReadonly && schema.unwrap() instanceof z.ZodArray) {
		if (!Array.isArray(value)) return { ok: false, fatal: false, reason: `${where}:要是一个数组` };
		const item = (schema.unwrap() as z.ZodArray<z.ZodType>).element;
		const max = LIST_MAX.get(schema) ?? Number.POSITIVE_INFINITY;
		const kept: unknown[] = [];
		for (const [i, element] of value.slice(0, max).entries()) {
			const cell = walkCell(item, element, at(where, i), state);
			if (cell.ok) kept.push(cell.value);
			else if (cell.fatal) return cell;
			else state.dropped.push(cell.reason);
		}
		if (value.length > max) {
			state.dropped.push(
				`${at(where, max)} 起:最多 ${max} 张,多出来的 ${value.length - max} 张丢了`,
			);
		}
		return { ok: true, value: kept };
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		return {
			ok: false,
			fatal: false,
			reason: `${where}:${parsed.error.issues.map((issue) => issue.message).join(";")}`,
		};
	}
	if (!(parsed.data instanceof Uint8Array)) return { ok: true, value: parsed.data };
	if (parsed.data.byteLength > state.imageBytesLeft) {
		return {
			ok: false,
			fatal: false,
			reason: `${where}:整条上报的图加起来超过 ${formatBytes(SUBSCRIPTION_REPORT_IMAGES_TOTAL_MAX_BYTES)}`,
		};
	}
	state.imageBytesLeft -= parsed.data.byteLength;
	// 🔴 拷一份:调用核完就返回,之后拓展再改它手里那几块字节(或者复用那块缓冲),出卡时读到的就变了。
	return { ok: true, value: new Uint8Array(parsed.data) };
}

/**
 * 核一条上报(决策 59)。收下时 `dropped` 是丢掉的每一格(哪一格、为什么),拒掉时 `reason` 点名哪儿
 * 不对 —— 两样宿主都原样记进「上报问题」(决策 60),拒掉的还原样交回拓展。
 *
 * 拓展交来的对象读起来会抛(getter、Proxy)也算整条拒,原话带上 —— 这里不往外抛。
 */
export function checkSubscriptionReport<K extends SubscriptionReportKind>(
	kind: K,
	raw: unknown,
): SubscriptionReportCheck<K> {
	const schema: z.ZodObject = REPORT_SCHEMAS[kind];
	const state: WalkState = {
		dropped: [],
		imageBytesLeft: SUBSCRIPTION_REPORT_IMAGES_TOTAL_MAX_BYTES,
	};
	let walked: CellOutcome;
	try {
		// 「是不是对象」也在 try 里判:撤销了的 Proxy 连 `Array.isArray` 都会抛。
		if (!isRecord(raw)) return { ok: false, reason: "上报的内容要是一个对象" };
		walked = walkObject(schema.shape as Record<string, z.ZodType>, raw, "", state);
	} catch (err) {
		return {
			ok: false,
			reason: `读上报内容时抛了:${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!walked.ok) return { ok: false, reason: walked.reason };
	// 走完的每一格都单独核过;整份再过一次严格的 schema,交出去的值才真是它说的那个类型。这一道要是
	// 不过,是上面走格子漏了规矩(BN 的 bug),不是拓展的。
	const whole = schema.safeParse(walked.value);
	if (!whole.success) {
		return {
			ok: false,
			reason: `BN 核完的结果过不了自己的上报表(这是 BN 的 bug):${whole.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join(";")}`,
		};
	}
	return {
		ok: true,
		value: whole.data as SubscriptionReportValue<K>,
		dropped: state.dropped,
	};
}

// ---- 收下之前的另外两问 ---------------------------------------------------------------------

/**
 * 报的这一种,清单声明了没有(决策 5 / 62:清单就是能力声明)—— 没声明回一句原因,声明了是 `undefined`。
 *
 * - 三种事件:`contributes.subscription.events` 里写了才收;
 * - 直播状态:声明了开播或下播之一才收(它是给直播那几样用的);
 * - 资料更新:总是收(订阅页的名字 / 头像 / 粉丝数,每个订阅源都有)。
 */
export function undeclaredReportReason(
	kind: SubscriptionReportKind,
	events: readonly SubscriptionEventKind[],
): string | undefined {
	switch (kind) {
		case "profile":
			return undefined;
		case "liveStatus":
			return events.includes("liveStart") || events.includes("liveEnd")
				? undefined
				: "直播状态只在清单 contributes.subscription.events 声明了 liveStart 或 liveEnd 时才收";
		default:
			return events.includes(kind)
				? undefined
				: `清单 contributes.subscription.events 里没声明 ${kind},BN 不收这一种`;
	}
}

const ExternalIdSchema = z
	.string({ error: "外部 id 要是字符串" })
	.min(1, "外部 id 不能是空串")
	.max(
		EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX,
		`外部 id 不能超过 ${EXTENSION_SUBSCRIPTION_EXTERNAL_ID_MAX} 字`,
	);

/** 报的外部 id:与订阅里存的那一格同一把尺子(建订阅时它从解析门交出来的那个 `id`)。 */
export function checkReportedExternalId(
	raw: unknown,
): { ok: true; externalId: string } | { ok: false; reason: string } {
	const parsed = ExternalIdSchema.safeParse(raw);
	return parsed.success
		? { ok: true, externalId: parsed.data }
		: { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join(";") };
}
