// @vitest-environment jsdom

/**
 * 拓展详情页的「上报问题」框(ADR-0019 决策 60):订阅源拓展报上来、BN 没照单全收的那几条 —— 丢了几格
 * 或整条拒了。**有问题才出现**;每行说清什么时候、哪条订阅、报的哪一种(作品按平台叫法)、丢了还是拒了、
 * 为什么。原因只写进日志的话,主人看见「卡片少了一张图」不会想到去日志里搜。
 */

import type { ExtensionDTO, ExtensionReportProblemView } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription, type Subscription } from "../../types/domain";
import ExtensionDetail from "../ExtensionDetail";

const { FakeApiError, disk } = vi.hoisted(() => {
	class FakeApiError extends Error {}
	return {
		FakeApiError,
		disk: { subs: [] as unknown[], problems: undefined as unknown[] | undefined },
	};
});

vi.mock("../../services/api", () => ({
	ApiError: FakeApiError,
	api: {
		get: vi.fn(async (url: string) => {
			if (url === "/api/subs") return disk.subs;
			if (url.endsWith("/docs")) return {};
			if (url === "/api/ext") {
				const douyin: ExtensionDTO = {
					id: "douyin",
					name: "抖音订阅",
					version: "0.1.0",
					apiVersion: 2,
					provides: ["subscription"],
					subscription: {
						display: { label: "抖音", shortLabel: "抖音", color: "#161823", postNoun: "作品" },
						events: ["post", "liveStart"],
					},
					dir: "/data/extensions/douyin",
					enabled: true,
					state: "running",
					...(disk.problems
						? { reportProblems: disk.problems as ExtensionReportProblemView[] }
						: {}),
				};
				return { extensions: [douyin] };
			}
			return {};
		}),
		patch: vi.fn(async () => ({})),
		delete: vi.fn(async () => ({ ok: true })),
	},
}));

function extSub(id: string, externalId: string, name?: string): Subscription {
	const {
		kind: _k,
		uid: _u,
		specialUsers: _s,
		followed: _f,
		followError: _e,
		...common
	} = makeEmptySubscription("0");
	return {
		...common,
		id,
		kind: "extension",
		extensionId: "douyin",
		externalId,
		cachedProfile: name
			? { name, avatar: "", sign: "", lastRefreshedAt: "2026-09-23T00:00:00.000Z" }
			: undefined,
	};
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

describe("拓展详情页:上报问题", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		disk.subs = [];
		disk.problems = undefined;
	});

	it("有问题:出一个框,每行说清哪条订阅、报的哪一种、丢了还是拒了、为什么", async () => {
		disk.subs = [extSub("s1", "sec-1", "某位 UP")];
		disk.problems = [
			{
				at: Date.now() - 5 * 60_000,
				kind: "liveStart",
				externalId: "sec-stranger",
				subscriptionIds: [],
				outcome: "rejected",
				reasons: ["清单 contributes.subscription.events 里没声明 liveStart,BN 不收这一种"],
			},
			{
				at: Date.now() - 10 * 60_000,
				kind: "post",
				externalId: "sec-1",
				subscriptionIds: ["s1"],
				outcome: "dropped",
				reasons: [
					"images[0]:只收 png / jpeg / webp / gif(按文件头认),这张都不是",
					"stats.likes:不能是负的",
				],
			},
		];
		renderDetail();

		const box = await screen.findByRole("region", { name: "上报问题" });
		const rows = within(box).getAllByRole("listitem");
		expect(rows).toHaveLength(2);

		// 新的在前:没对上订阅的那条印外部 id;开播照常叫「开播」。
		expect(within(rows[0] as HTMLElement).getByText("sec-stranger")).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText("开播")).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText("整条拒了")).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText(/没声明 liveStart/)).toBeTruthy();
		expect(within(rows[0] as HTMLElement).getByText("5 分钟前")).toBeTruthy();

		// 对上了订阅的印订阅的名字;作品按平台叫法(抖音叫「作品」);动了几格就列几句。药丸说「动了」不说
		// 「丢了」:截断(决策 59 的 09-24 🔗)也走这一种,丢了还是截了由每一句自己说。
		const second = rows[1] as HTMLElement;
		expect(await within(second).findByText("某位 UP")).toBeTruthy();
		expect(within(second).getByText("作品")).toBeTruthy();
		expect(within(second).getByText("动了 2 格")).toBeTruthy();
		expect(within(second).getByText(/images\[0\]/)).toBeTruthy();
		expect(within(second).getByText(/stats\.likes/)).toBeTruthy();
	});

	it("周期「正在直播」因为没有新状态跳过的那一轮也记在这儿(决策 61),标成跳过,不说丢了几格", async () => {
		disk.subs = [extSub("s1", "sec-1", "某位 UP")];
		disk.problems = [
			{
				at: Date.now() - 60_000,
				kind: "liveStatus",
				externalId: "sec-1",
				subscriptionIds: ["s1"],
				outcome: "skipped",
				reasons: ["上次推送之后没收到新的直播状态,这一轮周期「正在直播」没推"],
			},
		];
		renderDetail();

		const box = await screen.findByRole("region", { name: "上报问题" });
		const [row] = within(box).getAllByRole("listitem");
		expect(await within(row as HTMLElement).findByText("某位 UP")).toBeTruthy();
		expect(within(row as HTMLElement).getByText("直播状态")).toBeTruthy();
		expect(within(row as HTMLElement).getByText("跳过一轮")).toBeTruthy();
		expect(within(row as HTMLElement).queryByText(/丢了/)).toBeNull();
		expect(within(row as HTMLElement).getByText(/没收到新的直播状态/)).toBeTruthy();
	});

	it("没有问题:不出这个框", async () => {
		renderDetail();
		await screen.findByRole("button", { name: "删除拓展" });
		expect(screen.queryByRole("region", { name: "上报问题" })).toBeNull();
		expect(screen.queryByText("上报问题")).toBeNull();
	});
});
