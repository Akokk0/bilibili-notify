// @vitest-environment jsdom
/**
 * 系统页「重启一下」一节。
 *
 * 🔴 这一节最要紧的**不是那个按钮**,而是没有按钮的时候说了什么。拉不起来的环境上把
 * 按钮藏了却不解释,与「功能坏了」长得一模一样 —— 主人 2026-09-10 报的正是这个形状:
 * 「装了拓展要求重启,可 BN 没自动重启,也没有重启按钮」。
 */

import type { SystemInfoResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { useRestartStore } from "../../update/restart";
import { RestartSection } from "../restart-section";

function serve(restart: SystemInfoResponse["restart"]) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/system") return { restart };
		// 等待期间的探活:一直是同一个进程 —— 这几条用例只看「开始等了没」。
		if (path === "/api/health") return { version: "0.10.1", startedAt: "OLD" };
		throw new Error(`没有这条 mock:${path}`);
	});
	vi.mocked(api.post).mockResolvedValue({
		restarting: true,
		startedAt: "OLD",
		version: "0.10.1",
	});
}

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<RestartSection wait={{ intervalMs: 10, timeoutMs: 50 }} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	useRestartStore.getState().dismiss();
});

afterEach(() => {
	useRestartStore.getState().dismiss();
	cleanup();
	vi.clearAllMocks();
});

describe("重启一下", () => {
	it("容器里 → 给按钮,并且把「得配 restart 策略」这句提醒写出来", async () => {
		serve({ can: true, how: "container" });
		renderSection();

		expect(await screen.findByRole("button", { name: /重启/ })).toBeTruthy();
		expect(screen.getByText(/策略/)).toBeTruthy();
	});

	/** 外壳是唯一一个**明确承诺**见退出码 0 就拉起的,所以这一档不必吓唬人。 */
	it("桌面版 → 给按钮,说外壳会把它拉回来,不提容器那句", async () => {
		serve({ can: true, how: "desktop" });
		renderSection();

		expect(await screen.findByRole("button", { name: /重启/ })).toBeTruthy();
		expect(screen.getByText(/外壳/)).toBeTruthy();
		expect(screen.queryByText(/策略/)).toBeNull();
	});

	it("按下去 → 发重启指令,然后等新进程回来", async () => {
		serve({ can: true, how: "desktop" });
		renderSection();

		await userEvent.click(await screen.findByRole("button", { name: /重启/ }));

		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/system/restart", {}));
		expect(await screen.findByText(/正在重启/)).toBeTruthy();
	});

	it("开发版 → 不给按钮,但把为什么说清楚", async () => {
		serve({ can: false, reason: "source-run" });
		renderSection();

		expect(await screen.findByText(/tsx/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /重启/ })).toBeNull();
	});

	it("没人拉的环境 → 说明白没人拉,并给出自己动手那条路", async () => {
		serve({ can: false, reason: "unsupervised" });
		renderSection();

		expect(await screen.findByText(/没人/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /重启/ })).toBeNull();
	});

	/** 服务端还没有这个口(老载荷 / 这一节没挂)—— 摆一个按不动的按钮比不摆更糟。 */
	it("问不到判据 → 整节不渲染", async () => {
		vi.mocked(api.get).mockRejectedValue(new Error("404"));
		const { container } = renderSection();

		await waitFor(() => expect(api.get).toHaveBeenCalled());
		await waitFor(() => expect(container.textContent).toBe(""));
	});
});
