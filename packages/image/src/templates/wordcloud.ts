import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderCard } from "../render";
import { WordCloudCard } from "./wordcloud-card";

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

export async function buildWordCloudHtml(
	masterName: string,
	words: Array<[string, number]>,
	dirname: string,
	masterAvatarUrl?: string,
	colorStart = "#e0c3fc",
	colorEnd = "#8ec5fc",
	font = "sans-serif",
	/** 主人自带字体的 `@font-face` 规则(有就跟着一起进 CSS)。 */
	fontFace?: string,
): Promise<string> {
	const wordcloudJS = readFileSync(resolve(dirname, "static/wordcloud2.min.js"), "utf-8");
	const renderFunc = readFileSync(resolve(dirname, "static/render.js"), "utf-8");

	const html = await renderCard(
		WordCloudCard,
		{ masterName, masterAvatarUrl, colorStart, colorEnd },
		{ title: "弹幕词云", font, fontFace, htmlWidth: 720 },
	);

	const initScript = `
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

	return html.replace("</body>", `${initScript}</body>`);
}
