// @vitest-environment jsdom

/**
 * T 系列输入件新开的三个口子。
 *
 * 这三个都不是装饰,各自堵一个具体的坑:
 * - `ariaLabel` —— 调用方把控件包进带整段提示文字的 `<label>` 时,读屏器念的是
 *   **整段拼接**;没有它,「正文」这个框叫「正文 · 做事的步骤 Markdown。这段会……」。
 * - `width` —— 走 inline style 的数字而非 `w-*` 类名。本仓没装 tailwind-merge,
 *   `w-40` 压不掉基线的 `w-full`,胜负由样式表先后决定 —— 是个随构建漂移的结果。
 * - `TSelect.disabled` —— 四件 T 里只有它此前漏了这个态。
 */

import { DockPanel, DrawerShell, ModalShell } from "@bilibili-notify/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TArea, TInput, TSelect } from "../forms";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const noop = () => {};

describe("ariaLabel —— 无障碍名落在控件本身", () => {
	it("TInput 给了 ariaLabel 就用它当无障碍名,不被外层 label 的整段文字盖过", () => {
		render(
			// biome-ignore lint/a11y/noLabelWithoutControl: 控件由 TInput 渲染在内部
			<label>
				<span>手填字体名</span>
				<TInput ariaLabel="手填字体名" value="" onChange={noop} />
				<span>容器里没装的字体填了不生效</span>
			</label>,
		);
		// 用无障碍名精确取到 —— 取得到就说明属性落在 <input> 上而不是包装层。
		expect(screen.getByLabelText("手填字体名").tagName).toBe("INPUT");
	});

	it("TArea 同理", () => {
		render(<TArea ariaLabel="技能正文" value="" onChange={noop} />);
		expect(screen.getByLabelText("技能正文").tagName).toBe("TEXTAREA");
	});

	it("不给 ariaLabel 就不留空属性 —— 空的 aria-label 会把无障碍名清成空串", () => {
		const { container } = render(<TInput value="" onChange={noop} />);
		expect(container.querySelector("input")?.hasAttribute("aria-label")).toBe(false);
	});
});

describe("width —— 定宽走 inline style,不走类名", () => {
	it("给了 width 就写进 style,且不再挂 w-full / w-auto(否则两条宽度规则打架)", () => {
		const { container } = render(<TInput width={160} value="" onChange={noop} />);
		const el = container.querySelector("input") as HTMLInputElement;
		expect(el.style.width).toBe("160px");
		expect([el.className.includes("w-full"), el.className.includes("w-auto")]).toEqual([
			false,
			false,
		]);
	});

	it("不给 width 时维持原样:full 默认满宽,full={false} 收成 w-auto", () => {
		const { container } = render(
			<>
				<TInput value="" onChange={noop} />
				<TInput full={false} value="" onChange={noop} />
			</>,
		);
		const [a, b] = Array.from(container.querySelectorAll("input"));
		expect([a.className.includes("w-full"), a.style.width]).toEqual([true, ""]);
		expect([b.className.includes("w-auto"), b.style.width]).toEqual([true, ""]);
	});
});

describe("TSelect.disabled —— 补齐四件 T 里唯一缺的那个态", () => {
	const OPTS = [{ value: "a", label: "A" }];

	it("disabled 落到 <select> 本体,并带上与兄弟件同一套压暗语汇", () => {
		const { container } = render(<TSelect disabled value="a" onChange={noop} options={OPTS} />);
		const el = container.querySelector('[role="combobox"]') as HTMLButtonElement;
		expect(el.disabled).toBe(true);
		expect(el.className).toContain("disabled:opacity-60");
	});

	it("不给就是可用态", () => {
		const { container } = render(<TSelect value="a" onChange={noop} options={OPTS} />);
		expect(container.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(false);
	});
});

const CHOICES = [
	{ value: "a", label: "Alpha" },
	{ value: "off", label: "Disabled", disabled: true },
	{ value: "b", label: "Beta" },
];
it("a real click sequence selects once without transferring focus to an option", async () => {
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	const user = userEvent.setup(),
		change = vi.fn(),
		focus: Element[] = [];
	const observe = (event: FocusEvent) => {
		if (event.target instanceof Element) focus.push(event.target);
	};
	document.addEventListener("focusin", observe);
	try {
		render(<TSelect value="a" ariaLabel="Choice" options={CHOICES} onChange={change} />);
		const trigger = screen.getByRole("combobox");
		await user.click(trigger);
		await user.click(screen.getByRole("option", { name: "Beta" }));
		expect(change).toHaveBeenCalledExactlyOnceWith("b");
		expect(document.activeElement).toBe(trigger);
		expect(focus.some((element) => element.getAttribute("role") === "option")).toBe(false);
	} finally {
		document.removeEventListener("focusin", observe);
	}
});
it("Tab and outside clicks leave focus at their natural destination", async () => {
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	const user = userEvent.setup(),
		change = vi.fn();
	render(
		<>
			<input aria-label="Before" />
			<TSelect value="a" ariaLabel="Choice" options={CHOICES} onChange={change} />
			<input aria-label="After" />
		</>,
	);
	const trigger = screen.getByRole("combobox");
	await user.click(trigger);
	await user.tab();
	expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "After" }));
	expect(screen.queryByRole("listbox")).toBeNull();
	await user.click(trigger);
	await user.tab({ shift: true });
	expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Before" }));
	await user.click(trigger);
	await user.click(screen.getByRole("textbox", { name: "After" }));
	await act(async () => {});
	expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "After" }));
	expect(change).not.toHaveBeenCalled();
});

