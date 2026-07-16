// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PerUpCoverSection } from "../Cards";

const { getMock, postMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	postMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
	api: { get: getMock, post: postMock, upload: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

function renderWithQuery(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("PerUpCoverSection", () => {
	beforeEach(() => {
		getMock.mockReset();
		getMock.mockResolvedValue({ ok: true, ids: [] });
	});
	afterEach(() => cleanup());

	it("无封面覆盖 → 跟随态,不渲染图廊", () => {
		renderWithQuery(<PerUpCoverSection base={["g1"]} value={undefined} onChange={() => {}} />);
		expect(screen.getByText(/跟随全局封面/)).toBeTruthy();
		expect(screen.queryByText(/上传/)).toBeNull();
	});

	it("打开覆盖开关 → 快照全局封面列表,并保留 partial 里已有的颜色键", () => {
		const onChange = vi.fn();
		renderWithQuery(
			<PerUpCoverSection
				base={["g1", "g2"]}
				value={{ cardColorStart: "#f00" }}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(onChange).toHaveBeenCalledWith({
			cardColorStart: "#f00",
			liveCoverImages: ["g1", "g2"],
		});
	});

	it("关闭覆盖开关 → 只剥封面键;还剩颜色键则保留,否则清空为 undefined", () => {
		const onChange = vi.fn();
		const { unmount } = renderWithQuery(
			<PerUpCoverSection
				base={[]}
				value={{ cardColorStart: "#f00", liveCoverImages: ["c1"] }}
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(onChange).toHaveBeenCalledWith({ cardColorStart: "#f00" });
		unmount();

		const onChange2 = vi.fn();
		renderWithQuery(
			<PerUpCoverSection base={[]} value={{ liveCoverImages: ["c1"] }} onChange={onChange2} />,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(onChange2).toHaveBeenCalledWith(undefined);
	});
});
