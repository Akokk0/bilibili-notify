// @vitest-environment jsdom
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vite-plus/test";
import App from "../App";
import { i18n } from "../i18n";
import { setWsEnabled } from "../services/wsSingleton";
import { useAlertStore } from "../store/alerts";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => {
	cleanup();
	useAlertStore.getState().clear();
	setWsEnabled(false);
	qc.clear();
	vi.unstubAllGlobals();
});
function mountApp() {
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
			if (path === "/api/session") data = { authRequired: false, authed: false };
			else if (path === "/api/settings") data = { core };
			else if (path === "/api/health")
				data = { status: "ok", version: "test", startedAt: "2026-11-01T00:00:00Z", uptime: 0 };
			else if (path === "/api/system/update")
				data = { currentVersion: "0.0.0-dev", pinnedVersion: null, state: { phase: "disabled" } };
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
			<MemoryRouter initialEntries={["/rules"]}>
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
