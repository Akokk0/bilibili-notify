import { createGenerator } from "@unocss/core";
import presetWind4 from "@unocss/preset-wind4";
import { renderToString } from "@vue/server-renderer";
import type { Component } from "vue";
import { createSSRApp, h } from "vue";

let unoPromise: ReturnType<typeof createGenerator> | null = null;

function getUno() {
	if (!unoPromise) {
		unoPromise = createGenerator({
			presets: [
				presetWind4({
					preflights: {
						reset: true,
						theme: true,
						property: true,
					},
				}),
			],
			// rich-text 中动态颜色类（AT/@→蓝, TOPIC/#→粉），UnoCSS 扫描 HTML 时可能漏掉
			safelist: ["text-[#00AEEC]", "text-[#FF6699]"],
		});
	}
	return unoPromise;
}

export async function renderCard(
	component: Component,
	props: Record<string, unknown>,
	options: { title?: string; font?: string; htmlWidth?: number } = {},
): Promise<string> {
	const { title = "通知", font = "sans-serif", htmlWidth } = options;

	const uno = await getUno();
	const app = createSSRApp({ render: () => h(component, props) });
	const body = await renderToString(app);
	const { css } = await uno.generate(body, { preflights: true });

	const baseCSS = /* css */ `
		* { margin: 0; padding: 0; box-sizing: border-box; font-family: "${font}", "Microsoft YaHei", "Source Han Sans", "Noto Sans CJK", sans-serif; }
		body { margin: 0; }
		html { width: ${htmlWidth ? `${htmlWidth}px` : "fit-content"}; height: auto; }
	`;

	return /* html */ `
		<!DOCTYPE html>
			<html>
			<head>
				<meta charset="utf-8">
				<title>${title}</title>
				<style>${baseCSS}${css}</style>
			</head>
			<body>${body}</body>
		</html>
	`;
}
