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
import { SKIN_LIMITS, type SkinMode } from "@bilibili-notify/contract";
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
 * 「编辑器 = 能力全集」是这套皮肤的硬性原则:契约里能配的,盘上就得有控件,
 * **两份** AI 提示词里也都得写 —— 否则那一项等于只有会手写 skin.json 的人够得着。
 *
 * 这组测试原本叫「栏宽在三处都露面」,一个字段一条手写用例。它漏掉了第四处
 * (web 那份「粘贴给任意 AI」的提示词),而 `railWidth` 恰恰就是从那儿漏出去的:
 * 服务端提示词里有,web 那份 0 次;`fonts.asset` 同样。手写用例只守得住写它那天
 * 想得起来的字段与去处,所以改成**遍历**。
 *
 * 表由 `satisfies Record<keyof SkinMode, ...>` 钉着:`SkinMode` 加一个字段而这张表
 * 没跟上,这个文件**直接编译不过** —— 比测试变红更早一步。
 */
describe("每个模式字段都在四处露面", () => {
	const read = (rel: string) =>
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");

	/**
	 * 字段 → 在源码里的探针,就是字段名本身。
	 *
	 * 只问「**露没露面**」,不问措辞、也不问二级字段:四处的写法本来就不同(注入端
	 * 写 `mode.fonts?.body`、提示词写 `fonts.body`、编辑器是个控件),把探针定成
	 * 具体措辞只会让这条守卫变脆,然后被人改宽或删掉。
	 *
	 * 换来的代价是宽松:字段名若碰巧因别的原因出现在某个文件里,这一处就假绿。
	 * 认这个代价 —— 它要拦的是「加了新字段却忘了某一处」,而新字段名(`railWidth`
	 * 就是个例子)几乎不会碰巧撞上。
	 */
	const PROBE = {
		colors: "colors",
		page: "page",
		wallpaper: "wallpaper",
		glass: "glass",
		chat: "chat",
		fonts: "fonts",
		radius: "radius",
		railWidth: "railWidth",
		shadows: "shadows",
		css: "css",
		effects: "effects",
	} satisfies Record<keyof SkinMode, string>;

	/** 造皮肤的四条路。少一条,那条路上的 AI 与主人就够不着这个字段。 */
	const SURFACES: ReadonlyArray<{ what: string; rel: string }> = [
		{ what: "注入端", rel: "../../../../web/src/services/skin.ts" },
		{ what: "编辑器", rel: "../../../../web/src/pages/skins/SkinEditor.tsx" },
		{ what: "服务端提示词", rel: "../ai-edit.ts" },
		{ what: "粘贴给任意 AI 的提示词", rel: "../../../../web/src/services/skin-pack.ts" },
	];

	for (const { what, rel } of SURFACES) {
		it(`${what}把每个字段都提到了`, () => {
			const src = read(rel);
			const missing = Object.values(PROBE).filter((probe) => !src.includes(probe));
			expect(missing, `${what}少了这些字段`).toEqual([]);
		});
	}

	it("栏宽的取值域三处都读契约那张表,不硬编码", () => {
		// 硬编码 160/320 会和契约悄悄分家 —— 放宽取值域时滑杆拉不到新范围,
		// 而提示词还在教 AI 那个旧上限。
		for (const rel of [
			"../../../../web/src/pages/skins/SkinEditor.tsx",
			"../ai-edit.ts",
			"../../../../web/src/services/skin-pack.ts",
		]) {
			expect(read(rel), rel).toContain("SKIN_LIMITS.railWidth.min");
		}
	});

	it("注入端把它写成 --bn-rail-width", () => {
		expect(read("../../../../web/src/services/skin.ts")).toContain("--bn-rail-width");
	});
});
