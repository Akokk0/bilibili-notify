// @vitest-environment jsdom
import type {
	HealthDetailsResponse,
	HealthResponse,
	SystemNotice,
} from "@bilibili-notify/contract";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vite-plus/test";
import App from "../App";
import { browser, useRestartStore } from "../components/update/restart";
import { i18n } from "../i18n";
import { setWsEnabled } from "../services/wsSingleton";
import { useAlertStore } from "../store/alerts";
import { useSessionStore } from "../store/session";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => {
	cleanup();
	useRestartStore.getState().dismiss();
	vi.restoreAllMocks();
	useAlertStore.getState().clear();
	setWsEnabled(false);
	qc.clear();
	qc.setQueryDefaults(["health"], { staleTime: 0 });
	qc.setQueryDefaults(["subscription-tags"], { staleTime: 0 });
	useSessionStore.setState({ hydrated: false, authRequired: false, authed: false, expired: false });
	vi.unstubAllGlobals();
});
const runningDetails: HealthDetailsResponse = {
	phase: "running",
	core: { items: [], problemCount: 0 },
	integrations: [],
	identityDuplicates: [],
	problemCount: 0,
	moduleVersions: {
		storage: "test",
		subscription: "test",
		push: "test",
		image: "test",
		ai: "test",
	},
	modules: { dynamic: false, live: false, image: false, ai: false },
	configScopes: {
		globals: { exists: false, lastUpdatedAt: null },
		subscriptions: { exists: false, lastUpdatedAt: null, count: 0 },
		targets: { exists: false, lastUpdatedAt: null, count: 0 },
	},
};
function mountApp(
	options: {
		details?: () => HealthDetailsResponse | Promise<HealthDetailsResponse>;
		path?: string;
		health?: () => HealthResponse | Promise<HealthResponse>;
		notices?: () => SystemNotice[] | Promise<SystemNotice[]>;
		request?: (path: string, init?: RequestInit) => Promise<Response | undefined>;
		session?: { authRequired: boolean; authed: boolean };
	} = {},
) {
	const core = { ...makeDefaultGlobalConfig(), locale: "zh-CN", voice: "plain" };
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.stubGlobal(
		"WebSocket",
		class extends EventTarget {
			static OPEN = 1;
			static CLOSED = 3;
			readyState = 0;
			send() {}
			close() {
				this.readyState = 3;
			}
		},
	);
	vi.stubGlobal("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const path = String(input);
			const overridden = await options.request?.(path, init);
			if (overridden) return overridden;
			let data: unknown = {};
			if (path === "/api/system/notices") data = { notices: await (options.notices?.() ?? []) };
			else if (path === "/api/session")
				data = options.session ?? { authRequired: false, authed: false };
			else if (path === "/api/health/details") data = await (options.details?.() ?? runningDetails);
			else if (path === "/api/settings") data = { core };
			else if (path === "/api/health")
				data = await (options.health?.() ?? {
					status: "ok",
					version: "test",
					startedAt: "2026-11-01T00:00:00Z",
					uptime: 0,
				});
			else if (path === "/api/system/update")
				data = { currentVersion: "0.0.0-dev", pinnedVersion: null, state: { phase: "disabled" } };
			else if (path === "/api/subscriptions/tags") data = [];
			else if (path === "/api/adapters") data = { adapters: [] };
			else if (path === "/api/dashboard/skins/active")
				data = { active: { light: null, dark: null } };
			else if (path === "/api/accounts") data = { accounts: [] };
			else if (path === "/api/sources") data = { sources: [] };
			else if (path === "/api/problems")
				data = {
					problems: [
						{
							reporter: "core",
							code: "test_problem",
							message: "持续问题",
							since: "2026-11-02T00:00:00Z",
						},
					],
				};
			else if (path === "/api/ext") data = { extensions: [] };
			else if (
				path === "/api/subscriptions" ||
				path === "/api/targets" ||
				path === "/api/connections"
			)
				data = [];
			else if (path === "/api/dev/active") data = { active: [] };
			else if (path === "/api/dev") data = { scenarios: [], active: [] };
			else if (path === "/api/ws/ticket") data = { ticket: null };
			return new Response(JSON.stringify(data), {
				headers: { "content-type": "application/json" },
			});
		}),
	);
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[options.path ?? "/rules"]}>
				<App />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}
it("the authenticated App propagates voice changes to a mounted library form", async () => {
	mountApp();
	const buttons = await screen.findAllByRole("button", { name: /添加一行/ });
	const control = buttons[0];
	expect(control.textContent).not.toContain("主人");
	act(() => i18n.set({ voice: "maid" }));
	expect(control.isConnected).toBe(true);
	expect(control.textContent).toContain("主人");
});

it("推送链路错误分类、关闭及清空不删除持续问题，未知来源保留原source", async () => {
	mountApp();
	await screen.findByRole("button", { name: "待处理问题 1" });
	act(() => {
		useAlertStore.getState().push({ source: "image", message: "出图失败" });
		useAlertStore.getState().push({ source: "future-source", message: "外来失败" });
	});
	expect(await screen.findByText("推送链路错误 (2)")).toBeTruthy();
	expect(screen.getByText("渲染")).toBeTruthy();
	expect(screen.getByText("future-source")).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "清空错误记录" }));
	expect(screen.queryByText("出图失败")).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "待处理问题 1" }));
	expect(await screen.findByText("持续问题")).toBeTruthy();
});

