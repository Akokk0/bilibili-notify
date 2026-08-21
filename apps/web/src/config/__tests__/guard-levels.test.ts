/**
 * 大航海三档的**唯一色表**。
 *
 * 收编前站里有两张,同三个等级、六个色,谁也不知道哪张是对的:
 *
 * | 等级 | `Cards.tsx` | `rules/sections.tsx` |
 * | ---- | ----------- | -------------------- |
 * | 总督 | `#e84393` 玫红 | `#f2a053` 橙 |
 * | 提督 | `#a29bfe` 紫   | `#d8a0e6` 粉紫 |
 * | 舰长 | `#74b9ff` 蓝   | `#4ebcec` 青 |
 *
 * 留下 Cards 那套,不是因为它好看,是因为另一套的总督色**就是** `PUSH_TONE.guard`。
 * 那抹橙在全站的意思是「上舰这件事」,而这两屏讲的正好都是上舰 —— 同一屏里让它再兼任
 * 「总督」这一档,等于把「事件」和「等级」两个维度压进一个色。留下的这套只跟
 * `PUSH_TONE.derived` 撞一格(提督紫),而 derived 讲的是词云 / 直播总结那类派生功能,
 * 和上舰不同屏,撞不着。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { GUARD_LEVELS } from "../guard-levels";
import { PUSH_TONE } from "../push-kinds";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** 两处消费点 —— 各自曾抄过一份。 */
const CONSUMERS = ["pages/Cards.tsx", "pages/rules/sections.tsx"];

describe("大航海等级色表", () => {
	it("三档齐全,等级号 1/2/3 各一次", () => {
		expect(GUARD_LEVELS.map((g) => g.level)).toEqual([1, 2, 3]);
		expect(GUARD_LEVELS.map((g) => g.label)).toEqual(["总督", "提督", "舰长"]);
		expect(GUARD_LEVELS.map((g) => g.key)).toEqual(["governor", "commander", "captain"]);
	});

	it("三个色互不相同 —— 撞色就等于两档分不开", () => {
		expect(new Set(GUARD_LEVELS.map((g) => g.color)).size).toBe(3);
	});

	it("不占用上舰家族色 —— 这两屏讲的就是上舰,橙色已有主人", () => {
		const colors = GUARD_LEVELS.map((g) => g.color.toLowerCase());
		expect(colors).not.toContain(PUSH_TONE.guard.toLowerCase());
	});

	it("两处消费点都从这张表取", async () => {
		for (const rel of CONSUMERS) {
			const src = await readFile(join(SRC_DIR, rel), "utf8");
			expect(`${rel}: ${src.includes("config/guard-levels")}`).toBe(`${rel}: true`);
		}
	});

	it("消费点里不再出现成套的等级色字面量", async () => {
		const findings: string[] = [];
		for (const rel of CONSUMERS) {
			const raw = await readFile(join(SRC_DIR, rel), "utf8");
			// 注释先抹掉:文档里举例说明旧写法长什么样,那不算又抄了一张表。
			const src = raw
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "")
				.toLowerCase();
			// 六个色全查 —— 两张旧表都不许留。
			const stale = ["#e84393", "#a29bfe", "#74b9ff", "#4ebcec", "#d8a0e6", "#f2a053"];
			const hit = stale.filter((h) => src.includes(h));
			if (hit.length >= 2) findings.push(`${rel}: ${hit.join(" ")}`);
		}
		expect(findings).toEqual([]);
	});
});
