// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TSelect } from "../form-controls";

afterEach(cleanup);
const options = [
	{ value: "", label: "No unit" },
	{ value: "px", label: "Pixels" },
	{ value: "old", label: "Unavailable", disabled: true },
];

describe("controlled select", () => {
	it("keeps a legitimate empty option and does not write on mount", () => {
		const onChange = vi.fn();
		render(<TSelect ariaLabel="Unit" value="" onChange={onChange} options={options} />);
		expect(screen.getByRole("combobox").textContent).toBe("No unit");
		expect(onChange).not.toHaveBeenCalled();
	});
	it("keeps a disabled saved option visible", () => {
		render(<TSelect ariaLabel="Unit" value="old" onChange={vi.fn()} options={options} />);
		expect(screen.getByRole("combobox").textContent).toBe("Unavailable");
		fireEvent.click(screen.getByRole("combobox"));
		expect(
			(screen.getByRole("option", { name: "Unavailable" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});
	it("reports a selected string value without changing external state", () => {
		const onChange = vi.fn();
		render(<TSelect ariaLabel="Unit" value="" onChange={onChange} options={options} />);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: "Pixels" }));
		expect(onChange).toHaveBeenCalledWith("px");
	});
	it("keeps explicit width and disabled on the actual control", () => {
		render(
			<TSelect
				ariaLabel="Unit"
				width={60}
				disabled
				value="px"
				onChange={vi.fn()}
				options={options}
			/>,
		);
		const control = screen.getByRole("combobox") as HTMLButtonElement;
		expect(control.style.width).toBe("60px");
		expect(control.disabled).toBe(true);
		expect(control.getAttribute("data-bn")).toBe("input");
	});
});

it("opens a list and commits a clicked option", () => {
	const onChange = vi.fn();
	render(<TSelect ariaLabel="Unit" value="" onChange={onChange} options={options} />);
	const trigger = screen.getByRole("combobox");
	fireEvent.click(trigger);
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	fireEvent.click(screen.getByRole("option", { name: "Pixels" }));
	expect(onChange).toHaveBeenCalledExactlyOnceWith("px");
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement).toBe(trigger);
});

it("moves past disabled options without committing until Enter", () => {
	const onChange = vi.fn();
	render(<TSelect ariaLabel="Unit" value="" onChange={onChange} options={options} />);
	const trigger = screen.getByRole("combobox");
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "ArrowDown" });
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	fireEvent.keyDown(trigger, { key: "End" });
	expect(onChange).not.toHaveBeenCalled();
	const active = document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "");
	expect(active?.textContent).toBe("Pixels");
	fireEvent.keyDown(trigger, { key: "Enter" });
	expect(onChange).toHaveBeenCalledExactlyOnceWith("px");
	expect(document.activeElement).toBe(trigger);
});