it("keeps business pages and side effects unmounted while a reachable backend is migrating", async () => {
	mountApp({
		details: () => ({ phase: "migrating", progress: { step: 4, total: 12, label: "推送历史" } }),
	});
	expect(await screen.findByRole("heading", { name: "正在搬家" })).toBeTruthy();
	expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("步骤 4 / 12");
	expect(screen.queryByRole("link", { name: "系统" })).toBeNull();
	expect(screen.queryByRole("button", { name: /添加一行/ })).toBeNull();
	const paths = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
	expect(
		paths.filter((path) => !["/api/session", "/api/health", "/api/health/details"].includes(path)),
	).toEqual([]);
});

it("waits through null progress and starting, then clears old business data before restoring the entered route", async () => {
	let details: HealthDetailsResponse = { phase: "migrating", progress: null };
	qc.setQueryDefaults(["subscription-tags"], { staleTime: Infinity });
	qc.setQueryData(
		["subscription-tags"],
		[{ id: "11111111-1111-4111-8111-111111111111", name: "旧代标签" }],
	);
	mountApp({ details: () => details, path: "/subs" });
	expect(await screen.findByText(/等待首个迁移进度/)).toBeTruthy();
	expect(screen.queryByRole("progressbar")).toBeNull();
	details = { phase: "starting", progress: null };
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health", "details"] });
	});
	expect(await screen.findByRole("heading", { name: "正在启动服务" })).toBeTruthy();
	details = runningDetails;
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health", "details"] });
	});
	await screen.findByRole("button", { name: "管理标签" });
	await waitFor(() => expect(screen.queryByText("旧代标签")).toBeNull());
	expect(screen.queryByRole("button", { name: /添加一行/ })).toBeNull();
});

it("does not release from a cached running response while the current startup probe is still pending", async () => {
	let finish!: (value: HealthDetailsResponse) => void;
	const pending = new Promise<HealthDetailsResponse>((resolve) => {
		finish = resolve;
	});
	qc.setQueryData(["health", "details"], runningDetails);
	mountApp({ details: () => pending });
	expect(await screen.findByRole("heading", { name: "正在确认启动状态" })).toBeTruthy();
	await waitFor(() =>
		expect(
			vi.mocked(fetch).mock.calls.some(([path]) => String(path) === "/api/health/details"),
		).toBe(true),
	);
	expect(screen.queryByRole("link", { name: "系统" })).toBeNull();
	await act(async () =>
		finish({ phase: "migrating", progress: { step: 1, total: 12, label: "设置" } }),
	);
	expect(await screen.findByRole("heading", { name: "正在搬家" })).toBeTruthy();
});

it("preserves the last migration step across a failed probe, retries without opening business, and then resumes", async () => {
	let failed = false;
	let details: HealthDetailsResponse = {
		phase: "migrating",
		progress: { step: 4, total: 12, label: "推送历史" },
	};
	mountApp({ details: () => (failed ? Promise.reject(new Error("offline")) : details) });
	await screen.findByRole("heading", { name: "正在搬家" });
	failed = true;
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health", "details"] });
	});
	expect(await screen.findByRole("heading", { name: "正在等待重新连接" })).toBeTruthy();
	expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("步骤 4 / 12");
	expect(screen.queryByRole("link", { name: "系统" })).toBeNull();
	failed = false;
	details = runningDetails;
	await userEvent.click(screen.getByRole("button", { name: "重试" }));
	expect((await screen.findAllByRole("button", { name: /添加一行/ })).length).toBeGreaterThan(0);
});

it("requires a fresh process probe even when a recent cached health response says running", async () => {
	const old: HealthResponse = {
		status: "ok",
		version: "old",
		startedAt: "2026-11-01T00:00:00Z",
		uptime: 5,
	};
	qc.setQueryDefaults(["health"], { staleTime: Infinity });
	qc.setQueryData(["health"], old);
	qc.setQueryData(["health", "details"], runningDetails);
	let finish!: (health: HealthResponse) => void;
	const pending = new Promise<HealthResponse>((resolve) => {
		finish = resolve;
	});
	mountApp({ health: () => pending });
	await waitFor(() =>
		expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path) === "/api/health")).toBe(true),
	);
	expect(screen.queryByRole("link", { name: "系统" })).toBeNull();
	await act(async () => finish({ ...old, startedAt: "2026-11-04T00:00:00Z" }));
	expect((await screen.findAllByRole("button", { name: /添加一行/ })).length).toBeGreaterThan(0);
});

it("requires login before probing protected startup details", async () => {
	mountApp({ session: { authRequired: true, authed: false } });
	await screen.findByRole("button", { name: /登录/ });
	expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).toEqual(["/api/session"]);
});

it("shows an unknown startup state on a failed first probe instead of opening a business page", async () => {
	mountApp({ details: () => Promise.reject(new Error("offline")) });
	expect(await screen.findByRole("heading", { name: "暂时无法确认启动状态" })).toBeTruthy();
	expect(screen.queryByText(/最后一次进度/)).toBeNull();
	expect(screen.queryByRole("progressbar")).toBeNull();
	expect(screen.queryByRole("link", { name: "系统" })).toBeNull();
});

