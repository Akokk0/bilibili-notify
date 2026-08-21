// @vitest-environment jsdom

/**
 * `ErrorNote` —— 红字提示盒。
 *
 * 清单里写着它是「唯一写法」,可站内仍手写着四份:AI 聊天的出错横幅**两份逐字符一致**
 * (messages.tsx / index.tsx),UpCard 的「未关注」与备份导出的密级警告各一份带图标的。
 * 四份之间三种圆角(xl / lg / md)、三种字号(13 / 12 / 10.5px) —— 同一个意思看着像
 * 四种控件。收编要补的正是它们各自出格的那两件事:**图标槽**与**尺寸**。
 *
 * `role="alert"` 是顺手补的无障碍缺口:21 个调用点无一例外都是「出错了才渲染」,
 * 而只有手写的那两份 AI 横幅带了 role —— 库件反而没有,读屏器对其余 19 处一片死寂。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ErrorNote } from "../atoms";

afterEach(cleanup);

describe("ErrorNote", () => {
	it("是 role=alert —— 它只在出错时出现,读屏器该当场念出来", () => {
		render(<ErrorNote>保存失败:磁盘满了</ErrorNote>);
		expect(screen.getByRole("alert").textContent).toBe("保存失败:磁盘满了");
	});

	it("三档尺寸各不相同,但红色三件套(边 / 底 / 字)恒定", () => {
		const { container } = render(
			<>
				<ErrorNote size="sm">小</ErrorNote>
				<ErrorNote>中</ErrorNote>
				<ErrorNote size="lg">大</ErrorNote>
			</>,
		);
		const cls = Array.from(container.querySelectorAll('[role="alert"]')).map(
			(el) => (el as HTMLElement).className,
		);
		expect(new Set(cls).size).toBe(3);
		for (const c of cls) {
			expect(c).toContain("border-bn-danger-border");
			expect(c).toContain("bg-bn-danger-soft");
			expect(c).toContain("text-bn-danger-text");
		}
		// 字号真的分三档 —— 只换圆角/内边距不算「尺寸」。具体三档取自三兄弟共用的
		// 阶梯(见 `note-family.test.tsx`),这里只钉「确实是三个不同的字号」。
		expect([
			cls[0]?.includes("text-[11.5px]"),
			cls[1]?.includes("text-[12.5px]"),
			cls[2]?.includes("text-[13px]"),
		]).toEqual([true, true, true]);
	});

	it("给了 icon 就排成「图标 + 文字」,没给就不留空槽", () => {
		const { container: withIcon } = render(
			<ErrorNote icon={<svg data-testid="glyph" />}>未关注该 UP</ErrorNote>,
		);
		expect(withIcon.querySelector('[data-testid="glyph"]')).toBeTruthy();
		// 图标不该顶开文字的可读性 —— 无障碍名仍然只有正文。
		expect(screen.getByRole("alert").textContent).toBe("未关注该 UP");

		cleanup();
		const { container: bare } = render(<ErrorNote>没图标</ErrorNote>);
		// 没图标时不套 flex 壳,免得一行字被塞进一个两列布局里。
		expect((bare.querySelector('[role="alert"]') as HTMLElement).className).not.toContain("flex");
	});

	it("外边距仍然走 className —— 盒子本体样式不许各处漂", () => {
		const { container } = render(<ErrorNote className="mt-3">x</ErrorNote>);
		expect((container.querySelector('[role="alert"]') as HTMLElement).className).toContain("mt-3");
	});
});
