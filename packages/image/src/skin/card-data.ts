/**
 * 内部 props → **对外数据契约**(ADR-0014 决策 14)。
 *
 * 皮肤包里的占位符 `{a.b.c}` 与 `showIf` 指的都是 `CARD_SKIN_FIELDS`(住在
 * `@bilibili-notify/internal` 的 `schema/card-skin.ts`)里那张表;这一层负责把各卡模板自己的
 * props(`templates/*.tsx` 的 `*CardProps`)翻译成那张表的形状。
 *
 * 三条纪律:
 * - **产出与字段表一一对应**:多一个字段 = 皮肤引用不到的死数据,少一个 = 皮肤写了取不到值。
 *   `__tests__/card-data.test.ts` 逐 kind 对表钉死(路径集合与每个值的 typeof 都对)。
 * - **永不 undefined**:缺数据一律回落成空串 / 0 / false,占位符替换时不会冒出 "undefined"。
 * - **已格式化的文本直接给**(「1.2 万」「已开播 1 小时」),占位符不带过滤器。
 */

import type { GuardLevel } from "@bilibili-notify/blive";
import { GUARD_DESC } from "../blocks/guard";
import { htmlToPlain } from "../html-to-plain";
import { getSCLevel } from "../styles";
import type { DynamicCardProps } from "../templates/dynamic-card";
import type { GuardCardProps } from "../templates/guard-card";
import type { LiveCardProps } from "../templates/live-card";
import type { RoastBoardCardProps, RoastSoloCardProps } from "../templates/roast-card";
import type { SCCardProps } from "../templates/sc-card";
import type { WordCloudCardProps } from "../templates/wordcloud-card";
import type { Dynamic } from "../types";

/** 契约里一个字段的值。对应 `CardSkinFieldType`:`text` / `image` → string。 */
export type CardDataValue = string | number | boolean;

/**
 * 一张卡的契约数据。恰好两层 —— 外层是字段路径的第一段(`up` / `live` / `stats`…),
 * 内层是第二段。字段路径只有两段,所以这里不需要更深的嵌套。
 */
export type CardData = Record<string, Record<string, CardDataValue>>;

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
 * 粉丝那一格的**数值部分** —— 与 `blocks/live.tsx` 的 `followerText` 同一套分支,只是不带
 * 「当前粉丝数：」这类前缀(前缀归皮肤的模板写)。`watchedNum === "API"` 是接口没给数的哨兵值。
 */
function liveFans(p: LiveCardProps): string {
	if (p.liveStatus === 1) return str(p.fansNum);
	if (p.liveStatus === 2) return p.watchedNum !== "API" ? str(p.watchedNum) : "";
	if (p.liveStatus === 3) return str(p.fansChanged);
	return "";
}

function liveData(p: LiveCardProps): CardData {
	// `data` 是 B 站直播接口的原始结构(模板里就是 any),字段一律经 str() 兜。
	const data: Record<string, unknown> = p.data ?? {};
	const area = str(data.area_name);
	// 与 `blocks/live.tsx` 的封面块**同一条选择逻辑**:自定义封面优先;否则 `cover` 为真
	// (开播 / 下播态)取房间封面、为假(直播中)取关键帧。契约说的「有没有封面」得和画出
	// 来的那张一致,不能另起一套。
	const cover = str(p.coverOverride || (p.cover ? data.user_cover : data.keyframe));
	const fansChanged = str(p.fansChanged);
	return {
		up: { name: str(p.username), face: str(p.userface) },
		live: {
			title: str(data.title),
			area,
			time: str(p.liveTime),
			// 房间简介是富文本(可能带 <p>/<br> 或 entity-encoded 形式),契约只承诺纯文本。
			description: htmlToPlain(str(data.description)),
			cover,
			hasCover: cover !== "",
			isStreaming: p.liveStatus === 1,
			isEnded: p.liveStatus === 2,
		},
		stats: {
			// 与 `blocks/live.tsx` 的 statsLeft 同一套分支(含 3 = 刚下播那支)。
			popularity: p.liveStatus === 3 ? str(p.likedNum) : str(p.onlineNum),
			area,
			fans: liveFans(p),
			fansChanged,
			hasFansChanged: fansChanged !== "",
		},
	};
}

// ── dynamic ──────────────────────────────────────────────────────────────────

/**
 * 动态卡的数据有两个来源:`node`(已经装配好的呈现态结构树)给作者 / 时间 / 互动数,
 * `raw`(原始动态)给视频卡与图廊那两组 —— 它们在 node 里已经被画进 `body` 的 VNode 里,
 * 拆不回来了。没有 `raw` 时这两组一律空值(`hasVideo` / `hasPics` 随之为 false)。
 */
