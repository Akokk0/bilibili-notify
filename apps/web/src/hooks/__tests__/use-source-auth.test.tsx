// @vitest-environment jsdom

/**
 * `useSourceAuth` —— 登录状态按来源键分开存在查询缓存里：
 * 各来源各取各的口（`GET /api/sources/<键>/auth`），WS 帧只改帧里那个来源。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("../../services/api", () => ({ api: { get: apiGet, post: vi.fn(), delete: vi.fn() } }));

import { applySourceAuthChanged, useSourceAuth } from "../use-source-auth";

const NOW = "2026-10-11T00:00:00.000Z";

function Probe({ sourceKey }: { sourceKey: string }) {
	const { state } = useSourceAuth(sourceKey);
	return <div data-testid={sourceKey}>{state?.status ?? "loading"}</div>;
}

function mount(node: ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
	return qc;
}

afterEach(() => {
	cleanup();
	apiGet.mockReset();
});

describe("useSourceAuth", () => {
	it("各来源各取各的口，帧只改帧里那个来源", async () => {
		apiGet.mockImplementation(async (path: string) =>
			path === "/api/sources/bilibili/auth"
				? { state: { status: "logged-out" } }
				: { state: { status: "logged-in", loggedInAt: NOW } },
		);
		const qc = mount(
			<>
				<Probe sourceKey="bilibili" />
				<Probe sourceKey="fake-source" />
			</>,
		);
		await waitFor(() => expect(screen.getByTestId("bilibili").textContent).toBe("logged-out"));
		expect(screen.getByTestId("fake-source").textContent).toBe("logged-in");
		expect(apiGet).toHaveBeenCalledWith("/api/sources/bilibili/auth");
		expect(apiGet).toHaveBeenCalledWith("/api/sources/fake-source/auth");

		// 帧到了之后失效重取会再问口子：让口子也跟着换，免得重取把帧写的又盖回去。
		apiGet.mockImplementation(async (path: string) =>
			path === "/api/sources/bilibili/auth"
				? { state: { status: "expired", message: "账号登录已失效，请重新扫码登录" } }
				: { state: { status: "logged-in", loggedInAt: NOW } },
		);
		act(() => {
			applySourceAuthChanged(qc, {
				sourceKey: "bilibili",
				state: { status: "expired", message: "账号登录已失效，请重新扫码登录" },
			});
		});
		await waitFor(() => expect(screen.getByTestId("bilibili").textContent).toBe("expired"));
		expect(screen.getByTestId("fake-source").textContent).toBe("logged-in");
	});
});
