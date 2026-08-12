import type { WebSearchBackendId } from "@bilibili-notify/internal/constants";

/**
 * 联网搜索适配层 —— 把博查 / Tavily 两家互不兼容的协议统一成 `WebSearchExecutor`。
 *
 * 这是 `web_search` 工具的**执行方**:工具协议(挂给哪个模型、每轮调几次)在
 * `commentary-generator`,这里只管「一句 query 进,一列结构化结果出」。两家的
 * 请求形状都按官方实测契约钉死 —— 博查来自其官方 MCP server 源码,Tavily 来自
 * docs.tavily.com;别按印象改字段名,上游不认就是静默空结果。
 */

/** 一条搜索结果,已经是平台中立的形状。 */
export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	siteName?: string;
	publishedAt?: string;
}

/** 统一的执行器接口。生成器经 `setWebSearchSource` 热取,不持有。 */
export interface WebSearchExecutor {
	readonly backend: WebSearchBackendId;
	search(query: string): Promise<WebSearchResult[]>;
}

/**
 * 搜索失败的唯一出口 —— HTTP 非 2xx、网络层 reject、超时,调用方只须接一种错。
 * 消息里**永远不掺 key**:这个错误会进日志,也可能进给主人看的降级提示。
 */
export class WebSearchError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "WebSearchError";
	}
}

/** 默认返回条数。每一条都是回灌进上下文的 token,宁少勿多。 */
const DEFAULT_COUNT = 5;
/** 单条摘要的字符上限。搜索结果是攻击者可控文本,无上限就是 token 炸弹。 */
const SNIPPET_MAX = 400;
/** 单次搜索的墙钟上限。搜索挂起不能拖死整条生成链路。 */
const TIMEOUT_MS = 10_000;

function clip(s: string): string {
	return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s;
}

export interface WebSearchExecutorConfig {
	backend: WebSearchBackendId;
	apiKey: string;
	/** 每次搜索返回几条,默认 {@link DEFAULT_COUNT}。 */
	count?: number;
}

export function createWebSearchExecutor(cfg: WebSearchExecutorConfig): WebSearchExecutor {
	const count = cfg.count ?? DEFAULT_COUNT;
	const call = cfg.backend === "bocha" ? searchBocha : searchTavily;
	return {
		backend: cfg.backend,
		search: (query) => call(query, cfg.apiKey, count),
	};
}

/**
 * 发请求并解析 JSON。错误一律包成 {@link WebSearchError} —— 上游响应体里可能
 * 带着对排障有用的话(配额、鉴权),截一小段进消息;key 在请求头里,不会出现。
 */
async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		throw new WebSearchError(`搜索请求没发出去:${e instanceof Error ? e.message : String(e)}`, {
			cause: e,
		});
	}
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new WebSearchError(`搜索后端回了 ${res.status}:${text.slice(0, 200)}`);
	}
	return res.json();
}

/** 博查:POST /v1/web-search,结果在 `data.webPages.value`,Bing 系字段名。 */
async function searchBocha(
	query: string,
	apiKey: string,
	count: number,
): Promise<WebSearchResult[]> {
	const resp = (await postJson("https://api.bochaai.com/v1/web-search", apiKey, {
		query,
		// summary:true 要更长的摘要 —— 但那只是请求,上游不保证给,映射时退回 snippet。
		summary: true,
		freshness: "noLimit",
		count,
	})) as {
		data?: {
			webPages?: {
				value?: Array<{
					name?: string;
					url?: string;
					summary?: string;
					snippet?: string;
					datePublished?: string;
					siteName?: string;
				}>;
			};
		};
	};
	const values = resp.data?.webPages?.value ?? [];
	return values.slice(0, count).map((v) => ({
		title: v.name ?? "",
		url: v.url ?? "",
		snippet: clip(v.summary ?? v.snippet ?? ""),
		...(v.siteName ? { siteName: v.siteName } : {}),
		...(v.datePublished ? { publishedAt: v.datePublished } : {}),
	}));
}

/** Tavily:POST /search,结果平铺在 `results`。 */
async function searchTavily(
	query: string,
	apiKey: string,
	count: number,
): Promise<WebSearchResult[]> {
	const resp = (await postJson("https://api.tavily.com/search", apiKey, {
		query,
		max_results: count,
		search_depth: "basic",
	})) as { results?: Array<{ title?: string; url?: string; content?: string }> };
	return (resp.results ?? []).slice(0, count).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: clip(r.content ?? ""),
	}));
}
