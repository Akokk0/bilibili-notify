// @vitest-environment jsdom

/**
 * 回归测试 —— 全家福的四张卡不许一起打出去。
 *
 * 用户报告(0.5.1 升级后):卡片页四格里第一张出图正常,另外三张全是「渲染失败 ·
 * Failed to fetch」,而服务端日志一路「渲染完成」,没有任何错误。
 *
 * 根因不在渲染。服务端所有 puppeteer 渲染本来就串行(runtime/serial-gate.ts,治的是
 * 冷启动时 CDP 竞态把一张卡平铺成 2×2),而前端把四个预览请求**同时**发出去 —— 后三
 * 个只是挂在闸门口空等。最后一张要等前三张全渲完,Docker 里 chromium 还得冷启动,
 * 累计几十秒轻而易举,反向代理的读超时(nginx 默认 60s)一到就把连接切了。
 *
 * 所以排队要排在浏览器这边:轮到了才发请求,每条 HTTP 连接的存活时间就只剩自己那张
 * 卡的渲染时间。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import type { GlobalConfig } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => ({
	api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
	ApiError: class extends Error {},
	OFFLINE_STATUS: 0,
}));

import { api } from "../../services/api";

const GLOBALS = {
	app: {},
	master: {},
	defaults: makeDefaults(),
} as unknown as GlobalConfig;

/** 卡住不 resolve 的预览请求 —— 用它观察「下一个有没有抢跑」。 */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((res) => {
		open = res;
	});
	return { opened, open };
}

function previewCalls(): unknown[] {
	return vi.mocked(api.post).mock.calls.filter(([url]) => url === "/api/cards/preview");
}

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Cards />
		</QueryClientProvider>,
	);
}

const held = gate();

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subs")) return Promise.resolve([]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		return Promise.resolve(GLOBALS);
	});
});

afterEach(() => {
	// 放闸,别把没 settle 的任务留在模块级队列里拖累后面的测试。
	held.open();
	cleanup();
	vi.clearAllMocks();
});

describe("全家福预览的请求节奏", () => {
	it("同一时刻只有一个预览请求在飞 —— 第一个没回来,第二个不发", async () => {
		vi.mocked(api.post).mockImplementation(async (url: string) => {
			if (url !== "/api/cards/preview") return {};
			await held.opened;
			return { ok: true, dataUrl: "data:image/png;base64,xx" };
		});

		renderCards();

		// 防抖 500ms 之后第一个请求出发(四张卡各自防抖,但队列只放行一个)。
		await waitFor(() => expect(previewCalls()).toHaveLength(1), { timeout: 3000 });

		// 再宽限一会儿:若没有排队,另外三个早该一起打出去了。
		await new Promise((r) => setTimeout(r, 400));
		expect(previewCalls()).toHaveLength(1);

		// 放行第一个 → 后面的才依次跟上。
		held.open();
		await waitFor(() => expect(previewCalls().length).toBeGreaterThan(1), { timeout: 3000 });
	});

	it("全部放行后四种卡片一个不落", async () => {
		vi.mocked(api.post).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,xx" });

		renderCards();

		await waitFor(
			() => {
				const kinds = new Set(
					previewCalls().map((c) => (c as [string, { kind?: string }])[1]?.kind),
				);
				expect(kinds).toEqual(new Set(["live", "dyn", "sc", "guard"]));
			},
			{ timeout: 5000 },
		);
	});
});
