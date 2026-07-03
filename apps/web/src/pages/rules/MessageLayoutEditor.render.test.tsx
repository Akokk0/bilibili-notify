// @vitest-environment jsdom

/**
 * 消息版式编辑器交互回归 —— 块上移下移 / 分条符插删 / 显隐切换 / 分隔符编辑 /
 * 发送预览。编辑器是受控组件,断言以 onChange 收到的 next 值 + 预览文案为准。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { MessageKindLayoutFull } from "../../types/domain";
import { MessageLayoutEditor } from "./MessageLayoutEditor";

afterEach(cleanup);

function layoutOf(types: string[], separator = "\n"): MessageKindLayoutFull {
	return {
		blocks: types.map((t, i) => ({
			id: t === "split" ? `split-${i}` : t,
			type: t,
			visible: true,
		})),
		separator,
	};
}

function setup(value: MessageKindLayoutFull) {
	const onChange = vi.fn();
	render(
		<MessageLayoutEditor
			value={value}
			onChange={onChange}
			separatorCode="messageLayout.dynamic.separator"
		/>,
	);
	return { onChange };
}

describe("MessageLayoutEditor", () => {
	it("默认版式渲染三个部件行 + 单条发送预览", () => {
		setup(layoutOf(["card", "text", "link"]));
		expect(screen.getByText("卡片图")).toBeTruthy();
		expect(screen.getByText("文本")).toBeTruthy();
		expect(screen.getByText("链接")).toBeTruthy();
		expect(screen.getByText(/第 1 条『卡片图 \+ 文本 \+ 链接』/)).toBeTruthy();
	});

	it("点「插入分条符」→ onChange 收到末尾追加 split 的新块列表", () => {
		const { onChange } = setup(layoutOf(["card", "text"]));
		fireEvent.click(screen.getByText("插入分条符"));
		const next = onChange.mock.calls[0]?.[0] as MessageKindLayoutFull;
		expect(next.blocks.map((b) => b.type)).toEqual(["card", "text", "split"]);
	});

	it("分条符行有删除按钮;点删 → onChange 移除该块", () => {
		const { onChange } = setup(layoutOf(["card", "split", "text"]));
		fireEvent.click(screen.getByTitle("删除分条符"));
		const next = onChange.mock.calls[0]?.[0] as MessageKindLayoutFull;
		expect(next.blocks.map((b) => b.type)).toEqual(["card", "text"]);
	});

	it("每个块行都有拖拽手柄(dnd-kit 排序;重排逻辑由 moveBlock 单测钉住)", () => {
		setup(layoutOf(["card", "text", "link"]));
		expect(screen.getAllByTitle("拖动排序")).toHaveLength(3);
	});

	it("textSlot 内嵌在「文本」块行内;文本块隐藏时收起", () => {
		const layout = layoutOf(["card", "text", "link"]);
		render(
			<MessageLayoutEditor
				value={layout}
				onChange={vi.fn()}
				separatorCode="messageLayout.dynamic.separator"
				textSlot={<div data-testid="tpl-slot">模板编辑区</div>}
			/>,
		);
		// 槽与文本块同一行容器(li)内 —— 随块拖动
		const slot = screen.getByTestId("tpl-slot");
		expect(slot.closest("li")?.textContent).toContain("文本");
		cleanup();
		render(
			<MessageLayoutEditor
				value={{
					...layout,
					blocks: layout.blocks.map((b) => (b.type === "text" ? { ...b, visible: false } : b)),
				}}
				onChange={vi.fn()}
				separatorCode="messageLayout.dynamic.separator"
				textSlot={<div data-testid="tpl-slot">模板编辑区</div>}
			/>,
		);
		expect(screen.queryByTestId("tpl-slot")).toBeNull();
	});

	it("分条符切两条时预览显示两条消息;全部隐藏时显示不发送警告", () => {
		setup(layoutOf(["card", "split", "text", "link"]));
		expect(screen.getByText(/第 1 条『卡片图』/)).toBeTruthy();
		expect(screen.getByText(/第 2 条『文本 \+ 链接』/)).toBeTruthy();
		cleanup();
		setup({
			blocks: [
				{ id: "card", type: "card", visible: false },
				{ id: "text", type: "text", visible: false },
				{ id: "link", type: "link", visible: false },
			],
			separator: "\n",
		});
		expect(screen.getByText(/本类推送将不发送任何消息/)).toBeTruthy();
	});

	it("分隔符输入框显示 \\n 编码;编辑后 onChange 拿到解码值", () => {
		const { onChange } = setup(layoutOf(["card", "text"], "\n"));
		const input = screen.getByDisplayValue("\\n");
		fireEvent.change(input, { target: { value: " | " } });
		const next = onChange.mock.calls[0]?.[0] as MessageKindLayoutFull;
		expect(next.separator).toBe(" | ");
	});

	it("卡片图不在最前 → 显示 QQ 拆条提示;卡片图在最前时不显示", () => {
		setup(layoutOf(["text", "card", "link"]));
		expect(screen.getByText(/QQ/)).toBeTruthy();
		cleanup();
		setup(layoutOf(["card", "text", "link"]));
		expect(screen.queryByText(/QQ/)).toBeNull();
	});
});
