// @vitest-environment jsdom

/**
 * Subs 页右键 / 长按快捷菜单的接线集成测试。验证:右键弹菜单;菜单五项各自接到
 * 正确的 api(删除走二次确认后 DELETE、禁用走 PATCH enabled、编辑分组走弹框后
 * PATCH groups、复制 UID 走剪贴板);批量删除也统一走确认框。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

vi.mock("../../utils/clipboard", () => ({
	copyToClipboard: vi.fn().mockResolvedValue(true),
}));

import { copyToClipboard } from "../../utils/clipboard";

function makeSub(uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		cachedProfile: {
			name,
			avatar: "",
			sign: "",
			fans: 0,
			lastRefreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

const SUB_A = makeSub("111", "UP甲");
const SUB_B = makeSub("222", "UP乙");

function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Subs />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/subs")) return Promise.resolve([SUB_A, SUB_B]);
		if (path.startsWith("/api/targets")) return Promise.resolve([]);
		return Promise.resolve([]);
	});
	(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue(SUB_A);
	(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Subs 快捷菜单", () => {
	it("右键卡片 → 弹出快捷菜单", async () => {
		renderSubs();
		await screen.findByText("UP甲");

		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		expect(await screen.findByText("删除订阅")).toBeTruthy();
	});

	it("菜单「删除订阅」→ 弹二次确认 → 确认后 DELETE 该订阅", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("删除订阅"));
		fireEvent.click(await screen.findByText("确认删除"));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/subs/${SUB_A.id}`));
	});

	it("菜单删除的确认框点取消 → 不删除", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
		fireEvent.click(await screen.findByText("删除订阅"));

		fireEvent.click(await screen.findByText("取消"));

		expect(api.delete).not.toHaveBeenCalled();
	});

	it("菜单「禁用订阅」→ PATCH enabled:false", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("禁用订阅"));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subs/${SUB_A.id}`, { enabled: false }),
		);
	});

	it("菜单「编辑分组」→ 弹分组框 → 新建并确定 → PATCH groups", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("编辑分组"));
		const dialog = await screen.findByRole("dialog");
		fireEvent.change(within(dialog).getByPlaceholderText("新建分组名"), {
			target: { value: "重点" },
		});
		fireEvent.click(within(dialog).getByText("添加"));
		fireEvent.click(within(dialog).getByText("确定"));

		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subs/${SUB_A.id}`, { groups: ["重点"] }),
		);
	});

	it("菜单「复制 UID」→ 调 copyToClipboard(uid) 并弹提示", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });

		fireEvent.click(await screen.findByText("复制 UID"));

		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("111"));
		expect(await screen.findByText(/已复制/)).toBeTruthy();
	});

	it("批量删除 → 弹确认框 → 确认后逐个 DELETE 选中项", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		// 勾选两张卡(点一次后该卡的选择框 aria-label 变「已选」,故每次都取当前第一个「选择」)
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);

		fireEvent.click(await screen.findByText("批量删除"));
		fireEvent.click(await screen.findByText("确认删除"));

		await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2));
	});

	it("抽屉「移除订阅」→ 弹确认框 → 确认后 DELETE", async () => {
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.click(screen.getByText("UP甲")); // 打开抽屉

		fireEvent.click(await screen.findByText("移除订阅"));
		fireEvent.click(await screen.findByText("确认删除"));

		await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/subs/${SUB_A.id}`));
	});

	it("批量禁用后 → 自动清空勾选(批量栏消失)", async () => {
		(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		renderSubs();
		await screen.findByText("UP甲");
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "选择" })[0]);
		expect(screen.getByText(/已选 2 项/)).toBeTruthy();

		fireEvent.click(screen.getByText("批量禁用"));

		await waitFor(() => expect(screen.queryByText(/已选/)).toBeNull());
	});
});
