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

	it("ui 包的 theme.css 同样不许无层 position(它被 @import 进来,陷阱一模一样)", async () => {
		const css = await readFile(
			fileURLToPath(new URL("../../../../packages/ui/src/theme.css", import.meta.url)),
			"utf8",
		);
		expect(findUnlayeredPositionRules(css)).toEqual([]);
	});

	it("女仆 AI 聊天那一整块在 @layer components 里", async () => {
		const css = await readFile(STYLES, "utf8");
		// 锚在区段线标题上(不是裸词)—— 文件头部的搬迁注释里也会提到「女仆 AI 聊天」。
		const idx = css.indexOf("── 女仆 AI 聊天");
		expect(idx).toBeGreaterThan(-1);
		// 段落注释之后紧跟着开层。写死这一条是因为上面的通用规则只拦 position,
		// 而这一块里的 background / box-shadow 同样需要让位给工具类。
		expect(css.slice(idx, idx + 900)).toContain("@layer components {");
	});
});

describe("聊天玻璃族与外部玻璃 token 统一", () => {
	/**
	 * 聊天页的玻璃件不再有 chat 专属参数(玻璃质感滑杆/完全透明已撤):全族直接吃
	 * 默认装与皮肤共用的 --bn-glass-* token,皮肤在「玻璃」节调什么聊天页就长什么样。
	 * 守在源码上:jsdom 不算样式,量不出「透没透」;而「顺手给聊天玻璃再开一套
	 * 专属变量」正是最容易复发的回退。
	 */
	async function block(selector: string): Promise<string> {
		const css = await readFile(STYLES, "utf8");
		const start = css.indexOf(`${selector} {`);
		expect(`${selector}: ${start > -1}`).toBe(`${selector}: true`);
		return css.slice(start, css.indexOf("}", start));
	}

	/**
	 * 聊天页**不许再有平行的玻璃类**。
	 *
	 * 这三个类曾经存在(`.bn-glass-panel` / `.bn-glass-popover` / `.bn-glass-chip`),
	 * 而在「聊天玻璃族改吃共用 --bn-glass-* token」之后,它们的声明与库里那两档
	 * 逐字相同了 —— 纯复制品。代价不是几行重复:`glass` / `glass-strong` 两个挂点
	 * 匹配的是 `.bn-glass(-strong)`,于是皮肤的自定义 CSS 打得到整站每一块玻璃,
	 * 唯独打不到聊天页 —— 而皮肤工坊就住在聊天页。
	 *
	 * 复发形态就是「顺手再给聊天玻璃起个自己的类」,所以守在类名上。
	 */
	it("聊天页直接用 .bn-glass / .bn-glass-strong,没有平行的复制品类", async () => {
		const css = await readFile(STYLES, "utf8");
		for (const dead of [".bn-glass-panel", ".bn-glass-popover", ".bn-glass-chip"]) {
			// 注释里提到它们(讲由来)是允许的,只拦真的规则定义。
			expect(`${dead} 规则: ${css.includes(`${dead} {`) || css.includes(`${dead},`)}`).toBe(
				`${dead} 规则: false`,
			);
		}
		const chat = await readFile(
			fileURLToPath(new URL("../components/ai-chat/sidebar.tsx", import.meta.url)),
			"utf8",
		);
		expect(chat).toContain("bn-glass-strong");
	});

	it("chat 专属玻璃变量一个不剩 —— 剩一个就是回退的种子", async () => {
		const css = await readFile(STYLES, "utf8");
		for (const dead of ["--bn-chat-glass", "--bn-chat-blur", "--bn-chat-saturate"]) {
			expect(`${dead}: ${css.includes(dead)}`).toBe(`${dead}: false`);
		}
	});

	it("用户气泡 = accent 纱垫在普通档玻璃上 —— 纯纱在皮肤壁纸上会融进背景", async () => {
		const bubble = await block(".bn-chat-bubble-user");
		expect(bubble).toContain("var(--bn-glass-bg)");
		expect(bubble).toContain("color-mix(in srgb, var(--bn-chat-dot) 14%, transparent)");
	});

	it("消息组件把气泡建在 .bn-glass 上 —— 只有这样皮肤的 glass 挂点才够得到它", async () => {
		const tsx = await readFile(
			fileURLToPath(new URL("../components/ai-chat/messages.tsx", import.meta.url)),
			"utf8",
		);
		// 顺序要紧:.bn-glass 出底/描边/模糊,.bn-chat-bubble-user 只覆盖 background。
		expect(tsx).toContain("bn-glass bn-chat-bubble-user");
	});

	it("默认聊天主题从默认装 token 派生,不另写一套配色", async () => {
		const css = await readFile(STYLES, "utf8");
		// 强调色/整页底都必须是 var 引用 —— 手写字面量就是「原生皮肤自己写了一套」。
		expect(css).toContain("--bn-chat-dot: var(--color-bn-pink)");
		expect(css).toContain("--bn-chat-bg: var(--bn-page-bg)");
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
