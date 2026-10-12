// @vitest-environment jsdom

/**
 * 密钥格 —— 已存着的显示「遮挡胶囊 + 换一份」,点了才出输入框、可以「不换了」撤回;没存着的直接是输入框。
 * `maskedOf` 的各种形状在面板那边的 `secret.test.ts` 里钉着,这里只钉交互。
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DraftSecretInput, SavedSecretControl } from "../secret-cell";

afterEach(cleanup);

describe("SavedSecretControl", () => {
	const noop = () => {};

	it("没存着:直接是输入框,没有「换一份」", () => {
		const { queryByText, getByTestId } = render(
			<SavedSecretControl
				savedMask={undefined}
				replacing={false}
				onReplace={noop}
				onCancelReplace={noop}
			>
				<input data-testid="field" />
			</SavedSecretControl>,
		);
		expect(getByTestId("field")).toBeTruthy();
		expect(queryByText("换一份")).toBeNull();
	});

	it("存着、没在换:只显示遮挡串与「换一份」,不出输入框", () => {
		const onReplace = vi.fn();
		const { getByText, queryByTestId } = render(
			<SavedSecretControl
				savedMask="sk-••••abcd"
				replacing={false}
				onReplace={onReplace}
				onCancelReplace={noop}
			>
				<input data-testid="field" />
			</SavedSecretControl>,
		);
		expect(getByText("sk-••••abcd")).toBeTruthy();
		expect(queryByTestId("field")).toBeNull();
		fireEvent.click(getByText("换一份"));
		expect(onReplace).toHaveBeenCalledTimes(1);
	});

	it("存着、在换:出输入框与「不换了」,遮挡串不显示", () => {
		const onCancelReplace = vi.fn();
		const { getByText, getByTestId, queryByText } = render(
			<SavedSecretControl
				savedMask="sk-••••abcd"
				replacing
				onReplace={noop}
				onCancelReplace={onCancelReplace}
			>
				<input data-testid="field" />
			</SavedSecretControl>,
		);
		expect(getByTestId("field")).toBeTruthy();
		expect(queryByText("sk-••••abcd")).toBeNull();
		fireEvent.click(getByText("不换了"));
		expect(onCancelReplace).toHaveBeenCalledTimes(1);
	});
});

describe("DraftSecretInput", () => {
	const saved = { masked: "sk-••••abcd" };

	it("草稿格还是下发的遮挡:点「换一份」草稿变成空串", () => {
		const onChange = vi.fn();
		const { getByText } = render(
			<DraftSecretInput value={saved} saved={saved} onChange={onChange} />,
		);
		fireEvent.click(getByText("换一份"));
		expect(onChange).toHaveBeenCalledWith("");
	});

	it("草稿格是字符串(在换):点「不换了」把基线那份遮挡原样放回去", () => {
		const onChange = vi.fn();
		const { getByText } = render(<DraftSecretInput value="" saved={saved} onChange={onChange} />);
		fireEvent.click(getByText("不换了"));
		expect(onChange).toHaveBeenCalledWith(saved);
	});

	it("基线里没存着(空串):直接是输入框", () => {
		const { queryByText, container } = render(
			<DraftSecretInput value="" saved="" onChange={() => {}} />,
		);
		expect(queryByText("换一份")).toBeNull();
		expect(queryByText("不换了")).toBeNull();
		expect(container.querySelector("input")).not.toBeNull();
	});
});