it("re-enters the startup gate on a new process and keeps the original page after it becomes ready", async () => {
	let startedAt = "2026-11-01T00:00:00Z";
	let details: HealthDetailsResponse = runningDetails;
	mountApp({
		details: () => details,
		health: () => ({ status: "ok", version: "test", startedAt, uptime: 0 }),
	});
	await screen.findAllByRole("button", { name: /添加一行/ });
	startedAt = "2026-11-04T00:00:00Z";
	details = { phase: "migrating", progress: { step: 2, total: 12, label: "订阅" } };
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health"] });
	});
	expect(await screen.findByRole("heading", { name: "正在搬家" })).toBeTruthy();
	expect(screen.queryByRole("button", { name: /添加一行/ })).toBeNull();
	details = runningDetails;
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health", "details"] });
	});
	expect((await screen.findAllByRole("button", { name: /添加一行/ })).length).toBeGreaterThan(0);
});

const updateNotice: SystemNotice = {
	id: "notice-1",
	kind: "updated",
	createdAt: "2026-11-04T00:00:00Z",
	version: "1.0.1",
	releases: [],
};
const jsonResponse = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
it("offers an explicit 了解 action; snoozing and reopening never mark a system notice read", async () => {
	let left = [updateNotice];
	mountApp({
		notices: () => left,
		request: async (path, init) => {
			if (path === "/api/system/notices/notice-1/acknowledge" && init?.method === "POST") {
				left = [];
				return jsonResponse({ notices: left });
			}
		},
	});
	expect(await screen.findByText("本次更新 · 1.0.1")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "已了解" })).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "稍后提醒" }));
	expect(screen.queryByText("本次更新 · 1.0.1")).toBeNull();
	expect(
		vi
			.mocked(fetch)
			.mock.calls.filter(
				([path, init]) => init?.method === "POST" && String(path).endsWith("/acknowledge"),
			),
	).toEqual([]);
	await userEvent.click(screen.getByRole("button", { name: "查看" }));
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	await waitFor(() => expect(screen.queryByText("本次更新 · 1.0.1")).toBeNull());
	expect(
		vi
			.mocked(fetch)
			.mock.calls.some(
				([path, init]) =>
					String(path) === "/api/system/notices/notice-1/acknowledge" && init?.method === "POST",
			),
	).toBe(true);
});

it("lets the system notice finish before offering onboarding, then returns control to onboarding", async () => {
	mountApp({ notices: () => [updateNotice] });
	await screen.findByText("本次更新 · 1.0.1");
	await screen.findAllByRole("button", { name: /添加一行/ });
	expect(screen.queryByText("需要新手指引吗?")).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "稍后提醒" }));
	expect(await screen.findByText("需要新手指引吗?")).toBeTruthy();
});

it("renders release notes safely and handles failed-generation and rollback notices in server order", async () => {
	let left: SystemNotice[] = [
		{
			...updateNotice,
			releases: [
				{
					version: "1.0.1",
					date: "2026-11-04",
					summary: "**标签管理**\n\n<script>bad()</script>",
					caution: "请更新拓展",
					releaseUrl: "javascript:alert(1)",
				},
			],
		},
		{
			id: "notice-2",
			kind: "generation-failed",
			createdAt: "2026-11-04T00:00:01Z",
			source: "zero",
			message: "磁盘空间不足（原文）",
		},
		{ id: "notice-3", kind: "rolled-back", createdAt: "2026-11-04T00:00:02Z", version: "1.0.2" },
	];
	mountApp({
		notices: () => left,
		request: async (path, init) => {
			if (path.endsWith("/acknowledge") && init?.method === "POST") {
				left = left.slice(1);
				return jsonResponse({ notices: left });
			}
		},
	});
	expect(await screen.findByText("标签管理", { selector: "strong" })).toBeTruthy();
	expect(screen.getByText("请更新拓展")).toBeTruthy();
	expect(document.querySelector("script")).toBeNull();
	expect(screen.queryByRole("button", { name: "完整更新说明" })).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	expect(await screen.findByText("未能创建新数据")).toBeTruthy();
	expect(screen.getByText("磁盘空间不足（原文）")).toBeTruthy();
	expect(screen.getByText(/从旧代重新迁移未能完成/)).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	expect(await screen.findByText("已自动退回可用版本")).toBeTruthy();
	expect(screen.getByText(/1.0.2.*test/)).toBeTruthy();
});

it("keeps unread state unknown after a failed read and can retry the same notice list", async () => {
	let failing = true;
	mountApp({
		notices: () => [updateNotice],
		request: async (path) =>
			path === "/api/system/notices" && failing
				? jsonResponse({ code: "unavailable", message: "读提示失败原文" }, 503)
				: undefined,
	});
	expect(await screen.findByText("读提示失败原文")).toBeTruthy();
	expect(screen.queryByText("本次更新 · 1.0.1")).toBeNull();
	failing = false;
	await userEvent.click(screen.getByRole("button", { name: "重试" }));
	expect(await screen.findByText("本次更新 · 1.0.1")).toBeTruthy();
});

