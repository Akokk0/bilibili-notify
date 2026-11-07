// @vitest-environment jsdom
import type { HealthResponse } from "@bilibili-notify/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import type { ModuleLogLevels } from "../../types/globals";
import { SystemHealthCard } from "../Overview";
import { integrationHealth, runningHealth } from "./support/health";

vi.mock("../../services/api", () => ({ api: { get: vi.fn() }, ApiError: class extends Error {} }));

import { api } from "../../services/api";

const SHORT: HealthResponse = {
	status: "ok",
	version: "0.9.0",
	uptime: 600,
	startedAt: "2026-11-05T00:00:00Z",
};
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	vi.stubGlobal("__WEB_VERSION__", "0.0.0-test");
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});
function renderCard(
	over: {
		logLevel?: string;
		logLevels?: ModuleLogLevels;
		reachable?: boolean;
		settingsFailed?: boolean;
	} = {},
) {
	vi.mocked(api.get).mockImplementation(async (path) => {
		if (path === "/api/health/details")
			return runningHealth({ integrations: [integrationHealth()] });
		if (path === "/api/settings") {
			if (over.settingsFailed) throw new Error("settings failed");
			return {
				core: { logging: { level: over.logLevel ?? "debug", levels: over.logLevels ?? {} } },
			};
		}
		if (path === "/api/accounts") return { accounts: [] };
		if (path === "/api/sources") return { sources: [] };
		if (path === "/api/problems") return { problems: [] };
		return null;
	});
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<SystemHealthCard health={SHORT} reachable={over.reachable ?? true} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return qc;
}
async function detail(label: string) {
	await userEvent.click(
		await screen.findByRole("button", { name: new RegExp(`^${label} · .*查看详情$`) }),
	);
	return screen.getByRole("dialog");
}

describe("健康卡详情的日志覆盖", () => {
	it("core 日志覆盖属于存储、订阅、推送，渲染与AI各读自己的键", async () => {
		renderCard({ logLevel: "debug", logLevels: { core: "info", image: "warn", ai: "error" } });
		for (const [name, level] of [
			["存储", "INFO"],
			["订阅", "INFO"],
			["推送", "INFO"],
			["图片", "WARN"],
			["AI", "ERROR"],
		]) {
			const dialog = await detail(name);
			expect(within(dialog).getByText(level)).toBeTruthy();
			expect(within(dialog).getByText("独立配置")).toBeTruthy();
			await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		}
	});
});

describe("健康卡保留的版本与日志信息", () => {
	it("版本与默认日志收在信息区，模块详情使用对应版本和默认等级", async () => {
		renderCard({ logLevel: "warn" });
		await screen.findByRole("button", { name: "存储 · 运行中，查看详情" });
		expect(screen.queryByText("WARN")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "版本与日志 ＋" }));
		expect(screen.getByText("0.9.0")).toBeTruthy();
		expect(screen.getByText("0.0.0-test")).toBeTruthy();
		expect(screen.getByText("WARN")).toBeTruthy();
		const dialog = await detail("订阅");
		expect(within(dialog).getByText("0.7.1")).toBeTruthy();
		expect(within(dialog).getByText("WARN")).toBeTruthy();
		expect(within(dialog).getByText("跟随默认")).toBeTruthy();
	});
	it("覆盖成相同等级仍标为独立配置，集成按自己的键读取覆盖", async () => {
		renderCard({
			logLevel: "debug",
			logLevels: { core: "info", ai: "debug", "acme.source": "warn" },
		});
		let dialog = await detail("AI");
		expect(within(dialog).getByText("独立配置")).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
		dialog = await detail("测试来源");
		expect(within(dialog).getByText("WARN")).toBeTruthy();
		expect(within(dialog).getByText("独立配置")).toBeTruthy();
	});
	it("设置读取失败时不捏造默认INFO", async () => {
		renderCard({ settingsFailed: true });
		const dialog = await detail("存储");
		expect(within(dialog).queryByText("INFO")).toBeNull();
		expect(within(dialog).getAllByText("—")).toHaveLength(2);
	});
	it("失联时隐藏运行格和计数", async () => {
		renderCard({ reachable: false });
		expect(screen.getByText("暂时连不上服务")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /运行中，查看详情/ })).toBeNull();
	});
});

it("核心项的管理入口到对应页面", async () => {
	renderCard();
	for (const [name, path] of [
		["存储", "/system#storage"],
		["订阅", "/subs"],
		["推送", "/targets"],
		["图片", "/cards"],
		["AI", "/ai"],
	]) {
		const dialog = await detail(name);
		expect(within(dialog).getByRole("link", { name: "前往管理" }).getAttribute("href")).toBe(path);
		await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
	}
});

it("详情键盘焦点在弹窗内循环，关闭回到原入口", async () => {
	renderCard();
	const opener = await screen.findByRole("button", { name: "存储 · 运行中，查看详情" });
	await userEvent.click(opener);
	const dialog = screen.getByRole("dialog");
	await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
	expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "关闭" }));
	await userEvent.keyboard("{Tab}");
	expect(document.activeElement).toBe(within(dialog).getByRole("link", { name: "前往管理" }));
	await userEvent.keyboard("{Escape}");
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(document.activeElement).toBe(opener);
});
