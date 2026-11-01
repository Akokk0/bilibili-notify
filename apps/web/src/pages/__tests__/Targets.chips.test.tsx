// @vitest-environment jsdom
import {
	builtinAdapters,
	builtinCandidatesResponse,
} from "../../types/__tests__/connection-fixtures";

/**
 * 推送目标页的三排「一排里选一个」胶囊(平台 / OneBot 传输方式 / 作用域)。
 *
 * 收编进 ToneChip 之前这三排是手写的,而且犯着同一个毛病:**选中态用 tone 当字色**
 * —— 六个 tone 在亮色下对复合底的对比度是 2.23~3.60,一个都不过 AA(这正是
 * ToneChip 自己在 9b52a6c 修掉的);而且连未选中态那三个**静态** token 也写在
 * inline style 里,inline 压过一切 author 样式,皮肤连覆盖的机会都没有。
 *
 * 这里钉的是行为:三排各摆几颗、选中的是哪颗、点了回传什么。样式由 ToneChip
 * 自己的测试管。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PlatformMetaRoot } from "../../components/platform-meta";
import Targets from "../Targets";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
	ApiError: class extends Error {},
}));

import { api } from "../../services/api";

function renderPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<PlatformMetaRoot>
				<Targets />
			</PlatformMetaRoot>
		</QueryClientProvider>,
	);
}

/** 胶囊的选中态是 inline 的 12% tone 底 —— 未选中那颗没有 inline 背景。 */
function isActive(el: HTMLElement): boolean {
	return el.style.background.startsWith("color-mix");
}

beforeEach(() => {
	vi.mocked(api.get).mockImplementation(async (url: string) => {
		if (url === "/api/adapters") return { adapters: builtinAdapters };
		const candidates = builtinCandidatesResponse(url);
		if (candidates) return candidates;
		if (url === "/api/connections") return [];
		if (url === "/api/targets") return [];
		return [];
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function openConnectionEditor() {
	renderPage();
	const add = await screen.findByRole("button", { name: /新建连接/ });
	fireEvent.click(add);
	await screen.findByRole("button", { name: "HTTP" });
}

describe("连接弹窗的适配器胶囊", () => {
	it("先列适配器，默认选中第一项", async () => {
		await openConnectionEditor();
		for (const label of ["OneBot v11", "QQ 官方机器人", "Webhook"])
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
		expect(isActive(screen.getByRole("button", { name: "OneBot v11" }))).toBe(true);
		expect(screen.queryByRole("button", { name: /飞书/ })).toBeNull();
	});
	it("选 Webhook 后列出它的四个平台候选", async () => {
		await openConnectionEditor();
		fireEvent.click(screen.getByRole("button", { name: "Webhook" }));
		for (const name of [/飞书机器人/, /钉钉机器人/, /企业微信机器人/, /未指明的 HTTP 端点/])
			expect(await screen.findByRole("button", { name })).toBeTruthy();
		const feishu = screen.getByRole("button", { name: /飞书机器人/ });
		fireEvent.click(feishu);
		expect(feishu.getAttribute("data-bn")).toContain("option-active");
		expect(isActive(screen.getByRole("button", { name: "OneBot v11" }))).toBe(false);
	});
	it("适配器的选中色来自各自描述", async () => {
		await openConnectionEditor();
		const onebot = screen.getByRole("button", { name: "OneBot v11" }).style.borderColor;
		fireEvent.click(screen.getByRole("button", { name: "Webhook" }));
		const webhook = screen.getByRole("button", { name: "Webhook" }).style.borderColor;
		expect(webhook).not.toBe("");
		expect(webhook).not.toBe(onebot);
	});
});

describe("OneBot 传输方式胶囊", () => {
	it("摆出全部传输方式,选中的那颗有底色", async () => {
		await openConnectionEditor();
		const http = screen.getByRole("button", { name: "HTTP" });
		expect(http).toBeTruthy();
		fireEvent.click(http);
		await waitFor(() => expect(isActive(screen.getByRole("button", { name: "HTTP" }))).toBe(true));
	});

	it("切到走 webhook 的平台后这排就不在了 —— 它只属于 OneBot", async () => {
		await openConnectionEditor();
		expect(screen.queryByRole("button", { name: "HTTP" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Webhook" }));
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "HTTP" })).toBeNull();
		});
	});
});