const migratedNotice: SystemNotice = {
	id: "migrated-1",
	kind: "migrated",
	createdAt: "2026-11-04T00:00:00Z",
	version: "1.0.0",
	cardSkinsDropped: true,
	masterTargetCleared: true,
	releases: [],
};
it("shows only the migration follow-ups reported by the current generation", async () => {
	let left: SystemNotice[] = [
		migratedNotice,
		{ ...migratedNotice, id: "migrated-2", cardSkinsDropped: false, masterTargetCleared: false },
	];
	mountApp({
		notices: () => left,
		request: async (path, init) => {
			if (path.endsWith("/acknowledge") && init?.method === "POST") {
				left = left.slice(1);
				return jsonResponse({ notices: left });
			}
		},
	});
	expect(await screen.findByText("卡片皮肤需要重新制作")).toBeTruthy();
	expect(screen.getByText("重新选择主人目标")).toBeTruthy();
	expect(screen.getByRole("button", { name: "全新开始…" })).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "沿用已迁数据" }));
	await waitFor(() => expect(screen.queryByText("卡片皮肤需要重新制作")).toBeNull());
	expect(screen.queryByText("重新选择主人目标")).toBeNull();
	expect(screen.getByRole("button", { name: "全新开始…" })).toBeTruthy();
});

it("rechecks a notice missing at acknowledgement time instead of leaving a stale unread dialog", async () => {
	let left = [updateNotice];
	mountApp({
		notices: () => left,
		request: async (path, init) => {
			if (path.endsWith("/acknowledge") && init?.method === "POST") {
				left = [];
				return jsonResponse({ code: "not_found", message: "提示不存在" }, 404);
			}
		},
	});
	await screen.findByText("本次更新 · 1.0.1");
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	await waitFor(() => expect(screen.queryByText("本次更新 · 1.0.1")).toBeNull());
});

it("confirms the empty-generation consequences and refuses when the host cannot restart", async () => {
	mountApp({
		notices: () => [migratedNotice],
		request: async (path) =>
			path === "/api/ext"
				? jsonResponse({
						extensions: [],
						restart: { can: false, code: "source_run", message: "只能手动重启（原文）" },
					})
				: undefined,
	});
	await screen.findByText("数据已迁移完成");
	await userEvent.click(screen.getByRole("button", { name: "全新开始…" }));
	expect(await screen.findByText("确认全新开始？")).toBeTruthy();
	expect(await screen.findByText("只能手动重启（原文）")).toBeTruthy();
	expect(screen.getByText(/面板账号和密码保留/)).toBeTruthy();
	expect(
		(screen.getByRole("button", { name: "确认全新开始并重启" }) as HTMLButtonElement).disabled,
	).toBe(true);
	await userEvent.click(screen.getByRole("button", { name: "返回" }));
	expect(await screen.findByText("数据已迁移完成")).toBeTruthy();
	expect(
		vi
			.mocked(fetch)
			.mock.calls.filter(
				([path, init]) => String(path) === "/api/system/generations" && init?.method === "POST",
			),
	).toEqual([]);
});

it("submits an empty generation only after confirmation, retains failures, then waits for a new process", async () => {
	let attempts = 0;
	let accepted = false;
	const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
	mountApp({
		notices: () => [migratedNotice],
		health: () => ({
			status: "ok",
			version: "test",
			startedAt: accepted ? "2026-11-04T00:00:00Z" : "2026-11-01T00:00:00Z",
			uptime: 0,
		}),
		request: async (path, init) => {
			if (path === "/api/ext")
				return jsonResponse({ extensions: [], restart: { can: true, how: "desktop" } });
			if (path === "/api/system/generations" && init?.method === "POST") {
				expect(JSON.parse(String(init.body))).toEqual({ source: "empty" });
				attempts++;
				if (attempts === 1)
					return jsonResponse({ code: "unavailable", message: "暂时无法开新代" }, 503);
				accepted = true;
				return jsonResponse({
					restarting: true,
					startedAt: "2026-11-01T00:00:00Z",
					version: "test",
				});
			}
		},
	});
	await screen.findByText("数据已迁移完成");
	expect(attempts).toBe(0);
	await userEvent.click(screen.getByRole("button", { name: "全新开始…" }));
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "确认全新开始并重启" }) as HTMLButtonElement).disabled,
		).toBe(false),
	);
	await userEvent.click(screen.getByRole("button", { name: "确认全新开始并重启" }));
	expect(await screen.findByText("暂时无法开新代")).toBeTruthy();
	expect(reload).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("button", { name: "确认全新开始并重启" }));
	expect(await screen.findByRole("heading", { name: "正在等待服务重启" })).toBeTruthy();
	expect(screen.queryByRole("link", { name: "系统" })).toBeNull();
	await waitFor(() => expect(reload).toHaveBeenCalledOnce());
	expect(attempts).toBe(2);
});

