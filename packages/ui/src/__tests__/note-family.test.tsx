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
import { EmptyNote, ErrorNote, WarnNote } from "../atoms";

afterEach(cleanup);

/** 从 class 串里挑出圆角与字号这两样 —— 阶梯就是由它们组成的。 */
function shape(cls: string): { radius?: string; size?: string } {
	const tokens = cls.split(/\s+/);
	return {
		radius: tokens.find((t) => t.startsWith("rounded-")),
		size: tokens.find((t) => t.startsWith("text-[") || t === "text-xs" || t === "text-sm"),
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
