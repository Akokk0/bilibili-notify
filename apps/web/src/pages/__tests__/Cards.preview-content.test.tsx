// @vitest-environment jsdom

/**
 * 卡片页发给服务端的 SC / 上舰预览内容(㉓e):金额叫 `amount`、上舰那一档叫 `tierKey`(档的 key,不再是 B 站的 1–3 等级)。
 * 外层的卡种键 `sc` / `guard` 不动(归 ㉔)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import type { GlobalConfig } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
	OFFLINE_STATUS: 0,
}));

import { api } from "../../services/api";

const GLOBALS = { logging: {}, master: {}, defaults: makeDefaults() } as unknown as GlobalConfig;

interface PreviewBody {
	kind: string;
	content?: Record<string, unknown>;
}

function previewBodies(kind: string): PreviewBody[] {
	return vi
		.mocked(api.post)
		.mock.calls.filter(([url]) => url === "/api/cards/preview")
		.map(([, body]) => body as PreviewBody)
		.filter((b) => b.kind === kind);
}

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<Cards />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subscriptions")) return Promise.resolve([]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		return Promise.resolve(GLOBALS);
	});
	vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("预览请求体里的 SC 金额与上舰档", () => {
	it("全家福:sc 带 amount、guard 带 tierKey(默认最低一档舰长),都不再带 price / level", async () => {
		renderCards();
		await waitFor(
			() => {
				expect(previewBodies("superchat").length).toBeGreaterThan(0);
				expect(previewBodies("membership").length).toBeGreaterThan(0);
			},
			{ timeout: 5000 },
		);
		const sc = previewBodies("superchat")[0].content ?? {};
		const guard = previewBodies("membership")[0].content ?? {};
		expect(sc.amount).toBe(30);
		expect("price" in sc).toBe(false);
		expect(guard.tierKey).toBe("captain");
		expect("level" in guard).toBe(false);
	});

	// 验红:给 Cards.tsx 的档位选项加回 `.reverse()`,这条红。
	it("单卡上舰:档位钮由低到高摆(舰长 → 提督 → 总督),与规则页同序", async () => {
		renderCards();
		await waitFor(() => expect(screen.getAllByText("上舰提醒").length).toBeGreaterThan(0), {
			timeout: 5000,
		});
		fireEvent.click(screen.getAllByText("上舰提醒")[0]);
		await screen.findByRole("button", { name: "总督" });
		const names = screen
			.getAllByRole("button")
			.map((b) => b.textContent ?? "")
			.filter((t) => ["舰长", "提督", "总督"].includes(t));
		expect(names).toEqual(["舰长", "提督", "总督"]);
	});

	it("单卡上舰:点「总督」后请求带 tierKey governor", async () => {
		renderCards();
		await waitFor(() => expect(screen.getAllByText("上舰提醒").length).toBeGreaterThan(0), {
			timeout: 5000,
		});
		fireEvent.click(screen.getAllByText("上舰提醒")[0]);
		const governor = await screen.findByRole("button", { name: "总督" });
		fireEvent.click(governor);
		await waitFor(
			() =>
				expect(previewBodies("membership").some((b) => b.content?.tierKey === "governor")).toBe(
					true,
				),
			{ timeout: 5000 },
		);
	});

	it("单卡 SC:改金额后请求带新的 amount", async () => {
		renderCards();
		await waitFor(() => expect(screen.getAllByText("SC 提醒").length).toBeGreaterThan(0), {
			timeout: 5000,
		});
		fireEvent.click(screen.getAllByText("SC 提醒")[0]);
		const input = await waitFor(() => {
			const el = document.querySelector('[data-code="amount"] input');
			if (!el) throw new Error("金额输入框还没出来");
			return el as HTMLInputElement;
		});
		fireEvent.change(input, { target: { value: "500" } });
		await waitFor(
			() => expect(previewBodies("superchat").some((b) => b.content?.amount === 500)).toBe(true),
			{
				timeout: 5000,
			},
		);
	});
});
