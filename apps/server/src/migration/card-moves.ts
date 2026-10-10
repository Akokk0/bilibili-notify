/**
 * 卡片设置的搬家与老皮肤指针回默认(㉔e):0.x 的 `cardStyle` / `cardStyleByKind` 并成 1.0 的 `cards`。接在会员搬家
 * ({@link moveGlobalMembership} / {@link moveSubscriptionMembership},`membership-moves.ts`)之后、直播拆键之前串着跑;
 * 全局设置与逐订阅覆盖各一个入口:
 *
 * | 0.x | 1.0 |
 * | --- | --- |
 * | 全局 `cardStyle.enabled`(出图总开关) | `cards.enabled` |
 * | 全局直播封面:`cardStyleByKind.live.liveCoverImages` **有就用它,否则**用 `cardStyle.liveCoverImages` | `cards.liveCoverImageIds` |
 * | 逐订阅 `cardStyleByKind.live.liveCoverImages` 有就用它,否则 `cardStyle.liveCoverImages` | `overrides.cards.liveCoverImageIds`;并完没有就不留 `cards` |
 * | `cardStyle` 里的退役字段(`font` / `fontAsset` / `glassOpacity` / `glassClear`)、别的卡种(`dynamic` / `sc` / `guard`)下的东西、逐订阅与按卡种的 `enabled` | 丢掉 |
 * | `cardSkin`(不是内置的 `default`) | `default`(全局与逐订阅都一样,ADR-0022 决策 12:指向用户老皮肤的指针改回默认皮肤) |
 * | `cardSkinKnobs` 里不属于内置皮肤的那几套旋钮 | 删掉;删空了的逐订阅 `cardSkinKnobs` 整个键拿掉 |
 *
 * **「有」的判法照今天的行为**:0.x 的 `resolveCardStyleForKind` 是字段级浅合并,只要覆盖层那一格**有值**(是数组,哪怕是空数组)
 * 就盖掉下一层,没有这一格才往下取。所以 `cardStyleByKind.live.liveCoverImages: []` 算「有」、会盖掉 `cardStyle.liveCoverImages`
 * (主人清空了直播封面);没写这一格才取基准的。逐订阅那一份同样:UP·卡种 > UP·基准,两层都没有就不覆盖、跟随全局。
 *
 * **老皮肤整体不迁**(0.x 的卡片皮肤包在 1.0 里格式作废,开机整目录丢弃,见 `zero-generation.ts`):所以只有指着内置 `default`
 * 的指针与它的旋钮有意义,别的指针回 `default`、别的旋钮删掉。0.x 的内置皮肤只有这一套,id 冻在 {@link ZERO_BUILTIN_CARD_SKIN_ID}。
 *
 * `cards` 写在 `cardStyle` / `cardStyleByKind` 原来的位置(键序是 AI 上提到顶层之前 `defaults` 里的老键序:`ai` 之后、`cardSkin` 之前;`moveGlobalAi` 在这一步之后才跑);值原样搬、
 * 键序不变;认不得的形状原样放过(由配置仓开机时报出来);已经是新形状的数据(`cards` 在、两个老键不在、指针与旋钮都已合规)
 * 再跑一遍回**同一个对象**,新老并存时以新键为准、老键丢掉。**不依赖运行时代码**:词表与内置皮肤 id 都是迁移自己冻住的。
 */

import { isPlainObject } from "./files.js";
import { ZERO_BUILTIN_CARD_SKIN_ID } from "./zero-vocabulary.js";

type Obj = Record<string, unknown>;

/** 1.0 里指向内置皮肤的那个值(与 `DEFAULT_CARD_SKIN_ID` 同值,迁移不取运行时常量)。 */
const DEFAULT_SKIN = ZERO_BUILTIN_CARD_SKIN_ID;

/** 一份 0.x 卡片样式切片(`cardStyle` 或某卡种那一份)里的直播封面:是数组才算「有」(空数组也算)。 */
function coverOf(style: unknown): string[] | undefined {
	if (!isPlainObject(style) || !Array.isArray(style.liveCoverImages)) return undefined;
	return style.liveCoverImages.filter((id): id is string => typeof id === "string");
}

/** 并出最终的封面:卡种(`live`)那份有就用它,否则基准那份;都没有是 `undefined`。 */
function mergedCover(cardStyle: unknown, byKind: unknown): string[] | undefined {
	const kindCover = isPlainObject(byKind) ? coverOf(byKind.live) : undefined;
	return kindCover ?? coverOf(cardStyle);
}

/** 指针:不是内置的回 `default`;不是字符串(手改坏了)的原样放过。 */
function movedPointer(pointer: unknown): unknown {
	return typeof pointer === "string" && pointer !== DEFAULT_SKIN ? DEFAULT_SKIN : pointer;
}

