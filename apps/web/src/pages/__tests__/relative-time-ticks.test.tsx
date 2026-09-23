// @vitest-environment jsdom

/**
 * 挂在页面上一直开着的「N 分钟前」要跟着走 —— 推送历史每一行的时间、订阅卡上的「更新于」。
 * 只在渲染那一刻算一次的话,页面开着不动,它们就一直停在「刚刚」。节拍本身(共用一个、后台不走、
 * 卸载清掉)钉在 `rich-text-clock.test.tsx`;这里只钉**这两处真的接上了**。
 *
 * 🔴 这个文件用假定时器 —— 不许用 `waitFor` / `findBy*`(会死锁):查询靠推假时钟冲刷,全用 `act`。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HistoryEntryView } from "../../services/dashboard";
import { makeEmptySubscription } from "../../types/domain";
import History from "../History";
import { UpCard } from "../up/UpCard";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const T1 = "22222222-2222-4222-8222-222222222222";

function advance(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

/** 查询的回应与 react-query 的通知都挂在(假的)定时器上 —— 推几下让它们落地。 */
async function settle() {
	for (let i = 0; i < 5; i += 1) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
	}
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
	});
	vi.setSystemTime(NOW);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("挂在页面上的相对时间会走", () => {
	it("推送历史:行首的时间过了一分钟就变", async () => {
		const entry: HistoryEntryView = {
			id: "h1",
			pushId: "p1",
			ts: new Date(NOW).toISOString(),
			kind: "live",
			status: "delivered",
			uid: "u1",
			subscriptionId: "s1",
			targetId: T1,
			messages: [{ text: "开播了", role: "main", ok: true }],
			unameSnapshot: "某UP",
		};
		vi.mocked(api.get).mockImplementation(async (path: string) => {
			if (path.startsWith("/api/history")) return { entries: [entry] };
			if (path === "/api/targets") return [{ id: T1, name: "测试群", platform: "onebot" }];
			if (path === "/api/subs") return [];
			return { app: { historyRetentionDays: 30 } };
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<History />
			</QueryClientProvider>,
		);
		await settle();
		expect(screen.getByText("刚刚")).toBeTruthy();
		advance(60_000);
		expect(screen.getByText("1 分钟前")).toBeTruthy();
		expect(screen.queryByText("刚刚")).toBeNull();
	});

	it("订阅卡:「更新于」过了一分钟就变", () => {
		const sub = {
			...makeEmptySubscription("100"),
			cachedProfile: {
				name: "某UP",
				avatar: "",
				sign: "",
				fans: 1,
				lastRefreshedAt: new Date(NOW).toISOString(),
			},
		};
		render(
			<UpCard
				sub={sub}
				selected={false}
				onClick={vi.fn()}
				onToggleSelect={vi.fn()}
				onToggleEnabled={vi.fn()}
				togglePending={false}
				onRequestMenu={vi.fn()}
			/>,
		);
		expect(screen.getByText("· 更新于 刚刚")).toBeTruthy();
		advance(60_000);
		expect(screen.getByText("· 更新于 1 分钟前")).toBeTruthy();
	});
});
