// @vitest-environment jsdom
/**
 * 截流组的那张列表:拦下了什么、清空、清掉截流期间写进历史的行。守的是「按钮真的打到了对的口、
 * 回执真的显示出来了」,列表长什么样不守。
 */

import type { DevCapturesDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn() },
	ApiError: class ApiError extends Error {},
}));

import { api } from "../../services/api";
import { CaptureView } from "../capture-view";

const CAPTURES: DevCapturesDTO = {
	enabled: true,
	entries: [
		{
			id: "1",
			at: Date.parse("2026-09-06T08:01:02.000Z"),
			adapterId: "ad-1",
			adapterName: "家里的 NapCat",
			platform: "onebot",
			targetId: "t-1",
			targetName: "测试群",
			private: false,
			kind: "composite",
			text: "开播啦",
			images: 1,
		},
		{
			id: "2",
			at: Date.parse("2026-09-06T08:02:00.000Z"),
			adapterId: "ad-1",
			adapterName: "家里的 NapCat",
			platform: "onebot",
			targetId: "t-2",
			targetName: "主人",
			private: true,
			kind: "text",
			text: "指令回复",
			images: 0,
		},
	],
};

function renderView() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	render(
		<QueryClientProvider client={qc}>
			<CaptureView />
		</QueryClientProvider>,
	);
	return { invalidate };
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.post).mockReset();
});
afterEach(cleanup);

describe("CaptureView", () => {
	it("列出拦下的每一条:目标、适配器、文本、图数、私聊标记", async () => {
		vi.mocked(api.get).mockResolvedValue(CAPTURES);
		renderView();
		expect(await screen.findByText("开播啦")).toBeTruthy();
		expect(screen.getByText("测试群")).toBeTruthy();
		expect(screen.getAllByText("家里的 NapCat")).toHaveLength(2);
		expect(screen.getByText("指令回复")).toBeTruthy();
		expect(screen.getByText("私聊")).toBeTruthy();
		expect(screen.getByRole("img", { name: "1 张图" })).toBeTruthy();
	});

	it("关着且空 → 空态说一句怎么开", async () => {
		vi.mocked(api.get).mockResolvedValue({ enabled: false, entries: [] });
		renderView();
		expect(await screen.findByText(/截流关着/)).toBeTruthy();
	});

	it("「清空列表」打 /captures/clear", async () => {
		vi.mocked(api.get).mockResolvedValue(CAPTURES);
		vi.mocked(api.post).mockResolvedValue({ enabled: true, entries: [] });
		renderView();
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "清空列表" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/dev/captures/clear", {}));
		await waitFor(() => expect(screen.queryByText("开播啦")).toBeNull());
	});

	it("「清掉截流期间的历史行」打 purge-history,回执显示删了几行,并作废查询让历史页刷新", async () => {
		vi.mocked(api.get).mockResolvedValue(CAPTURES);
		vi.mocked(api.post).mockResolvedValue({ deleted: 3 });
		const { invalidate } = renderView();
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "清掉截流期间的历史行" }));
		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/dev/captures/purge-history", {}),
		);
		expect(await screen.findByText(/清掉了 3 行/)).toBeTruthy();
		expect(invalidate).toHaveBeenCalled();
	});
});
