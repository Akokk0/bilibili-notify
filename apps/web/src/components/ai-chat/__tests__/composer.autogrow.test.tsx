// @vitest-environment jsdom
/**
 * 输入框的自适应高度。
 *
 * 真机上撞到的:`rows={1}` 加一个 `max-h`,而高度从来不涨 —— 打长一点的需求
 * (「参照某个角色做一套皮肤,要毛玻璃风格…」)之后,框还是一行高,文字被顶出
 * 视野,主人看不见自己写的开头(2026-08-19)。`max-h` 在一个从不长高的元素上
 * 一点作用也没有。
 *
 * jsdom 不排版,`scrollHeight` 恒为 0,所以这里把它伪造成「内容有多高」——
 * 测的是**这段逻辑**(照内容长、到顶就停、清空回落),不是浏览器的排版。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { COMPOSER_MAX_HEIGHT, Composer } from "../composer";

/** 让 scrollHeight 听我的:返回「当前内容需要多高」。 */
function fakeScrollHeight(heightOf: (value: string) => number) {
	Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLTextAreaElement) {
			return heightOf(this.value);
		},
	});
}

/**
 * Composer 是**受控**的:value 从 props 来。测试里必须真的把状态接上,否则
 * `fireEvent.change` 之后 React 会把 DOM 值改回 props 那个,高度自然不动 ——
 * 那样测出来的「不长高」是测试的错,不是组件的错。
 */
function Host({ initial }: { initial: string }) {
	const [value, setValue] = useState(initial);
	return (
		<Composer
			value={value}
			onChange={setValue}
			onSubmit={() => {}}
			busy={false}
			attachments={[]}
			onPickFiles={() => {}}
			onRemoveAttachment={() => {}}
			aiName="伦伦"
		/>
	);
}

function mount(value: string) {
	const view = render(<Host initial={value} />);
	return { view, ta: screen.getByLabelText("聊天输入") as HTMLTextAreaElement };
}

beforeEach(() => {
	// 一行 24px,每 20 个字算一行。
	fakeScrollHeight((v) => 24 * Math.max(1, Math.ceil(v.length / 20)));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Composer 高度跟着内容长", () => {
	it("一行内容 → 一行高", () => {
		const { ta } = mount("在吗");
		expect(ta.style.height).toBe("24px");
	});

	it("内容变长 → 框跟着长高", () => {
		const { ta } = mount("");
		fireEvent.change(ta, { target: { value: "啊".repeat(60) } });
		expect(Number.parseInt(ta.style.height, 10)).toBeGreaterThan(24);
	});

	it("长到上限就停 —— 再长下去输入框会把整个页面吃掉", () => {
		const { ta } = mount("");
		fireEvent.change(ta, { target: { value: "啊".repeat(2000) } });
		expect(ta.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
	});

	it("到顶之后自己能滚 —— 停在上限却滚不动,等于又把开头顶没了", () => {
		const { ta } = mount("啊".repeat(2000));
		expect(ta.className).toContain("overflow-y-auto");
	});

	it("发完清空 → 高度回落成一行,不留一个空荡荡的大框", () => {
		const { ta } = mount("");
		fireEvent.change(ta, { target: { value: "啊".repeat(200) } });
		fireEvent.change(ta, { target: { value: "" } });
		expect(ta.style.height).toBe("24px");
	});
});
