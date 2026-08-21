/**
 * 出图字号的**现状冻结**。
 *
 * 这不是一套阶梯 —— 阶梯的意思是「档与档之间有语义、挑档有依据」,而这 13 个值不是,
 * 它们是七张卡片各写各的结果。前端那边的同类问题(454 处漂成 21 个值)已经归并成九
 * 档 token 了,这边**刻意不跟着做**:
 *
 *   - 出图走的是另一套体系(UnoCSS wind4 + Vue SSR + 截图),自带样式正本
 *     `styles.ts`,与前端的 `theme.css` 没有任何关系。
 *   - 改前端字号,肉眼一看就知道对不对;改出图字号,得等卡片真的推出去才看得见效果,
 *     而排版是按当前字号调过的 —— 挪一档就可能挤行、撑破卡、把「+N」角标顶出格。
 *   - `render.ts` 那段长注释记着:UnoCSS 只扫 `class` 属性里的**字面量**,动态拼接
 *     的类名会被漏掉(rich-text 那两个颜色至今靠 safelist 兜底)。改成 token 类名
 *     本身安全,但把 69 处逐一改写却验不了,风险不划算。
 *
 * 于是这里只做一件事:**认下现状,别再漂**。清单是双向的 —— 加新值要在这里登记,
 * 删到没人用也要从这里删掉,免得清单自己变成第二个垃圾场。
 *
 * 将来真要归并,先看这三处半档:`11.5` ×2 与 `13.5` ×1,全在 `roast-card.tsx` 一个
 * 文件里,而同一个文件也在用 11 和 13。那是最像「随手写的」的三处,也是最划算的起点。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 出图当前在用的字号,单位 px。加值删值都要动这里。 */
const FROZEN = [10, 11, 11.5, 12, 13, 13.5, 14, 15, 16, 17, 18, 28, 36];

function sources(dir: string): string[] {
	const acc: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry !== "__tests__") acc.push(...sources(full));
		} else if (/\.tsx?$/.test(full)) acc.push(full);
	}
	return acc;
}

function usedSizes(): Map<number, string[]> {
	const hits = new Map<number, string[]>();
	for (const file of sources(SRC)) {
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/text-\[([0-9.]+)px\]/g)) {
			const px = Number(m[1]);
			hits.set(px, [...(hits.get(px) ?? []), file.slice(SRC.length + 1)]);
		}
	}
	return hits;
}

describe("出图字号冻结", () => {
	it("没有出现清单外的新字号", () => {
		const frozen = new Set(FROZEN);
		const extra = [...usedSizes()]
			.filter(([px]) => !frozen.has(px))
			.map(([px, files]) => `${px}px (${[...new Set(files)].join(", ")})`);
		expect(
			extra,
			"出图字号不是随手挑的 —— 先看能不能用清单里已有的一档,真要新增就登记进 FROZEN",
		).toEqual([]);
	});

	it("清单里每个值都还有人用 —— 否则清单自己就成了第二个垃圾场", () => {
		const used = new Set(usedSizes().keys());
		expect(FROZEN.filter((px) => !used.has(px))).toEqual([]);
	});

	it("半档只有那三处 —— 别再多", () => {
		const halves = [...usedSizes()]
			.filter(([px]) => !Number.isInteger(px))
			.flatMap(([px, files]) => files.map((f) => `${px}px ${f}`));
		// 归并的起点就是它们,所以数量只许减不许增。
		expect(halves.length).toBeLessThanOrEqual(3);
		expect([...new Set(halves.map((h) => h.split(" ")[1]))]).toEqual(["templates/roast-card.tsx"]);
	});
});
