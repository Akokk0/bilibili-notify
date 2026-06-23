// @vitest-environment jsdom

/**
 * 高级规则页 tab 关闭确认。点 per-UP tab 的 x 关闭一个「已有覆盖项」的 UP 属于
 * 销毁性操作(清空 overrides + specialUsers),回归前会直接 PATCH 清空、静默回到
 * 全局;现在必须先弹 ConfirmDialog,取消则不动 backend,确认才真正清空。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";
import Rules from "../Rules";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const CUSTOMIZED: Subscription = {
	...makeEmptySubscription("123456"),
	overrides: { imageGroup: { enable: true, forward: false } },
};

const GLOBALS = {
	app: {},
	master: {},
	defaults: makeDefaults(),
} as unknown as GlobalConfig;

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function renderRules() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Rules />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) =>
		Promise.resolve(url.includes("/api/subs") ? [CUSTOMIZED] : GLOBALS),
	);
	vi.mocked(api.patch).mockResolvedValue(CUSTOMIZED);
});

afterEach(() => {
	cleanup();
	resetStore();
	vi.clearAllMocks();
});

describe("高级规则 tab 关闭确认", () => {
	it("点已定制 UP 的 x → 弹确认 dialog,且不立即 PATCH 清空", async () => {
		renderRules();
		const closeBtn = await screen.findByTitle(/移除 .* 的个性化配置/);
		fireEvent.click(closeBtn);

		expect(await screen.findByText("移除该 UP 的个性化配置?")).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("确认 dialog 点『取消』→ 关闭弹窗,不动 backend", async () => {
		renderRules();
		fireEvent.click(await screen.findByTitle(/移除 .* 的个性化配置/));
		fireEvent.click(await screen.findByText("移除该 UP 的个性化配置?"));
		fireEvent.click(screen.getByRole("button", { name: "取消" }));

		await waitFor(() => expect(screen.queryByText("移除该 UP 的个性化配置?")).toBeNull());
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("确认 dialog 点『移除』→ PATCH 清空 overrides + specialUsers", async () => {
		renderRules();
		fireEvent.click(await screen.findByTitle(/移除 .* 的个性化配置/));
		await screen.findByText("移除该 UP 的个性化配置?");
		fireEvent.click(screen.getByRole("button", { name: "移除" }));

		// overrides 须以清除哨兵下发(现存 slice 显式 null),否则空对象 merge 不删任何键。
		await waitFor(() =>
			expect(api.patch).toHaveBeenCalledWith(`/api/subs/${CUSTOMIZED.id}`, {
				overrides: { imageGroup: null },
				specialUsers: [],
			}),
		);
	});
});