function dynamicData(p: DynamicCardProps, raw?: Dynamic): CardData {
	const node = p.node;
	const major = raw?.modules?.module_dynamic?.major;
	// 视频卡的来源与 `templates/dynamic-content.tsx` 的 buildVideoContent 同一处。
	const archive = major?.archive;
	// 图廊的来源与同文件的 buildPicsContent 同一处。
	const pics = major?.opus?.pics ?? [];
	const videoTitle = str(archive?.title);
	return {
		up: { name: str(node.upName), face: str(node.avatarUrl), isVip: !!node.upIsVip },
		dynamic: {
			type: str(raw?.type),
			action: str(node.headerLabel),
			time: str(node.pubTime),
			topic: str(node.topic),
			hasTopic: !!node.topic,
			isForward: !!node.forward,
			hasAdditional: !!node.additional,
			hasVideo: videoTitle !== "",
			hasPics: pics.length > 0,
		},
		video: {
			title: videoTitle,
			cover: str(archive?.cover),
			duration: str(archive?.duration_text),
			// 接口给的播放 / 弹幕数可能已是格式化字符串("6.5万"),原样转文本,不做算术。
			views: str(archive?.stat?.play),
			danmaku: str(archive?.stat?.danmaku),
		},
		pics: { count: pics.length, first: str(pics[0]?.url) },
		stats: {
			forward: str(node.stats?.forward),
			comment: str(node.stats?.comment),
			like: str(node.stats?.like),
		},
	};
}

// ── sc ───────────────────────────────────────────────────────────────────────

/**
 * 价位档。渲染器是按 `getSCLevel(price * 10)` 算出档位、再拿它去取色的(`image-renderer.ts`),
 * 档位本身没进 props —— 这里按同一条公式从金额再算一次,永远落在 0~5,与契约说明一致。
 */
function scLevel(price: number): number {
	return getSCLevel(price * 10);
}

function scData(p: SCCardProps): CardData {
	const price = num(p.price);
	return {
		sender: { name: str(p.senderName), face: str(p.senderFace) },
		master: { name: str(p.masterName), face: str(p.masterAvatarUrl) },
		sc: {
			// 与 `blocks/sc.tsx` 的金额块同形状(那里是 `¥{p.price}`)。
			price: `¥${price}`,
			priceValue: price,
			duration: str(p.duration),
			level: scLevel(price),
			text: str(p.text),
		},
	};
}

// ── guard ────────────────────────────────────────────────────────────────────

const GUARD_LEVEL_NAMES: Record<number, string> = { 1: "总督", 2: "提督", 3: "舰长" };

/** 文字信息那句 —— 与文字块同一份 `GUARD_DESC`,不认识的等级给空串。 */
function guardText(level: number, uname: string, masterName: string): string {
	return GUARD_DESC[level as GuardLevel]?.(uname, masterName) ?? "";
}

function guardData(p: GuardCardProps): CardData {
	const level = num(p.guardLevel);
	const uname = str(p.uname);
	const masterName = str(p.masterName);
	return {
		user: { name: uname, face: str(p.face), isAdmin: !!p.isAdmin },
		master: { name: masterName, face: str(p.masterAvatarUrl) },
		guard: {
			level,
			levelName: GUARD_LEVEL_NAMES[level] ?? "",
			badge: str(p.captainImgUrl),
			text: guardText(level, uname, masterName),
		},
	};
}

// ── roast / wordcloud ────────────────────────────────────────────────────────

/** 榜单周报不属于任何单个 UP,props 里压根没有主播名 —— 契约留着这个字段,值恒为空串。 */
function roastBoardData(p: RoastBoardCardProps): CardData {
	return { master: { name: "" }, report: { days: num(p.days) } };
}

function roastSoloData(p: RoastSoloCardProps): CardData {
	return {
		up: { name: str(p.up?.name), face: str(p.up?.avatar) },
		report: { days: num(p.days) },
	};
}

function wordCloudData(p: WordCloudCardProps): CardData {
	return { master: { name: str(p.masterName), face: str(p.masterAvatarUrl) } };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export function buildCardData(kind: "live", props: LiveCardProps): CardData;
export function buildCardData(kind: "dynamic", props: DynamicCardProps, raw?: Dynamic): CardData;
export function buildCardData(kind: "sc", props: SCCardProps): CardData;
export function buildCardData(kind: "guard", props: GuardCardProps): CardData;
export function buildCardData(kind: "roastBoard", props: RoastBoardCardProps): CardData;
export function buildCardData(kind: "roastSolo", props: RoastSoloCardProps): CardData;
export function buildCardData(kind: "wordcloud", props: WordCloudCardProps): CardData;
/**
 * 把一张卡的 props 翻成它那份契约数据。产出的路径集合与 `CARD_SKIN_FIELDS[kind]` 一字不差。
 *
 * @param raw 仅 dynamic 卡用:原始动态,视频卡 / 图廊那两组字段从它取。
 */
export function buildCardData(
	kind: "live" | "dynamic" | "sc" | "guard" | "roastBoard" | "roastSolo" | "wordcloud",
	props: unknown,
	raw?: Dynamic,
): CardData {
	switch (kind) {
		case "live":
			return liveData(props as LiveCardProps);
		case "dynamic":
			return dynamicData(props as DynamicCardProps, raw);
		case "sc":
			return scData(props as SCCardProps);
		case "guard":
			return guardData(props as GuardCardProps);
		case "roastBoard":
			return roastBoardData(props as RoastBoardCardProps);
		case "roastSolo":
			return roastSoloData(props as RoastSoloCardProps);
		case "wordcloud":
			return wordCloudData(props as WordCloudCardProps);
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
export function readCardField(data: CardData, path: string): CardDataValue | undefined {
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
