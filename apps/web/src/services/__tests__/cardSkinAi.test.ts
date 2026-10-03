/**
 * 「请女仆帮忙写」那条流的读法 —— 服务端事件名与载荷在这一层被解释,对不上的话两边的
 * 测试各自全绿、真机上框里一个字都不进。事件形状照 `CardSkinAiCssEvent` 手写成线格式。
 */

import type { CardSkinAiCssEvent } from "@bilibili-notify/contract";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError } from "../api";
import { streamCardSkinAiCss } from "../cardSkinAi";

function sse(events: CardSkinAiCssEvent[], split = 7): Response {
	const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
	const bytes = new TextEncoder().encode(text);
	// 故意切成小块:网络给的分片不认帧边界。
	const body = new ReadableStream<Uint8Array>({
		start(ctl) {
			for (let i = 0; i < bytes.length; i += split) ctl.enqueue(bytes.slice(i, i + split));
			ctl.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const BODY = { kind: "live" as const, blockId: "cover", instruction: "圆角", manifest: {} };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamCardSkinAiCss", () => {
	it("rule / retry 逐个回调,done 的内容作为结果;请求带着草稿与取消信号", async () => {
		const fetch = vi.fn(async () =>
			sse([
				{ event: "rule", data: { text: ".a{x:1}" } },
				{ event: "retry", data: { issues: [{ message: "解析失败" }] } },
				{ event: "rule", data: { text: ".b{y:2}" } },
				{ event: "done", data: { css: ".b{y:2}", warnings: ["削掉一条"] } },
			]),
		);
		vi.stubGlobal("fetch", fetch);
		const rules: string[] = [];
		const retries: string[][] = [];
		const ctl = new AbortController();
		const out = await streamCardSkinAiCss(
			"neon",
			BODY,
			{ onRule: (t) => rules.push(t), onRetry: (e) => retries.push(e) },
			ctl.signal,
		);
		expect(rules).toEqual([".a{x:1}", ".b{y:2}"]);
		expect(retries).toEqual([["解析失败"]]);
		expect(out).toEqual({ css: ".b{y:2}", warnings: ["削掉一条"] });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("/api/cards/skins/neon/ai");
		expect(JSON.parse(init.body as string)).toEqual(BODY);
		expect(init.signal).toBe(ctl.signal);
	});

	/** 抓住抛出来的那个错(而不是只断言消息):码和逐条原因也要在上面。 */
	async function failureOf(): Promise<ApiError> {
		try {
			await streamCardSkinAiCss("neon", BODY, { onRule: () => {}, onRetry: () => {} }, undefined);
		} catch (e) {
			expect(e).toBeInstanceOf(ApiError);
			return e as ApiError;
		}
		throw new Error("本该抛错却没抛");
	}

	it("error 事件(与非 2xx 的错误体同形)→ 抛成 ApiError:message 是概括,码与逐条原因都在上面", async () => {
		vi.stubGlobal("fetch", async () =>
			sse([
				{
					event: "error",
					data: {
						code: "invalid",
						message: "女仆写的样式没通过检查（共 2 条）",
						issues: [{ message: "超过上限" }, { message: "解析失败" }],
					},
				},
			]),
		);
		const err = await failureOf();
		expect(err.message).toBe("女仆写的样式没通过检查（共 2 条）");
		expect(err.code).toBe("invalid");
		expect(err.issues?.map((i) => i.message)).toEqual(["超过上限", "解析失败"]);
	});

	it("error 事件:生成本身失败 → unavailable,对端的原因就在 message 里", async () => {
		vi.stubGlobal("fetch", async () =>
			sse([
				{ event: "error", data: { code: "unavailable", message: "女仆那边没写成：AI 网关超时" } },
			]),
		);
		const err = await failureOf();
		expect(err.code).toBe("unavailable");
		expect(err.message).toContain("AI 网关超时");
		expect(err.issues).toBeUndefined();
	});

	it("开流之前就被拒 → 抛服务端那句话,码也带着(面板据码分情况)", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ code: "not_configured", message: "还没配好模型" }), {
					status: 409,
					headers: { "content-type": "application/json" },
				}),
		);
		const err = await failureOf();
		expect(err.message).toBe("还没配好模型");
		expect(err.code).toBe("not_configured");
		expect(err.status).toBe(409);
	});

	it("开流之前被拒但体读不出来 → 退回带状态码的一句,不吞成空话", async () => {
		vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
		const err = await failureOf();
		expect(err.message).toBe("请求失败(502)");
		expect(err.code).toBeUndefined();
	});

	it("流断了既没 done 也没 error → 当失败,别当成写完了", async () => {
		vi.stubGlobal("fetch", async () => sse([{ event: "rule", data: { text: ".a{x:1}" } }]));
		await expect(
			streamCardSkinAiCss("neon", BODY, { onRule: () => {}, onRetry: () => {} }, undefined),
		).rejects.toThrow(/中断/);
	});
});
