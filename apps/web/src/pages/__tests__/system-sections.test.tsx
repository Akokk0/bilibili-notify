// @vitest-environment jsdom
/**
 * 接线守卫:系统页上**真的有**「重启一下」那一节吗。
 *
 * 🔴 组件自己那六条全绿,证明不了它被挂进页面 —— 少 import 那一行的症状,正是主人
 * 2026-09-10 报的那句「也没有重启按钮」,而门禁一片绿。
 */

import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: {
		get: vi.fn(async (path: string) => {
			if (path === "/api/system") return { restart: { can: true, how: "container" } };
			// 更新那一节读得到状态才不会在这条用例里炸(它与重启是同一页上的邻居)。
			if (path === "/api/update")
				return {
					currentVersion: "0.10.1",
					rollbackTarget: null,
					pinnedVersion: null,
					state: { phase: "idle" },
				};
			if (path === "/api/health") return { version: "0.10.1", startedAt: "OLD" };
			// 系统页上的分区各读 globals 的一角(免扰、日志、更新、链接解析…)。手写一份
			// 迟早缺一格,而缺格的症状是**别的分区**抛,这条守卫跟着一起红 —— 用出厂值。
			if (path === "/api/globals") return makeDefaultGlobalConfig();
			// 列表口一律给空表:形状是数组的那几条,给 `{}` 会在别的分区里炸。
			if (
				path === "/api/targets" ||
				path === "/api/subs" ||
				path === "/api/commands" ||
				path === "/api/connections" ||
				path === "/api/skins" ||
				path === "/api/ext"
			)
				return [];
			return {};
		}),
		post: vi.fn(async () => ({})),
		patch: vi.fn(async () => ({})),
		del: vi.fn(async () => ({})),
	},
	ApiError: class extends Error {},
}));

import System from "../System";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("系统页的分区", () => {
	it("挂着「重启一下」那一节", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<MemoryRouter initialEntries={["/system"]}>
				<QueryClientProvider client={qc}>
					<System />
				</QueryClientProvider>
			</MemoryRouter>,
		);
		expect(await screen.findByRole("button", { name: /重启 BN/ })).toBeTruthy();
	});
});
