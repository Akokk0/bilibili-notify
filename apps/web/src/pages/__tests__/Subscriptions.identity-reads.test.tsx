// @vitest-environment jsdom

/**
 * 订阅页里「按订阅的身份读」的两处(身份 = 来源 + 来源那头的 id):
 *
 * - 搜索框按身份里的外部 id 搜:B 站就是 uid,拓展订阅没有 uid、是它的外部 id;
 * - 右键菜单「复制 UID」只 B 站订阅有 —— 复制的是身份里的外部 id。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import { makeSource } from "../rules/__tests__/fixtures";
import Subscriptions from "../Subscriptions";

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
	cachedProfile: { name, followers: 0, refreshedAt: "t" },
});

const BILI = named(makeEmptySubscription({ sourceKey: "bilibili", externalId: "111" }), "UP甲");
const EXT = named(makeEmptySubscription({ sourceKey: "douyin", externalId: "Sec-Abc" }), "抖音乙");

let problems: unknown[] = [];
beforeEach(() => {
	problems = [];
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		// `/api/subscriptions/tags` 也以 `/api/subscriptions` 开头:订阅列表那条必须精确匹配,别让标签表串味进来。
		if (path === "/api/problems") return Promise.resolve({ problems });
		if (path === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
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
				<Subscriptions />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByText("UP甲");
}

describe("搜索框按身份里的外部 id 搜", () => {
	it("来源刷新后当前搜索使用最新来源叫法", async () => {
		const sub = makeEmptySubscription({ sourceKey: "library", externalId: "0007" });
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/subscriptions") return [sub];
			if (path === "/api/sources")
				return {
					sources: [
						makeSource({
							key: "library",
							descriptor: { label: "Old source", supportedFeatures: ["post"] },
						}),
					],
				};
			return [];
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MemoryRouter>
					<Subscriptions />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		await screen.findAllByText("Old source · 0007");
		fireEvent.change(screen.getByPlaceholderText("搜索订阅的名字或 id…"), {
			target: { value: "New source" },
		});
		expect(screen.queryByText("Old source · 0007")).toBeNull();
		act(() =>
			qc.setQueryData(["sources"], {
				sources: [
					makeSource({
						key: "library",
						descriptor: { label: "New source", supportedFeatures: ["post"] },
					}),
				],
			}),
		);
		expect((await screen.findAllByText("New source · 0007")).length).toBeGreaterThan(0);
		expect(api.patch).not.toHaveBeenCalled();
	});
	it("输入 B 站订阅的 uid → 只剩它;输入拓展订阅的外部 id(不分大小写)→ 只剩它", async () => {
		await renderSubs();
		const input = screen.getByPlaceholderText("搜索订阅的名字或 id…");

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
		expect(api.patch).not.toHaveBeenCalled();
	});

	it("未知来源也复制原始外部 id，保留前导零且不保存订阅", async () => {
		const sub = named(
			makeEmptySubscription({ sourceKey: "retired", externalId: "0012" }),
			"遗留订阅",
		);
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/subscriptions") return [BILI, sub];
			if (path === "/api/sources") return { sources: [makeSource()] };
			return [];
		});
		await renderSubs();
		fireEvent.contextMenu(screen.getByText("遗留订阅"), { clientX: 100, clientY: 100 });
		fireEvent.click(await screen.findByText("复制 ID"));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("0012"));
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	});

	it("非 B 来源使用自己的 ID 叫法，复制失败显示提示而不保存", async () => {
		const sub = named(makeEmptySubscription({ sourceKey: "library", externalId: "0007" }), "读者");
		vi.mocked(copyToClipboard).mockResolvedValueOnce(false);
		vi.mocked(api.get).mockImplementation(async (path) => {
			if (path === "/api/subscriptions") return [BILI, sub];
			if (path === "/api/sources")
				return {
					sources: [
						makeSource({
							key: "library",
							descriptor: {
								label: "Library",
								externalIdNoun: "Account",
								supportedFeatures: ["post"],
							},
						}),
					],
				};
			return [];
		});
		await renderSubs();
		fireEvent.contextMenu(screen.getByText("读者"), { clientX: 100, clientY: 100 });
		fireEvent.click(await screen.findByText("复制 Account"));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("0007"));
		expect(await screen.findByText(/复制失败/)).toBeTruthy();
		expect(api.patch).not.toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	});
});

it("shows the isolated-subscription count message without changing or hiding valid subscriptions", async () => {
	problems = [
		{
			reporter: "core",
			code: "subscriptions_invalid",
			message: "2 isolated subscriptions; fix the file and restart",
			since: "2026-11-03T00:00:00Z",
		},
	];
	await renderSubs();
	expect(
		await screen.findByText("2 isolated subscriptions; fix the file and restart"),
	).toBeTruthy();
	expect(screen.getByText("抖音乙")).toBeTruthy();
	expect(api.patch).not.toHaveBeenCalled();
	expect(api.post).not.toHaveBeenCalled();
});
