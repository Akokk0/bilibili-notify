// @vitest-environment jsdom
/**
 * 「从推送目标里勾几个」的共享胶囊选择器 —— 链接解析白名单与周报「发送到」共用。
 *
 * 缝在组件 props:目标列表与已选 id 进,点击回调 id 出。停用的目标**照列照勾**并标
 * 「已停用」(主人定的:两处选择器行为一致,停用是暂停不是消失),不测样式。
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushTarget } from "../../types/domain";
import { TargetChipPicker } from "../target-chip-picker";

const T_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function target(id: string, name: string, enabled = true): PushTarget {
	return {
		id,
		name,
		adapterId: "11111111-1111-4111-8111-111111111111",
		scope: "group",
		enabled,
		platform: "onebot",
		session: { groupId: "123" },
	} as PushTarget;
}

afterEach(cleanup);

describe("TargetChipPicker", () => {
	it("每个目标一颗胶囊,点一下回调它的 id", () => {
		const onToggle = vi.fn();
		render(
			<TargetChipPicker
				targets={[target(T_A, "群 A"), target(T_B, "群 B")]}
				selected={[T_A]}
				onToggle={onToggle}
				tone="#ff0000"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /群 B/ }));
		expect(onToggle).toHaveBeenCalledWith(T_B);
	});

	it("已选的胶囊亮着,没选的不亮", () => {
		render(
			<TargetChipPicker
				targets={[target(T_A, "群 A"), target(T_B, "群 B")]}
				selected={[T_A]}
				onToggle={() => {}}
				tone="#ff0000"
			/>,
		);
		expect(screen.getByRole("button", { name: /群 A/ }).getAttribute("data-bn")).toContain(
			"chip-active",
		);
		expect(screen.getByRole("button", { name: /群 B/ }).getAttribute("data-bn")).not.toContain(
			"chip-active",
		);
	});

	it("停用的目标照样列出来、能点,并标「已停用」", () => {
		const onToggle = vi.fn();
		render(
			<TargetChipPicker
				targets={[target(T_A, "群 A"), target(T_B, "群 B", false)]}
				selected={[]}
				onToggle={onToggle}
				tone="#ff0000"
			/>,
		);
		const chip = screen.getByRole("button", { name: /群 B/ });
		expect(within(chip).getByText("已停用")).toBeTruthy();
		expect(within(screen.getByRole("button", { name: /群 A/ })).queryByText("已停用")).toBeNull();
		fireEvent.click(chip);
		expect(onToggle).toHaveBeenCalledWith(T_B);
	});

	it("一个目标都没有 → 显示调用方给的空态,不画胶囊", () => {
		render(
			<TargetChipPicker
				targets={[]}
				selected={[]}
				onToggle={() => {}}
				tone="#ff0000"
				empty="还没有可用的推送目标"
			/>,
		);
		expect(screen.getByText("还没有可用的推送目标")).toBeTruthy();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});
