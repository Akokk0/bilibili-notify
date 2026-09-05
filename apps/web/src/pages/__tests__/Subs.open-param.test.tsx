// @vitest-environment jsdom
/**
 * `/subs?open=<订阅 id>` 直达:打开那位 UP 的抽屉并滚到「推送目标」一节 —— 无目标小卡上的
 * 「去配置」就跳到这儿。悬空 id 忽略;参数用完即清,刷新不会再弹一次。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function makeSub(uid: string, name: string): Subscription {
	return {
		...makeEmptySubscription(uid),
		cachedProfile: {
			name,
			avatar: "",
			sign: "",
			fans: 0,
			lastRefreshedAt: "1970-01-01T00:00:00.000Z",
		},
	};
}

const SUB_A = makeSub("111", "UP甲");
const SUB_B = makeSub("222", "UP乙");

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderAt(path: string) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route
						path="/subs"
						element={
							<>
								<Subs />
								<LocationProbe />
							</>
						}
					/>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

let scrolled: Element[];

beforeEach(() => {
	scrolled = [];
	Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
		scrolled.push(this);
	};
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/subs")) return Promise.resolve([SUB_A, SUB_B]);
		return Promise.resolve([]);
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Subs · ?open= 直达", () => {
	it("open 指向某订阅 → 抽屉打开、滚到「推送目标」;参数随即清掉", async () => {
		renderAt(`/subs?open=${SUB_A.id}`);
		const header = await screen.findByText("推送目标", { selector: "section *" });
		await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
		expect(scrolled[0]?.contains(header)).toBe(true);
		await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/subs"));
	});

	it("悬空 id → 忽略,不开抽屉", async () => {
		renderAt("/subs?open=nope");
		await screen.findByText("UP甲");
		expect(screen.queryByText("推送目标", { selector: "section *" })).toBeNull();
		expect(scrolled).toHaveLength(0);
	});
});
