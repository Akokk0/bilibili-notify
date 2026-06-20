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
		// SectionNav 双形态(竖栏 + 横向条)→ section 标签各出现两次。
		expect(screen.getAllByText("运行日志").length).toBeGreaterThan(0);
		expect(screen.queryByText("Changelog · 独立端")).toBeNull();
	});

	it("renders changelog only after switching sections", async () => {
		renderLogs();
		fireEvent.click(screen.getAllByRole("button", { name: /更新日志/ })[0]);
		expect(await screen.findByText("Changelog · 独立端")).toBeTruthy();
		expect(screen.getAllByText("apps/CHANGELOG.md").length).toBeGreaterThan(0);
	});

	// 回归:bn-anim-fade-in 的残留 transform 不能挂在 grid 上,否则会改写内部 sticky
	// 竖栏(SectionNav 的 aside)的包含块,窄视口单列布局坍缩。见 Logs.tsx return 处注释。
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
