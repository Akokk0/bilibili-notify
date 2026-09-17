/**
 * 「请 AI 帮忙写」那条流的读法 —— 服务端事件名与载荷在这一层被解释,对不上的话两边的
 * 测试各自全绿、真机上框里一个字都不进。事件形状照 `CardSkinAiCssEvent` 手写成线格式。
 */

import type { CardSkinAiCssEvent } from "@bilibili-notify/contract";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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
				{ event: "retry", data: { errors: ["解析失败"] } },
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
		expect(url).toBe("/api/card-skins/neon/ai-css");
		expect(JSON.parse(init.body as string)).toEqual(BODY);
		expect(init.signal).toBe(ctl.signal);
	});

	it("error 事件 → 抛出,原因带着", async () => {
		vi.stubGlobal("fetch", async () =>
			sse([{ event: "error", data: { errors: ["超过上限", "解析失败"] } }]),
		);
		await expect(
			streamCardSkinAiCss("neon", BODY, { onRule: () => {}, onRetry: () => {} }, undefined),
		).rejects.toThrow(/超过上限[\s\S]*解析失败/);
	});

	it("开流之前就被拒 → 抛服务端那句话", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ ok: false, errors: ["还没配好模型"] }), { status: 503 }),
		);
		await expect(
			streamCardSkinAiCss("neon", BODY, { onRule: () => {}, onRetry: () => {} }, undefined),
		).rejects.toThrow("还没配好模型");
	});

	it("流断了既没 done 也没 error → 当失败,别当成写完了", async () => {
		vi.stubGlobal("fetch", async () => sse([{ event: "rule", data: { text: ".a{x:1}" } }]));
		await expect(
			streamCardSkinAiCss("neon", BODY, { onRule: () => {}, onRetry: () => {} }, undefined),
		).rejects.toThrow(/中断/);
	});
});
