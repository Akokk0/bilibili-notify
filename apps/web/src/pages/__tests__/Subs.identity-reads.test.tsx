// @vitest-environment jsdom

/**
 * 订阅页里「按订阅的身份读」的两处(身份 = 来源 + 来源那头的 id):
 *
 * - 搜索框按身份里的外部 id 搜:B 站就是 uid,拓展订阅没有 uid、是它的外部 id;
 * - 右键菜单「复制 UID」只 B 站订阅有 —— 复制的是身份里的外部 id。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import Subs from "../Subs";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class ApiError extends Error {},
}));

import { api } from "../../services/api";

vi.mock("../../utils/clipboard", () => ({
	copyToClipboard: vi.fn().mockResolvedValue(true),
}));

import { copyToClipboard } from "../../utils/clipboard";

const named = (sub: Subscription, name: string): Subscription => ({
	...sub,
	cachedProfile: { name, sign: "", fans: 0, lastRefreshedAt: "t" },
});

const BILI = named(makeEmptySubscription({ sourceKey: "bilibili", externalId: "111" }), "UP甲");
const EXT = named(makeEmptySubscription({ sourceKey: "douyin", externalId: "Sec-Abc" }), "抖音乙");

beforeEach(() => {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		// `/api/subscriptions/tags` 也以 `/api/subscriptions` 开头:订阅列表那条必须精确匹配,别让标签表串味进来。
		if (path === "/api/subscriptions/tags") return Promise.resolve([]);
		if (path === "/api/subscriptions") return Promise.resolve([BILI, EXT]);
		if (path === "/api/ext") return Promise.resolve({ extensions: [] });
		return Promise.resolve([]);
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function renderSubs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByText("UP甲");
}

describe("搜索框按身份里的外部 id 搜", () => {
	it("输入 B 站订阅的 uid → 只剩它;输入拓展订阅的外部 id(不分大小写)→ 只剩它", async () => {
		await renderSubs();
		const input = screen.getByPlaceholderText("搜索 UP 主名称或 UID...");

		fireEvent.change(input, { target: { value: "111" } });
		expect(screen.getByText("UP甲")).toBeTruthy();
		expect(screen.queryByText("抖音乙")).toBeNull();

		fireEvent.change(input, { target: { value: "sec-abc" } });
		expect(screen.getByText("抖音乙")).toBeTruthy();
		expect(screen.queryByText("UP甲")).toBeNull();
	});
});

describe("右键菜单「复制 UID」", () => {
	it("B 站订阅有,复制的是它的 uid", async () => {
		await renderSubs();
		fireEvent.contextMenu(screen.getByText("UP甲"), { clientX: 100, clientY: 100 });
		fireEvent.click(await screen.findByText("复制 UID"));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("111"));
	});

	it("拓展订阅没有 uid → 菜单里没有这一项(其余项照常)", async () => {
		await renderSubs();
		fireEvent.contextMenu(screen.getByText("抖音乙"), { clientX: 100, clientY: 100 });
		expect(await screen.findByText("删除订阅")).toBeTruthy();
		expect(screen.queryByText("复制 UID")).toBeNull();
	});
});
