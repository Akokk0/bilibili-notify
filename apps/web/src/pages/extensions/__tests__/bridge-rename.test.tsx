// @vitest-environment jsdom
/**
 * 接入的**改名**。
 *
 * 🔴 名字是接入卡上唯一能认出「这条是给谁的」的东西(token 是乱码、地址两条一模一样),
 * 而它此前**只在新建那一刻能填**:填错了只能删掉重配,而重配意味着换 token、对面那个
 * 插件也要跟着改一次。
 */

import type { Connection } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";
import { BridgeConnections } from "../bridge-panel";

const LINK = {
	id: "c1",
	name: "koishi 那台",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: "t0ken", bridgeKind: "koishi" },
} as unknown as Connection;

function renderPanel() {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/connections") return [LINK];
		throw new Error("没有状态"); // 拓展没跑 —— 这一页照样要能改接入
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<BridgeConnections extensionId="bridge" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.mocked(api.patch).mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("接入改名", () => {
	it("点一下改名 → 输入框里是现在的名字,存下去只发 name 那一格", async () => {
		renderPanel();
		await userEvent.click(await screen.findByRole("button", { name: /改名/ }));

		const input = await screen.findByRole("textbox", { name: /名字/ });
		expect((input as HTMLInputElement).value).toBe("koishi 那台");
		await userEvent.clear(input);
		await userEvent.type(input, "家里那台");
		await userEvent.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() =>
			// 🔴 只发自己那一格:整条连接发出去的话,config 里的 token 会被这一发按回旧值。
			expect(api.patch).toHaveBeenCalledWith("/api/connections/c1", { name: "家里那台" }),
		);
	});

	it("取消 → 什么都不发,名字还是原来那个", async () => {
		renderPanel();
		await userEvent.click(await screen.findByRole("button", { name: /改名/ }));
		await userEvent.type(await screen.findByRole("textbox", { name: /名字/ }), "乱改");
		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(api.patch).not.toHaveBeenCalled();
		expect(await screen.findByText("koishi 那台")).toBeTruthy();
	});

	/** 空名字 = 这张卡上什么都不剩,那比改错更糟。 */
	it("清空之后按保存 → 不发,当作没改", async () => {
		renderPanel();
		await userEvent.click(await screen.findByRole("button", { name: /改名/ }));
		const input = await screen.findByRole("textbox", { name: /名字/ });
		await userEvent.clear(input);
		await userEvent.click(screen.getByRole("button", { name: "保存" }));

		expect(api.patch).not.toHaveBeenCalled();
	});
});
