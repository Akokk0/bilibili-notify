// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import { GlassHeader } from "../header";

const get = vi.hoisted(() => vi.fn());
vi.mock("../../services/api", () => ({ api: { get } }));
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	get.mockImplementation(async (path: string) =>
		path === "/api/health"
			? { status: "ok", version: "dev", uptime: 1 }
			: path === "/api/problems"
				? {
						problems: [
							{
								reporter: "missing.source",
								code: "unknown_code",
								message: "<script>原文</script>",
								since: "2026-11-02T00:00:00Z",
								about: { subscriptionId: "gone-sub" },
							},
						],
					}
				: path === "/api/sources"
					? { sources: [] }
					: path === "/api/adapters"
						? { adapters: [] }
						: path === "/api/ext"
							? { extensions: [] }
							: [],
	);
});
afterEach(cleanup);
function mount(entry = "/") {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[entry]}>
				<GlassHeader />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return qc;
}
it("顶栏展示持续问题与安全原文，未知归属保留id且无清除入口", async () => {
	mount();
	await userEvent.click(await screen.findByRole("button", { name: "待处理问题 1" }));
	expect(await screen.findByText("<script>原文</script>")).toBeTruthy();
	expect(screen.getByText("missing.source")).toBeTruthy();
	expect(screen.getByText("gone-sub")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "全部清除" })).toBeNull();
	expect(screen.getByRole("link", { name: "查看日志" }).getAttribute("href")).toBe("/logs");
});
it("读取失败时不把旧问题当现状，重试成功空表后才显示暂无问题", async () => {
	const qc = mount();
	await userEvent.click(await screen.findByRole("button", { name: "待处理问题 1" }));
	get.mockImplementation(async (path: string) => {
		if (path === "/api/problems") throw new Error("private reason");
		return [];
	});
	await qc.invalidateQueries({ queryKey: ["problems"] });
	expect(await screen.findByText("问题列表读取失败或后端失联，当前状态未知。")).toBeTruthy();
	expect(screen.queryByText("<script>原文</script>")).toBeNull();
	expect(screen.queryByText("private reason")).toBeNull();
	get.mockResolvedValue({ problems: [] });
	await userEvent.click(screen.getByRole("button", { name: "重试" }));
	expect(await screen.findByRole("button", { name: "暂无待处理问题" })).toBeTruthy();
	qc.clear();
});

it("直接打开问题深链接时也按阅读宽度定位", async () => {
	mount("/#problems");
	const panel = await screen.findByRole("dialog", { name: "待处理问题" });
	expect(panel.style.width).toBe("440px");
});
