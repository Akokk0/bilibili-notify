/**
 * 推送类型的**唯一色表与文案表**。
 *
 * 由来:同一份「kind → 颜色 / 标签 / 图标」此前抄在五个地方 —— toast、Dashboard
 * 时间轴、History 列表、Cards 卡片类型、UpCard 功能胶囊。抄多了就飘:`guard` 在
 * 四处是橙 `#f2a053`、在 toast 里是紫 `#7A5AF8`;`sc` 是 `#fdcb6e` vs `#FFB454`;
 * `live` 在 Cards 是 `#FF6699`、别处是 `#FB7299`。没有任何东西拦下一次再飘。
 *
 * **两种归色口径都是有意的,不是漂移**,所以这里两样都给:
 * - `tone` —— 每种一色。toast 一次只弹一条,独立色好认(527df87 的 "Source-typed")。
 * - {@link familyTone} —— 按家族归色。时间轴/列表是成片的,把直播家族(开播/总结/
 *   进房/弹幕)归成同一个粉才读得出层次。
 *
 * 颜色**刻意不跟皮肤走**:它们是产品语言(「直播是粉的、动态是蓝的」),跟 B 站蓝、
 * 危险红同类。皮肤重上色会让两种 kind 撞成一个颜色,一眼分辨的能力就没了 ——
 * 所以这里写字面量,而 `Pill` / `GlassStatCard` 的 `color` 两种都收。
 */

import type { PushKind, PushStatus } from "@bilibili-notify/contract";
import type { IconName } from "@bilibili-notify/ui";

/** 四个主家族的色,外加 UpCard 给「衍生能力」用的那一档。 */
export const PUSH_TONE = {
	live: "#FB7299",
	dynamic: "#00AEEC",
	sc: "#fdcb6e",
	guard: "#f2a053",
	/** 词云 / 总结 / 特别弹幕 / 特别进房 —— UpCard 把这几档衍生能力统一成紫。 */
	derived: "#a29bfe",
} as const;

export type PushFamily = "live" | "dynamic" | "sc" | "guard";

export interface PushKindMeta {
	/** 每种一色(toast 口径)。四个主 kind 直接用家族色,三个衍生 kind 各有独立色。 */
	tone: string;
	/** 归到哪个家族 —— 列表/时间轴按它上色,见 {@link familyTone}。 */
	family: PushFamily;
	/** 分类口径的短标签:列表列、筛选胶囊。 */
	label: string;
	/** 事件口径的标签:toast 说的是「刚发生了什么」,所以是「开播」不是「直播」。 */
	eventLabel: string;
	icon: IconName;
}

export const PUSH_KIND_META: Record<PushKind, PushKindMeta> = {
	dynamic: {
		tone: PUSH_TONE.dynamic,
		family: "dynamic",
		label: "动态",
		eventLabel: "动态",
		icon: "dyn",
	},
	live: { tone: PUSH_TONE.live, family: "live", label: "开播", eventLabel: "开播", icon: "live" },
	"live-ongoing": {
		tone: PUSH_TONE.live,
		family: "live",
		label: "直播中",
		eventLabel: "正在直播",
		icon: "live",
	},
	"live-end": {
		tone: "#F472B6",
		family: "live",
		label: "下播",
		eventLabel: "下播",
		icon: "sparkle",
	},
	sc: { tone: PUSH_TONE.sc, family: "sc", label: "SC", eventLabel: "SC", icon: "sc" },
	guard: {
		tone: PUSH_TONE.guard,
		family: "guard",
		label: "舰长",
		eventLabel: "上舰",
		icon: "guard",
	},
	"special-danmaku": {
		tone: "#10B981",
		family: "live",
		label: "弹幕",
		eventLabel: "特别弹幕",
		icon: "mic",
	},
	"special-enter": {
		tone: "#06B6D4",
		family: "live",
		label: "进房",
		eventLabel: "特别进房",
		icon: "user",
	},
};

/**
 * 一行历史的四态怎么标。失败是红的;部分失败(本体到了、附加没到)与无目标(没推到任何
 * 地方)是警示色 —— 两者都不是「坏了」,是「有件事你该看一眼」。
 */
export const PUSH_STATUS_META: Record<PushStatus, { label: string; tone: string }> = {
	delivered: { label: "已送达", tone: "var(--color-bn-success)" },
	partial: { label: "部分失败", tone: "var(--color-bn-warning)" },
	failed: { label: "失败", tone: "var(--color-bn-danger)" },
	"no-targets": { label: "无目标", tone: "var(--color-bn-warning)" },
};

/**
 * 家族归色 —— 时间轴、History 列表、趋势图用这个。
 *
 * 八种 kind 折成四色:直播家族(开播 / 直播中 / 下播 / 进房 / 弹幕)全归粉。成片的列表里
 * 八种颜色会花掉,归族之后一眼能看出「这段时间主要在直播」。
 */
export function familyTone(kind: PushKind): string {
	return PUSH_TONE[PUSH_KIND_META[kind].family];
}
