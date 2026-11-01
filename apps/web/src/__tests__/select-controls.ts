import { fireEvent, within } from "@testing-library/react";
/** Drive the real public combobox; no hidden native control or synthetic change bridge. */
export function selectOptionsOf(trigger: HTMLElement): HTMLElement[] {
	if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
	const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
	if (!list) throw new Error("select list is not open");
	return within(list).getAllByRole("option");
}
export function chooseSelect(trigger: HTMLElement, label: string | RegExp): void {
	selectOptionsOf(trigger);
	const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
	if (!list) throw new Error("select list is not open");
	fireEvent.click(within(list).getByRole("option", { name: label }));
}
