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
import { getSCLevel } from "../styles";
import type { DynamicCardProps } from "../templates/dynamic-card";
import type { GuardCardProps } from "../templates/guard-card";
import type { LiveCardView } from "../templates/live-card";
import type { RoastBoardCardProps, RoastSoloCardProps } from "../templates/roast-card";
import type { SCCardProps } from "../templates/sc-card";
import type { WordCloudCardProps } from "../templates/wordcloud-card";

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
 * 直播卡的数据全从 {@link LiveCardView} 取 —— 与块库(`blocks/live.tsx`)吃的是同一份,
 * 判据也同一套:开播与直播中是同一种样子(`isStreaming`),下播是另一种(`isEnded`)。
 */
function liveData(p: LiveCardView): CardData {
	const onAir = p.status === "start" || p.status === "streaming";
	const ended = p.status === "end";
	const fansChanged = str(p.fansChanged);
	return {
		up: { name: str(p.username), face: str(p.userface) },
		live: {
			title: str(p.title),
			area: str(p.area),
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
		stats: {
			// 与 `blocks/live.tsx` 的 statsLeft 同一套分支:下播是点赞(决策 76),其余是此刻在线。
			popularity: ended ? str(p.likes) : str(p.online),
			area: str(p.area),
			// 粉丝那一格的**数值部分** —— 与 `blocks/live.tsx` 的 `followerText` 同一套分支,
			// 只是不带「当前粉丝数：」这类前缀(前缀归皮肤的模板写)。
			fans: onAir ? str(p.fans) : ended ? str(p.totalViewers) : "",
			// 默认卡不画它(决策 76,它进下播文案),契约照给 —— 自己做皮肤的人想画就能画。
			fansChanged,
			hasFansChanged: fansChanged !== "",
		},
	};
}

// ── dynamic ──────────────────────────────────────────────────────────────────

/**
 * 动态卡的数据**全从 node 取**(ADR-0019 决策 68)。
 *
 * 块画什么、契约就说什么,判据只有一份:视频那一组读 `node.video`(五个视频块画的就是它),
 * 图廊那一组读 `node.images`(`pics` 块拿它现画),动态类型读 `node.type`。从前后两样要回头
 * 去 B 站原始数据里刨,出卡入口因此得另收一份原始数据 —— 拓展的作品没有那份东西;而各刨
 * 各的,判据迟早分叉(从前拿「标题非空」当 `hasVideo`,一条没标题的投稿会画出封面,却告诉
 * 皮肤的 `showIf` 说没视频)。
 */
function dynamicData(p: DynamicCardProps): CardData {
	const node = p.node;
	const images = node.images ?? [];
	const video = node.video;
	return {
		up: { name: str(node.upName), face: str(node.avatarUrl), isVip: !!node.upIsVip },
		dynamic: {
			type: str(node.type),
			action: str(node.headerLabel),
			time: str(node.pubTime),
			topic: str(node.topic),
			hasTopic: !!node.topic,
			isForward: !!node.forward,
			hasAdditional: !!node.additional,
			hasVideo: !!video,
			hasPics: images.length > 0,
		},
		video: {
			title: str(video?.title),
			desc: str(video?.desc),
			cover: str(video?.cover),
			duration: str(video?.duration),
			// 接口给的播放 / 弹幕数可能已是格式化字符串("6.5万"),`videoOf` 原样转了文本。
			// 播放数、弹幕数都选填(拓展作品不收弹幕数、播放数选填),缺了就是空串。
			views: str(video?.views),
			danmaku: str(video?.danmaku),
		},
		pics: { count: images.length, first: str(images[0]?.url) },
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

export function buildCardData(kind: "live", props: LiveCardView): CardData;
export function buildCardData(kind: "dynamic", props: DynamicCardProps): CardData;
export function buildCardData(kind: "sc", props: SCCardProps): CardData;
export function buildCardData(kind: "guard", props: GuardCardProps): CardData;
export function buildCardData(kind: "roastBoard", props: RoastBoardCardProps): CardData;
export function buildCardData(kind: "roastSolo", props: RoastSoloCardProps): CardData;
export function buildCardData(kind: "wordcloud", props: WordCloudCardProps): CardData;
/**
 * 把一张卡的 props 翻成它那份契约数据。产出的路径集合与 `CARD_SKIN_FIELDS[kind]` 一字不差。
 */
export function buildCardData(
	kind: "live" | "dynamic" | "sc" | "guard" | "roastBoard" | "roastSolo" | "wordcloud",
	props: unknown,
): CardData {
	switch (kind) {
		case "live":
			return liveData(props as LiveCardView);
		case "dynamic":
			return dynamicData(props as DynamicCardProps);
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
