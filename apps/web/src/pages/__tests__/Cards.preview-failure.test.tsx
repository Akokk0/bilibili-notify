// @vitest-environment jsdom

/**
 * 卡片预览失败时,面板怎么分情况(ADR-0026)。
 *
 * 从前面板靠**状态码 503**认「没配浏览器」并摆出「一键检测并启用 Chrome」—— 可同一个 503 里还
 * 混着「引擎还没就绪」「皮肤库还没就绪」,后者等一会儿就好,摆一个配 Chrome 的挂件是误导。
 * 现在服务端把两件事分开:没配浏览器是 `not_configured`,引擎没就绪是 `unavailable`;面板只按
 * **码**判,不看状态码。
 *
 * 「画一张、回报结果」的失败(渲染抛错)是 200 + 失败那一支(`Result`),不是非 2xx —— 面板把它
 * 造成同样带 `code` / `message` 的错,与非 2xx 走同一条路。测试推送同理:送达带 `latencyMs`,
 * 没送达带 `message`(对端的原话),面板读 `message`,不再读旧的 `err`。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraftStore } from "../../store/draft";
import type { GlobalSettings } from "../../types/globals";
import Cards from "../Cards";
import { makeDefaults, makeSource } from "../rules/__tests__/fixtures";

vi.mock("../../services/api", () => {
	// 与真 `ApiError` 一样:`code` 从错误体里读出来。
	class ApiError extends Error {
		code?: string;
		constructor(
			readonly status: number,
			readonly body: unknown,
			message: string,
		) {
			super(message);
			this.code = (body as { code?: string } | undefined)?.code;
		}
	}
	return {
		api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn() },
		ApiError,
		OFFLINE_STATUS: 0,
	};
});

import { i18n } from "../../i18n";
import { ApiError, api } from "../../services/api";

// This scenario uses Chinese UI; it must not depend on untranslated fallbacks.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});

const GLOBALS = {
	logging: {},
	master: {},
	defaults: makeDefaults(),
} as unknown as GlobalSettings;

const NO_CHROME = "puppeteer 未配置 — 设置 BN_CHROME_PATH（本地 Chromium 路径）";
const NOT_READY = "服务还没准备好，请稍后重试";

function renderCards() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<MemoryRouter>
			<QueryClientProvider client={qc}>
				<Cards />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

/** 让预览请求按给定的方式失败(其余请求给空对象)。 */
function failPreviewWith(fail: () => Promise<unknown>) {
	vi.mocked(api.post).mockImplementation(async (url: string) =>
		url === "/api/cards/preview" ? fail() : {},
	);
}

const AUTO_DETECT = { name: /自动探测 Chrome/ };

/**
 * 全家福四张卡各自防抖 500ms、请求还排着串行队列,错误是一张一张冒出来的 —— 等到四张都失败了
 * 再断言,不然「不摆挂件」这种反向断言可能在后面几张还没出来时就白过了。
 */
async function allFourFailed(text: string | RegExp): Promise<void> {
	await waitFor(() => expect(screen.getAllByText(text).length).toBe(4), { timeout: 8000 });
}

