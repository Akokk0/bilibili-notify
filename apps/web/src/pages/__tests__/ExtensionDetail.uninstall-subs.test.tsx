// @vitest-environment jsdom

/**
 * 卸订阅源拓展之前,确认框说清它名下的订阅怎么办(ADR-0019 决策 10):订阅**保留**、暂停,装回来
 * 自动恢复 —— 不说的话,主人会以为卸掉拓展就把那些订阅一起删了,或者反过来以为它们还在推。
 * 名下一条都没有时不多这一句。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../services/api";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import ExtensionDetail from "../ExtensionDetail";

const { FakeApiError, disk } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return { FakeApiError, disk: { subs: [] as unknown[] } };
});

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/subs") return disk.subs;
			if (url.endsWith("/docs")) return {};
			if (url === "/api/ext") {
				return {
					extensions: [
						{
							id: "douyin",
							name: "抖音订阅",
							version: "0.1.0",
							apiVersion: 2,
							provides: ["subscription"],
							subscription: {
								display: { label: "抖音", shortLabel: "抖音", color: "#161823" },
								events: ["post"],
							},
							dir: "/data/extensions/douyin",
							enabled: false,
							state: "disabled",
						},
					],
				};
			}
			return {};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

function extSub(extensionId: string, externalId: string): Subscription {
	const {
		kind: _k,
		uid: _u,
		specialUsers: _s,
		followed: _f,
		followError: _e,
		...common
	} = makeEmptySubscription("0");
	return { ...common, kind: "extension", extensionId, externalId };
}

function renderDetail() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<MemoryRouter initialEntries={["/extensions/douyin"]}>
			<QueryClientProvider client={qc}>
				<Routes>
					<Route path="/extensions/:id" element={<ExtensionDetail />} />
				</Routes>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("卸订阅源拓展:名下的订阅", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		disk.subs = [];
	});

	it("名下有 2 条 → 确认框写「有 2 条订阅会保留(暂停)」;别人名下的、B 站的不算", async () => {
		disk.subs = [
			extSub("douyin", "a"),
			extSub("douyin", "b"),
			extSub("kuaishou", "c"),
			makeEmptySubscription("123"),
		];
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));

		expect(await screen.findByText("有 2 条订阅会保留(暂停)")).toBeTruthy();
	});

	it("名下一条都没有 → 不多这一句", async () => {
		disk.subs = [extSub("kuaishou", "c"), makeEmptySubscription("123")];
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "删除拓展" }));
		await screen.findByText(/删掉它的设置也会一起没/);
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/subs"));
		// 让订阅表那一发落地、框重画一次,再看。
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(screen.queryByText(/条订阅会保留/)).toBeNull();
	});
});
