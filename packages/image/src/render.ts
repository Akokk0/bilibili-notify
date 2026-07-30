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

/**
 * CSS 里**不能加引号**的家族名 —— 加了就从「generic 家族」变成「找一个叫
 * sans-serif 的字体文件」,必然找不到。
 */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"cursive",
	"fantasy",
	"system-ui",
	"ui-serif",
	"ui-sans-serif",
	"ui-monospace",
	"ui-rounded",
	"emoji",
	"math",
	"fangsong",
]);

/** 缺字体时的兜底链,恒挂在最后 —— 少了它缺字形会渲染成一排方块。 */
const FALLBACK_FAMILIES = '"Microsoft YaHei", "Source Han Sans", "Noto Sans CJK", sans-serif';

/**
 * 主人自带字体在 CSS 里的家族名。
 *
 * 固定一个内部名字,而不是去解析字体文件里的真名:解析 ttf/otf 要拖一个字体解析库
 * 进来,而这里唯一需要的就是「@font-face 声明的名字」和「font-family 引用的名字」
 * 对得上 —— 自己定一个反倒最稳,还不受字体文件元数据缺失 / 是中文名之类影响。
 */
export const USER_FONT_FAMILY = "bn-user-font";

/**
 * data URL → 一条 `@font-face` 规则。**推送出图与设置页预览共用这一处** ——
 * 两边各拼一份的话,迟早出现「预览是这款、推出去是另一款」而两边都说不出哪儿错了。
 *
 * `font-display: block` 是刻意的:截图不等字体加载完就出图会得到一张兜底字体的卡,
 * 而这条路上字体是内联的 data URL(不走网络),block 只是让浏览器别抢跑。
 */
export function buildFontFace(dataUrl: string): string {
	return `@font-face{font-family:"${USER_FONT_FAMILY}";src:url("${dataUrl}");font-display:block}`;
}

/**
 * 配置里的字体值 → 合法的 `font-family` 声明值。
 *
 * 这里曾经是 `"${font}"` 一把梭,于是**整串**被套进一对引号。CSS 里带引号 =
 * **一个**家族名,所以出厂默认值 `PingFang SC, sans-serif` 成了一个不存在的家族,
 * 苹方从来没生效过 —— 而这种错永远不报,解析器对不存在的家族就是静静跳过。
 *
 * 逐项处理:generic 家族原样(不能加引号),其余一律加引号(家族名常含空格),
 * 引号与反斜杠转义(既防写坏 CSS,也堵掉从配置值注入样式那条路)。
 */
export function cssFontFamily(font: string): string {
	return font
		.split(",")
		.map((token) => {
			const name = token.trim();
			if (!name) return "";
			if (GENERIC_FAMILIES.has(name.toLowerCase())) return name;
			return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
		})
		.filter(Boolean)
		.join(", ");
}

export async function renderCard(
	component: Component,
	props: Record<string, unknown>,
	options: {
		title?: string;
		font?: string;
		htmlWidth?: number;
		/**
		 * 完整的 `@font-face` 规则 —— 主人自己上传的字体经这里进来(字体文件由适配层
		 * 解析成 data URL 内联,与背景图同一条路:`packages/image` 不碰文件系统)。
		 */
		fontFace?: string;
	} = {},
): Promise<string> {
	const { title = "通知", font = "sans-serif", htmlWidth, fontFace } = options;

	const uno = await getUno();
	const app = createSSRApp({ render: () => h(component, props) });
	const body = await renderToString(app);
	const { css } = await uno.generate(classTokens(body), { preflights: true });

	const families = [cssFontFamily(font), FALLBACK_FAMILIES].filter(Boolean).join(", ");
	const baseCSS = /* css */ `
		* { margin: 0; padding: 0; box-sizing: border-box; font-family: ${families}; }
		html { width: ${htmlWidth ? `${htmlWidth}px` : "fit-content"}; height: auto; }
	`;

	return /* html */ `
		<!DOCTYPE html>
			<html>
			<head>
				<meta charset="utf-8">
				<title>${title}</title>
				<style>${fontFace ?? ""}${baseCSS}${css}</style>
			</head>
			<body>${body}</body>
		</html>
	`;
}