beforeEach(() => {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.mocked(api.get).mockImplementation((url: string) => {
		if (url.includes("/api/subscriptions")) return Promise.resolve([]);
		if (url === "/api/connections") return Promise.resolve([]);
		if (url.includes("/api/targets")) return Promise.resolve([]);
		if (url === "/api/sources") return Promise.resolve({ sources: [makeSource()] });
		return Promise.resolve({ core: GLOBALS });
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("预览失败:挂件与标题按码挑", () => {
	it("没配浏览器(not_configured,409)→ 摆出「一键检测并启用 Chrome」,标题说未配置", async () => {
		failPreviewWith(async () => {
			throw new ApiError(409, { code: "not_configured", message: NO_CHROME }, NO_CHROME);
		});
		renderCards();

		await allFourFailed("puppeteer 未配置");
		expect(screen.getAllByRole("button", AUTO_DETECT)).toHaveLength(4);
	}, 12_000);

	it("引擎还没就绪(unavailable,503)→ 只说原话,不摆配 Chrome 的挂件(从前同一个 503 会误摆)", async () => {
		failPreviewWith(async () => {
			throw new ApiError(503, { code: "unavailable", message: NOT_READY }, NOT_READY);
		});
		renderCards();

		await allFourFailed(NOT_READY);
		expect(screen.getAllByText("渲染失败")).toHaveLength(4);
		expect(screen.queryByRole("button", AUTO_DETECT)).toBeNull();
		expect(screen.queryByText("puppeteer 未配置")).toBeNull();
	}, 12_000);

	it("渲染抛错(200 + 失败那一支)→ 同样按码读:原话显示,不摆挂件", async () => {
		failPreviewWith(async () => ({
			ok: false,
			code: "unavailable",
			message: "卡片渲染失败：Failed to launch the browser process",
		}));
		renderCards();

		await allFourFailed("卡片渲染失败：Failed to launch the browser process");
		expect(screen.queryByRole("button", AUTO_DETECT)).toBeNull();
	}, 12_000);

	it("200 + 失败那一支的码是 not_configured → 也摆挂件(认的是码,不是 HTTP 状态)", async () => {
		failPreviewWith(async () => ({ ok: false, code: "not_configured", message: NO_CHROME }));
		renderCards();

		await allFourFailed("puppeteer 未配置");
		expect(screen.getAllByRole("button", AUTO_DETECT)).toHaveLength(4);
	}, 12_000);
});

describe("测试推送的结果", () => {
	const TARGET = { id: "t1", name: "群一", enabled: true };

	/** 点开 SC 那个类型 tab(测试推送只在类型 tab 里),点「测试推送」;预览照常画得出来。 */
	async function clickTestPush(reply: () => Promise<unknown>): Promise<void> {
		vi.mocked(api.get).mockImplementation((url: string) => {
			if (url === "/api/connections") return Promise.resolve([]);
			if (url.includes("/api/targets")) return Promise.resolve([TARGET]);
			if (url.includes("/api/subscriptions")) return Promise.resolve([]);
			return Promise.resolve({ core: GLOBALS });
		});
		vi.mocked(api.post).mockImplementation(async (url: string) =>
			url === "/api/cards/test" ? reply() : { ok: true, dataUrl: "data:image/png;base64,xx" },
		);
		renderCards();
		fireEvent.click((await screen.findAllByRole("button", { name: "SC 提醒" }))[0] as HTMLElement);
		const btn = (await screen.findByRole("button", { name: "测试推送" })) as HTMLButtonElement;
		await waitFor(() => expect(btn.disabled).toBe(false));
		fireEvent.click(btn);
	}

	it.each([
		[
			"en",
			"Sending…",
			"Test push",
			"Delivered · 12ms",
			"A sample card was sent: Original reason 原因",
			"Push failed: Original diagnostic 原文",
		],
		[
			"ja",
			"送信中…",
			"テスト送信",
			"送信完了 · 12ms",
			"サンプルカードを送信しました：Original reason 原因",
			"送信失敗：Original diagnostic 原文",
		],
		[
			"zh-TW",
			"推播中…",
			"測試推播",
			"已送達 · 12ms",
			"已推播範例卡片：Original reason 原因",
			"推播失敗：Original diagnostic 原文",
		],
	] as const)(
		"%s test push localizes pending and result text while preserving diagnostics and sending once per click",
		async (locale, pending, button, delivered, sample, failed) => {
			let finish: ((response: unknown) => void) | undefined;
			const response = new Promise((resolve) => {
				finish = resolve;
			});
			await clickTestPush(() => response);
			act(() => i18n.set({ locale, voice: "plain" }));
			const sending = screen.getByRole("button", { name: pending }) as HTMLButtonElement;
			expect(sending.disabled).toBe(true);
			if (!finish) throw new Error("test push was not started");
			await act(async () => {
				finish?.({ ok: true, latencyMs: 12, sampleReason: "Original reason 原因" });
			});
			expect(await screen.findByText(delivered)).toBeTruthy();
			expect(screen.getByText(sample)).toBeTruthy();
			vi.mocked(api.post).mockImplementation(async (url: string) =>
				url === "/api/cards/test"
					? { ok: false, code: "unavailable", message: "Original diagnostic 原文" }
					: { ok: true, dataUrl: "data:image/png;base64,xx" },
			);
			fireEvent.click(screen.getByRole("button", { name: button }));
			expect(await screen.findByText(failed)).toBeTruthy();
			const sent = vi.mocked(api.post).mock.calls.filter(([url]) => url === "/api/cards/test");
			expect(sent).toHaveLength(2);
			for (const [, body] of sent)
				expect(body).toMatchObject({
					targetId: "t1",
					kind: "superchat",
					content: { amount: 30, rank: 1, durationSec: 60 },
				});
			expect(api.patch).not.toHaveBeenCalled();
		},
	);

	it("送达({ ok: true, latencyMs })→「已送达 · 耗时」", async () => {
		await clickTestPush(async () => ({ ok: true, latencyMs: 12 }));
		expect(await screen.findByText("已送达 · 12ms")).toBeTruthy();
	});

	it("没送达(200 + 失败那一支)→「推送失败:」加对端的原话(读 message,不再读 err)", async () => {
		await clickTestPush(async () => ({ ok: false, code: "unavailable", message: "群不存在" }));
		expect(await screen.findByText("推送失败:群不存在")).toBeTruthy();
	});

	it("请求被拒(非 2xx,如没配浏览器)→ 同样「推送失败:」加服务端那句话", async () => {
		await clickTestPush(async () => {
			throw new ApiError(409, { code: "not_configured", message: NO_CHROME }, NO_CHROME);
		});
		expect(await screen.findByText(`推送失败:${NO_CHROME}`)).toBeTruthy();
	});
});
