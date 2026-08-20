// @vitest-environment jsdom
/**
 * 输入框的**键盘交互** —— `skills.test.ts` 只钉得住「该匹配出哪几条」,
 * 匹配对了但 ↑↓ 不动、Enter 直接把 `/锐` 当正文发出去,纯函数测试照样全绿。
 *
 * 这几条都是一闪而过的行为,在页面上靠肉眼很难反复验,所以钉在这里。
 */

import type { MaidSkillDTO } from "@bilibili-notify/contract";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Composer } from "../composer";

/** 菜单里那几条。技能现在从服务端来,所以测试自己造一份喂进去。 */
const SKILLS: MaidSkillDTO[] = ["weekly-report", "unsub-cleanup", "up-pk"].map((name) => ({
	name,
	description: `${name} 干什么`,
	disableModelInvocation: false,
	body: "步骤",
	builtin: true,
}));

afterEach(cleanup);

/** 受控组件:自己接住 onChange,免得每条测试都写一遍 wrapper。 */
function renderComposer(initial = "", over: Partial<Parameters<typeof Composer>[0]> = {}) {
	const onSubmit = vi.fn();
	let value = initial;
	const view = render(
		<Composer
			value={value}
			onChange={() => {}}
			onSubmit={onSubmit}
			busy={false}
			aiName="小绫"
			skills={SKILLS}
			{...over}
		/>,
	);
	const rerenderWith = (next: string) => {
		value = next;
		view.rerender(
			<Composer
				value={value}
				onChange={() => {}}
				onSubmit={onSubmit}
				busy={false}
				aiName="小绫"
				skills={SKILLS}
				{...over}
			/>,
		);
	};
	const textarea = () => screen.getByLabelText("聊天输入");
	return { onSubmit, rerenderWith, textarea };
}

describe("Composer — 技能菜单", () => {
	it("打 / 弹出菜单,列出全部技能", () => {
		const { rerenderWith } = renderComposer();
		rerenderWith("/");
		expect(screen.getByRole("listbox", { name: "女仆技能" })).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(SKILLS.length);
	});

	it("普通文字不弹菜单", () => {
		renderComposer("本周谁最勤奋");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("↓ 移动高亮 —— 靠 aria-selected 定位,不依赖颜色", () => {
		const { rerenderWith, textarea } = renderComposer();
		rerenderWith("/");
		const before = screen.getAllByRole("option");
		expect(before[0]?.getAttribute("aria-selected")).toBe("true");

		fireEvent.keyDown(textarea(), { key: "ArrowDown" });
		const after = screen.getAllByRole("option");
		expect(after[0]?.getAttribute("aria-selected")).toBe("false");
		expect(after[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("↑ 从第一条回绕到最后一条", () => {
		const { rerenderWith, textarea } = renderComposer();
		rerenderWith("/");
		fireEvent.keyDown(textarea(), { key: "ArrowUp" });
		const options = screen.getAllByRole("option");
		expect(options[options.length - 1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("菜单开着时 Enter 是「选中技能」而不是「发送」", () => {
		// 这条是最容易写错的:两个 Enter 语义撞在一起,发出去的就会是半截 `/锐`。
		const { rerenderWith, textarea, onSubmit } = renderComposer();
		rerenderWith("/");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("Esc 关掉菜单,之后 Enter 恢复成发送", () => {
		const { rerenderWith, textarea, onSubmit } = renderComposer();
		rerenderWith("/");
		fireEvent.keyDown(textarea(), { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});
});

describe("Composer — 发送", () => {
	it("Enter 发送", () => {
		const { textarea, onSubmit } = renderComposer("在吗");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("Shift+Enter 换行,不发送", () => {
		const { textarea, onSubmit } = renderComposer("第一行");
		fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("空输入时 Enter 不发送,发送键也是禁用的", () => {
		const { textarea, onSubmit } = renderComposer("   ");
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByLabelText("发送").hasAttribute("disabled")).toBe(true);
	});

	it("等回复期间不能再发 —— 否则一句话会被连打好几遍", () => {
		const { textarea, onSubmit } = renderComposer("在吗", { busy: true });
		fireEvent.keyDown(textarea(), { key: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByLabelText("发送").hasAttribute("disabled")).toBe(true);
	});
});
