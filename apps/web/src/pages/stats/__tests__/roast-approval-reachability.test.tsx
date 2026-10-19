// @vitest-environment jsdom
/**
 * 审批开关收不收得到回复:看主人目标**所挂那条连接**的 `inbound` 能力,不读目标自己那一格。
 * 支持 → 能开;不支持 → 不能开,理由是能力里的原因;还不知道 → 不能开,理由说「还不知道」;
 * 连接已加载但不在 → 不能开,理由说「连接已经不在了」;连接表 / 能力表还没回来 → 不能开但不下结论。
 */

import type { ConnectionCapabilitiesMap } from "@bilibili-notify/contract";
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

/** 目标自己不带平台:平台只在连接上。 */
function master(): PushTarget {
	return {
		id: T_MASTER,
		name: "主人",
		connectionId: CONN,
		scope: "private",
		enabled: true,
		kind: "session",
		address: "123",
	} as PushTarget;
}

function connection(platform: string): Connection {
	return { id: CONN, adapterKey: platform, platform, enabled: true } as Connection;
}

const UNKNOWN = { state: "unknown" } as const;
function inboundCaps(
	inbound: ConnectionCapabilitiesMap[string]["inbound"],
): ConnectionCapabilitiesMap {
	return { [CONN]: { atAll: UNKNOWN, inbound, nativeShare: UNKNOWN } };
}
const RECEIVES = inboundCaps({ state: "supported", checkedAt: 1 });
const NO_RETURN_PATH = inboundCaps({
	state: "unsupported",
	reason: "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话",
	checkedAt: 1,
});

/** `capabilities` 省略 = 能力表这个请求永远不回来(模拟还在加载)。 */
function reachability(
	target: PushTarget,
	connections: Connection[],
	capabilities?: ConnectionCapabilitiesMap,
) {
	vi.mocked(api.get).mockImplementation(async (path: string) => {
		if (path === "/api/targets") return [target];
		if (path === "/api/connections") return connections;
		if (path === "/api/settings") return { master: { targetId: T_MASTER } };
		if (path === "/api/connections/capabilities") {
			if (capabilities === undefined) return new Promise(() => {});
			return capabilities;
		}
		throw new Error(`unexpected GET ${path}`);
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderHook(() => useApprovalReachability(), {
		wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
	});
}

afterEach(cleanup);

describe("useApprovalReachability · 看连接的 inbound 能力", () => {
	it("inbound 是「支持」→ 收得到", async () => {
		const { result } = reachability(master(), [connection("onebot")], RECEIVES);
		await waitFor(() => expect(result.current.canApprove).toBe(true));
	});

	it("inbound 是「不支持」→ 收不到,理由是能力里的原因", async () => {
		const { result } = reachability(master(), [connection("feishu")], NO_RETURN_PATH);
		await waitFor(() => expect(result.current.hint).toMatch(/webhook 只是一个出站 HTTP 请求/));
		expect(result.current.canApprove).toBe(false);
	});

	it("inbound 是「还不知道」→ 收不到,理由说「还不知道」,有原因就带括号", async () => {
		const { result } = reachability(
			master(),
			[connection("telegram")],
			inboundCaps({ state: "unknown", reason: "桥没报这一项" }),
		);
		await waitFor(() =>
			expect(result.current.hint).toBe("还不知道这条连接收不收得到主人的回复（桥没报这一项）"),
		);
		expect(result.current.canApprove).toBe(false);
	});

	it("能力表里没这条连接 → 当「还不知道」:收不到,没有括号", async () => {
		const { result } = reachability(master(), [connection("onebot")], {});
		await waitFor(() => expect(result.current.hint).toBe("还不知道这条连接收不收得到主人的回复"));
		expect(result.current.canApprove).toBe(false);
	});

	it("连接已加载但不在 → 收不到,理由是「…连接已经不在了」", async () => {
		const { result } = reachability(master(), [], RECEIVES);
		await waitFor(() => expect(result.current.hint).toBe("主人私聊目标挂的那条连接已经不在了"));
		expect(result.current.canApprove).toBe(false);
	});

	it("能力表还没回来 → 收不到但不下结论:没有理由", async () => {
		const { result } = reachability(master(), [connection("onebot")]);
		// 让目标 / 设置 / 连接表都回来(它们立即 resolve),此时只差那个永远不回的能力表。
		await new Promise((r) => setTimeout(r, 30));
		expect(vi.mocked(api.get)).toHaveBeenCalledWith("/api/connections/capabilities");
		expect(result.current).toEqual({ canApprove: false });
	});
});
