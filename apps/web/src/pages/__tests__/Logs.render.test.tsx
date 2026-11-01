// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { chooseSelect } from "../../__tests__/select-controls";
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

describe("Logs page", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		apiGetMock.mockClear();
		Element.prototype.scrollIntoView = vi.fn();
	});

	it("renders the runtime log area with an empty state", async () => {
		renderLogs();
		expect(await screen.findByText("没有符合条件的日志")).toBeTruthy();
	});

	// 更新日志已迁出到 `/about`,日志页回归纯运行日志(单栏,不再有 SectionNav)。
	it("no longer hosts the changelog (moved to /about)", async () => {
		renderLogs();
		await screen.findByText("没有符合条件的日志");
		expect(screen.queryByText("apps/CHANGELOG.md")).toBeNull();
		expect(screen.queryByText("更新日志")).toBeNull();
	});
});

it("filters sources locally and restores all sources through the empty option", async () => {
	apiGetMock.mockResolvedValueOnce({
		entries: [
			{ ts: "2026-11-01T00:00:00Z", level: "info", name: "alpha", msg: "Alpha entry" },
			{ ts: "2026-11-01T00:00:00Z", level: "info", name: "beta", msg: "Beta entry" },
		],
	} as never);
	renderLogs();
	await screen.findByText("Beta entry");
	chooseSelect(screen.getByRole("combobox"), "alpha");
	await waitFor(() => expect(screen.queryByText("Beta entry")).toBeNull());
	expect(screen.getByText("Alpha entry")).toBeTruthy();
	chooseSelect(screen.getByRole("combobox"), "全部来源");
	expect(screen.getByText("Beta entry")).toBeTruthy();
});