it("keeps third-party extension updates behind confirmation without marking the migration notice read", async () => {
	let installed = false;
	let installs = 0;
	const entry = {
		source: "alice",
		official: false,
		id: "alice.bridge",
		name: "示例消息桥",
		description: "demo",
		version: "2.0.0",
		apiVersion: 3,
		prerelease: false,
		size: 100,
		state: "updatable",
	};
	mountApp({
		notices: () => [migratedNotice],
		request: async (path, init) => {
			if (path === "/api/ext")
				return jsonResponse({
					extensions: [
						{
							id: entry.id,
							name: entry.name,
							dir: "/tmp/demo",
							state: installed ? "disabled" : "incompatible",
							enabled: false,
							detail: "旧契约不兼容",
						},
					],
					restart: { can: false, code: "source_run", message: "手动重启" },
				});
			if (path === "/api/ext/marketplace")
				return jsonResponse({
					available: true,
					fetchedAt: "2026-11-04T00:00:00Z",
					sources: [{ id: "alice", name: "Alice 的拓展源", official: false, ok: true }],
					extensions: [{ ...entry, state: installed ? "installed" : "updatable" }],
				});
			if (path === "/api/ext/marketplace/install" && init?.method === "POST") {
				expect(JSON.parse(String(init.body))).toEqual({ source: "alice", id: entry.id });
				installed = true;
				installs++;
				return jsonResponse({
					id: entry.id,
					name: entry.name,
					version: entry.version,
					staged: false,
					enabled: false,
					restart: { can: false, code: "source_run", message: "手动重启" },
				});
			}
		},
	});
	await screen.findByText("示例消息桥");
	await userEvent.click(await screen.findByRole("button", { name: "更新" }));
	expect(installs).toBe(0);
	expect(screen.getAllByRole("dialog")).toHaveLength(1);
	expect(screen.getByText(/Alice 的拓展源/)).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "返回" }));
	expect(installs).toBe(0);
	await userEvent.click(screen.getByRole("button", { name: "更新" }));
	await userEvent.click(screen.getByRole("button", { name: "照样更新" }));
	await waitFor(() => expect(installs).toBe(1));
	expect(screen.getByText("数据已迁移完成")).toBeTruthy();
	expect(
		vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith("/acknowledge")),
	).toEqual([]);
});

it("locks acknowledgement, retains server issues on failure, and retries without closing the unread notice", async () => {
	let resolve!: (response: Response) => void;
	let calls = 0;
	const pending = new Promise<Response>((r) => {
		resolve = r;
	});
	mountApp({
		notices: () => [updateNotice],
		request: async (path, init) => {
			if (path.endsWith("/acknowledge") && init?.method === "POST") {
				calls++;
				return calls === 1 ? pending : jsonResponse({ notices: [] });
			}
		},
	});
	await screen.findByText("本次更新 · 1.0.1");
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	expect((screen.getByRole("button", { name: "稍后提醒" }) as HTMLButtonElement).disabled).toBe(
		true,
	);
	await userEvent.keyboard("{Escape}");
	await userEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
	expect(screen.getByText("本次更新 · 1.0.1")).toBeTruthy();
	expect(calls).toBe(1);
	await act(async () =>
		resolve(
			jsonResponse(
				{
					code: "unavailable",
					message: "不可写",
					issues: [{ path: ["notices"], message: "磁盘只读" }],
				},
				503,
			),
		),
	);
	expect(await screen.findByText("不可写：notices：磁盘只读")).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	await waitFor(() => expect(screen.queryByText("本次更新 · 1.0.1")).toBeNull());
	expect(calls).toBe(2);
});

it("keeps keyboard focus inside the notice and returns it to the unread entry after snoozing", async () => {
	mountApp({ notices: () => [updateNotice] });
	await screen.findByText("本次更新 · 1.0.1");
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "稍后提醒" })),
	);
	await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "了解" }));
	await userEvent.keyboard("{Tab}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "稍后提醒" }));
	await userEvent.keyboard("{Escape}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看" }));
});

it("ignores an old acknowledgement reply after the backend has switched generations", async () => {
	let left: SystemNotice[] = [updateNotice];
	let startedAt = "2026-11-01T00:00:00Z";
	let details: HealthDetailsResponse = runningDetails;
	let resolve!: (response: Response) => void;
	const pending = new Promise<Response>((r) => {
		resolve = r;
	});
	mountApp({
		notices: () => left,
		details: () => details,
		health: () => ({ status: "ok", version: "test", startedAt, uptime: 0 }),
		request: async (path, init) =>
			path.endsWith("/acknowledge") && init?.method === "POST" ? pending : undefined,
	});
	await screen.findByText("本次更新 · 1.0.1");
	await userEvent.click(screen.getByRole("button", { name: "了解" }));
	startedAt = "2026-11-04T00:00:00Z";
	details = { phase: "migrating", progress: null };
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health"] });
	});
	await screen.findByRole("heading", { name: "正在搬家" });
	left = [];
	details = runningDetails;
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health", "details"] });
	});
	await screen.findAllByRole("button", { name: /添加一行/ });
	await act(async () => resolve(jsonResponse({ notices: [updateNotice] })));
	expect(screen.queryByText("本次更新 · 1.0.1")).toBeNull();
});

