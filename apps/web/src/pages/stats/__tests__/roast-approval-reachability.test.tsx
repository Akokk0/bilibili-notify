// @vitest-environment jsdom
/**
 * 审批开关收不收得到回复:主人目标的平台**取自它挂着的连接**,不读目标自己那一格。
 * 连接已加载但不在 → 收不到,理由说「连接已经不在了」;连接还没回来 → 收不到但不下结论。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connection, PushTarget } from "../../../types/domain";
import { useApprovalReachability } from "../RoastScheduleFields";

vi.mock("../../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../../services/api";

const T_MASTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN = "11111111-1111-4111-8111-111111111111";

/** 目标自己那格 `platform` 由调用方故意写成跟连接相反的。 */
function master(ownPlatform: string): PushTarget {
	return {
		id: T_MASTER,
		name: "主人",
		connectionId: CONN,
		scope: "private",
		enabled: true,
		kind: "session",
		platform: ownPlatform,
		address: "123",
	} as PushTarget;
}

function connection(platform: string): Connection {
	return { id: CONN, kind: "direct", platform, enabled: true } as Connection;
}

function reachability(target: PushTarget, connections: Connection[]) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/targets") return [target];
		if (path === "/api/connections") return connections;
		if (path === "/api/settings") return { master: { targetId: T_MASTER } };
		throw new Error(`unexpected GET ${path}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderHook(() => useApprovalReachability(), {
		wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
	});
}

afterEach(cleanup);

describe("useApprovalReachability · 平台取自连接", () => {
	it("主人目标挂在 OneBot 连接上 → 收得到(目标自己那格写成 feishu 也不影响)", async () => {
		const { result } = reachability(master("feishu"), [connection("onebot")]);
		await waitFor(() => expect(result.current.canApprove).toBe(true));
	});

	it("主人目标挂在 webhook 那一族的连接上 → 收不到,理由是今天那句(目标自己那格写成 onebot 也不影响)", async () => {
		const { result } = reachability(master("onebot"), [connection("feishu")]);
		await waitFor(() => expect(result.current.hint).toMatch(/webhook 只是一个出站 HTTP 请求/));
		expect(result.current.canApprove).toBe(false);
	});

	it("连接已加载但不在 → 收不到,理由是「…连接已经不在了」", async () => {
		const { result } = reachability(master("onebot"), []);
		await waitFor(() => expect(result.current.hint).toBe("主人私聊目标挂的那条连接已经不在了"));
		expect(result.current.canApprove).toBe(false);
	});
});
