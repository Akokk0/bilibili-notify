/**
 * 守卫 — styles.css 里凡是**设定 position 的组件类**都必须落在 `@layer` 里。
 *
 * 真炸过一次:`.bn-ai-fab { position: relative }` 是无层 CSS,而 Tailwind 的
 * `.fixed` 在 `@layer utilities` 里 —— **无层恒压过分层**,与书写顺序、特异性
 * 都无关。于是右下角那颗胶囊的 `fixed` 失效,回到常规流叠上 `display:flex`,
 * 摊成了一整条横幅;同理 `.bn-glass-sheen` 的 relative 把「返回控制台」的
 * `absolute right-4` 顶掉,按钮从右上角掉回左边。
 *
 * 这类问题**类名断言抓不住**(类一直都在),jsdom 也量不出实际位置(没有 layout),
 * 只有直接查样式表本身。所以规则定在这里:要在类里写 position,就得进 @layer。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const STYLES = fileURLToPath(new URL("../styles.css", import.meta.url));

/**
 * 逐行扫一遍,记录当前的花括号深度与是否在 `@layer` 块内。
 *
 * 用括号计数而不是正则整块匹配:嵌套(`@layer` 里还有 `@media`)让「块的范围」
 * 没法用一条正则表达,数括号才是可靠的。
 */
function findUnlayeredPositionRules(css: string): string[] {
	const findings: string[] = [];
	const lines = css.split("\n");
	let depth = 0;
	/** 进入 @layer 时的深度;null = 当前不在任何 @layer 内。 */
	let layerDepth: number | null = null;

	for (const [i, raw] of lines.entries()) {
		const line = raw.trim();
		if (layerDepth === null && /^@layer\b[^;]*\{/.test(line)) layerDepth = depth;

		// position 声明(排除注释行与 @theme / :root 里的自定义属性)。
		if (!line.startsWith("*") && !line.startsWith("/*") && /^position\s*:/.test(line)) {
			if (layerDepth === null) findings.push(`styles.css:${i + 1} ${line}`);
		}

		for (const ch of raw) {
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (layerDepth !== null && depth <= layerDepth) layerDepth = null;
			}
		}
	}
	return findings;
}

describe("styles.css 分层", () => {
	it("没有任何无层规则去设定 position —— 那会压掉 Tailwind 的 fixed / absolute", async () => {
		const css = await readFile(STYLES, "utf8");
		expect(findUnlayeredPositionRules(css)).toEqual([]);
	});

	it("女仆 AI 聊天那一整块在 @layer components 里", async () => {
		const css = await readFile(STYLES, "utf8");
		const idx = css.indexOf("女仆 AI 聊天");
		expect(idx).toBeGreaterThan(-1);
		// 段落注释之后紧跟着开层。写死这一条是因为上面的通用规则只拦 position,
		// 而这一块里的 background / box-shadow 同样需要让位给工具类。
		expect(css.slice(idx, idx + 900)).toContain("@layer components {");
	});
});

describe("完全透明的作用范围", () => {
	/**
	 * 「完全透明」把玻璃片透光 + 去掉磨砂,但**设置弹层不在其列** —— 调这个开关的
	 * 控件就在那块弹层里。一起透掉的话,主人开完的下一秒就看不见自己在调什么,
	 * 连关回去的开关都摸不着,只能去清 localStorage。
	 *
	 * 这条守在源码上而不是渲染上:jsdom 不算样式,量不出「透没透」。后来者顺手
	 * 把 popover 补进那串选择器里是很自然的动作,得有句话拦一下。
	 */
	/** 弹层那条规则的正文。 */
	async function popoverBlock(): Promise<string> {
		const css = await readFile(STYLES, "utf8");
		const start = css.indexOf(".bn-glass-popover {");
		expect(start).toBeGreaterThan(-1);
		return css.slice(start, css.indexOf("}", start));
	}

	/**
	 * 测的是「有没有留后路」这个事实,不是具体数值 —— 数值是观感,该由主人在真机上
	 * 定;有没有后路是可用性,一旦没了主人就被自己锁在外面,只能去清 localStorage。
	 */
	it("底色留了下限 —— 拉到 0 / 开了完全透明,弹层也得读得出来", async () => {
		expect(await popoverBlock()).toContain("max(");
	});

	it("磨砂不跟着完全透明一起掉 —— 掉了就是文字叠文字", async () => {
		// 其它玻璃件的 blur 都乘了 --bn-chat-blur(完全透明时归零),唯独这块不乘。
		// 一起归零的话,弹层背后是清晰的会话列表,两层文字直接糊在一起。
		expect(await popoverBlock()).not.toContain("--bn-chat-blur");
	});
});

describe("findUnlayeredPositionRules 自身", () => {
	it("认得出无层的 position", () => {
		expect(findUnlayeredPositionRules(".a {\n\tposition: relative;\n}")).toHaveLength(1);
	});

	it("@layer 里的 position 不算", () => {
		expect(
			findUnlayeredPositionRules("@layer components {\n\t.a {\n\t\tposition: relative;\n\t}\n}"),
		).toEqual([]);
	});

	it("@layer 结束之后又恢复成「无层」", () => {
		// 层的边界数错的话,后面所有规则都会被误判成安全的。
		const css =
			"@layer components {\n\t.a {\n\t\tposition: relative;\n\t}\n}\n.b {\n\tposition: fixed;\n}";
		expect(findUnlayeredPositionRules(css)).toHaveLength(1);
	});

	it("@layer 里嵌套 @media 不会提前结束层", () => {
		const css =
			"@layer components {\n\t@media (min-width: 40px) {\n\t\t.a {\n\t\t\tposition: absolute;\n\t\t}\n\t}\n\t.b {\n\t\tposition: fixed;\n\t}\n}";
		expect(findUnlayeredPositionRules(css)).toEqual([]);
	});
});
