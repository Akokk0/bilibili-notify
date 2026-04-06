import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildWordCloudHtml(
	masterName: string,
	words: Array<[string, number]>,
	dirname: string,
): string {
	const wordcloudJS = pathToFileURL(resolve(dirname, "static/wordcloud2.min.js"));
	const renderFunc = pathToFileURL(resolve(dirname, "static/render.js"));

	return /* html */ `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <title>高清词云展示</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                html {
                    width: 720px;
                    height: 520px;
                }

                .wordcloud-bg {
                    width: 720px;
                    height: 520px;
                    background: linear-gradient(to right, #e0eafc, #cfdef3);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }

                .wordcloud-card {
                    width: 700px;
                    height: 500px;
                    backdrop-filter: blur(10px);
                    background: rgba(255, 255, 255, 0.25);
                    border-radius: 20px;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
                    padding: 20px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                }

                h2 {
                    margin: 0 0 10px;
                    color: #333;
                    font-size: 24px;
                }

                canvas {
                    width: 100%;
                    height: 100%;
                    display: block;
                }
            </style>
        </head>
        <body>
            <div class="wordcloud-bg">
                <div class="wordcloud-card">
                    <h2>${masterName}直播弹幕词云</h2>
                    <canvas id="wordCloudCanvas"></canvas>
                </div>
            </div>

            <script src="${wordcloudJS}"></script>
            <script src="${renderFunc}"></script>
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

                window.wordcloudDone = false;
                canvas.addEventListener('wordcloudstop', () => {
                    window.wordcloudDone = true;
                });

                renderAutoFitWordCloud(canvas, words, {
                    maxFontSize: 60,
                    minFontSize: 12,
                    densityTarget: 0.3,
                    weightExponent: 0.4
                });
            </script>
        </body>
        </html>
    `;
}