it("cancels with Escape before a parent window handler and dismisses outside without stealing focus", () => {
	const onChange = vi.fn(),
		parent = vi.fn();
	window.addEventListener("keydown", parent);
	try {
		render(
			<>
				<TSelect ariaLabel="Unit" value="" onChange={onChange} options={options} />
				<input aria-label="Next" />
			</>,
		);
		const trigger = screen.getByRole("combobox");
		trigger.focus();
		fireEvent.click(trigger);
		fireEvent.keyDown(trigger, { key: "Escape" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(parent).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(trigger);
		fireEvent.click(trigger);
		const next = screen.getByRole("textbox");
		fireEvent.pointerDown(next);
		next.focus();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(next);
		expect(onChange).not.toHaveBeenCalled();
	} finally {
		window.removeEventListener("keydown", parent);
	}
});

it("cycles matching prefixes, skips disabled matches and ignores composition", () => {
	render(
		<TSelect
			ariaLabel="Animal"
			value="a"
			onChange={vi.fn()}
			options={[
				{ value: "a", label: "Ant" },
				{ value: "x", label: "Bear", disabled: true },
				{ value: "b", label: "Bee" },
				{ value: "c", label: "Bird" },
			]}
		/>,
	);
	const trigger = screen.getByRole("combobox");
	fireEvent.click(trigger);
	fireEvent.keyDown(trigger, { key: "b" });
	const active = () =>
		document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.textContent;
	expect(active()).toBe("Bee");
	fireEvent.keyDown(trigger, { key: "b" });
	expect(active()).toBe("Bird");
	fireEvent.keyDown(trigger, { key: "a", isComposing: true });
	expect(active()).toBe("Bird");
});

it("shows unknown values honestly and never invents a selection for empty lists", () => {
	const onChange = vi.fn();
	const { rerender } = render(<TSelect value="missing" onChange={onChange} options={options} />);
	expect(screen.getByRole("combobox").textContent).toContain("missing");
	expect(screen.getByRole("combobox").textContent).toContain("当前值不可用");
	rerender(<TSelect value="" onChange={onChange} options={[{ value: "a", label: "A" }]} />);
	expect(screen.getByRole("combobox").textContent).toContain("请选择");
	rerender(<TSelect value="" onChange={onChange} options={[]} />);
	expect(screen.getByRole("combobox").textContent).toContain("可选项");
	fireEvent.click(screen.getByRole("combobox"));
	expect(screen.queryByRole("listbox")).toBeNull();
	expect(onChange).not.toHaveBeenCalled();
});

it("keeps focus on pointer press and ignores a click following a scroll gesture", () => {
	const onChange = vi.fn();
	render(<TSelect ariaLabel="Unit" value="" onChange={onChange} options={options} />);
	const trigger = screen.getByRole("combobox");
	trigger.focus();
	fireEvent.click(trigger);
	const option = screen.getByRole("option", { name: "Pixels" });
	fireEvent.pointerDown(option, { pointerId: 1, isPrimary: true, clientY: 10 });
	expect(fireEvent.mouseDown(option, { button: 0 })).toBe(false);
	fireEvent.scroll(option.parentElement as HTMLElement);
	fireEvent.pointerUp(option, { pointerId: 1, isPrimary: true, clientY: 40 });
	fireEvent.click(option, { detail: 1 });
	expect(onChange).not.toHaveBeenCalled();
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement).toBe(trigger);
});

it("keeps the active descendant valid when async options replace the open list", () => {
	const { rerender } = render(
		<TSelect value="a" options={[{ value: "a", label: "Alpha" }]} onChange={vi.fn()} />,
	);
	const trigger = screen.getByRole("combobox");
	fireEvent.click(trigger);
	rerender(
		<TSelect
			value="a"
			options={[
				{ value: "a", label: "Alpha", disabled: true },
				{ value: "b", label: "Beta" },
			]}
			onChange={vi.fn()}
		/>,
	);
	const active = document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "");
	expect(active?.textContent).toBe("Beta");
	expect(active?.getAttribute("aria-selected")).toBe("false");
});

it("distinguishes equal titles by their description in both the trigger and options", () => {
	const onChange = vi.fn();
	render(
		<TSelect
			ariaLabel="Destination"
			value="home"
			onChange={onChange}
			options={[
				{
					value: "home",
					label: "Family",
					description: "Main account",
					icon: <span data-testid="main-icon" />,
				},
				{ value: "other", label: "Family", description: "Other account" },
			]}
		/>,
	);
	expect(screen.getByRole("combobox").textContent).toContain("Main account");
	expect(screen.getAllByTestId("main-icon")).toHaveLength(1);
	fireEvent.click(screen.getByRole("combobox"));
	expect(screen.getByRole("option", { name: "Family · Main account" })).toBeTruthy();
	fireEvent.click(screen.getByRole("option", { name: "Family · Other account" }));
	expect(onChange).toHaveBeenCalledExactlyOnceWith("other");
});