it("explains the required container restart policy before confirming a fresh start", async () => {
	mountApp({
		notices: () => [migratedNotice],
		request: async (path) =>
			path === "/api/ext"
				? jsonResponse({ extensions: [], restart: { can: true, how: "container" } })
				: undefined,
	});
	await screen.findByText("数据已迁移完成");
	await userEvent.click(screen.getByRole("button", { name: "全新开始…" }));
	expect(await screen.findByText(/容器.*自动重启策略/)).toBeTruthy();
});

it("系统账号按来源扫码，默认可排序且不需要进入调整模式", async () => {
	const stamp = "2026-11-05T00:00:00Z";
	const rows: import("@bilibili-notify/contract").AccountView[] = [
		{ sourceKey: "library", state: { status: "logged-out" } },
		{ sourceKey: "later", state: { status: "logged-out" } },
	];
	mountApp({
		path: "/system",
		request: async (path, init) => {
			if (path === "/api/accounts") return Response.json({ accounts: rows });
			if (path === "/api/sources")
				return Response.json({
					sources: rows.map((a) => ({
						key: a.sourceKey,
						status: "running",
						has: { auth: true },
						descriptor: {
							label: a.sourceKey === "library" ? "书库" : "另一个来源",
							shortLabel: "源",
							color: "#888",
							icon: "globe",
						},
					})),
				});
			if (path === "/api/sources/library/auth" && init?.method === "POST") {
				rows[0] = {
					sourceKey: "library",
					state: {
						status: "awaiting-scan",
						qr: { dataUrl: "data:image/png;base64,AA==", expiresAt: stamp },
					},
				};
				return Response.json({ state: rows[0].state });
			}
		},
	});
	await screen.findByText("来源账号");
	expect(screen.queryByRole("button", { name: "调整顺序" })).toBeNull();
	expect(screen.getByRole("button", { name: "拖动排序 书库" })).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "扫码登录书库" }));
	expect((await screen.findByText("书库 · 扫码登录")).closest("[role=dialog]")).not.toBeNull();
	expect(screen.getByAltText("书库登录二维码")).toBeTruthy();
	expect(
		vi
			.mocked(fetch)
			.mock.calls.some(
				([path, init]) => path === "/api/sources/library/auth" && init?.method === "POST",
			),
	).toBe(true);
});

it("排序沿系统草稿保存，失败保稿，保留暂不在册键和重复键", async () => {
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
		accounts: { order: ["dormant", "library", "library", "radio"] },
	};
	const rows = [
		{ sourceKey: "library", state: { status: "logged-out" } },
		{ sourceKey: "radio", state: { status: "logged-out" } },
	];
	const attempts: unknown[] = [];
	let fail = true;
	const nativeRect = HTMLElement.prototype.getBoundingClientRect;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
		this: HTMLElement,
	) {
		if (this.id.startsWith("source-account-")) {
			const index = [...(this.parentElement?.children ?? [])].indexOf(this);
			return new DOMRect(0, index * 90, 800, 90);
		}
		return nativeRect.call(this);
	});
	mountApp({
		path: "/system",
		request: async (path, init) => {
			if (path === "/api/settings" && init?.method === "PATCH") {
				const patch = JSON.parse(String(init.body));
				attempts.push(patch);
				if (fail)
					return Response.json({ code: "unavailable", message: "保存顺序失败" }, { status: 503 });
				core.accounts = patch.core.accounts;
				return Response.json({ core });
			}
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/accounts") {
				const keys = [...new Set(core.accounts.order)];
				return Response.json({
					accounts: keys.flatMap((key) => rows.filter((row) => row.sourceKey === key)),
				});
			}
			if (path === "/api/sources")
				return Response.json({
					sources: rows.map((row) => ({
						key: row.sourceKey,
						status: "running",
						has: { auth: true },
						descriptor: {
							label: row.sourceKey === "library" ? "书库" : "电台",
							shortLabel: "源",
							icon: "globe",
						},
					})),
				});
		},
	});
	const handle = await screen.findByRole("button", { name: "拖动排序 书库" });
	handle.focus();
	await userEvent.keyboard("[Space]");
	await userEvent.keyboard("[ArrowDown]");
	await userEvent.keyboard("[Space]");
	expect(await screen.findByText("保存后，电台将成为顶栏显示账号。")).toBeTruthy();
	expect(screen.getByRole("button", { name: "来源账号：书库 · 未登录" })).toBeTruthy();
	await userEvent.click(await screen.findByRole("button", { name: "保存" }));
	expect(await screen.findByText("保存顺序失败")).toBeTruthy();
	expect(attempts[0]).toEqual({
		core: { accounts: { order: ["dormant", "radio", "library", "library"] } },
	});
	expect(screen.getByRole("button", { name: "来源账号：书库 · 未登录" })).toBeTruthy();
	fail = false;
	await userEvent.click(screen.getByRole("button", { name: "关闭" }));
	await userEvent.click(await screen.findByRole("button", { name: "保存" }));
	expect(await screen.findByRole("button", { name: "来源账号：电台 · 未登录" })).toBeTruthy();
});

