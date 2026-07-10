// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GroupEditDialog } from "./GroupEditDialog";

/**
 * 右键「编辑分组」弹框:列出已有分组,当前所属的预勾;勾 / 取消即时改草稿,新建
 * 输入并进列表,点确定把最终分组集合交给父层(父层再 PATCH 落盘)。
 */
afterEach(cleanup);

describe("GroupEditDialog", () => {
	it("渲染所有已有分组,当前所属项预先勾选", () => {
		render(
			<GroupEditDialog
				allGroups={["A", "B", "C"]}
				current={["B"]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		expect((screen.getByRole("checkbox", { name: "B" }) as HTMLInputElement).checked).toBe(true);
		expect((screen.getByRole("checkbox", { name: "A" }) as HTMLInputElement).checked).toBe(false);
	});

	it("勾选一个未所属分组 → 即时勾上(草稿变化)", () => {
		render(
			<GroupEditDialog
				allGroups={["A", "B"]}
				current={[]}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const a = screen.getByRole("checkbox", { name: "A" }) as HTMLInputElement;
		expect(a.checked).toBe(false);

		fireEvent.click(a);

		expect((screen.getByRole("checkbox", { name: "A" }) as HTMLInputElement).checked).toBe(true);
	});

	it("新建一个分组名 → 出现在列表且默认勾上", () => {
		render(
			<GroupEditDialog allGroups={["A"]} current={[]} onConfirm={vi.fn()} onCancel={vi.fn()} />,
		);

		fireEvent.change(screen.getByPlaceholderText("新建分组名"), { target: { value: "新组" } });
		fireEvent.click(screen.getByText("添加"));

		expect((screen.getByRole("checkbox", { name: "新组" }) as HTMLInputElement).checked).toBe(true);
	});

	it("确定 → 把最终分组集合交给 onConfirm", () => {
		const onConfirm = vi.fn();
		render(
			<GroupEditDialog
				allGroups={["A", "B"]}
				current={["A"]}
				onConfirm={onConfirm}
				onCancel={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "B" })); // 追加 B
		fireEvent.click(screen.getByText("确定"));

		expect(onConfirm).toHaveBeenCalledWith(["A", "B"]);
	});

	it("取消 → onCancel,不 onConfirm", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(
			<GroupEditDialog
				allGroups={["A"]}
				current={["A"]}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		fireEvent.click(screen.getByText("取消"));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
