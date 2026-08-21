/**
 * 推送类型色表的守卫。
 *
 * 这张表的由来就是「同一份映射抄了五份然后飘了」:`guard` 在四处是橙、在 toast
 * 里是紫;`sc` 是 `#fdcb6e` vs `#FFB454`;`live` 在 Cards 是 `#FF6699`。构建全绿、
 * 测试全绿,只有把两个页面并排摆着才看得出来 —— 所以守卫得钉在「只有一处出处」
 * 这件事本身上,而不是钉某个颜色值。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { familyTone, PUSH_KIND_META, PUSH_TONE } from "../push-kinds";

/** 与 packages/internal 的 HistorySourceSchema 同步;少一个就是有 kind 没上色。 */
const SOURCES = [
	"dynamic",
	"live",
	"sc",
	"guard",
	"special-danmaku",
	"special-enter",
	"live-summary",
] as const;

const SRC_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("PUSH_KIND_META", () => {
	it("七种 kind 一个不少、一个不多", () => {
		expect(Object.keys(PUSH_KIND_META).sort()).toEqual([...SOURCES].sort());
	});

	it("四个家族色互不相同 —— 撞色就等于两种 kind 分不开", () => {
		const family = [PUSH_TONE.live, PUSH_TONE.dynamic, PUSH_TONE.sc, PUSH_TONE.guard];
		expect(new Set(family).size).toBe(family.length);
	});

	it("familyTone:直播家族四种全归粉,其余各归各的", () => {
		for (const s of ["live", "live-summary", "special-enter", "special-danmaku"] as const) {
			expect(`${s} → ${familyTone(s)}`).toBe(`${s} → ${PUSH_TONE.live}`);
		}
		expect(familyTone("dynamic")).toBe(PUSH_TONE.dynamic);
		expect(familyTone("sc")).toBe(PUSH_TONE.sc);
		expect(familyTone("guard")).toBe(PUSH_TONE.guard);
	});

	it("四个主 kind 的每种一色 = 它的家族色 —— 两套口径在这四种上必须一致", () => {
		// 衍生那三种刻意不同(toast 一次弹一条,独立色好认);主 kind 不同就是漂移。
		for (const s of ["live", "dynamic", "sc", "guard"] as const) {
			expect(`${s}: ${PUSH_KIND_META[s].tone}`).toBe(`${s}: ${familyTone(s)}`);
		}
	});

	it("每种 kind 两套标签都非空 —— 事件口径与分类口径都有人用", () => {
		for (const s of SOURCES) {
			expect(`${s}: ${PUSH_KIND_META[s].label.length > 0}`).toBe(`${s}: true`);
			expect(`${s}: ${PUSH_KIND_META[s].eventLabel.length > 0}`).toBe(`${s}: true`);
		}
	});
});

describe("没有第二份 kind 色表", () => {
	/**
	 * 复发形态是「在页面里再手搓一张 `Record<HistorySource, string>`」。这里扫的是
	 * 那五个曾经各存一份的文件:它们必须从 push-kinds 取色,而不是自己写十六进制。
	 */
	const CONSUMERS = [
		"components/toast-shell.tsx",
		"pages/Dashboard.tsx",
		"pages/History.tsx",
		"pages/Cards.tsx",
		"pages/up/UpCard.tsx",
	];

	it("五个曾经各存一份的文件都从 push-kinds 取", async () => {
		for (const rel of CONSUMERS) {
			const src = await readFile(join(SRC_DIR, rel), "utf8");
			expect(`${rel}: ${src.includes("config/push-kinds")}`).toBe(`${rel}: true`);
		}
	});

	/**
	 * 判据是「**四个家族色里凑齐三个以上**」而不是「出现任何一个」—— 那才是一张
	 * 色表的签名。单独一个不算:Dashboard 的日志级别表里 info 用 `#00AEEC`,那是
	 * 「信息=蓝」这个语义,与推送类型无关,不该被这条拦下来。
	 *
	 * 这条真抓到过东西:收表时先漏了 Dashboard 趋势图的图例(第六份副本)。
	 */
	it("这五个文件里不再出现成套的家族色字面量", async () => {
		const hexes = [PUSH_TONE.live, PUSH_TONE.dynamic, PUSH_TONE.sc, PUSH_TONE.guard];
		const findings: string[] = [];
		for (const rel of CONSUMERS) {
			const src = (await readFile(join(SRC_DIR, rel), "utf8")).toLowerCase();
			const hit = hexes.filter((h) => src.includes(h.toLowerCase()));
			if (hit.length >= 3) findings.push(`${rel}: ${hit.join(" ")}`);
		}
		expect(findings).toEqual([]);
	});

	it("push-kinds 自己是唯一出处 —— config/ 下没有第二张", async () => {
		const files = await readdir(join(SRC_DIR, "config"));
		expect(files.filter((f) => /kind|tone|source/i.test(f) && f.endsWith(".ts"))).toEqual([
			"push-kinds.ts",
		]);
	});

	/**
	 * 分区装饰色表(`section-accents.ts`)是**另一件事** —— 它按「这一屏讲哪件事」上色,
	 * 与 kind 无关,所以名字里刻意避开 `tone` 那个词(本仓库里 tone 特指推送家族色)。
	 *
	 * 但它确实有条把两者混起来的路:往里塞一整套家族色,于是又成了第二张 kind 表。
	 * 判据同上面那条 —— 四个家族色凑齐三个以上才算,单独撞一个不算:`persona` 那抹
	 * 暖黄与 `PUSH_TONE.sc` **恰好同值而不同义**(特别关注弹幕自己的推送色是绿的),
	 * 那是巧合,已在表里写明「SC 调色时这里不跟着动」。
	 *
	 * `guard` 那档反过来 —— 它讲的**就是**上舰,所以直接引用 `PUSH_TONE.guard`,
	 * 不另抄字面量。
	 */
	it("分区装饰色表里不许出现成套的家族色", async () => {
		const raw = await readFile(join(SRC_DIR, "config/section-accents.ts"), "utf8");
		// 注释先抹掉:那份文档正在**举例说明**旧写法长什么样(「`#FB7299` 配 `#b8425d`」),
		// 连注释一起扫的话,写得越清楚越容易被自己的守卫判成违规(实测当场误报)。
		const src = raw
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.toLowerCase();
		const hexes = [PUSH_TONE.live, PUSH_TONE.dynamic, PUSH_TONE.sc, PUSH_TONE.guard];
		const hit = hexes.filter((h) => src.includes(h.toLowerCase()));
		expect(hit.length < 3, `凑齐了 ${hit.join(" ")} —— 这已经是一张 kind 色表了`).toBe(true);
	});
});
