// @vitest-environment jsdom
/**
 * DevDock —— devtools 在面板里的那一整套:探 `/api/dev`(404 = 不是开发版,整个不出现)、
 * 左下角药丸、底边面板、按 schema 画参数、跑一个、看「当前生效」、收摊。
 *
 * 这里不守观感,守的是**每一步真的打到了服务端、打的是对的东西**:参数带对了、跑完刷了
 * 所有查询(更新状态那条链路靠这一刷才动)、收摊打的是对的 id。
 */

import type { DevStatusDTO, UpdateStatusDTO } from "@bilibili-notify/contract";
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
import { useToastStore } from "../../store/notifications";
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

/** 开发版上 `/api/update` 报的形状,`state` 是注入进去的那份。 */
function dto(state: UpdateStatusDTO["state"]): UpdateStatusDTO {
	return { currentVersion: "0.0.0-dev", rollbackTarget: null, pinnedVersion: null, state };
}

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
		const ready = dto({ phase: "ready", target: "0.99.0", releaseUrl: "https://example.invalid" });
		vi.mocked(api.get).mockResolvedValue(STATUS);
		vi.mocked(api.post).mockImplementation(async (path: string) =>
			path === "/api/update/check"
				? ready
				: { active: [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }] },
		);
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
		// 跑完会把所有查询作废,`/api/dev` 也会再拉一次 —— 服务端那时报的生效表就是注入后的;
		// 跟着补做的那次更新检查拉的是 `/api/update`,给它一份注入后的状态。
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/update"
				? ready
				: { ...STATUS, active: [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }] },
		);
		await user.click(screen.getByRole("button", { name: "跑一下" }));

		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/dev/run/update.state", {
				params: { phase: "ready", target: "0.99.0", count: 6 },
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		// 「当前生效」条上出现了那一条;没有红字。
		expect(await screen.findByText("更新状态 → ready 0.99.0")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
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

	it("quick 场景在药丸上占一个快捷位,点了按默认值跑(params 为空,服务端补);图标按声明取", async () => {
		vi.mocked(api.get).mockResolvedValue({
			...STATUS,
			scenarios: [{ ...UPDATE_STATE, icon: "download" }],
		});
		vi.mocked(api.post).mockResolvedValue({ active: [] });
		renderDock();
		const user = userEvent.setup();

		const slot = await screen.findByRole("button", { name: "更新状态" });
		// 声明了 icon 就画那一枚(download 是一条带箭头的路径),而不是分组的滑杆。
		expect(slot.querySelector("svg path")?.getAttribute("d")).toMatch(/^M12 3v11/);
		await user.click(slot);
		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/dev/run/update.state", { params: {} }),
		);
	});

	it("导览卡张开时药丸抬到它上面 —— 导览卡层级高得多,不让开就整个被盖住点不到", async () => {
		// 「新手指引停在第几步」那个场景要求导览开着,而导览卡和药丸都钉在左下角。
		const card = document.createElement("div");
		card.className = "bn-tour-card";
		card.setAttribute("data-shown", "false");
		card.getBoundingClientRect = () => ({ height: 200 }) as DOMRect;
		document.body.append(card);

		vi.mocked(api.get).mockResolvedValue(STATUS);
		renderDock();
		await screen.findByRole("button", { name: "devtools" });
		const pill = document.querySelector("[data-dock-pill]") as HTMLElement;
		expect(pill.style.bottom).toBe("");

		card.setAttribute("data-shown", "true");
		await waitFor(() => expect(pill.style.bottom).toBe("208px"));

		card.remove();
	});

	it("有注入生效时轮的是 /api/dev/active,不是整张场景表那份 /api/dev", async () => {
		// 场景表十几 KB 且静态;生效表几十字节且会变。按秒重发前者只是在搬同样的字节。
		const active = [{ scenarioId: "update.state", label: "更新状态 → ready 0.99.0" }];
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/dev/active" ? { active } : { ...STATUS, active },
		);
		renderDock();
		await screen.findByRole("button", { name: "devtools" });
		await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/dev/active"));
		// 场景表只拉了那一次。
		expect(vi.mocked(api.get).mock.calls.filter(([p]) => p === "/api/dev")).toHaveLength(1);
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

	it("跑「更新状态」→ 当场重放打开面板那次自动检查,右下角出「有新版」卡,不用刷新页面", async () => {
		const injected = dto({
			phase: "available",
			target: "0.99.0",
			releaseUrl: "https://example.invalid/v0.99.0",
			checkedAt: 1,
			notes: "devtools 造的一版",
		});
		const active = [{ scenarioId: "update.state", label: "更新状态 → available 0.99.0" }];
		vi.mocked(api.get).mockImplementation(async (path: string) =>
			path === "/api/update" ? injected : { ...STATUS, active },
		);
		vi.mocked(api.post).mockImplementation(async (path: string) =>
			path === "/api/update/check" ? injected : { active },
		);
		useToastStore.getState().clear();
		renderDock();
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "更新状态" }));
		// 走的是打开面板那条路本身:先拉状态、再 POST check、再判有没有新版 —— 不另造一条发卡的路。
		await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/update/check", {}));
		await waitFor(() =>
			expect(useToastStore.getState().items).toContainEqual(
				expect.objectContaining({
					kind: "notice",
					id: "update:0.99.0",
					title: "有新版 0.99.0",
					body: "devtools 造的一版\n到系统页下载;什么时候重启换版本由你按。",
				}),
			),
		);
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

	it("sub / target / adapter 三种字段是真选择器:选项来自站内列表,留空 = 服务端默认", async () => {
		vi.mocked(api.get).mockImplementation(async (path: string) => {
			switch (path) {
				case "/api/subs":
					return [
						{ id: "s1", uid: "100", enabled: true, cachedProfile: { name: "甲" } },
						{ id: "s2", uid: "200", enabled: false, name: "乙别名" },
					];
				case "/api/targets":
					return [{ id: "t1", name: "测试群", enabled: true }];
				case "/api/adapters":
					return [{ id: "a1", name: "家里的 NapCat", enabled: true }];
				default:
					return {
						...STATUS,
						scenarios: [
							{
								id: "live.start",
								group: "event",
								title: "开播",
								params: [
									{ key: "sub", label: "订阅", kind: "sub" },
									{ key: "target", label: "目标", kind: "target" },
									{ key: "adapter", label: "适配器", kind: "adapter" },
								],
							},
						],
					};
			}
		});
		vi.mocked(api.post).mockResolvedValue({ active: [] });
		renderDock();
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "devtools" }));
		await user.click(screen.getByRole("button", { name: /^事件/ }));

		const sub = (await screen.findByRole("combobox", { name: "订阅" })) as HTMLSelectElement;
		await waitFor(() => expect(sub.options.length).toBe(3));
		expect([...sub.options].map((o) => o.textContent)).toEqual([
			"（服务端默认）",
			"甲 · 100",
			"乙别名 · 200（停用）",
		]);
		expect(
			[
				...((await screen.findByRole("combobox", { name: "目标" })) as HTMLSelectElement).options,
			].map((o) => o.textContent),
		).toEqual(["（服务端默认）", "测试群"]);
		expect(
			[
				...((await screen.findByRole("combobox", { name: "适配器" })) as HTMLSelectElement).options,
			].map((o) => o.textContent),
		).toEqual(["（服务端默认）", "家里的 NapCat"]);

		// 留空全部不带;选了才带。
		await user.click(screen.getByRole("button", { name: "跑一下" }));
		await waitFor(() =>
			expect(api.post).toHaveBeenCalledWith("/api/dev/run/live.start", { params: {} }),
		);
		await user.selectOptions(sub, "s1");
		await user.click(screen.getByRole("button", { name: "跑一下" }));
		await waitFor(() =>
			expect(api.post).toHaveBeenLastCalledWith("/api/dev/run/live.start", {
				params: { sub: "s1" },
			}),
		);
	});

	it("前端半边的场景:在「前端」组里跑,不打服务端;生效条能看见,✕ 就地收摊", async () => {
		vi.mocked(api.get).mockResolvedValue(STATUS);
		let on = false;
		const reset = vi.fn(() => {
			on = false;
		});
		const web = [
			{
				id: "web.fake",
				group: "web" as const,
				title: "假的前端场景",
				params: [],
				run: () => {
					on = true;
					return "跑了";
				},
				active: () => (on ? { scenarioId: "web.fake", label: "前端 → 假的" } : null),
				reset,
			},
		];
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<DevDock webScenarios={web} />
			</QueryClientProvider>,
		);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "devtools" }));
		await user.click(screen.getByRole("button", { name: /^前端/ }));
		await user.click(screen.getByRole("button", { name: "跑一下" }));

		expect(await screen.findByText("跑了")).toBeTruthy();
		expect(screen.getByText("前端 → 假的")).toBeTruthy();
		expect(api.post).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "收掉:前端 → 假的" }));
		expect(reset).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByText("前端 → 假的")).toBeNull());
		expect(api.post).not.toHaveBeenCalled();
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
