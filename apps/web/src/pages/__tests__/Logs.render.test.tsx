// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