it("多个来源等待扫码时只打开一个弹窗，可分别继续原码", async () => {
	const rows = ["library", "radio"].map((sourceKey) => ({
		sourceKey,
		state: {
			status: "awaiting-scan",
			qr: { dataUrl: `data:image/png;base64,${sourceKey}`, expiresAt: "2026-11-05T10:00:00Z" },
		},
	}));
	mountApp({
		path: "/system",
		request: async (path) => {
			if (path === "/api/accounts") return Response.json({ accounts: rows });
			if (path === "/api/sources")
				return Response.json({
					sources: rows.map((a) => ({
						key: a.sourceKey,
						status: "running",
						has: { auth: true },
						descriptor: {
							label: a.sourceKey === "library" ? "书库" : "电台",
							shortLabel: "源",
							color: "#888",
							icon: "globe",
						},
					})),
				});
		},
	});
	await screen.findByAltText("书库登录二维码");
	expect(screen.queryByAltText("电台登录二维码")).toBeNull();
	await userEvent.keyboard("{Escape}");
	await userEvent.click(screen.getByRole("button", { name: "继续扫码电台" }));
	expect(await screen.findByAltText("电台登录二维码")).toBeTruthy();
	expect(screen.queryByAltText("书库登录二维码")).toBeNull();
	expect(
		vi
			.mocked(fetch)
			.mock.calls.filter(
				([path, init]) => String(path).startsWith("/api/sources/") && init?.method === "POST",
			),
	).toEqual([]);
});

it("素材库可独立打开，按图片与字体展示已有元数据", async () => {
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
	};
	mountApp({
		path: "/library",
		request: async (path) => {
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/library/images") return Response.json({ ok: true, ids: [] });
			if (path === "/api/library/fonts")
				return Response.json({
					ok: true,
					fonts: [{ id: `${"a".repeat(32)}.woff2`, name: "示例字体.woff2", size: 2097152 }],
				});
		},
	});
	expect(await screen.findByText("反复使用的图片与字体，统一放在这里。")).toBeTruthy();
	expect(screen.getByRole("link", { name: "素材库" }).getAttribute("href")).toBe("/library");
	expect(await screen.findByText("还没有图片")).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "字体" }));
	expect(await screen.findByText("示例字体.woff2")).toBeTruthy();
	expect(screen.getByText("2.0 MB · 字体文件")).toBeTruthy();
});

it("素材库图片预览使用鉴权读取的对象地址，并在关闭大图后保留清单", async () => {
	const id = `${"1".repeat(32)}.png`;
	const revoke = vi.fn();
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL() {
				return "blob:library-image";
			}
			static revokeObjectURL = revoke;
		},
	);
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
	};
	mountApp({
		path: "/library",
		request: async (path) => {
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/library/images") return Response.json({ ok: true, ids: [id] });
			if (path === `/api/library/images/${id}`)
				return new Response(new Blob(["image"], { type: "image/png" }));
		},
	});
	await userEvent.click(await screen.findByRole("button", { name: "预览图片 1" }));
	expect((await screen.findByAltText("素材预览")).getAttribute("src")).toBe("blob:library-image");
	const request = vi
		.mocked(fetch)
		.mock.calls.find(([path]) => path === `/api/library/images/${id}`);
	expect(request?.[1]?.credentials).toBe("include");
	await userEvent.keyboard("{Escape}");
	expect(screen.queryByAltText("素材预览")).toBeNull();
	expect(screen.getByRole("button", { name: "预览图片 1" })).toBeTruthy();
});

it("删除字体先确认，被引用时保留原话与文件，解除引用后可重新删除", async () => {
	const id = `${"a".repeat(32)}.woff2`;
	let fonts = [{ id, name: "使用中的字体.woff2", size: 1024 }];
	let referenced = true;
	let deletes = 0;
	const reason = "该字体被全局默认使用，请先换掉再删除";
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
	};
	mountApp({
		path: "/library",
		request: async (path, init) => {
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/library/images") return Response.json({ ok: true, ids: [] });
			if (path === "/api/library/fonts") return Response.json({ ok: true, fonts });
			if (path === `/api/library/fonts/${id}` && init?.method === "DELETE") {
				deletes++;
				if (referenced)
					return Response.json({ code: "conflict", message: reason }, { status: 409 });
				fonts = [];
				return Response.json({ ok: true });
			}
		},
	});
	await screen.findByText("还没有图片");
	await userEvent.click(screen.getByRole("button", { name: "字体" }));
	await userEvent.click(await screen.findByRole("button", { name: "删除字体 使用中的字体.woff2" }));
	expect(deletes).toBe(0);
	await userEvent.click(screen.getByRole("button", { name: "取消" }));
	expect(deletes).toBe(0);
	await userEvent.click(screen.getByRole("button", { name: "删除字体 使用中的字体.woff2" }));
	await userEvent.click(screen.getByRole("button", { name: "删除" }));
	expect(await screen.findByText(reason)).toBeTruthy();
	expect(deletes).toBe(1);
	expect(screen.queryByRole("button", { name: "重试删除" })).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "关闭" }));
	referenced = false;
	await userEvent.click(screen.getByRole("button", { name: "删除字体 使用中的字体.woff2" }));
	await userEvent.click(screen.getByRole("button", { name: "删除" }));
	expect(await screen.findByText("还没有字体")).toBeTruthy();
	expect(deletes).toBe(2);
});

