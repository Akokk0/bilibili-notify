// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
