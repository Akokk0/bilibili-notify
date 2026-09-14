// @vitest-environment jsdom

/**
 * 皮肤旋钮区(ADR-0014 决策 16 的 🔗)。
 *
 * 钉的五条各对应一个静默失败:① 皮肤没声明旋钮时整块不渲染(摆个空壳等于告诉主人这里
 * 本该有东西);② 四种类型各画各的控件(画错一种,那枚旋钮就永远拧不到自己的取值域);
 * ③ **没拧过的键不落盘** —— 这条是「存覆盖不存值」的判据,一旦把 `default` 一并写进去,
 * 默认皮肤那三档玻璃兜底会被注出来的同一个数当场塌成一档;④ 「还原」删的是键,不是写回
 * default(界面上两者长得一模一样);⑤ 只改当前这套皮肤那一层,别套皮肤的覆盖原样带走。
 */

import type { CardSkinKnob } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CardSkinKnobsSection } from "../CardSkinKnobs";
import type { CardSkinKnobsBySkin } from "../knob-ops";

vi.mock("../../../services/api", () => ({
	ApiError: class extends Error {},
	api: { get: vi.fn() },
}));

import { api } from "../../../services/api";

const KNOBS: CardSkinKnob[] = [
	{ key: "gradient-start", label: "背景渐变起色", type: "color", default: "#e0c3fc" },
	{
		key: "glass-opacity",
		label: "玻璃白纱",
		type: "number",
		default: 0.82,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "corner",
		label: "圆角风格",
		type: "select",
		default: "12px",
		options: [
			{ value: "12px", label: "圆润" },
			{ value: "0px", label: "硬直角" },
		],
	},
	{ key: "show-badge", label: "显示徽章", type: "switch", default: true, on: "block", off: "none" },
];

function listWith(knobs?: CardSkinKnob[]) {
	return {
		skins: [
			{
				id: "neon",
				name: "霓虹夜",
				builtin: false,
				updatedAt: 1,
				knobs: [KNOBS[0] as CardSkinKnob],
			},
			{ id: "default", name: "默认", builtin: true, updatedAt: 0, ...(knobs ? { knobs } : {}) },
		],
		active: "default",
		fallbacks: [],
	};
}

function renderKnobs(value: CardSkinKnobsBySkin, onChange = vi.fn()) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<CardSkinKnobsSection value={value} onChange={onChange} />
		</QueryClientProvider>,
	);
	return { ...view, onChange };
}

/** 某一枚旋钮那一行(控件都从行里面找,免得撞上别行的同名控件)。 */
function rowOf(container: HTMLElement, key: string): HTMLElement {
	const row = container.querySelector(`[data-knob="${key}"]`);
	if (!row) throw new Error(`旋钮 ${key} 那一行没渲染出来`);
	return row as HTMLElement;
}

beforeEach(() => {
	vi.mocked(api.get).mockResolvedValue(listWith(KNOBS));
});
afterEach(() => cleanup());

describe("CardSkinKnobsSection", () => {
	it("当前皮肤没声明旋钮 → 不画控件,但明说一句这套皮肤没有可调项", async () => {
		vi.mocked(api.get).mockResolvedValue(listWith(undefined));
		const { container } = renderKnobs({});
		// 主人 2026-09-14 真机上就栽在这里:从前整块不渲染,看上去和「面板是旧的」一模一样。
		expect(await screen.findByText(/这套皮肤没有提供可调项/)).toBeTruthy();
		expect(container.querySelector("[data-knob]")).toBeNull();
	});

	it("皮肤列表还没到 → 什么都不画(别先闪一句「没有可调项」)", async () => {
		let resolve: ((v: unknown) => void) | undefined;
		vi.mocked(api.get).mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const { container } = renderKnobs({});
		await waitFor(() => expect(vi.mocked(api.get)).toHaveBeenCalled());
		expect(container.textContent).toBe("");
		resolve?.(listWith(KNOBS));
	});

	it("按声明顺序逐枚生成控件,四种类型各画各的", async () => {
		const { container } = renderKnobs({});
		await screen.findByText("皮肤旋钮");

		// 顺序照声明,不按 key 排序也不按类型分组。
		expect(
			[...container.querySelectorAll("[data-knob]")].map((n) => n.getAttribute("data-knob")),
		).toEqual(["gradient-start", "glass-opacity", "corner", "show-badge"]);

		// color → 颜色选择器
		expect(rowOf(container, "gradient-start").querySelector('input[type="color"]')).not.toBeNull();

		// number → 滑杆,取值域照声明夹死
		const range = rowOf(container, "glass-opacity").querySelector(
			'input[type="range"]',
		) as HTMLInputElement;
		expect([range.min, range.max, range.step, range.value]).toEqual(["0", "1", "0.01", "0.82"]);

		// select → 下拉,候选照声明
		const select = rowOf(container, "corner").querySelector("select") as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual(["12px", "0px"]);
		expect(select.value).toBe("12px");

		// switch → 开关(Toggle 是个按钮,不是 input)
		const toggle = rowOf(container, "show-badge").querySelector("button[aria-label]");
		expect(toggle?.getAttribute("aria-label")).toBe("显示徽章");
	});

	it("没拧过的键不落盘 —— 拧一枚只写这一枚,别的键一个都不带上", async () => {
		const { container, onChange } = renderKnobs({});
		await screen.findByText("皮肤旋钮");

		const range = rowOf(container, "glass-opacity").querySelector(
			'input[type="range"]',
		) as HTMLInputElement;
		fireEvent.change(range, { target: { value: "0.4" } });

		// 只有被拧的那一个键。gradient-start / corner / show-badge 虽然控件上摆着 default,
		// 但它们是「起始位置」不是「值」—— 一并写进去就会被注成 CSS,把各卡各自的兜底盖平。
		expect(onChange).toHaveBeenCalledWith({ default: { "glass-opacity": 0.4 } });
	});

	it("拧过的才有「还原」,点它是把键删掉而不是写回 default", async () => {
		const { container, onChange } = renderKnobs({ default: { "glass-opacity": 0.4 } });
		await screen.findByText("皮肤旋钮");

		// 没拧过的那三行不该有还原钮 —— 那是一颗点了什么都不会发生的钮。
		expect(rowOf(container, "corner").textContent).not.toContain("还原");

		const row = rowOf(container, "glass-opacity");
		expect(row.textContent).toContain("还原");
		expect((row.querySelector('input[type="range"]') as HTMLInputElement).value).toBe("0.4");

		fireEvent.click(screen.getByText("还原"));
		// 键没了(而不是 `{ "glass-opacity": 0.82 }`),这套皮肤空了连层一起摘掉。
		expect(onChange).toHaveBeenCalledWith({});
	});

	it("只改当前启用那套皮肤那一层,别套皮肤的覆盖原样带走", async () => {
		const { container, onChange } = renderKnobs({ neon: { accent: "#ff0000" } });
		await screen.findByText("皮肤旋钮");

		fireEvent.change(rowOf(container, "corner").querySelector("select") as HTMLSelectElement, {
			target: { value: "0px" },
		});
		expect(onChange).toHaveBeenCalledWith({
			neon: { accent: "#ff0000" },
			default: { corner: "0px" },
		});
	});
});