/** 旋钮:只留内置皮肤那一套;没有要删的回同一个对象。 */
function keptKnobs(knobs: Obj): Obj {
	const dropped = Object.keys(knobs).filter((id) => id !== DEFAULT_SKIN);
	if (dropped.length === 0) return knobs;
	return Object.fromEntries(Object.entries(knobs).filter(([id]) => id === DEFAULT_SKIN));
}

const OLD_KEYS = ["cardStyle", "cardStyleByKind"] as const;

/**
 * 整份全局设置(**已经改成 1.0 的键**)的 raw → raw:`defaults.cardStyle` / `cardStyleByKind` 并成 `defaults.cards`,
 * `defaults.cardSkin` 与 `cardSkinKnobs` 里的老皮肤回默认 / 删掉。没有要搬的回同一个对象。
 */
export function moveGlobalCards(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.defaults)) return raw;
	const defaults = raw.defaults;
	const hasOld = OLD_KEYS.some((key) => Object.hasOwn(defaults, key));
	const knobs = isPlainObject(defaults.cardSkinKnobs) ? defaults.cardSkinKnobs : undefined;
	const nextKnobs = knobs === undefined ? undefined : keptKnobs(knobs);
	const nextPointer = movedPointer(defaults.cardSkin);
	if (!hasOld && nextKnobs === knobs && nextPointer === defaults.cardSkin) return raw;

	// 新键已经在(新老并存)就以它为准;否则按并法写。
	const cards = Object.hasOwn(defaults, "cards") ? undefined : cardsOfGlobal(defaults);
	const entries: Array<[string, unknown]> = [];
	let placed = false;
	for (const [key, value] of Object.entries(defaults)) {
		if ((OLD_KEYS as readonly string[]).includes(key)) {
			if (!placed && cards !== undefined) entries.push(["cards", cards]);
			placed = true;
		} else if (key === "cardSkin") {
			entries.push([key, nextPointer]);
		} else if (key === "cardSkinKnobs" && nextKnobs !== undefined) {
			entries.push([key, nextKnobs]);
		} else {
			entries.push([key, value]);
		}
	}
	return { ...raw, defaults: Object.fromEntries(entries) };
}

/** 全局 `cards`:开关取 `cardStyle.enabled`(是布尔才搬),封面按上面的并法;两格都没有来源就是「没得搬」。 */
function cardsOfGlobal(defaults: Obj): Obj | undefined {
	const cardStyle = defaults.cardStyle;
	const enabled = isPlainObject(cardStyle) ? cardStyle.enabled : undefined;
	const cover = mergedCover(cardStyle, defaults.cardStyleByKind);
	if (typeof enabled !== "boolean" && cover === undefined) return undefined;
	return {
		...(typeof enabled === "boolean" ? { enabled } : {}),
		...(cover !== undefined ? { liveCoverImageIds: cover } : {}),
	};
}

/**
 * 一条订阅(**已经改成 1.0 的键**,B 站或拓展)的 raw → raw:`overrides.cardStyle` / `cardStyleByKind` 并成
 * `overrides.cards`(只有直播封面;并完没有就不留),`overrides.cardSkin` 指向老皮肤的回 `default`,`cardSkinKnobs` 里老皮肤的删掉
 * (删空了整个键拿掉)。没有要搬的回同一个对象。
 */
export function moveSubscriptionCards(row: unknown): unknown {
	if (!isPlainObject(row) || !isPlainObject(row.overrides)) return row;
	const overrides = row.overrides;
	const hasOld = OLD_KEYS.some((key) => Object.hasOwn(overrides, key));
	const knobs = isPlainObject(overrides.cardSkinKnobs) ? overrides.cardSkinKnobs : undefined;
	const nextKnobs = knobs === undefined ? undefined : keptKnobs(knobs);
	const nextPointer = movedPointer(overrides.cardSkin);
	if (!hasOld && nextKnobs === knobs && nextPointer === overrides.cardSkin) return row;

	const cover = Object.hasOwn(overrides, "cards")
		? undefined
		: mergedCover(overrides.cardStyle, overrides.cardStyleByKind);
	const cards = cover === undefined ? undefined : { liveCoverImageIds: cover };
	const entries: Array<[string, unknown]> = [];
	let placed = false;
	for (const [key, value] of Object.entries(overrides)) {
		if ((OLD_KEYS as readonly string[]).includes(key)) {
			if (!placed && cards !== undefined) entries.push(["cards", cards]);
			placed = true;
		} else if (key === "cardSkin") {
			entries.push([key, nextPointer]);
		} else if (key === "cardSkinKnobs" && nextKnobs !== undefined) {
			if (Object.keys(nextKnobs).length > 0) entries.push([key, nextKnobs]);
		} else {
			entries.push([key, value]);
		}
	}
	return { ...row, overrides: Object.fromEntries(entries) };
}
