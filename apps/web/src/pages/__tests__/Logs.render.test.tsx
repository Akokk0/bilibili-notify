// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Logs from "../Logs";

const { apiGetMock } = vi.hoisted(() => ({
	apiGetMock: vi.fn(async (_url: string) => ({ entries: [] })),
}));

vi.mock("../../hooks/useLogChannel", () => ({
	useLogChannel: () => undefined,
}));

vi.mock("../../services/api", () => ({
	api: {
		get: apiGetMock as unknown as (url: string) => Promise<{ entries: unknown[] }>,
	},
}));

function renderLogs() {
	const qc = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});
	return render(
		<QueryClientProvider client={qc}>
			<Logs />
		</QueryClientProvider>,
	);
}

describe("Logs page sections", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		apiGetMock.mockClear();
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("defaults to runtime logs and keeps changelog content hidden", async () => {
		renderLogs();
		expect(await screen.findByText("没有符合条件的日志")).toBeTruthy();
		expect(screen.getByText("运行日志")).toBeTruthy();
		expect(screen.queryByText("Changelog · 独立端")).toBeNull();
	});

	it("renders changelog only after switching sections", async () => {
		renderLogs();
		fireEvent.click(screen.getByRole("button", { name: /更新日志/ }));
		expect(await screen.findByText("Changelog · 独立端")).toBeTruthy();
		expect(screen.getAllByText("apps/CHANGELOG.md").length).toBeGreaterThan(0);
	});

	// 回归:bn-anim-fade-in 的残留 transform 不能挂在 grid 上,否则 sticky aside 的包含块
	// 被改写,窄视口单列布局坍缩(aside 压住内容)。见 Logs.tsx return 处注释。
	it("keeps the fade-in transform off the grid/sticky layer", () => {
		const { container } = renderLogs();
		const fade = container.querySelector(".bn-anim-fade-in");
		expect(fade).toBeTruthy();
		expect(fade?.classList.contains("grid")).toBe(false);
		const grid = fade?.querySelector(".grid");
		expect(grid).toBeTruthy();
		expect(grid?.querySelector("aside.sticky")).toBeTruthy();
	});
});
