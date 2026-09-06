// @vitest-environment jsdom
/**
 * DevDock —— devtools 在面板里的那一整套:探 `/api/dev`(404 = 不是开发版,整个不出现)、
 * 左下角药丸、底边面板、按 schema 画参数、跑一个、看「当前生效」、收摊。
 *
 * 这里不守观感,守的是**每一步真的打到了服务端、打的是对的东西**:参数带对了、跑完刷了
 * 所有查询(更新状态那条链路靠这一刷才动)、收摊打的是对的 id。
 */

import type { DevStatusDTO } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn() },
	ApiError: class ApiError extends Error {
		constructor(
			public readonly status: number,
			public readonly body: unknown,
			message: string,
		) {
			super(message);
		}
	},
}));

import { ApiError, api } from "../../services/api";
import { DevDock } from "../dock";

const UPDATE_STATE: DevStatusDTO["scenarios"][number] = {
	id: "update.state",
	group: "state",
	title: "更新状态",
	desc: "换掉面板看到的更新状态。",
	quick: true,
	params: [
		{
			key: "phase",
			label: "相位",
			kind: "enum",
			options: [
				{ value: "available", label: "有新版" },
				{ value: "ready", label: "已就绪" },
			],
			default: "available",
		},
		{ key: "target", label: "目标版本", kind: "text", default: "0.99.0" },
		{ key: "count", label: "条数", kind: "number", default: 6, min: 1, max: 10 },
	],
};

const STATUS: DevStatusDTO = { scenarios: [UPDATE_STATE], active: [] };

function renderDock() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(qc, "invalidateQueries");
	render(
		<QueryClientProvider client={qc}>
			<DevDock />
		</QueryClientProvider>,
	);
	return { qc, invalidate };
}

beforeEach(() => {
	vi.mocked(api.get).mockReset();
	vi.mocked(api.post).mockReset();
	window.localStorage.clear();
});
afterEach(cleanup);

describe("DevDock", () => {
	it("服务端没有 /api/dev(404)→ 什么都不渲染", async () => {
		vi.mocked(api.get).mockRejectedValue(new ApiError(404, { error: "not_found" }, "GET → 404"));
		renderDock();
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/dev"));
		expect(screen.queryByRole("button", { name: "devtools" })).toBeNull();
	});

	it("有 → 药丸出现;有注入生效时亮呼吸点、念出几项", async () => {
		vi.mocked(api.get).mockResolvedValue({
			...STATUS,
			active: [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }],
		});
		renderDock();
		expect(await screen.findByRole("button", { name: "devtools" })).toBeTruthy();
		expect(screen.getByRole("img", { name: "1 项生效" })).toBeTruthy();
	});

	it("点药丸 → 面板升起;状态组里有那张卡,改相位、跑一下 → POST 带上参数,跑完刷全部查询", async () => {
		vi.mocked(api.get).mockResolvedValue(STATUS);
		vi.mocked(api.post).mockResolvedValue({
			active: [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }],
		});
		const { invalidate } = renderDock();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "devtools" }));
		const panel = screen.getByRole("dialog", { name: "devtools" });
		expect(panel).toBeTruthy();
		// 五组都在。
		for (const name of ["事件", "状态", "定时", "截流", "前端"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
		}
		await user.click(screen.getByRole("button", { name: /^状态/ }));
		expect(screen.getByText("更新状态")).toBeTruthy();

		await user.selectOptions(screen.getByRole("combobox", { name: "相位" }), "ready");
		// 跑完会把所有查询作废,`/api/dev` 也会再拉一次 —— 服务端那时报的生效表就是注入后的。
		vi.mocked(api.get).mockResolvedValue({
			...STATUS,
			active: [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }],
		});
		await user.click(screen.getByRole("button", { name: "跑一下" }));

		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/dev/run/update.state", {
				params: { phase: "ready", target: "0.99.0", count: 6 },
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		// 「当前生效」条上出现了那一条。
		expect(await screen.findByText("更新状态 → ready 0.99.0")).toBeTruthy();
	});

	it("生效条上的 ✕ 收那一条、「全部收摊」收全部,都打对应的 reset", async () => {
		vi.mocked(api.get).mockResolvedValue({
			...STATUS,
			active: [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }],
		});
		vi.mocked(api.post).mockResolvedValue({ active: [] });
		renderDock();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "devtools" }));
		// 每一步之后 `/api/dev` 都会被重新拉一次,mock 跟着服务端该有的状态走。
		vi.mocked(api.get).mockResolvedValue(STATUS);
		await user.click(screen.getByRole("button", { name: "收掉:更新状态 → ready 0.99.0" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/dev/reset/update.state", {}));
		await waitFor(() => expect(screen.queryByText("更新状态 → ready 0.99.0")).toBeNull());

		// 再造一条(走药丸上的快捷位),生效条回来了;然后全收。
		const idle = { scenarioId: "update.state", label: "更新状态 → idle" };
		vi.mocked(api.post).mockResolvedValue({ active: [idle] });
		vi.mocked(api.get).mockResolvedValue({ ...STATUS, active: [idle] });
		await user.click(screen.getByRole("button", { name: "更新状态" }));
		expect(await screen.findByText("更新状态 → idle")).toBeTruthy();

		vi.mocked(api.post).mockResolvedValue({ active: [] });
		vi.mocked(api.get).mockResolvedValue(STATUS);
		await user.click(screen.getByRole("button", { name: "全部收摊" }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/dev/reset", {}));
		await waitFor(() => expect(screen.queryByText("更新状态 → idle")).toBeNull());
	});

	it("quick 场景在药丸上占一个快捷位,点了按默认值跑(params 为空,服务端补)", async () => {
		vi.mocked(api.get).mockResolvedValue(STATUS);
		vi.mocked(api.post).mockResolvedValue({ active: [] });
		renderDock();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "更新状态" }));
		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/dev/run/update.state", { params: {} }),
		);
	});

	it("跑失败 → 那张卡里红字说原因", async () => {
		vi.mocked(api.get).mockResolvedValue(STATUS);
		vi.mocked(api.post).mockRejectedValue(
			new ApiError(400, { err: "相位没有「x」这一档" }, "相位没有「x」这一档"),
		);
		renderDock();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "devtools" }));
		await user.click(screen.getByRole("button", { name: /^状态/ }));
		await user.click(screen.getByRole("button", { name: "跑一下" }));

		expect((await screen.findByRole("alert")).textContent).toContain("相位没有「x」这一档");
	});

	it("截流组:场景卡之外多一张拦截列表(打 /api/dev/captures)", async () => {
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/dev/captures"
				? { enabled: false, entries: [] }
				: {
						...STATUS,
						scenarios: [{ id: "push.capture", group: "capture", title: "推送截流", params: [] }],
					},
		);
		renderDock();
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "devtools" }));
		await user.click(screen.getByRole("button", { name: /^截流/ }));
		expect(screen.getByText("推送截流")).toBeTruthy();
		expect(await screen.findByText(/截流关着/)).toBeTruthy();
		expect(api.get).toHaveBeenCalledWith("/api/dev/captures");
	});

	it("面板高度记在 localStorage,下次打开还是那么高", async () => {
		window.localStorage.setItem("bn:devtools:height", "333");
		vi.mocked(api.get).mockResolvedValue(STATUS);
		renderDock();
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "devtools" }));
		expect(screen.getByRole("dialog", { name: "devtools" }).style.height).toBe("333px");
	});
});
