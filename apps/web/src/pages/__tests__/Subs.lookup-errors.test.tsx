// @vitest-environment jsdom

/**
 * 「添加 UP 主」查人失败时显示什么(ADR-0026)。
 *
 * 服务端的 `message` 本身就是给人看的中文(查无此人、B 站没就绪、搜索词为空、无法访问 B 站……
 * 各说各的),面板原样显示。从前 `formatApiError` 按状态码换成固定句子,会把服务端的原话盖掉 ——
 * 风控和未登录都被说成「未找到该 UP 主」就是这么来的(面板那一半)。
 *
 * 状态码故意配得和 message 对不上号(404 配一句限流话、503 配一句限流话):
 * 只要还有谁按状态码换句子,这里就红。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeEmptySubscription } from "../../types/domain";
import Subs from "../Subs";

const { FakeApiError } = vi.hoisted(() => {
	class FakeApiError extends Error {
		constructor(
			message: string,
			public readonly status: number,
			public readonly code: string,
		) {
			super(message);
		}
	}
	return { FakeApiError };
});

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: FakeApiError,
}));

import { api } from "../../services/api";

const BILI = {
	...makeEmptySubscription("111"),
	cachedProfile: { name: "UP甲", avatar: "", sign: "", fans: 0, lastRefreshedAt: "t" },
};

/** 让查人的那个接口回一个失败,别的接口照常。 */
function failLookupsWith(error: Error): void {
	(api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
		if (path.startsWith("/api/subs/lookup") || path.startsWith("/api/subs/search")) {
			return Promise.reject(error);
		}
		if (path.startsWith("/api/subs")) return Promise.resolve([BILI]);
		if (path === "/api/ext") return Promise.resolve({ extensions: [] });
		return Promise.resolve([]);
	});
}

beforeEach(() => {
	(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function queryFor(input: string): Promise<void> {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/subs"]}>
				<Subs />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByText("UP甲");
	await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/ext"));
	fireEvent.click(screen.getAllByText("添加")[0] as HTMLElement);
	await screen.findByText(/选定后进入配置表单/);
	fireEvent.change(screen.getByPlaceholderText("搜索 UID 或 UP 主名字"), {
		target: { value: input },
	});
	// B 站这一支:纯数字走 UID 精确查询(按钮叫「查询」),名字走搜索(「搜索」)。
	fireEvent.click(screen.getByRole("button", { name: /^\d+$/.test(input) ? "查询" : "搜索" }));
}

describe("添加 UP 主 —— 查人失败", () => {
	it("按 UID 查:服务端的话原样显示,不被 404 换成固定句子", async () => {
		failLookupsWith(new FakeApiError("B 站现在很忙，请过一会儿再查", 404, "not_found"));
		await queryFor("999");
		expect(await screen.findByText("B 站现在很忙，请过一会儿再查")).toBeTruthy();
		expect(screen.queryByText(/请检查 UID 是否正确/)).toBeNull();
	});

	it("按名字搜:服务端的话原样显示,不被 503 换成「尚未就绪」", async () => {
		failLookupsWith(new FakeApiError("无法访问 B 站：请求过于频繁", 503, "unavailable"));
		await queryFor("阿婆");
		expect(await screen.findByText("无法访问 B 站：请求过于频繁")).toBeTruthy();
		expect(screen.queryByText(/尚未就绪/)).toBeNull();
	});

	it("不是 ApiError(断线之类)也照样显示它的话", async () => {
		failLookupsWith(new Error("连接中断，GET /api/subs/lookup 没有拿到服务器响应"));
		await queryFor("999");
		expect(await screen.findByText(/连接中断/)).toBeTruthy();
	});
});
