/**
 * 联网搜索适配层 —— 两家(博查 / Tavily)协议互不兼容,这里把它们统一成
 * `WebSearchExecutor`。请求形状按**官方实测契约**钉死:
 *
 * - 博查:POST api.bochaai.com/v1/web-search,结果嵌在 `data.webPages.value`
 *   (字段名 `name`/`summary`,微软 Bing 系的命名),来源是博查官方 MCP server 源码。
 * - Tavily:POST api.tavily.com/search,结果平铺在 `results`(字段名 `title`/`content`),
 *   来源是 docs.tavily.com 的 API reference。
 *
 * fetch 用 vi.stubGlobal mock,不打真实网络(对齐 qq-official-auth.test.ts)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWebSearchExecutor, WebSearchError } from "../web-search";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonRes(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
	return new Response(JSON.stringify(body), { status: init.status ?? 200 });
}

/** 博查的正常响应,两条结果。字段名与官方 MCP server 读取的一致。 */
function bochaBody(values: Array<Record<string, unknown>>) {
	return { code: 200, data: { webPages: { value: values } } };
}

const BOCHA_ONE = {
	name: "B 站 2026 年二季度财报",
	url: "https://example.com/report",
	summary: "哔哩哔哩公布了 2026 年第二季度财务报告……",
	snippet: "短摘要",
	datePublished: "2026-08-10T00:00:00Z",
	siteName: "示例新闻",
};

describe("createWebSearchExecutor — 博查", () => {
	it("请求形状:端点 / Bearer / body 字段一个不差", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes(bochaBody([])));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "sk-test" });
		await ex.search("b站 财报");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.bochaai.com/v1/web-search");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
		expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
		expect(JSON.parse(init.body as string)).toEqual({
			query: "b站 财报",
			summary: true,
			freshness: "noLimit",
			count: 5,
		});
	});

	it("响应映射:name→title、summary→snippet、datePublished→publishedAt", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes(bochaBody([BOCHA_ONE])));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "k" });
		const results = await ex.search("q");
		expect(results).toEqual([
			{
				title: "B 站 2026 年二季度财报",
				url: "https://example.com/report",
				snippet: "哔哩哔哩公布了 2026 年第二季度财务报告……",
				siteName: "示例新闻",
				publishedAt: "2026-08-10T00:00:00Z",
			},
		]);
	});

	it("summary 缺席时退回 snippet —— summary:true 只是请求,上游不保证给", async () => {
		const { summary: _, ...noSummary } = BOCHA_ONE;
		fetchMock.mockResolvedValueOnce(jsonRes(bochaBody([noSummary])));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "k" });
		const results = await ex.search("q");
		expect(results[0].snippet).toBe("短摘要");
	});

	it("webPages 整段缺席 = 没搜到,回空数组而不是炸", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ code: 200, data: {} }));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "k" });
		await expect(ex.search("q")).resolves.toEqual([]);
	});
});

describe("createWebSearchExecutor — Tavily", () => {
	it("请求形状:端点 / Bearer / max_results / search_depth", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ results: [] }));
		const ex = createWebSearchExecutor({ backend: "tavily", apiKey: "tvly-x", count: 3 });
		await ex.search("bilibili earnings");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.tavily.com/search");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tvly-x");
		expect(JSON.parse(init.body as string)).toEqual({
			query: "bilibili earnings",
			max_results: 3,
			search_depth: "basic",
		});
	});

	it("响应映射:title/url/content→snippet", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonRes({
				results: [{ title: "T", url: "https://e.com", content: "正文摘要", score: 0.9 }],
			}),
		);
		const ex = createWebSearchExecutor({ backend: "tavily", apiKey: "k" });
		const results = await ex.search("q");
		expect(results).toEqual([{ title: "T", url: "https://e.com", snippet: "正文摘要" }]);
	});
});

