/**
 * 皮肤旋钮覆盖表的读写(ADR-0014 决策 16 的 🔗)。
 *
 * 钉的都是「存覆盖不存值」那条判据上的静默失败:还原写回了 default 而不是删键(界面上
 * 完全看不出区别 —— 直到默认皮肤那三档玻璃基线塌成一档)、写一枚顺手把别套皮肤的覆盖
 * 冲掉(换回去才发现设置没了)、以及残值不退回 default(面板画一个卡片上根本没生效的值)。
 */

import type { CardSkinKnob } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import {
	type CardSkinKnobsBySkin,
	isKnobTweaked,
	knobSliderStep,
	knobValue,
	resetKnobOverride,
	setKnobOverride,
} from "../knob-ops";

const COLOR: CardSkinKnob = {
	key: "gradient-start",
	label: "背景渐变起色",
	type: "color",
	default: "#e0c3fc",
};
type NumberKnob = Extract<CardSkinKnob, { type: "number" }>;

const NUMBER: NumberKnob = {
	key: "glass-opacity",
	label: "玻璃白纱",
	type: "number",
	default: 0.82,
	min: 0,
	max: 1,
	step: 0.01,
};
const SELECT: CardSkinKnob = {
	key: "corner",
	label: "圆角",
	type: "select",
	default: "12px",
	options: [
		{ value: "12px", label: "圆" },
		{ value: "0px", label: "直角" },
	],
};
const SWITCH: CardSkinKnob = {
	key: "show-badge",
	label: "显示徽章",
	type: "switch",
	default: true,
	on: "block",
	off: "none",
};

describe("knobValue", () => {
	it("没拧过 → 显示声明的 default(拿它当控件起始位置,不是存进去的值)", () => {
		expect(knobValue(NUMBER, undefined)).toBe(0.82);
		expect(knobValue(NUMBER, {})).toBe(0.82);
	});

	it("拧过 → 显示拧的那个", () => {
		expect(knobValue(NUMBER, { "glass-opacity": 0.4 })).toBe(0.4);
		expect(knobValue(COLOR, { "gradient-start": "#123456" })).toBe("#123456");
		expect(knobValue(SELECT, { corner: "0px" })).toBe("0px");
		expect(knobValue(SWITCH, { "show-badge": false })).toBe(false);
	});

	it("残值(类型不对 / 越界 / 不在候选里)退回 default —— 渲染那头对它们也是不注入", () => {
		// 手改过配置,或者皮肤升级换了这枚旋钮的类型,存储里就会留下这些。
		expect(knobValue(NUMBER, { "glass-opacity": 2 })).toBe(0.82);
		expect(knobValue(NUMBER, { "glass-opacity": -1 })).toBe(0.82);
		expect(knobValue(NUMBER, { "glass-opacity": "0.4" })).toBe(0.82);
		expect(knobValue(SELECT, { corner: "99px" })).toBe("12px");
		expect(knobValue(SWITCH, { "show-badge": "block" })).toBe(true);
		expect(knobValue(COLOR, { "gradient-start": 1 })).toBe("#e0c3fc");
	});
});

describe("isKnobTweaked", () => {
	it("只看键在不在,不看值等于什么 —— 拧成和 default 一样也是拧过", () => {
		expect(isKnobTweaked({ "glass-opacity": 0.82 }, "glass-opacity")).toBe(true);
		expect(isKnobTweaked({}, "glass-opacity")).toBe(false);
		expect(isKnobTweaked(undefined, "glass-opacity")).toBe(false);
	});
});

describe("knobSliderStep", () => {
	it("声明写了 step 就用它", () => {
		expect(knobSliderStep({ ...NUMBER, step: 0.05 })).toBe(0.05);
	});

	it("没写 step 时 0~1 的旋钮走 0.01 —— 走 range 的原生默认 1 会把它变成只有两档的开关", () => {
		const k: NumberKnob = { key: "o", label: "o", type: "number", default: 0.5, min: 0, max: 1 };
		expect(knobSliderStep(k)).toBe(0.01);
	});

	it("没写 step 时跨度大的走 1(px / deg / ms 那类)", () => {
		const k: NumberKnob = { key: "b", label: "b", type: "number", default: 10, min: 0, max: 40 };
		expect(knobSliderStep(k)).toBe(1);
	});
});

describe("setKnobOverride", () => {
	it("写进这套皮肤那层,别套皮肤原样带着走", () => {
		const before: CardSkinKnobsBySkin = { neon: { accent: "#ff0000" }, default: { a: 1 } };
		const after = setKnobOverride(before, "default", "b", 2);
		expect(after).toEqual({ neon: { accent: "#ff0000" }, default: { a: 1, b: 2 } });
		// 不可变:原表一个字没动。
		expect(before).toEqual({ neon: { accent: "#ff0000" }, default: { a: 1 } });
	});

	it("这套皮肤此前一枚都没拧过 → 现开一层", () => {
		expect(setKnobOverride({}, "neon", "accent", "#fff")).toEqual({ neon: { accent: "#fff" } });
	});
});

describe("resetKnobOverride", () => {
	it("把键删掉,不是写回 default —— 存了值就会被注进 CSS,把各卡各自的兜底盖平", () => {
		const after = resetKnobOverride(
			{ default: { "glass-opacity": 0.4, blur: 8 } },
			"default",
			"glass-opacity",
		);
		expect(after).toEqual({ default: { blur: 8 } });
		expect("glass-opacity" in (after.default ?? {})).toBe(false);
	});

	it("这套皮肤一个键都不剩 → 整层也摘掉(别在盘上留个空对象)", () => {
		expect(resetKnobOverride({ neon: { a: 1 }, default: { b: 2 } }, "default", "b")).toEqual({
			neon: { a: 1 },
		});
	});

	it("本来就没拧过 → 原样返回(别凭空造出一层空表来)", () => {
		const before: CardSkinKnobsBySkin = { neon: { a: 1 } };
		expect(resetKnobOverride(before, "neon", "zzz")).toBe(before);
		expect(resetKnobOverride(before, "default", "a")).toBe(before);
	});
});
