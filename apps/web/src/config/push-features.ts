import { i18n } from "../i18n";
/**
 * 推送(按特性键)的**唯一色表与文案表**。
 *
 * 由来:同一份「特性 → 颜色 / 标签 / 图标」此前抄在五个地方 —— toast、Dashboard
 * 时间轴、History 列表、Cards 卡片类型、SubscriptionCard 功能胶囊。抄多了就飘:上舰在
 * 四处是橙 `#f2a053`、在 toast 里是紫 `#7A5AF8`;SC 是 `#fdcb6e` vs `#FFB454`;
 * 直播在 Cards 是 `#FF6699`、别处是 `#FB7299`。没有任何东西拦下一次再飘。
 *
 * 表的键是特性键(`FeatureKey`):历史行与 WS 推来的行记的就是特性键,不再有一套单独的推送种类(⑬f)。
 *
 * **两种归色口径都是有意的,不是漂移**,所以这里两样都给:
 * - `tone` —— 每把一色。toast 一次只弹一条,独立色好认(527df87 的 "Source-typed")。
 * - {@link familyTone} —— 按家族归色。时间轴/列表是成片的,把直播家族(开播/总结/
 *   进房/弹幕)归成同一个粉才读得出层次。
 *
 * 颜色**刻意不跟皮肤走**:它们是产品语言(「直播是粉的、动态是蓝的」),跟 B 站蓝、
 * 危险红同类。皮肤重上色会让两种推送撞成一个颜色,一眼分辨的能力就没了 ——
 * 所以这里写字面量,而 `Pill` / `GlassStatCard` 的 `color` 两种都收。
 */

import type { PushStatus } from "@bilibili-notify/contract";
import type { IconName } from "@bilibili-notify/ui";
import type { FeatureKey } from "../types/domain";

/** 四个主家族的色,外加 SubscriptionCard 给「衍生能力」用的那一档。键与 {@link PushFamily} 同一套说法(特性键那套)。 */
export const PUSH_TONE = {
	live: "#FB7299",
	post: "#00AEEC",
	superchat: "#fdcb6e",
	membership: "#f2a053",
	/** 词云 / 总结 / 特别弹幕 / 特别进房 —— SubscriptionCard 把这几档衍生能力统一成紫。 */
	derived: "#a29bfe",
} as const;

/** 把几把特性归成几组:直播 / 作品 / SC / 上舰。取值用特性键那套的说法(0.x 叫 dynamic / sc / guard)。 */
export type PushFamily = "live" | "post" | "superchat" | "membership";

export interface FeatureDescriptor {
	/** 每把一色(toast 口径)。四个主特性直接用家族色,其余衍生特性各有独立色。 */
	tone: string;
	/** 归到哪个家族 —— 列表/时间轴按它上色,见 {@link familyTone}。 */
	family: PushFamily;
	/** 分类口径的短标签:列表列、筛选胶囊。 */
	label: string;
	/** 事件口径的标签:toast 说的是「刚发生了什么」,所以是「开播」不是「直播」。 */
	eventLabel: string;
	icon: IconName;
}

export const FEATURE_DESCRIPTORS: Record<FeatureKey, FeatureDescriptor> = {
	post: {
		tone: PUSH_TONE.post,
		family: "post",
		get label() {
			return i18n.t("panelUi.config.push-features.1");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.2");
		},
		icon: "dyn",
	},
	liveStart: {
		tone: PUSH_TONE.live,
		family: "live",
		get label() {
			return i18n.t("panelUi.config.push-features.3");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.4");
		},
		icon: "live",
	},
	liveStreaming: {
		tone: PUSH_TONE.live,
		family: "live",
		get label() {
			return i18n.t("panelUi.config.push-features.5");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.6");
		},
		icon: "live",
	},
	liveEnd: {
		tone: "#F472B6",
		family: "live",
		get label() {
			return i18n.t("panelUi.config.push-features.7");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.8");
		},
		icon: "sparkle",
	},
	superchat: {
		tone: PUSH_TONE.superchat,
		family: "superchat",
		label: "SC",
		eventLabel: "SC",
		icon: "sc",
	},
	membership: {
		tone: PUSH_TONE.membership,
		family: "membership",
		get label() {
			return i18n.t("panelUi.config.push-features.9");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.10");
		},
		icon: "guard",
	},
	viewerChat: {
		tone: "#10B981",
		family: "live",
		get label() {
			return i18n.t("panelUi.config.push-features.11");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.12");
		},
		icon: "mic",
	},
	viewerEnter: {
		tone: "#06B6D4",
		family: "live",
		get label() {
			return i18n.t("panelUi.config.push-features.13");
		},
		get eventLabel() {
			return i18n.t("panelUi.config.push-features.14");
		},
		icon: "user",
	},
};

/**
 * 一行历史的六态怎么标。失败是红的;部分失败(本体到了、附加没到)与无目标(没推到任何
 * 地方)是警示色 —— 两者都不是「坏了」,是「有件事你该看一眼」。被静音 / 免扰挡下的不是该看一眼的事
 * (那是主人自己要的安静),用「未发送」那一支未激活的灰;被过滤的作品同理(那是主人自己定的规则挡下的,
 * 只是留痕),同一支灰。
 */
export const PUSH_STATUS_META: Record<PushStatus, { label: string; tone: string }> = {
	delivered: {
		get label() {
			return i18n.t("panelUi.config.push-features.15");
		},
		tone: "var(--color-bn-success)",
	},
	partial: {
		get label() {
			return i18n.t("panelUi.config.push-features.16");
		},
		tone: "var(--color-bn-warning)",
	},
	failed: {
		get label() {
			return i18n.t("panelUi.config.push-features.17");
		},
		tone: "var(--color-bn-danger)",
	},
	"no-targets": {
		get label() {
			return i18n.t("panelUi.config.push-features.18");
		},
		tone: "var(--color-bn-warning)",
	},
	silenced: {
		get label() {
			return i18n.t("panelUi.config.push-features.19");
		},
		tone: "var(--color-bn-inactive)",
	},
	filtered: {
		get label() {
			return i18n.t("panelUi.config.push-features.20");
		},
		tone: "var(--color-bn-inactive)",
	},
};

/**
 * 家族归色 —— 时间轴、History 列表、趋势图用这个。
 *
 * 八把特性折成四色:直播家族(开播 / 直播中 / 下播 / 进房 / 弹幕)全归粉。成片的列表里
 * 八种颜色会花掉,归族之后一眼能看出「这段时间主要在直播」。
 */
export function familyTone(feature: FeatureKey): string {
	return PUSH_TONE[FEATURE_DESCRIPTORS[feature].family];
}
