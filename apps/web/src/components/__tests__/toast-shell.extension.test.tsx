// @vitest-environment jsdom
/**
 * 推送小卡上「这是谁」那行小字(ADR-0019 决策 73):B 站行照旧「UID xxx」;拓展行没有 uid,
 * 写「平台名 · 外部 id」—— 平台名照已装拓展的清单,拓展卸载了取不到就写拓展 id。
 *
 * 单开一个文件:`toast-shell.test.tsx` 里有假定时器,这里要等拓展清单回来(`findBy*`)。
 */

import type { ExtensionDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type PushEventView, useToastStore } from "../../store/notifications";
import { ToastShell } from "../toast-shell";

/** 装着的抖音订阅源 —— 平台名照它的清单。 */
const DOUYIN = {
	id: "douyin",
	name: "抖音订阅",
	dir: "/data/extensions/douyin",
	enabled: true,
	state: "running",
	apiVersion: 2,
	provides: ["subscription"],
	subscription: {
		display: { label: "抖音", shortLabel: "抖", color: "#161823" },
		events: ["post", "liveStart", "liveEnd"],
	},
} as ExtensionDTO;

const installed = vi.hoisted(() => ({ extensions: [] as unknown[] }));
const apiGet = vi.hoisted(() =>
	vi.fn(async (path: string) => {
		if (path === "/api/ext") return { extensions: installed.extensions };
		return null;
	}),
);
vi.mock("../../services/api", () => ({ api: { get: apiGet } }));

function pushView(over: Partial<PushEventView> = {}): PushEventView {
	return {
		id: "h1",
		pushId: "p1",
		ts: "2026-09-24T10:00:00.000Z",
		kind: "dynamic",
		status: "delivered",
		uid: "u1",
		subscriptionId: "s1",
		targetId: "t1",
		messages: [{ text: "一条推送", role: "main", ok: true }],
		...over,
	};
}

function extView(over: Partial<PushEventView> = {}): PushEventView {
	return pushView({ uid: undefined, extensionId: "douyin", externalId: "sec-1", ...over });
}

function renderShell() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/"]}>
				<ToastShell />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	useToastStore.getState().clear();
	installed.extensions = [DOUYIN];
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("推送小卡 · 这是谁", () => {
	it("B 站行:「UID xxx」(照旧)", () => {
		renderShell();
		act(() => useToastStore.getState().push(pushView()));
		expect(screen.getByText("UID u1")).toBeTruthy();
	});

	it("拓展行:「平台名 · 外部 id」,不印 UID", async () => {
		renderShell();
		act(() => useToastStore.getState().push(extView()));
		expect(await screen.findByText("抖音 · sec-1")).toBeTruthy();
		expect(screen.queryByText(/UID/)).toBeNull();
	});

	it("拓展卸载了(清单里没有它)→ 平台名写拓展 id", async () => {
		installed.extensions = [];
		renderShell();
		act(() => useToastStore.getState().push(extView()));
		await vi.waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/ext"));
		expect(await screen.findByText("douyin · sec-1")).toBeTruthy();
	});
});