it("上传图片失败保留清单，再传同一文件成功即入库，不提交设置", async () => {
	const id = `${"2".repeat(32)}.png`;
	let ids: string[] = [];
	let failed = true;
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
	};
	mountApp({
		path: "/library",
		request: async (path, init) => {
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/library/images" && init?.method === "POST") {
				if (failed)
					return Response.json(
						{ code: "unavailable", message: "上传未完成，请重试" },
						{ status: 503 },
					);
				ids = [id];
				return Response.json({ ok: true, id });
			}
			if (path === "/api/library/images") return Response.json({ ok: true, ids });
		},
	});
	await screen.findByText("还没有图片");
	const input = document.querySelector<HTMLInputElement>('input[type="file"]');
	expect(input).not.toBeNull();
	if (!input) throw new Error("missing upload input");
	const file = new File(["png"], "sample.png", { type: "image/png" });
	const { fireEvent } = await import("@testing-library/react");
	fireEvent.change(input, { target: { files: [file] } });
	expect(await screen.findByText("上传未完成，请重试")).toBeTruthy();
	expect(screen.getByText("还没有图片")).toBeTruthy();
	failed = false;
	fireEvent.change(input, { target: { files: [file] } });
	expect(await screen.findByRole("button", { name: "预览图片 1" })).toBeTruthy();
	expect(screen.queryByText("上传未完成，请重试")).toBeNull();
	expect(
		vi
			.mocked(fetch)
			.mock.calls.some(([path, init]) => path === "/api/settings" && init?.method === "PATCH"),
	).toBe(false);
});

it("图片删除失败可重试，等待响应时不重复发起，成功后刷新清单", async () => {
	const id = `${"3".repeat(32)}.png`;
	let ids = [id],
		deletes = 0;
	let release: (response: Response) => void = () => {};
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
	};
	mountApp({
		path: "/library",
		request: async (path, init) => {
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/library/images") return Response.json({ ok: true, ids });
			if (path === `/api/library/images/${id}` && init?.method === "DELETE") {
				deletes++;
				if (deletes === 1)
					return Response.json(
						{ code: "unavailable", message: "删除失败，原文件还在" },
						{ status: 503 },
					);
				return new Promise<Response>((resolve) => {
					release = (response) => {
						ids = [];
						resolve(response);
					};
				});
			}
		},
	});
	await userEvent.click(await screen.findByRole("button", { name: "删除图片 1" }));
	await userEvent.click(screen.getByRole("button", { name: "删除" }));
	expect(await screen.findByText("删除失败，原文件还在")).toBeTruthy();
	await userEvent.click(screen.getByRole("button", { name: "重试删除" }));
	expect(
		((await screen.findByRole("button", { name: "正在删除…" })) as HTMLButtonElement).disabled,
	).toBe(true);
	await userEvent.click(screen.getByRole("button", { name: "正在删除…" }));
	expect(deletes).toBe(2);
	await act(async () => release(Response.json({ ok: true })));
	expect(await screen.findByText("还没有图片")).toBeTruthy();
});

it("素材读取失败不展示旧缓存为空库，重试成功后恢复清单", async () => {
	const id = `${"4".repeat(32)}.png`;
	let failed = false;
	const core = {
		...makeDefaultGlobalConfig(),
		locale: "zh-CN",
		voice: "plain",
		onboarding: { skipped: true },
	};
	mountApp({
		path: "/library",
		request: async (path) => {
			if (path === "/api/settings") return Response.json({ core });
			if (path === "/api/library/images")
				return failed
					? Response.json({ code: "unavailable", message: "暂时无法列举素材" }, { status: 503 })
					: Response.json({ ok: true, ids: [id] });
		},
	});
	await screen.findByRole("button", { name: "预览图片 1" });
	failed = true;
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["library", "images"] });
	});
	expect(await screen.findByText("素材列表暂时无法读取，请重试。")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "预览图片 1" })).toBeNull();
	expect(screen.queryByText("还没有图片")).toBeNull();
	failed = false;
	await userEvent.click(screen.getByRole("button", { name: "重试" }));
	expect(await screen.findByRole("button", { name: "预览图片 1" })).toBeTruthy();
});

it("迁移提示首次与重新打开时先聚焦正文，Tab后才聚焦操作，关闭返回查看入口", async () => {
	mountApp({ notices: () => [migratedNotice] });
	await screen.findByText("数据已迁移完成");
	const cards = screen.getByRole("button", { name: "前往卡片设置" });
	const dialog = screen.getByRole("dialog");
	await waitFor(() => {
		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement?.matches("button, a[href], summary")).toBe(false);
	});
	await userEvent.keyboard("{Tab}");
	expect(document.activeElement).toBe(cards);
	await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "沿用已迁数据" }));
	await userEvent.keyboard("{Tab}");
	expect(document.activeElement).toBe(cards);
	await userEvent.click(screen.getByRole("button", { name: "稍后提醒" }));
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看" }));
	await userEvent.click(screen.getByRole("button", { name: "查看" }));
	expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
	expect(document.activeElement?.matches("button, a[href], summary")).toBe(false);
	await userEvent.keyboard("{Escape}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看" }));
	expect(
		vi
			.mocked(fetch)
			.mock.calls.some(
				([path, init]) => String(path).endsWith("/acknowledge") && init?.method === "POST",
			),
	).toBe(false);
});
