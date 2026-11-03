// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { ConfirmDialog } from "../dialog";
import { TColor } from "../form-controls";
import { UiTextProvider } from "../texts";
import { TriStateChip } from "../tri-state";

afterEach(cleanup);
it("updates mounted form controls when the supplied translator changes", () => {
	const { rerender } = render(
		<UiTextProvider t={() => "Picker"}>
			<TColor value="#ffffff" onChange={() => {}} ariaLabel="Color" />
		</UiTextProvider>,
	);
	expect(screen.queryByLabelText("Picker")).not.toBeNull();
	const input = screen.getByLabelText("Color");
	rerender(
		<UiTextProvider t={() => "Changed picker"}>
			<TColor value="#ffffff" onChange={() => {}} ariaLabel="Color" />
		</UiTextProvider>,
	);
	expect(screen.getByLabelText("Color")).toBe(input);
	expect(screen.queryByLabelText("Changed picker")).not.toBeNull();
});

it("updates mounted shared dialog defaults and capability labels through the existing provider", () => {
	const tree = (word: string) => (
		<UiTextProvider t={() => word}>
			<ConfirmDialog
				title="Confirm action"
				message="Body"
				onConfirm={() => {}}
				onCancel={() => {}}
			/>
			<TriStateChip label="Images" state="unknown" />
		</UiTextProvider>
	);
	const { rerender } = render(tree("First"));
	expect(screen.queryAllByRole("button", { name: "First" })).toHaveLength(3);
	expect(screen.queryByTitle("Images:First")).not.toBeNull();
	rerender(tree("Second"));
	expect(screen.queryAllByRole("button", { name: "Second" })).toHaveLength(3);
	expect(screen.queryByTitle("Images:Second")).not.toBeNull();
});
