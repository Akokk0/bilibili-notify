// @vitest-environment jsdom

/**
 * ToneChip —— 「一排里选一个/开一个」的可点胶囊,选中时按给定语义色染色。
 *
 * 抽出来之前这套写法在站内手抄了四遍(运行日志的等级 / 暂停 / 自动滚动、推送历史
 * 的类型筛选),四份 `${tone}1f` / `${tone}55` 字面量里已经抄漏一处(暂停那颗写成
 * `20`)。这里钉住的就是那四份该有的共同行为。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ToneChip } from "../atoms";

afterEach(cleanup);

const chip = () => screen.getByRole("button");

describe("ToneChip", () => {
	/**
	 * 选中态的**字不用 tone** —— tone 只管底与边。
	 *
	 * 初版是「12% tone 底 + 100% tone 字」,字与底同色相,对比度天然受限于 tone
	 * 本身与主题背景的明度差:亮色下 warn 1.90:1、info 2.22:1、粉 2.30:1(7 档里
	 * 5 档不过 AA),暗色下深色调的紫 2.84:1、灰 2.45:1 也塌。改用正文色后两套
	 * 主题全部 12~16:1,而色彩识别改由**实色边框**接手 —— 真机上实色边比 12%
	 * 淡底更醒目,识别度不降反升。
	 */
	it("选中态:底 12% tone、边实色 tone、字走正文色", () => {
		render(
			<ToneChip tone="#f2a053" active onClick={() => {}}>
				暂停
			</ToneChip>,
		);
		const el = chip();
		expect(el.style.background).toBe("color-mix(in srgb, rgb(242, 160, 83) 12%, transparent)");
		expect(el.style.borderColor).toBe("rgb(242, 160, 83)");
		// 字色不落 inline,走 token 类 —— 皮肤能搬,且两套主题各自跟随。
		expect(el.style.color).toBe("");
		expect(el.className).toContain("text-bn-text-primary");
	});

	/**
	 * 未选中态的三个颜色是**静态**的,必须走 class 不走 inline `style` ——
	 * inline 没有 `:hover`,写进去这颗胶囊就永远没有悬停反馈(抽取时正是这么写的,
	 * 四颗胶囊一起丢了 hover)。只有 active 态的 `tone` 是动态值,才该落 inline。
	 */
	it("未选中态走中性档的 class,并带悬停反馈 —— 不落 inline style", () => {
		render(
			<ToneChip tone="#f2a053" onClick={() => {}}>
				暂停
			</ToneChip>,
		);
		const el = chip();
		expect(el.getAttribute("style")).toBe(null);
		expect(el.className).toContain("text-bn-text-tertiary");
		expect(el.className).toContain("border-bn-border");
		expect(el.className).toContain("hover:text-bn-text-primary");
	});

	it("tone 收 var() —— color-mix 的意义就在这,十六进制后缀做不到", () => {
		render(
			<ToneChip tone="var(--color-bn-pink)" active onClick={() => {}}>
				直播
			</ToneChip>,
		);
		const s = chip().style;
		expect(s.background).toBe("color-mix(in srgb, var(--color-bn-pink) 12%, transparent)");
		expect(s.borderColor).toBe("var(--color-bn-pink)");
	});

	// 它改的是某个值(筛选/开关),不是执行动作 —— 挂 chip 不挂 btn,免得皮肤的
	// 按钮实底把整排筛选胶囊画成一排按钮(2026-08-23 挂点语义分家)。
	it("挂 chip 皮肤挂点(选中额外挂 chip-active),圆角走 pill 轴而不是写死 rounded-full", () => {
		const { unmount } = render(<ToneChip tone="#f2a053">暂停</ToneChip>);
		expect(chip().getAttribute("data-bn")).toBe("chip");
		expect(chip().className).toContain("rounded-bn-pill");
		expect(chip().className).not.toContain("rounded-full");
		unmount();
		render(
			<ToneChip tone="#f2a053" active>
				暂停
			</ToneChip>,
		);
		expect(chip().getAttribute("data-bn")).toBe("chip chip-active");
	});

	it("点得动,且 disabled 时不触发", () => {
		const onClick = vi.fn();
		const { rerender } = render(
			<ToneChip tone="#f2a053" onClick={onClick}>
				暂停
			</ToneChip>,
		);
		fireEvent.click(chip());
		expect(onClick).toHaveBeenCalledTimes(1);
		rerender(
			<ToneChip tone="#f2a053" onClick={onClick} disabled>
				暂停
			</ToneChip>,
		);
		fireEvent.click(chip());
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	/**
	 * `tone` 只在 active 时有意义,所以是可选的 —— 没有开关态的纯操作钮
	 * (如日志页的「↓ .jsonl」)不该被逼着填一个用不上的颜色。
	 */
	it("纯操作钮不必填 tone —— 恒中性态", () => {
		render(<ToneChip onClick={() => {}}>↓ 2026-08-21.jsonl</ToneChip>);
		expect(chip().getAttribute("style")).toBe(null);
		expect(chip().className).toContain("text-bn-text-tertiary");
	});

	it("uppercase 只在点名时才加 —— 日志等级要,类型筛选不要", () => {
		const { rerender } = render(<ToneChip tone="#f2a053">warn</ToneChip>);
		expect(chip().className).not.toContain("uppercase");
		rerender(
			<ToneChip tone="#f2a053" uppercase>
				warn
			</ToneChip>,
		);
		expect(chip().className).toContain("uppercase");
	});
});
