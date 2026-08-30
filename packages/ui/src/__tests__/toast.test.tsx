// @vitest-environment jsdom

/**
 * `Toast` —— 一句话瞬时提示。
 *
 * 收编前站里有两处各写各的:Subs 的复制提示(中性底 + 正文色字)与 Targets 的
 * 保存提示(**实心语义底 + 写死白字**)。两处的差别不是设计,是两种语汇撞在一起,
 * 而后者那种写法有两个真问题:
 *
 * ① 白字写死、底色可被皮肤重绘 —— 正是 About 那颗按钮翻车的同一类缺陷,所以它
 *    整个挂不上挂点,皮肤够不着。
 * ② 它钉在 `bottom-4 right-4`,而推送 toast 的整摞也钉在 `bottom-4 right-4`
 *    —— 同一个角,推送提示正显示时保存一次目标,两者直接叠在一起。
 *
 * 统一后的语汇跟推送 toast 一致:中性底 + 语义**描边**,字恒走正文色 token。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Toast } from "../toast";

afterEach(cleanup);

describe("Toast", () => {
	it("挂 glass-strong —— 它是实底浮层,属性挂点就是为这类准备的", () => {
		render(<Toast>已复制</Toast>);
		expect(screen.getByRole("status").getAttribute("data-bn")).toBe("glass-strong");
	});

	it("字色恒走正文色 token,不写死白字 —— 底色能被皮肤重绘,写死的字色不能", () => {
		const { container } = render(<Toast tone="err">保存失败</Toast>);
		const el = container.querySelector('[role="status"]') as HTMLElement;
		expect([
			el.className.includes("text-bn-text-primary"),
			el.className.includes("text-white"),
		]).toEqual([true, false]);
	});

	it("语义走描边而不是实心底 —— 底恒定,tone 只换 borderColor", () => {
		const { container } = render(
			<>
				<Toast tone="ok">好了</Toast>
				<Toast tone="err">坏了</Toast>
				<Toast>中性</Toast>
			</>,
		);
		const [ok, err, neutral] = Array.from(
			container.querySelectorAll('[role="status"]'),
		) as HTMLElement[];
		// 三者底色同一档(与庆祝胶囊同一块 glass-strong 玻璃),只有描边不同。
		// 边由 `.bn-glass-strong` 的 border 出,再叠 border-bn-border 会被玻璃类
		// 的 shorthand 压掉还留下误导(同 PopoverShell 玻璃档)。
		for (const el of [ok, err, neutral]) {
			expect(el.className).toContain("bn-glass-strong");
			expect(el.className).not.toContain("bg-bn-surface-strong");
			expect(el.className).not.toContain("border-bn-border");
		}
		expect(ok.style.borderColor).toBe("var(--color-bn-success-border)");
		expect(err.style.borderColor).toBe("var(--color-bn-danger-border)");
		expect(neutral.style.borderColor).toBe("");
	});

	it("底部居中 —— 右下角是推送 toast 那一摞的地盘,占过去会叠在一起", () => {
		const { container } = render(<Toast>x</Toast>);
		const el = container.querySelector('[role="status"]') as HTMLElement;
		expect([
			el.className.includes("left-1/2"),
			el.className.includes("-translate-x-1/2"),
			el.className.includes("right-4"),
		]).toEqual([true, true, false]);
	});

	it("role=status + aria-live=polite —— 读屏器要念出来,但别打断当前朗读", () => {
		render(<Toast>已保存</Toast>);
		const el = screen.getByRole("status");
		expect(el.getAttribute("aria-live")).toBe("polite");
		expect(el.textContent).toBe("已保存");
	});
});