describe("createWebSearchExecutor — 公共纪律", () => {
	it("条数封顶:上游多给也只取 count 条 —— 每一条都是回灌进上下文的 token", async () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			...BOCHA_ONE,
			url: `https://e.com/${i}`,
		}));
		fetchMock.mockResolvedValueOnce(jsonRes(bochaBody(many)));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "k", count: 4 });
		const results = await ex.search("q");
		expect(results).toHaveLength(4);
	});

	it("snippet 超长截断 —— 搜索结果是攻击者可控文本,无上限就是 token 炸弹", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonRes(bochaBody([{ ...BOCHA_ONE, summary: "长".repeat(2000) }])),
		);
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "k" });
		const [r] = await ex.search("q");
		expect(r.snippet.length).toBeLessThanOrEqual(401);
		expect(r.snippet.endsWith("…")).toBe(true);
	});

	it("非 2xx 抛 WebSearchError,消息里有状态码、没有 key", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes({ msg: "quota exceeded" }, { status: 403 }));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "sk-secret" });
		const err = await ex.search("q").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect(String(err)).toContain("403");
		expect(String(err)).not.toContain("sk-secret");
	});

	// 「搜索失败的唯一出口是 WebSearchError」是本文件自立的契约 —— 200 + 非 JSON
	// (网关维护页)时 res.json() 的 SyntaxError 曾原样外逃,回给模型/日志的是
	// 「Unexpected token <…」这类原始英文噪音而非约定的人话错误。
	it("200 + 非 JSON 正文(网关维护页)→ 也包成 WebSearchError", async () => {
		fetchMock.mockResolvedValueOnce(new Response("<html>maintenance</html>", { status: 200 }));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "sk-secret" });
		const err = await ex.search("q").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect(String(err)).not.toContain("sk-secret");
	});

	it("网络层直接 reject 也包成 WebSearchError —— 调用方只须接一种错", async () => {
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
		const ex = createWebSearchExecutor({ backend: "tavily", apiKey: "k" });
		await expect(ex.search("q")).rejects.toBeInstanceOf(WebSearchError);
	});

	it("带超时信号 —— 搜索挂起不能拖死整条生成链路", async () => {
		fetchMock.mockResolvedValueOnce(jsonRes(bochaBody([])));
		const ex = createWebSearchExecutor({ backend: "bocha", apiKey: "k" });
		await ex.search("q");
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("webSearchExecutorFromSettings — 配置到执行器的映射", () => {
	// 动态导入躲开顶部 import 收敛;这个工厂与 fetch 无关,不吃上面的 stub。
	it("当前后端的 key 为空 → null(「未配置」的唯一判据)", async () => {
		const { webSearchExecutorFromSettings } = await import("../web-search");
		expect(
			webSearchExecutorFromSettings({ backend: "bocha", keys: { bocha: "", tavily: "tvly-x" } }),
		).toBeNull();
		expect(
			webSearchExecutorFromSettings({ backend: "bocha", keys: { bocha: "   ", tavily: "" } }),
		).toBeNull();
	});

	it("key 在 → 执行器,认的是当前后端自己的那格 key", async () => {
		const { webSearchExecutorFromSettings } = await import("../web-search");
		const ex = webSearchExecutorFromSettings({
			backend: "tavily",
			keys: { bocha: "", tavily: "tvly-x" },
		});
		expect(ex?.backend).toBe("tavily");
	});
});

describe("formatWebSearchResults — 回灌模型的文本", () => {
	it("空结果必须指引模型换词重试 —— 干巴巴的「没搜到」等于叫它就地放弃", async () => {
		const { formatWebSearchResults } = await import("../web-search");
		const msg = formatWebSearchResults([]);
		// 真实案例:博查对「国际重大新闻 最新」确定性回空,模型看到旧文案
		// 直接放弃,预算里剩下的搜索次数一次没用。文案要点出「换关键词再试」。
		expect(msg).toContain("没有搜到");
		expect(msg).toMatch(/换.*关键词/);
	});
});
