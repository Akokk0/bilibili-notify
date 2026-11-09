// @vitest-environment jsdom

/**
 * 日志页「↓ 某天.jsonl」下载。服务端的失败是平铺的 `{ code, message }` JSON(不是一行纯文本
 * `not found`),提示要读 `message` —— 从前是 `res.text()`,改成 JSON 之后会把整段 JSON 原样印给主人。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n";
import Logs from "../Logs";

vi.mock("../../hooks/useLogChannel", () => ({ useLogChannel: () => undefined }));

// 只换掉取数的 `api.get`;`apiErrorOf`(下载失败时解析错误体)要用真的。
vi.mock("../../services/api", async (importActual) => ({
	...(await importActual<typeof import("../../services/api")>()),
	api: { get: vi.fn(async () => ({ entries: [] })) },
}));

function renderLogs() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Logs />
		</QueryClientProvider>,
	);
}

describe("日志下载失败", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("那一天没有日志文件 → 提示服务端那句 message,不是整段 JSON", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ code: "not_found", message: "没有这一天的日志文件" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
		renderLogs();
		await screen.findByText("没有符合条件的日志");
		fireEvent.click(screen.getByText(/\.jsonl$/));
		await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
		expect(alertSpy).toHaveBeenCalledWith("下载失败:没有这一天的日志文件");
	});

	it.each([
		["ja", "ダウンロードに失敗しました：ご主人様、ダウンロードに失敗しました（HTTP 502）"],
		["zh-TW", "下載失敗：主人，下載失敗了（HTTP 502）"],
	] as const)("%s 女仆口吻的下载回落保留 HTTP 状态且只请求一次", async (locale, message) => {
		const fetchMock = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
		vi.stubGlobal("fetch", fetchMock);
		const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
		renderLogs();
		await screen.findByText("没有符合条件的日志");
		act(() => i18n.set({ locale, voice: "maid" }));
		fireEvent.click(screen.getByText(/\.jsonl$/));
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(message));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("体读不出来(反代的 HTML)→ 退回带状态码的一句,不抛出别的东西", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
		);
		const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
		renderLogs();
		await screen.findByText("没有符合条件的日志");
		fireEvent.click(screen.getByText(/\.jsonl$/));
		await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
		expect(alertSpy).toHaveBeenCalledWith("下载失败:下载失败（HTTP 502）");
	});
});

// This scenario explicitly tests the Chinese UI.
beforeEach(() => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
});
