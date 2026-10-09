// @vitest-environment jsdom

/**
 * 「测试连通 / 测试推送」的结果怎么显示(ADR-0026)。
 *
 * 这两个接口都是「试一次、回报结果」:照旧回 200,体是 `Result<{ latencyMs }>` ——
 * 通了带 `latencyMs`;没通带 `code` + `message`,面板读 `message` 显示(不再读 `err`)。
 * 「这个平台没有探测协议」(如 webhook)是失败那一支的 `unsupported`:既不是通、也不是不通,
 * 面板清掉进行中的状态、只提示一句,不打红叉。
 *
 * 只钉线上的形状。盘上存的 `testStatus.err`(连接卡上「上次测试失败 — …」那一句)不在这里。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connection, PushTarget } from "../../types/domain";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

const ONEBOT_ID = "11111111-1111-4111-8111-111111111111";
const WEBHOOK_ID = "33333333-3333-4333-8333-333333333333";

const ONEBOT_CONNECTION = {
	id: ONEBOT_ID,
	name: "家里那台 OneBot",
	enabled: true,
	kind: "direct",
	connector: "http",
	platform: "onebot",
	config: { transport: "http", baseUrl: "http://127.0.0.1:5700", accessToken: "" },
} as unknown as Connection;

const WEBHOOK_CONNECTION = {
	id: WEBHOOK_ID,
	name: "飞书群机器人",
	enabled: true,
	kind: "direct",
	connector: "webhook",
	platform: "feishu",
	config: { url: "https://open.feishu.cn/hook/abcdef", provider: "feishu", headers: {} },
} as unknown as Connection;

const MANAGED_TARGET = {
	id: "44444444-4444-4444-8444-444444444444",
	name: "飞书群机器人 · 投递",
	connectionId: WEBHOOK_ID,
	kind: "endpoint",
	enabled: true,
	managedBy: "connection",
	session: {},
} as unknown as PushTarget;

function renderPage(connections: Connection[], targets: PushTarget[]) {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/connections") return connections;
		if (url === "/api/targets") return targets;
		return [];
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Targets />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("测试连通(连接自己的探测)", () => {
	async function clickTest(): Promise<void> {
		fireEvent.click(await screen.findByRole("button", { name: "测试" }));
	}

	it("通了 → 「连通 · 耗时」", async () => {
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce({ ok: true, latencyMs: 12 });
		await clickTest();
		expect(await screen.findByText("连通 · 12ms")).toBeTruthy();
		expect(api.post).toHaveBeenCalledWith(`/api/connections/${ONEBOT_ID}/probe`, {});
	});

	it("没通 → 「失败:」加服务端的 message(读 message、不再读 err)", async () => {
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce({
			ok: false,
			code: "unavailable",
			message: "拒绝连接",
		});
		await clickTest();
		expect(await screen.findByText("失败:拒绝连接")).toBeTruthy();
	});

	it("这个平台没有探测协议(unsupported)→ 只提示一句,进行中的状态清掉、不打红叉", async () => {
		renderPage([ONEBOT_CONNECTION], []);
		vi.mocked(api.post).mockResolvedValueOnce({
			ok: false,
			code: "unsupported",
			message: "该平台不支持连接探测",
		});
		await clickTest();
		expect(await screen.findByText("该平台不支持连接探测")).toBeTruthy();
		// 按钮回到「测试」,不是「失败」/「测试中…」。
		expect(screen.getByRole("button", { name: "测试" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "失败" })).toBeNull();
	});
});

describe("测试推送(webhook 连接的「发送测试」)", () => {
	it("送达 → 「已送达 · 耗时」", async () => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
		vi.mocked(api.post).mockResolvedValueOnce({ ok: true, latencyMs: 34 });
		fireEvent.click(await screen.findByRole("button", { name: "发送测试" }));
		expect(await screen.findByText("已送达 · 34ms")).toBeTruthy();
		// 目标 id 在路径里,体里只剩 kind(ADR-0036)。
		expect(api.post).toHaveBeenCalledWith(`/api/targets/${MANAGED_TARGET.id}/test`, {
			kind: "text",
		});
	});

	it("没送达 → 「失败:」加服务端的 message", async () => {
		renderPage([WEBHOOK_CONNECTION], [MANAGED_TARGET]);
		vi.mocked(api.post).mockResolvedValueOnce({
			ok: false,
			code: "unavailable",
			message: "群不存在",
		});
		fireEvent.click(await screen.findByRole("button", { name: "发送测试" }));
		await waitFor(() => expect(screen.getByText("失败:群不存在")).toBeTruthy());
	});
});
