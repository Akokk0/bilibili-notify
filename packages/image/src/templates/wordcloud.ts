import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * JSON 嵌入内联 `<script>` 的安全序列化。`JSON.stringify` **不**转义
 * `</script>` / `<!--` / U+2028 / U+2029 —— 弹幕词(`words`,完全攻击者可控)
 * 含 `</script>` 即脚本块 breakout,在 puppeteer 页内注入任意标签/脚本。
 * 中和 `<` 及行分隔符后产物仍是合法 JSON / JS 表达式。
 */
export function safeJsonForScript(value: unknown): string {
	// < → \\u003c 中和 </script> / <!-- / <script;U+2028/U+2029 按 codepoint
	// 正则匹配(不在源码内嵌裸行分隔符)。产物仍是合法 JSON / JS 表达式。
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const WORD_COLORS = [
	"#6c5ce7",
	"#0984e3",
	"#00b894",
	"#fd79a8",
	"#fdcb6e",
	"#e17055",
	"#74b9ff",
	"#a29bfe",
];

/**
 * 词云画布的**脚本注入**——「`#wordCloudCanvas` 这个空画布 → 真的画上词」的那一半。
 *
 * 单独抽出来是因为**画布那半已经归皮肤了**(ADR-0014:词云卡整张正文是一个内置块,
 * 皮肤只管外框),而这一半得现读两个磁盘文件 —— 拼 HTML 的人(`ImageRenderer` /
 * 测试)只要把它注进去就行,取色与自适应参数只有这一份。
 *
 * 产物必须塞在 `</body>` 之前 —— 脚本里 `getElementById` 立刻就找画布。
 */
export function wordCloudInitScript(words: Array<[string, number]>, dirname: string): string {
	const wordcloudJS = readFileSync(resolve(dirname, "static/wordcloud2.min.js"), "utf-8");
	const renderFunc = readFileSync(resolve(dirname, "static/render.js"), "utf-8");
	return `
		<script>${wordcloudJS}</script>
		<script>${renderFunc}</script>
		<script>
			const canvas = document.getElementById('wordCloudCanvas');
			const ctx = canvas.getContext('2d');
			const style = getComputedStyle(canvas);
			const cssWidth = parseInt(style.width);
			const cssHeight = parseInt(style.height);
			const ratio = window.devicePixelRatio || 1;
			canvas.width = cssWidth * ratio;
			canvas.height = cssHeight * ratio;
			ctx.scale(ratio, ratio);

			const words = ${safeJsonForScript(words)};
			const wordColors = ${safeJsonForScript(WORD_COLORS)};

			window.wordcloudDone = false;
			canvas.addEventListener('wordcloudstop', () => {
				window.wordcloudDone = true;
			});

			renderAutoFitWordCloud(canvas, words, {
				maxFontSize: 60,
				minFontSize: 12,
				densityTarget: 0.3,
				weightExponent: 0.4,
				color: () => wordColors[Math.floor(Math.random() * wordColors.length)],
			});
		</script>
	`;
}

/** 词云的脚本必须塞在这之前。出图与测试共用同一个落点。 */
export function injectWordCloudScript(html: string, script: string): string {
	return html.replace("</body>", `${script}</body>`);
}
