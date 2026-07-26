/**
 * 「额外请求参数」—— 主人手写的一段 JSON,原样摊进请求体顶层。
 *
 * 它是方言适配的**兜底口**:我们只适配了四家,而 OpenAI 兼容生态里还有几十家,
 * 加上联网搜索这种分裂得没法统一的能力(主人拍板删掉 enableSearch 就是让路给
 * 这里 —— OpenRouter 填 `plugins`、硅基填 `enable_search`,各写各的)。
 *
 * 三条要紧的契约:
 *
 * ① **非法 JSON 绝不静默吞掉。** 这是个手写文本框,写错是常态。吞掉的话主人
 *    会看着一个填好的框却毫无效果,完全无从查起。
 * ② **冲突时主人赢。** 兜底口存在的意义就是推翻我们的猜测 —— 比如嫌我们那套
 *    effort 映射不合胃口,想直接给 `reasoning.max_tokens`。
 * ③ **结构性字段必须挡住。** `messages` 被覆盖 = 整段对话凭空消失,
 *    `tools` 被覆盖 = 看图和只读工具集体失灵,而两者都表现为「女仆变笨了」,
 *    根本不会有人往这个框上想。
 */

import { describe, expect, it } from "vite-plus/test";
import { mergeExtraParams, parseExtraParams } from "../extra-params";

describe("解析", () => {
	it("空着不算错", () => {
		for (const raw of ["", "   ", undefined, null]) {
			const r = parseExtraParams(raw);
			expect(r.ok).toBe(true);
			expect(r.value).toEqual({});
		}
	});

	it("正常对象照单全收", () => {
		const r = parseExtraParams('{"enable_search": true, "top_k": 40}');
		expect(r.ok).toBe(true);
		expect(r.value).toEqual({ enable_search: true, top_k: 40 });
	});

	it("非法 JSON 报错而不是抛异常,也不是当空处理", () => {
		const r = parseExtraParams("{enable_search: true}");
		expect(r.ok).toBe(false);
		expect(r.error).toBeTruthy();
		expect(r.value).toEqual({});
	});

	it("合法 JSON 但不是对象,同样算错", () => {
		// `[1,2]` / `42` / `"x"` 都能 JSON.parse 通过,摊进请求体却毫无意义。
		for (const raw of ["[1,2]", "42", '"x"', "null"]) {
			expect(parseExtraParams(raw).ok).toBe(false);
		}
	});
});

describe("结构性字段的闸", () => {
	it.each(["model", "messages", "stream", "tools", "tool_choice"])("挡掉 %s", (key) => {
		const r = parseExtraParams(JSON.stringify({ [key]: "x", top_k: 40 }));
		expect(r.value).toEqual({ top_k: 40 });
		expect(r.dropped).toContain(key);
	});

	it("挡掉之后仍然算解析成功 —— 剩下的参数照常生效", () => {
		const r = parseExtraParams('{"messages": [], "top_k": 40}');
		expect(r.ok).toBe(true);
		expect(r.value).toEqual({ top_k: 40 });
	});

	it("整段都是危险键时,value 为空但不报错", () => {
		const r = parseExtraParams('{"messages": []}');
		expect(r.ok).toBe(true);
		expect(r.value).toEqual({});
		expect(r.dropped).toEqual(["messages"]);
	});
});

describe("合并", () => {
	it("冲突时主人写的赢", () => {
		expect(
			mergeExtraParams({ reasoning: { enabled: true, effort: "high" } }, { reasoning: "custom" }),
		).toEqual({ reasoning: "custom" });
	});

	it("不冲突的就并排放", () => {
		expect(mergeExtraParams({ enable_thinking: true }, { top_k: 40 })).toEqual({
			enable_thinking: true,
			top_k: 40,
		});
	});

	it("不改动传进来的两个对象 —— 降级重试要拿同一份 extraParams 再合一次", () => {
		const base = { enable_thinking: true };
		const extra = { top_k: 40 };
		mergeExtraParams(base, extra);
		expect(base).toEqual({ enable_thinking: true });
		expect(extra).toEqual({ top_k: 40 });
	});
});
