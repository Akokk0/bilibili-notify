// @vitest-environment jsdom
/**
 * 打开面板就查一次更新 —— 不定时、不轮询,就这一次。
 *
 * 这里守的是**什么时候不该查**:功能关着(服务端也不会碰网络,但省一次请求)、
 * 排队了回退(自动检查在开着自动下载时会装新版、顺手拔钉子,等于用户开一次面板
 * 就把自己按的回退撤销了)。以及查到新版之后通知卡要出、没新版不出。
 */

import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { leaveRestartMark } from "../../components/update/restart";
import { UPDATE_QUERY_KEY } from "../../components/update/status";
import { useToastStore } from "../../store/notifications";
import { useUpdateCheckOnOpen } from "../useUpdateCheckOnOpen";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function dto(state: UpdateStatusDTO["state"]): UpdateStatusDTO {
	return { currentVersion: "0.8.0", rollbackTarget: null, pinnedVersion: null, state };
}

function Harness() {
	useUpdateCheckOnOpen();
	return null;
}

/**
 * 用 `render` 挂一个真组件,而不是 `renderHook`:实测 vitest + jsdom 下 `renderHook` 包在
 * StrictMode 里 effect 只跑**一次**,`render` 才会跑两次。前者会让「网络只能打一次」那条
 * 断言变成空跑 —— 把实现里的 fired 守卫删掉照样绿。
 */
function mount(before: UpdateStatusDTO, after: UpdateStatusDTO) {
	vi.mocked(api.get).mockResolvedValue(before);
	vi.mocked(api.post).mockResolvedValue(after);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<StrictMode>
			<QueryClientProvider client={qc}>
				<Harness />
			</QueryClientProvider>
		</StrictMode>,
	);
	return qc;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	useToastStore.getState().clear();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useUpdateCheckOnOpen", () => {
	it("有新版 → 查一次,结果写进缓存,右下角出一张带「去更新」的通知卡", async () => {
		const after = dto({
			phase: "available",
			target: "0.9.0",
			releaseUrl: "https://x",
			checkedAt: 1,
		});
		const qc = mount(dto({ phase: "idle" }), after);

		await waitFor(() => expect(useToastStore.getState().items).toHaveLength(1));

		// StrictMode 会把 effect 跑两遍 —— 网络只能打一次。(挂载方式见上面 mount 的说明,
		// 这条断言只有在 effect 真的跑了两遍时才有意义。)
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(api.post).toHaveBeenCalledTimes(1);
		expect(api.post).toHaveBeenCalledWith("/api/update/check", {});
		expect(qc.getQueryData(UPDATE_QUERY_KEY)).toEqual(after);
		const [card] = useToastStore.getState().items;
		expect(card).toMatchObject({
			kind: "notice",
			title: "有新版 0.9.0",
			action: { label: "去更新", to: "/system#update" },
		});
	});

	it("重启之后钉子还在盘上(内存态早已是 idle)→ 不自动查", async () => {
		// 回退靠重启生效,重启之后 phase 是 idle、钉子在盘上。只认 rolled-back 那个
		// 内存态的守卫,守的正是最不需要守的那个窗口:重启之前。
		mount(
			{ ...dto({ phase: "idle" }), pinnedVersion: "0.8.0" },
			dto({ phase: "up-to-date", checkedAt: 1 }),
		);

		await flush();
		await flush();

		expect(api.get).toHaveBeenCalled();
		expect(api.post).not.toHaveBeenCalled();
	});

	it("已是最新 → 查了,但不打扰", async () => {
		const after = dto({ phase: "up-to-date", checkedAt: 1 });
		const qc = mount(dto({ phase: "idle" }), after);

		await waitFor(() => expect(qc.getQueryData(UPDATE_QUERY_KEY)).toEqual(after));
		await flush();

		expect(useToastStore.getState().items).toHaveLength(0);
	});

	it("功能关着 → 连查都不查", async () => {
		mount(
			dto({ phase: "disabled", reason: "no-keys" }),
			dto({ phase: "disabled", reason: "no-keys" }),
		);

		await waitFor(() => expect(api.get).toHaveBeenCalled());
		await flush();

		expect(api.post).not.toHaveBeenCalled();
		expect(useToastStore.getState().items).toHaveLength(0);
	});

	it("排队了回退 → 不替用户做主,不查", async () => {
		mount(
			dto({ phase: "rolled-back", target: "0.7.0" }),
			dto({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" }),
		);

		await waitFor(() => expect(api.get).toHaveBeenCalled());
		await flush();

		expect(api.post).not.toHaveBeenCalled();
	});

	it("查不到(后端不通)→ 安静,壳层自有错误态", async () => {
		vi.mocked(api.get).mockRejectedValue(new Error("ECONNREFUSED"));
		const qc = new QueryClient();
		expect(() =>
			render(
				<QueryClientProvider client={qc}>
					<Harness />
				</QueryClientProvider>,
			),
		).not.toThrow();
		await flush();
		expect(useToastStore.getState().items).toHaveLength(0);
	});
});

describe("useUpdateCheckOnOpen —— 刷新回来先报重启的结果", () => {
	afterEach(() => {
		sessionStorage.clear();
	});

	function current(version: string): UpdateStatusDTO {
		return {
			currentVersion: version,
			rollbackTarget: null,
			pinnedVersion: null,
			state: { phase: "up-to-date", checkedAt: 1 },
		};
	}

	it("记号对得上现在跑的版本 → 弹「已更新到」,记号用掉;照常再查一次更新", async () => {
		leaveRestartMark({ target: "0.9.0", mode: "update" });
		mount(current("0.9.0"), current("0.9.0"));

		await waitFor(() => expect(useToastStore.getState().items).toHaveLength(1));
		expect(useToastStore.getState().items[0]).toMatchObject({
			kind: "notice",
			title: "已更新到 0.9.0",
		});
		expect(sessionStorage.getItem("bn.update.restarted")).toBeNull();
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/update/check", {}));
	});

	it("回退的记号说的是「已退回」", async () => {
		leaveRestartMark({ target: "0.7.0", mode: "rollback" });
		mount(current("0.7.0"), current("0.7.0"));

		await waitFor(() => expect(useToastStore.getState().items).toHaveLength(1));
		expect(useToastStore.getState().items[0]).toMatchObject({ title: "已退回 0.7.0" });
	});

	it("记号和现在跑的版本对不上 → 不说,记号也丢掉(那不是这次重启的结果)", async () => {
		leaveRestartMark({ target: "0.9.0", mode: "update" });
		mount(current("0.8.0"), current("0.8.0"));

		await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
		await flush();
		expect(useToastStore.getState().items).toHaveLength(0);
		expect(sessionStorage.getItem("bn.update.restarted")).toBeNull();
	});
});
