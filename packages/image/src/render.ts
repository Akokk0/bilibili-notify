import { renderToString } from "@vue/server-renderer";
import type { Component } from "vue";
import { createSSRApp, h } from "vue";

// biome-ignore lint/suspicious/noExplicitAny: UnoCSS generator type from dynamic import
let unoPromise: Promise<any> | null = null;

function getUno() {
	if (!unoPromise) {
		unoPromise = Promise.all([import("@unocss/core"), import("@unocss/preset-wind4")]).then(
			([{ createGenerator }, { default: presetWind4 }]) =>
				createGenerator({
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
				}),
		);
	}
	return unoPromise;
}

/**
 * 只把 class 属性里的内容交给 UnoCSS 扫描,**输出的 HTML 仍是原样**。
 *
 * UnoCSS 的默认 extractor 不解析 HTML,把整份文档当成一锅字符按分隔符切词 ——
 * 于是正文、style 属性、SVG path、SSR 注释全都参与「猜类名」。轻则凭空多造规则
 * (`style="backdrop-filter:…"` 就能造出一条没人用的 `.backdrop-filter`),重则
 * **吞掉真正的类名**:一个落单的 `[` 会被当成任意值方括号的开头,一路吃到后面
 * 第一个 `]`,把中间的类名整段并成一个无效 token。
 *
 * Vue 给每个 Fragment(`<>…</>`、数组 children、`.map()`)插的 SSR 锚点注释
 * `<!--[-->` 正好是这个形状,于是紧跟其后那个元素的 class 全数消失;UP 名字叫
 * `bili-[酱]` 同理。症状极隐蔽:类名照样写在 HTML 里,构建 / 类型 / lint 全绿,
 * 而被吞的类名只要在卡片别处复用过就被别处带出来 —— 只有「全卡唯一」的那些会
 * 真的消失。锐评卡单人头像行的 gap、榜单标题行的 justify-between 就是这么没的,
 * 一直到出图才看得见。
 *
 * 所以别把输入换回整份 HTML:类名只可能出现在 class 属性里,喂别的都是风险。
 */
function classTokens(html: string): string {
	return [...html.matchAll(/\sclass="([^"]*)"/g)].map((m) => m[1]).join(" ");
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
	const { css } = await uno.generate(classTokens(body), { preflights: true });

	const baseCSS = /* css */ `
		* { margin: 0; padding: 0; box-sizing: border-box; font-family: "${font}", "Microsoft YaHei", "Source Han Sans", "Noto Sans CJK", sans-serif; }
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
