// @vitest-environment jsdom

/**
 * 提示盒三兄弟 —— `ErrorNote`(红)/ `WarnNote`(黄)/ `EmptyNote`(中性虚线)。
 *
 * 它们说的是同一类话(「这里有件事要告诉你」),所以**只该差颜色,不该差形状**。
 * 收编前对不上:红盒 `rounded-md` 12px、黄盒 `rounded-lg` 11.5px、空态盒又是另外
 * 两档。于是同一个弹窗里「保存失败」是 6px 圆角 12px 字、「有几处没照办」是 8px
 * 圆角 11.5px 字 —— 看着像两种不同的控件,而它们本来是一族。
 *
 * 这条守的是**阶梯共用**,不是「三个长得一模一样」:内边距仍各归各的(空态盒要撑满
 * 整块面板的留白、红盒挤在表单字段之间),那是位置决定的,不是漂移。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EmptyNote, ErrorNote, HintNote, WarnNote } from "../atoms";

afterEach(cleanup);

/**
 * 字号阶梯的九档,抄自 `theme.css` 的 `--text-bn-*`。
 *
 * 不能拿 `text-bn-` 前缀了事 —— 颜色类也长这样(`text-bn-text-primary`),前缀匹配
 * 会把字色当成字号挑走。
 *
 * 这份名单是**抄**的不是**读**的:本包 tsconfig 写着 `"types": []`,平台中立的展示件
 * 库不碰 Node API,测试也不例外。名单落后于表也不会漏守 —— 三兄弟改用了名单外的新档,
 * `size` 就是 undefined,下面第一条断言当场红,提示的正是「该更新名单了」。跨端的
 * 「用的档在表里真有定义」由 `color-token-conformance.test.ts` 兜。
 */
const SIZE_CLASSES = new Set(
	["micro", "2xs", "xs", "sm", "base", "md", "lg", "xl", "hero"].map((n) => `text-bn-${n}`),
);

/** 从 class 串里挑出圆角与字号这两样 —— 阶梯就是由它们组成的。 */
function shape(cls: string): { radius?: string; size?: string } {
	const tokens = cls.split(/\s+/);
	return {
		radius: tokens.find((t) => t.startsWith("rounded-")),
		size: tokens.find((t) => SIZE_CLASSES.has(t)),
	};
}

function shapeOf(el: Element | null): { radius?: string; size?: string } {
	return shape((el as HTMLElement).className);
}

describe("提示盒三兄弟共用一套尺寸阶梯", () => {
	it("sm 档:红盒与黄盒的圆角字号一致", () => {
		const { container } = render(
			<>
				<ErrorNote size="sm">红</ErrorNote>
				<WarnNote size="sm">黄</WarnNote>
			</>,
		);
		const [err, warn] = Array.from(container.children);
		expect(shapeOf(err ?? null)).toEqual(shapeOf(warn ?? null));
	});

	it("md 档:红盒、黄盒、空态盒三个的圆角字号一致", () => {
		const { container } = render(
			<>
				<ErrorNote>红</ErrorNote>
				<WarnNote>黄</WarnNote>
				<EmptyNote>空</EmptyNote>
			</>,
		);
		const [err, warn, empty] = Array.from(container.children);
		const s = shapeOf(err ?? null);
		expect(s.radius, "md 档得有圆角").toBeTruthy();
		expect(s.size, "md 档得有字号").toBeTruthy();
		expect(shapeOf(warn ?? null)).toEqual(s);
		expect(shapeOf(empty ?? null)).toEqual(s);
	});

	it("阶梯是单调的 —— 越大档圆角越大,不是随机三套", () => {
		const { container } = render(
			<>
				<ErrorNote size="sm">1</ErrorNote>
				<ErrorNote>2</ErrorNote>
				<ErrorNote size="lg">3</ErrorNote>
			</>,
		);
		const radii = Array.from(container.children).map((el) => shapeOf(el).radius);
		expect(radii).toEqual(["rounded-md", "rounded-lg", "rounded-xl"]);
	});

	it("内边距仍各归各的 —— 空态盒撑满面板,红盒挤在字段之间", () => {
		const { container } = render(
			<>
				<ErrorNote>红</ErrorNote>
				<EmptyNote>空</EmptyNote>
			</>,
		);
		const [err, empty] = Array.from(container.children);
		const pad = (el: Element) =>
			(el as HTMLElement).className.split(/\s+/).filter((t) => /^p[xy]?-/.test(t));
		expect(pad(err as Element)).not.toEqual(pad(empty as Element));
	});
});

/**
 * 第四位成员 HintNote —— 「顺带说一句」的低调旁注:虚线 + 软底 + 小字。
 * 收编前三处各配各的圆角(Cards `rounded-sm` / FontPicker `rounded-lg` /
 * UpDialog `rounded-md`),同一句「旁注」三种控件长相。
 */
describe("HintNote 旁注盒", () => {
	const note = (container: HTMLElement) => container.firstElementChild as HTMLElement;

	it("形状走家族 sm 档 —— 与红盒 sm 的圆角字号一致,且是虚线", () => {
		const { container } = render(
			<>
				<HintNote>旁注</HintNote>
				<ErrorNote size="sm">红</ErrorNote>
			</>,
		);
		const [hint, err] = Array.from(container.children);
		expect(shapeOf(hint ?? null)).toEqual(shapeOf(err ?? null));
		expect((hint as HTMLElement).className).toContain("border-dashed");
	});

	it("三档 tone 只换颜色;底一律实色 soft token,不是 /60 那种纱", () => {
		const { container } = render(
			<>
				<HintNote>中性</HintNote>
				<HintNote tone="success">报喜</HintNote>
				<HintNote tone="danger">警示</HintNote>
			</>,
		);
		const [neutral, success, danger] = Array.from(container.children) as HTMLElement[];
		expect(neutral?.className).toContain("bg-bn-surface-muted");
		expect(success?.className).toContain("bg-bn-success-soft");
		expect(danger?.className).toContain("bg-bn-danger-soft");
		// 纱在壁纸皮肤下会隐形(Cards 收编前的 bg-bn-success-soft/60 正是这种写法)。
		for (const el of [neutral, success, danger]) {
			expect(el?.className).not.toMatch(/bg-bn-[a-z-]+\/\d+/);
		}
	});

	it("danger 档与红盒同挂 note-danger,其余只挂造型档 note", () => {
		const { container } = render(
			<>
				<HintNote>中性</HintNote>
				<HintNote tone="danger">警示</HintNote>
			</>,
		);
		const [neutral, danger] = Array.from(container.children);
		expect(neutral?.getAttribute("data-bn")).toBe("note");
		expect(danger?.getAttribute("data-bn")).toBe("note note-danger");
	});

	it("className 追加布局(flex 行)接在本体之后 —— FontPicker 那种「文字 + 按钮」行", () => {
		const { container } = render(<HintNote className="flex items-center gap-2">行</HintNote>);
		expect(note(container).className.endsWith("flex items-center gap-2")).toBe(true);
	});
});
