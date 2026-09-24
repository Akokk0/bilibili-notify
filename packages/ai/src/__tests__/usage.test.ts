/**
 * token 用量的字段读法 —— 两套协议、三家厂商扩展,读成同一个四格形状。
 *
 * 钉的是**优先级与「缺 = 不知道」**:缓存命中两个来源谁先、都有时取哪个;
 * 任何一格没报就是 undefined,绝不当 0 —— 0 是「真的一个都没有」,
 * 把「没报」写成 0 会让日志里凭空多出一笔「零缓存命中」。
 */

import { describe, expect, it } from "vite-plus/test";
import { readTokenUsage } from "../usage";

describe("readTokenUsage — chat completions 的 usage", () => {
	it("输入 / 输出 / 缓存命中 / 思考 四格各取各的字段", () => {
		expect(
			readTokenUsage({
				prompt_tokens: 12345,
				completion_tokens: 321,
				prompt_tokens_details: { cached_tokens: 11000 },
				completion_tokens_details: { reasoning_tokens: 120 },
			}),
		).toEqual({ input: 12345, cached: 11000, output: 321, reasoning: 120 });
	});

	it("缓存命中只给了厂商扩展 prompt_cache_hit_tokens(DeepSeek / 硅基流动)→ 用它", () => {
		expect(
			readTokenUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64 })
				.cached,
		).toBe(64);
	});

	it("两个缓存来源都有且一致 → 就是那个数,不相加", () => {
		expect(
			readTokenUsage({
				prompt_tokens: 100,
				prompt_tokens_details: { cached_tokens: 64 },
				prompt_cache_hit_tokens: 64,
			}).cached,
		).toBe(64);
	});

	it("两个缓存来源都有而不同 → 取较大者", () => {
		expect(
			readTokenUsage({
				prompt_tokens: 100,
				prompt_tokens_details: { cached_tokens: 0 },
				prompt_cache_hit_tokens: 64,
			}).cached,
		).toBe(64);
		expect(
			readTokenUsage({
				prompt_tokens: 100,
				prompt_tokens_details: { cached_tokens: 80 },
				prompt_cache_hit_tokens: 64,
			}).cached,
		).toBe(80);
	});

	it("缓存命中是输入的一部分 —— 输入原样照读,不把缓存加进去", () => {
		expect(
			readTokenUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }).input,
		).toBe(100);
	});

	it("没报的格子是 undefined,不是 0", () => {
		expect(readTokenUsage({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({
			input: 100,
			cached: undefined,
			output: 5,
			reasoning: undefined,
		});
	});

	it("真报了 0 就是 0 —— 与「没报」分得开", () => {
		expect(
			readTokenUsage({
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 0 },
			}),
		).toEqual({ input: 100, cached: 0, output: 5, reasoning: 0 });
	});
});

describe("readTokenUsage — Responses API 的 usage", () => {
	it("input_tokens / output_tokens 与两个 details 里的缓存、思考", () => {
		expect(
			readTokenUsage({
				input_tokens: 900,
				output_tokens: 70,
				input_tokens_details: { cached_tokens: 512 },
				output_tokens_details: { reasoning_tokens: 30 },
			}),
		).toEqual({ input: 900, cached: 512, output: 70, reasoning: 30 });
	});

	it("没带 details → 缓存与思考那两格是 undefined", () => {
		expect(readTokenUsage({ input_tokens: 900, output_tokens: 70 })).toEqual({
			input: 900,
			cached: undefined,
			output: 70,
			reasoning: undefined,
		});
	});
});

describe("readTokenUsage — 拿不到就什么都不编", () => {
	it("usage 缺席 / 是 null / 不是对象 → 四格全 undefined", () => {
		const blank = { input: undefined, cached: undefined, output: undefined, reasoning: undefined };
		expect(readTokenUsage(undefined)).toEqual(blank);
		expect(readTokenUsage(null)).toEqual(blank);
		expect(readTokenUsage("42")).toEqual(blank);
	});

	it("字段不是数字(网关塞了字符串 / null / 负数)→ 当没报", () => {
		expect(
			readTokenUsage({
				prompt_tokens: "100",
				completion_tokens: null,
				prompt_tokens_details: { cached_tokens: -1 },
				completion_tokens_details: null,
			}),
		).toEqual({ input: undefined, cached: undefined, output: undefined, reasoning: undefined });
	});

	it("两个缓存来源一个是垃圾、一个是数 → 用那个数", () => {
		expect(
			readTokenUsage({
				prompt_tokens: 100,
				prompt_tokens_details: { cached_tokens: null },
				prompt_cache_hit_tokens: 64,
			}).cached,
		).toBe(64);
	});
});
