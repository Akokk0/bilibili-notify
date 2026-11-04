// @vitest-environment jsdom
import type { HealthDetailsResponse, HealthResponse } from "@bilibili-notify/contract";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vite-plus/test";
import App from "../App";
import { i18n } from "../i18n";
import { setWsEnabled } from "../services/wsSingleton";
import { useAlertStore } from "../store/alerts";
import { useSessionStore } from "../store/session";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => {
	cleanup();
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
		vi.fn(async (input: string | URL | Request) => {
			const path = String(input);
			let data: unknown = {};
			if (path === "/api/session") data = options.session ?? { authRequired: false, authed: false };
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
		await qc.invalidateQueries({ queryKey: ["health"], exact: true });
	});
	expect(await screen.findByRole("heading", { name: "正在搬家" })).toBeTruthy();
	expect(screen.queryByRole("button", { name: /添加一行/ })).toBeNull();
	details = runningDetails;
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["health", "details"] });
	});
	expect((await screen.findAllByRole("button", { name: /添加一行/ })).length).toBeGreaterThan(0);
});
