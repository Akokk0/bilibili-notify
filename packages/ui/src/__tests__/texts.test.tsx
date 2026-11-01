// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { TColor } from "../form-controls";
import { UiTextProvider } from "../texts";

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
