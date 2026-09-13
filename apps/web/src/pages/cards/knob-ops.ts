/**
 * 皮肤旋钮覆盖的读写(ADR-0014 决策 16 的 🔗)。
 *
 * 一条判据贯穿整个文件:**存覆盖不存值**。声明里的 `default` 只是控件的起始位置,渲染
 * 那头不注入它 —— 所以「用户没拧过」必须表现成**这个键根本不在表里**,而不是「值恰好
 * 等于 default」。两者在默认皮肤上不等价:玻璃白纱的兜底各卡一档(直播 .82 / SC .75 /
 * 锐评 .86),真把 default 存进去就会注出一个数、把三档当场塌成一档。所以这里不做
 * 「值等于 default 就当没设」的聪明事,删除只由「还原」那条明路走。
 *
 * 表按皮肤 id 分层(换皮肤再换回来设置还在),所以每个写操作都只碰**当前这一套**的那层,
 * 别家原样带过去。
 */

import type { CardSkinKnob } from "@bilibili-notify/contract";
import type { GlobalConfig } from "../../types/globals";

/** 全表:皮肤 id → 该套皮肤拧过的键。形状从配置类型里取,免得两边各写一份会漂。 */
export type CardSkinKnobsBySkin = GlobalConfig["defaults"]["cardSkinKnobs"];
/** 一套皮肤拧过的那些键。 */
export type CardSkinKnobOverrides = CardSkinKnobsBySkin[string];
export type CardSkinKnobValue = CardSkinKnobOverrides[string];

/** 这一枚拧过没有。**只看键在不在**,不看值等于什么(见文件头)。 */
export function isKnobTweaked(overrides: CardSkinKnobOverrides | undefined, key: string): boolean {
	return overrides !== undefined && key in overrides;
}

/**
 * 控件该显示的值:拧过就显示拧的那个,没拧过(或存着一个对不上类型 / 越界 / 不在候选里
 * 的残值)显示声明的 `default`。
 *
 * 「残值退回 default」是照着渲染器那头的 `cardSkinKnobCss` 抄的:它对同样这些值返回 null
 * = 不注入 = 皮肤 CSS 的兜底生效。面板要是照残值画控件,主人看到的就是一个「明明写着
 * 50px 卡片上却没有」的旋钮。残值怎么来的:手改过配置,或者皮肤升级换了这枚旋钮的类型。
 */
export function knobValue(
	knob: CardSkinKnob,
	overrides: CardSkinKnobOverrides | undefined,
): CardSkinKnobValue {
	const raw = overrides?.[knob.key];
	if (raw === undefined) return knob.default;
	switch (knob.type) {
		case "color":
			return typeof raw === "string" ? raw : knob.default;
		case "number":
			return typeof raw === "number" && Number.isFinite(raw) && raw >= knob.min && raw <= knob.max
				? raw
				: knob.default;
		case "select":
			return typeof raw === "string" && knob.options.some((o) => o.value === raw)
				? raw
				: knob.default;
		case "switch":
			return typeof raw === "boolean" ? raw : knob.default;
	}
}

/**
 * 滑杆步长。声明里没写 step 时**不能**让它走 `<input type="range">` 的原生默认 1 ——
 * 玻璃白纱那种 0~1 的旋钮会变成只有两档(0 与 1)的开关,拧不出中间值。
 * 跨度小于 10 的按 0.01 走(比例、倍率那类),再大的按 1 走(px / deg / ms 那类)。
 */
export function knobSliderStep(knob: Extract<CardSkinKnob, { type: "number" }>): number {
	return knob.step ?? (knob.max - knob.min < 10 ? 0.01 : 1);
}

/** 拧一枚:写进这套皮肤那层,别的皮肤原样带过去。 */
export function setKnobOverride(
	all: CardSkinKnobsBySkin,
	skinId: string,
	key: string,
	value: CardSkinKnobValue,
): CardSkinKnobsBySkin {
	return { ...all, [skinId]: { ...(all[skinId] ?? {}), [key]: value } };
}

/**
 * 还原一枚:把这个键**删掉**,不是写回 default(文件头那条判据)。
 *
 * 这套皮肤一个键都不剩就把它整层也摘掉 —— 留个空对象在盘上读起来像「这套皮肤设置过
 * 什么」,而 buildPatch 还会照发一条没有意义的 `{}`。
 */
export function resetKnobOverride(
	all: CardSkinKnobsBySkin,
	skinId: string,
	key: string,
): CardSkinKnobsBySkin {
	const current = all[skinId];
	if (current === undefined || !(key in current)) return all;
	const rest = { ...current };
	delete rest[key];
	const next = { ...all };
	if (Object.keys(rest).length === 0) delete next[skinId];
	else next[skinId] = rest;
	return next;
}
