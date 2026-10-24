// @vitest-environment jsdom

/**
 * 规则页「可用变量」速查面板回归测试:提示条上的变量代码必须与模板变量表一致。
 *
 * 面板曾停留在 koishi 旧版的 `-dmc` 写法,后来又漏过运行时一直认的 `{time}` / `{postNoun}`。
 * 现在代码从 `@bilibili-notify/internal/template-variables` 取,这里逐条对表;中文说明仍住在面板,
 * 由类型钉住「表里有的变量都有说明」。
 */

import { defaultMessageKindLayout } from "@bilibili-notify/internal";
import { templateDefaultsFor } from "@bilibili-notify/internal/builtin-texts";
import { DEFAULT_LOCALE } from "@bilibili-notify/internal/i18n";
import { TEMPLATE_VARIABLES, type TemplateKey } from "@bilibili-notify/internal/template-variables";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	DynamicMsgVariableHints,
	GuardVariableHints,
	LiveMsgSection,
	LiveMsgVariableHints,
	SpecialDanmakuVariableHints,
	SpecialEnterVariableHints,
	StopWordsHint,
	SummaryVariableHints,
} from "../sections";

const FACTORY_TEMPLATES = templateDefaultsFor(DEFAULT_LOCALE);

afterEach(cleanup);

const codesOf = (container: HTMLElement): string[] =>
	[...container.querySelectorAll("code")].map((node) => node.textContent ?? "");

/** `{un1..5}` 这种合并写法摊回表里逐个变量名。 */
const expandCode = (code: string): string[] => {
	const range = /^\{([A-Za-z_]+)(\d+)\.\.(\d+)\}$/.exec(code);
	if (!range) return [code];
	const out: string[] = [];
	for (let i = Number(range[2]); i <= Number(range[3]); i += 1) out.push(`{${range[1]}${i}}`);
	return out;
};

const codesInTable = (keys: readonly TemplateKey[]): string[] => [
	...new Set(
		keys.flatMap((key) => Object.keys(TEMPLATE_VARIABLES[key]).map((name) => `{${name}}`)),
	),
];

describe("提示条的变量代码与表一致", () => {
	it.each([
		["直播总结", SummaryVariableHints, ["liveSummary"]],
		["直播消息", LiveMsgVariableHints, ["liveStart", "liveStreaming", "liveEnd"]],
		["动态消息", DynamicMsgVariableHints, ["post"]],
		["上舰提示", GuardVariableHints, ["membership"]],
		["特别弹幕", SpecialDanmakuVariableHints, ["viewerChat"]],
		["特别进场", SpecialEnterVariableHints, ["viewerEnter"]],
	] as const)("%s 的提示条列出的就是表里那条的全部变量", (_label, Hint, keys) => {
		const { container } = render(<Hint />);
		const shown = codesOf(container).flatMap(expandCode).sort();
		expect(shown).toEqual(codesInTable(keys).sort());
	});

	it("直播消息的开播格也列全了表里的变量", () => {
		const { container } = render(
			<LiveMsgSection
				templates={{ ...FACTORY_TEMPLATES, wordcloudStopWords: "", membership: {} }}
				factory={FACTORY_TEMPLATES}
				layout={defaultMessageKindLayout("live")}
				onPatch={() => {}}
			/>,
		);
		expect(
			codesOf(container)
				.filter((code) => code.startsWith("{"))
				.sort(),
		).toEqual(codesInTable(["liveStart"]).sort());
	});
});

describe("SummaryVariableHints", () => {
	it("does not show legacy dash-prefixed placeholders", () => {
		const { container } = render(<SummaryVariableHints />);
		// legacy 渲染器仍兼容 `-key`,但 UI 不再宣传它,以免与默认模板/文档矛盾。
		expect(container.textContent).not.toContain("-dmc");
		expect(container.textContent).not.toContain("-un1");
	});
});

/**
 * 提示条的**标题色必须是派生的**。
 *
 * 站里两条提示条(紫的「可用变量」、青的「词云停用词」)长得一模一样,但只有前者把三处
 * 颜色都从一个 accent `color-mix` 出来。后者三个色是手挑的字面量,其中标题那枚
 * `#076e94` 是深青 —— 亮色下压在 10% 青底上正合适,暗色下页面本身就是黑的,那层半透明
 * 底根本挡不住,深青字直接糊进背景。同一个病 `#946800` 已经在别处犯过一次了。
 *
 * 派生式(`color-mix(… , var(--color-bn-text-primary))`)天生免疫:亮色下往黑里调、
 * 暗色下往白里调,accent 换成什么色都跟得住。
 */
describe("提示条标题色", () => {
	const titleColor = (node: HTMLElement) =>
		(node.querySelector("span.font-bold") as HTMLElement | null)?.style.color ?? "";

	it("词云停用词条的标题色是派生的,不是写死的深色", () => {
		const { container } = render(<StopWordsHint />);
		const color = titleColor(container);
		expect(color).toContain("color-mix");
		// 往正文色里调 —— 这一步就是暗色下自动提亮的来源。
		expect(color).toContain("--color-bn-text-primary");
	});

	it("和「可用变量」条走同一套派生 —— 两条提示条不许各挑各的色", () => {
		const stop = render(<StopWordsHint />).container;
		const vars = render(<SummaryVariableHints />).container;
		const shape = (c: string) => c.replace(/var\(--color-bn-[a-z-]+\)|#[0-9a-fA-F]{3,8}/g, "@");
		expect(shape(titleColor(stop))).toBe(shape(titleColor(vars)));
	});

	it("底与边也跟着 accent 走,不写死 hex", () => {
		const { container } = render(<StopWordsHint />);
		const bar = container.firstElementChild as HTMLElement;
		expect(bar.style.background).toContain("color-mix");
		expect(bar.style.borderColor).toContain("color-mix");
	});
});
