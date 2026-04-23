import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderCard } from "../render";
import { WordCloudCard } from "./wordcloud-card";

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
): Promise<string> {
	const wordcloudJS = readFileSync(resolve(dirname, "static/wordcloud2.min.js"), "utf-8");
	const renderFunc = readFileSync(resolve(dirname, "static/render.js"), "utf-8");

	const html = await renderCard(
		WordCloudCard,
		{ masterName, masterAvatarUrl, colorStart, colorEnd },
		{ title: "弹幕词云", font, htmlWidth: 720 },
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

			const words = ${JSON.stringify(words)};
			const wordColors = ${JSON.stringify(WORD_COLORS)};

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
