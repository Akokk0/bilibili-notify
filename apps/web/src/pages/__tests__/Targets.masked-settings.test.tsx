// @vitest-environment jsdom
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";

/**
 * 服务端下发连接时 `settings` 有三种样子(见 `ConnectionView`),面板对「整格是遮挡」「带设置问题」
 * 「探不了」各有说法:
 *
 * - 整格遮挡(适配器没在跑 / 设置不合法):编辑弹窗里**没有设置表单**、只有一句说明,保存时 PATCH
 *   **不带 `settings`**(往整格遮挡里加键再交回去,就绕过了服务端「拒收遮挡值」那道检查);列表那行小字写
 *   「设置看不了」;
 * - `settingsIssues` 非空:连接卡片上一行红字「设置不合法:原因」;
 * - `probeState.status === "unsupported"`:连接卡片上一行小字「这种连接没有探测办法」。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { snapshotFor } from "../../__tests__/platform-snapshot";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const ID = "11111111-1111-4111-8111-111111111111";

const SHELL = { id: ID, name: "家里那台", enabled: true } as const;

/** 设置不合法:服务端整格遮挡,另带逐条原因。 */
const INVALID_ONEBOT = {
	...SHELL,
	adapterKey: "onebot",
	platform: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: { masked: "••••••••" },
	settingsIssues: [{ path: ["baseUrl"], message: "必须是合法的 URL" }],
};

const WEBHOOK = {
	...SHELL,
	adapterKey: "webhook",
	platform: "feishu",
	platformSnapshot: snapshotFor("feishu"),
	settings: { url: { masked: "http••••••••=tok" }, headers: {} },
};

let connections: unknown[] = [];

beforeEach(() => {
	connections = [INVALID_ONEBOT];
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return { adapters: builtinAdapters };
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/connections") return connections;
		return [];
	});
	vi.mocked(api.patch).mockResolvedValue({});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Targets />
		</QueryClientProvider>,
	);
}

async function openEdit(): Promise<HTMLElement> {
	renderPage();
	fireEvent.click(await screen.findByRole("button", { name: "配置" }));
	await waitFor(() => screen.getByRole("dialog"));
	return screen.getByRole("dialog");
}

describe("settings 整格是遮挡", () => {
	it("编辑弹窗没有设置表单,只有一句说明", async () => {
		const dialog = await openEdit();
		expect(dialog.querySelector('[data-code^="settings."]')).toBeNull();
		expect(within(dialog).getByText(/这条连接的设置现在看不了/)).toBeTruthy();
		// 名字与开关照常能改。
		expect(within(dialog).getByDisplayValue("家里那台")).toBeTruthy();
	});

	it("只改名字保存 → PATCH 里不带 settings", async () => {
		const dialog = await openEdit();
		fireEvent.change(within(dialog).getByDisplayValue("家里那台"), {
			target: { value: "改了名" },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
		await waitFor(() => expect(api.patch).toHaveBeenCalled());
		const [url, body] = vi.mocked(api.patch).mock.calls[0] as [string, Record<string, unknown>];
		expect(url).toBe(`/api/connections/${ID}`);
		expect(body).toMatchObject({ name: "改了名" });
		expect(body).not.toHaveProperty("settings");
		expect(JSON.stringify(body)).not.toContain("masked");
	});

	it("列表那行小字写「设置看不了」,不展开成地址", async () => {
		renderPage();
		await screen.findByText(/设置看不了/);
		expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
	});
});

describe("连接卡片的设置问题", () => {
	it("settingsIssues 非空 → 一行红字「设置不合法:第一条原因」", async () => {
		renderPage();
		const line = await screen.findByText(/设置不合法/);
		expect(line.textContent).toBe("设置不合法：baseUrl：必须是合法的 URL");
		expect((line as HTMLElement).style.color).toBe("var(--color-bn-danger-text)");
	});

	it("没有 settingsIssues → 没有这行", async () => {
		connections = [WEBHOOK];
		renderPage();
		await screen.findAllByText("家里那台");
		expect(screen.queryByText(/设置不合法/)).toBeNull();
	});
});

describe("探不了的连接", () => {
	it("probeState 是 unsupported → 一行小字「这种连接没有探测办法」", async () => {
		connections = [
			{
				...WEBHOOK,
				probeState: { status: "unsupported", lastCheckedAt: "2026-10-10T00:00:00.000Z" },
			},
		];
		renderPage();
		await screen.findByText("这种连接没有探测办法");
	});

	it("没探过或探通了 → 没有这行", async () => {
		connections = [
			{
				...WEBHOOK,
				probeState: { status: "reachable", lastCheckedAt: "2026-10-10T00:00:00.000Z" },
			},
		];
		renderPage();
		await screen.findAllByText("家里那台");
		expect(screen.queryByText("这种连接没有探测办法")).toBeNull();
	});
});
