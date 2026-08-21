/**
 * 皮肤能调**左栏宽度**。
 *
 * `SectionNav` 那五页(Rules / Targets / About / Ai / MaidSkills)在 xl 以上是「左侧竖栏
 * + 右侧内容」,栏宽此前是六处各写一遍的 `220px`,现在收成 `--bn-rail-width` 了。
 * 收进皮肤契约是因为它真的有人会想动:分区名长的皮肤想放宽,想让内容区更阔的想收窄。
 *
 * 窄屏(xl 以下)不受影响 —— 那时 `SectionNav` 变成顶部横向 chip 条,栏宽没有意义。
 *
 * 取值域刻意收得比「技术上能填的」窄:太窄放不下分区名、太宽把内容挤成一条缝,
 * 两头都是坏掉的版式而不是风格选择。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIN_LIMITS } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { parseSkinManifest } from "../schema";

const base = { schemaVersion: 1 as const, name: "t" };

function parseMode(mode: Record<string, unknown>) {
	return parseSkinManifest({ ...base, modes: { light: mode } });
}

describe("皮肤的左栏宽度", () => {
	it("取值域在契约里,且两头都收得住", () => {
		expect(SKIN_LIMITS.railWidth).toBeTruthy();
		expect(SKIN_LIMITS.railWidth.min).toBeGreaterThanOrEqual(120);
		expect(SKIN_LIMITS.railWidth.max).toBeLessThanOrEqual(480);
		expect(SKIN_LIMITS.railWidth.min).toBeLessThan(SKIN_LIMITS.railWidth.max);
		// 默认装的 220 得落在域内,否则「恢复默认」会被自己的校验拒收。
		expect(SKIN_LIMITS.railWidth.min).toBeLessThanOrEqual(220);
		expect(SKIN_LIMITS.railWidth.max).toBeGreaterThanOrEqual(220);
	});

	it("合法值收下", () => {
		const r = parseMode({ railWidth: 260 });
		expect(r.ok, r.ok ? "" : r.errors.join("\n")).toBe(true);
		expect(r.ok && r.skin.modes.light?.railWidth).toBe(260);
	});

	it("越界的拒收,不静默夹到边界", () => {
		for (const v of [SKIN_LIMITS.railWidth.min - 1, SKIN_LIMITS.railWidth.max + 1]) {
			const r = parseMode({ railWidth: v });
			// 拒收有两种落法:整包 ok:false,或收下包但丢掉这一项。夹到边界是第三种,
			// 那种最坏 —— 皮肤作者以为自己填的值生效了。
			const kept = r.ok ? r.skin.modes.light?.railWidth : undefined;
			expect(kept, `${v} 不该被夹成一个合法值`).toBeUndefined();
			expect(r.ok ? [] : r.errors, `${v} 应当报错`).not.toEqual([]);
		}
	});

	it("不是数字的拒收", () => {
		const r = parseMode({ railWidth: "220px" });
		expect(r.ok ? [] : r.errors).not.toEqual([]);
	});

	it("不写就是不写 —— 不替皮肤作者填一个默认值进去", () => {
		const r = parseMode({ radius: { card: 10 } });
		expect(r.ok, r.ok ? "" : r.errors.join("\n")).toBe(true);
		expect(r.ok && r.skin.modes.light?.railWidth).toBeUndefined();
	});
});

/**
 * 「编辑器 = 能力全集」是这套皮肤的硬性原则:契约里能配的,盘上就得有控件,AI 提示词
 * 里也得写 —— 否则那一项等于只有会手写 skin.json 的人够得着。
 */
describe("栏宽在三处都露面", () => {
	const read = (rel: string) =>
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");

	it("注入端把它写成 --bn-rail-width", () => {
		const src = read("../../../../web/src/services/skin.ts");
		expect(src).toContain("--bn-rail-width");
		expect(src).toContain("railWidth");
	});

	it("编辑器上有控件,且取值域读的是契约那张表", () => {
		const src = read("../../../../web/src/pages/skins/SkinEditor.tsx");
		expect(src).toContain("railWidth");
		// 硬编码 160/320 会和契约悄悄分家 —— 放宽取值域时滑杆就拉不到新范围了。
		expect(src).toContain("SKIN_LIMITS.railWidth.min");
		expect(src).toContain("SKIN_LIMITS.railWidth.max");
	});

	it("AI 提示词里写了它,取值域同样读表", () => {
		const src = read("../ai-edit.ts");
		expect(src).toContain("railWidth");
		expect(src).toContain("SKIN_LIMITS.railWidth.min");
	});
});