it("disabled controls and disabled saved options cannot commit", async () => {
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	const user = userEvent.setup(),
		change = vi.fn();
	const { rerender } = render(
		<TSelect disabled value="a" ariaLabel="Choice" options={CHOICES} onChange={change} />,
	);
	await user.click(screen.getByRole("combobox"));
	expect(screen.queryByRole("listbox")).toBeNull();
	rerender(<TSelect value="off" ariaLabel="Choice" options={CHOICES} onChange={change} />);
	await user.click(screen.getByRole("combobox"));
	const disabled = screen.getByRole("option", { name: "Disabled" });
	expect(disabled.getAttribute("aria-selected")).toBe("true");
	await user.click(disabled);
	expect(change).not.toHaveBeenCalled();
	expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe("true");
	rerender(<TSelect disabled value="off" ariaLabel="Choice" options={CHOICES} onChange={change} />);
	expect(screen.queryByRole("listbox")).toBeNull();
});
it("returns internal focus but never reclaims focus after the window loses it", async () => {
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	const user = userEvent.setup(),
		change = vi.fn();
	render(<TSelect value="a" ariaLabel="Choice" options={CHOICES} onChange={change} />);
	const trigger = screen.getByRole("combobox");
	await user.click(trigger);
	const row = screen.getByRole("option", { name: "Beta" });
	act(() => row.focus());
	expect(document.activeElement).toBe(trigger);
	expect(screen.queryByRole("listbox")).not.toBeNull();
	fireEvent.blur(window);
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(change).not.toHaveBeenCalled();
});
function pointer(target: Element, type: string, details: Partial<PointerEvent> = {}) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		clientX: 20,
		clientY: 20,
		...details,
	});
	Object.defineProperties(event, {
		pointerId: { value: 1 },
		isPrimary: { value: true },
		pointerType: { value: "touch" },
	});
	return fireEvent(target, event);
}
it.each(["move", "cancel", "different", "scroll"])(
	"a %s touch gesture cannot select, and the next tap can",
	async (kind) => {
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		const change = vi.fn();
		render(<TSelect value="a" ariaLabel="Choice" options={CHOICES} onChange={change} />);
		const trigger = screen.getByRole("combobox");
		trigger.focus();
		fireEvent.click(trigger);
		const row = screen.getByRole("option", { name: "Beta" });
		expect(pointer(row, "pointerdown")).toBe(true);
		if (kind === "move") pointer(row, "pointermove", { clientY: 60 });
		if (kind === "cancel") pointer(row, "pointercancel");
		if (kind === "scroll") fireEvent.scroll(row.parentElement as HTMLElement);
		pointer(
			kind === "different" ? screen.getByRole("option", { name: "Alpha" }) : row,
			"pointerup",
		);
		fireEvent.click(row, { detail: 1 });
		await act(async () => {});
		expect(change).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox")).not.toBeNull();
		pointer(row, "pointerdown");
		pointer(row, "pointerup");
		fireEvent.click(row, { detail: 1 });
		await act(async () => {});
		expect(change).toHaveBeenCalledExactlyOnceWith("b");
		expect(document.activeElement).toBe(trigger);
	},
);

it.each(["modal", "drawer", "dock"])(
	"portal selection and the first Escape never close the parent %s",
	async (kind) => {
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		const user = userEvent.setup(),
			close = vi.fn(),
			change = vi.fn();
		const child = <TSelect value="a" ariaLabel="Choice" options={CHOICES} onChange={change} />;
		render(
			kind === "modal" ? (
				<ModalShell width={300} onCancel={close}>
					{child}
				</ModalShell>
			) : kind === "drawer" ? (
				<DrawerShell width={300} ariaLabel="Parent" onClose={close}>
					{child}
				</DrawerShell>
			) : (
				<DockPanel
					title="Parent"
					height={200}
					onHeightChange={noop}
					onClose={close}
					rail={[]}
					activeId=""
					onPick={noop}
				>
					{child}
				</DockPanel>
			),
		);
		const trigger = screen.getByRole("combobox");
		await user.click(trigger);
		await user.click(screen.getByRole("option", { name: "Beta" }));
		expect(change).toHaveBeenCalledExactlyOnceWith("b");
		expect(close).not.toHaveBeenCalled();
		await user.click(trigger);
		const option = screen.getByRole("option", { name: "Beta" });
		act(() => option.focus());
		fireEvent.keyDown(option, { key: "Escape" });
		expect(close).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await user.keyboard("{Escape}");
		expect(close).toHaveBeenCalledTimes(1);
	},
);
