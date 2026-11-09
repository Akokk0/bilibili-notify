/**
 * 单元测试 — logs 路由的 limit/day 输入校验(镜像 history-route 的
 * 「非法 query 显式 400 而非静默坏行为」契约)。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { createSystemLogsRoute } from "../system-logs.js";
import type { RouteDeps } from "../types.js";

let query: ReturnType<typeof vi.fn>;

function makeApp(root = tmpdir()) {
	query = vi.fn(async () => []);
	const deps = {
		runtime: {
			logStore: { query, dayFilePath: (d: string) => join(root, `bn-logs-test-${d}.jsonl`) },
		},
	} as unknown as RouteDeps;
	return createSystemLogsRoute(deps);
}

describe("logs route — limit/day 校验", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		i18n.set({ locale: "zh-CN", voice: "maid" });
	});
	it.each([
		[
			"en",
			[
				"limit must be a number: raw",
				"day must be a date in YYYY-MM-DD format: raw",
				"The day parameter (YYYY-MM-DD) is required.",
				"No log file was found for this day.",
			],
		],
		[
			"ja",
			[
				"limitは数値で指定してください：raw",
				"dayはYYYY-MM-DD形式の日付で指定してください：raw",
				"dayパラメーター（YYYY-MM-DD）が必要です。",
				"この日のログファイルが見つかりません。",
			],
		],
		[
			"zh-TW",
			[
				"limit 必須是數字：raw",
				"day 必須是 YYYY-MM-DD 格式的日期：raw",
				"必須提供 day 參數（YYYY-MM-DD）。",
				"找不到這一天的日誌檔案。",
			],
		],
	] as const)(
		"%s localizes log query and download failures while keeping the raw file intact",
		async (locale, text) => {
			const root = await mkdtemp(join(tmpdir(), "bn-logs-locale-"));
			try {
				const app = makeApp(root);
				i18n.set({ locale, voice: "plain" });
				for (const [url, message] of [
					["/?limit=raw", text[0]],
					["/?day=raw", text[1]],
					["/raw?day=raw", text[1]],
					["/raw", text[2]],
				] as const) {
					const res = await app.request(url);
					expect(res.status).toBe(400);
					expect(await res.json()).toEqual({ code: "invalid", message });
				}
				expect(query).not.toHaveBeenCalled();
				await mkdir(join(root, "bn-logs-test-1999-01-02.jsonl"));
				for (const day of ["1999-01-01", "1999-01-02"]) {
					const res = await app.request(`/raw?day=${day}`);
					expect(res.status).toBe(404);
					expect(await res.json()).toEqual({ code: "not_found", message: text[3] });
				}
				const raw = '{"message":"Original log 原文","event":"original.event"}\n';
				await writeFile(join(root, "bn-logs-test-1999-01-03.jsonl"), raw);
				const res = await app.request("/raw?day=1999-01-03");
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toContain("application/x-ndjson");
				expect(res.headers.get("content-disposition")).toBe(
					'attachment; filename="bilibili-notify-1999-01-03.jsonl"',
				);
				expect(await res.text()).toBe(raw);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("limit 非数字 → 400,不调用 query", async () => {
		const res = await makeApp().request("/?limit=abc");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "invalid", message: "limit 要是数字：abc" });
		expect(query).not.toHaveBeenCalled();
	});

	it("day 非 YYYY-MM-DD → 400,不调用 query", async () => {
		const res = await makeApp().request("/?day=2026_05_17");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			message: expect.stringContaining("day"),
		});
		expect(query).not.toHaveBeenCalled();
	});

	it("合法 limit → 200,clamp 后透传", async () => {
		const res = await makeApp().request("/?limit=50");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 50 });
	});

	it("limit 越界 → clamp 到 500 上限", async () => {
		await makeApp().request("/?limit=9999");
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 500 });
	});

	it("合法 day → 200 透传", async () => {
		const res = await makeApp().request("/?day=2026-05-17");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ day: "2026-05-17" });
	});

	it("无参数 → 200,默认 limit=200", async () => {
		const res = await makeApp().request("/");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 200 });
	});

	it("/raw 缺 day / 非法 day → 400", async () => {
		const missing = await makeApp().request("/raw");
		expect(missing.status).toBe(400);
		expect(await missing.json()).toMatchObject({ code: "invalid" });
		const bad = await makeApp().request("/raw?day=bad");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ code: "invalid" });
	});

	/** 这条下载是 GET,失败也是平铺的 `{ code, message }` JSON —— 面板下载时读 `message`,不是一段纯文本。 */
	it("/raw 那一天没有日志文件 → 404 not_found", async () => {
		const res = await makeApp().request("/raw?day=1999-01-01");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这一天的日志文件" });
	});
});
