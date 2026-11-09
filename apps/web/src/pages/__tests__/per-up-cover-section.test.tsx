// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { PerUpCoverSection } from "../Cards";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: {
		blob: vi.fn().mockRejectedValue(new Error("thumbnail unavailable in fixture")),
		get: getMock,
		post: postMock,
		upload: vi.fn(),
		delete: vi.fn(),
	},
	ApiError: class extends Error {},
}));

function renderWithQuery(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("PerUpCoverSection", () => {
	beforeEach(() => {
		i18n.set({ locale: "zh-CN", voice: "plain" });
		getMock.mockReset();
		getMock.mockResolvedValue({ ok: true, ids: [] });
	});
	afterEach(() => cleanup());

	it("无封面覆盖 → 跟随态,不渲染图廊", () => {
		renderWithQuery(<PerUpCoverSection base={["g1"]} value={undefined} onChange={() => {}} />);
		expect(screen.getByText(/跟随全局封面/)).toBeTruthy();
		expect(screen.queryByText(/上传/)).toBeNull();
	});

	it("打开覆盖开关 → 快照全局封面列表当起点", () => {
		const onChange = vi.fn();
		renderWithQuery(
			<PerUpCoverSection base={["g1", "g2"]} value={undefined} onChange={onChange} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "" }));
		expect(onChange).toHaveBeenCalledWith(["g1", "g2"]);
	});

	// 验红:把 `toggleOverride` 里关掉时的 `undefined` 换成 `[]`,这条红(关掉被存成「不用自定义封面」)。
	it("关闭覆盖开关 → 回 undefined(跟随全局),不是空列表", () => {
		const onChange = vi.fn();
		renderWithQuery(<PerUpCoverSection base={[]} value={["c1"]} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: "" }));
		expect(onChange).toHaveBeenCalledWith(undefined);
	});

	it("空列表也是「单独设置」态:不渲染成跟随", () => {
		renderWithQuery(<PerUpCoverSection base={["g1"]} value={[]} onChange={() => {}} />);
		expect(screen.queryByText(/跟随全局封面/)).toBeNull();
		expect(screen.getByText("单独设置")).toBeTruthy();
	});
});
