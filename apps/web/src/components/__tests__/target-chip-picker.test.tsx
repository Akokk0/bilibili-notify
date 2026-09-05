// @vitest-environment jsdom
/**
 * 「从推送目标里勾几个」的胶囊选择器 —— 今天周报的「发送到」用它。
 *
 * 缝在组件 props:目标列表、适配器表与已选 id 进,点击回调 id 出。停用的目标**照列照勾**
 * 并标「已停用」(主人定的:停用是暂停不是消失),而「停用」与服务端跳过它时同一条判定 ——
 * 适配器停用的目标也标。不测样式。
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PushAdapter, PushTarget } from "../../types/domain";
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

const ADAPTER = "11111111-1111-4111-8111-111111111111";
const adapters = [{ id: ADAPTER, enabled: true }] as PushAdapter[];

afterEach(cleanup);

describe("TargetChipPicker", () => {
	it("每个目标一颗胶囊,点一下回调它的 id", () => {
		const onToggle = vi.fn();
		render(
			<TargetChipPicker
				targets={[target(T_A, "群 A"), target(T_B, "群 B")]}
				adapters={adapters}
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
				adapters={adapters}
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
				adapters={adapters}
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

	it("目标自己开着、它挂的适配器停了 → 也标「已停用」(服务端一样不发)", () => {
		render(
			<TargetChipPicker
				targets={[target(T_A, "群 A")]}
				adapters={[{ id: ADAPTER, enabled: false }] as PushAdapter[]}
				selected={[]}
				onToggle={() => {}}
				tone="#ff0000"
			/>,
		);
		expect(within(screen.getByRole("button", { name: /群 A/ })).getByText("已停用")).toBeTruthy();
	});

	it("一个目标都没有 → 显示调用方给的空态,不画胶囊", () => {
		render(
			<TargetChipPicker
				targets={[]}
				adapters={adapters}
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
