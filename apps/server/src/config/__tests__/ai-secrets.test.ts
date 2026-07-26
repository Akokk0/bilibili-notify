/**
 * AI 密钥在「各家一套配置」下的收集 / 回填 / 剥离。
 *
 * 密钥不再是一把,而是**每个服务商桶两把**(主模型 + 看图副模型),桶最多五个。
 * 这三个函数是加密袋与 globals.json 之间唯一的通道:
 *
 *   落盘:`stripAiSecrets` 把明文抠掉 → globals.json 里一把都不留
 *   读回:`applyAiSecrets` 从加密袋灌回内存 → 引擎照旧读得到
 *   写入:`collectAiSecrets` 收集要存进袋子的
 *
 * 漏掉任何一把的后果分两种,都很难发现:
 * - `strip` 漏 → 那把 key **明文躺在 state/globals.json 里**,而这个文件不加密。
 * - `apply` 漏 → 重启后那家静默失效(内存里是空 key),看着像「配置丢了」。
 *
 * 所以这里刻意遍历所有桶断言,不挑一两家试 —— 写死家数的实现会在注册表加一家时
 * 静默漏掉新那家。
 */

import { AI_PROVIDER_IDS, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { applyAiSecrets, collectAiSecrets, stripAiSecrets } from "../ai-secrets.js";

function profile(over: Record<string, unknown> = {}) {
	return {
		apiKey: "",
		baseUrl: "",
		model: "",
		temperature: 0.7,
		enableThinking: false,
		thinkingLevel: "medium" as const,
		extraParams: "",
		enableVision: false,
		vision: { baseUrl: "", apiKey: "", model: "" },
		...over,
	};
}

/** 每家都配齐、两把 key 都填了。 */
function withAllBuckets() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.providers = Object.fromEntries(
		AI_PROVIDER_IDS.map((id) => [
			id,
			profile({
				apiKey: `sk-main-${id}`,
				vision: { baseUrl: "", apiKey: `sk-v-${id}`, model: "" },
			}),
		]),
	);
	return g;
}

describe("collectAiSecrets", () => {
	it("每桶两把全收进来,键能认出是谁的", () => {
		const bag = collectAiSecrets(withAllBuckets());
		for (const id of AI_PROVIDER_IDS) {
			expect(bag[id]).toBe(`sk-main-${id}`);
			expect(bag[`${id}:vision`]).toBe(`sk-v-${id}`);
		}
	});

	it("空 key 不进袋 —— 袋里存个空串等于把「未配置」写成「配置了空的」", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = { deepseek: profile({ apiKey: "sk-x" }) };
		const bag = collectAiSecrets(g);
		expect(bag).toEqual({ deepseek: "sk-x" });
	});

	it("一家都没添加时是个空袋", () => {
		expect(collectAiSecrets(makeDefaultGlobalConfig())).toEqual({});
	});
});

describe("stripAiSecrets — 落盘前抠干净", () => {
	it("序列化之后搜不到任何一段真 key", () => {
		const json = JSON.stringify(stripAiSecrets(withAllBuckets()));
		expect(json).not.toContain("sk-main-");
		expect(json).not.toContain("sk-v-");
	});

	it("抠的是密钥,不碰同桶的别的字段", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = {
			deepseek: profile({
				apiKey: "sk-x",
				baseUrl: "https://api.deepseek.com",
				model: "deepseek-v4-pro",
				vision: { baseUrl: "https://other/v1", apiKey: "sk-v", model: "qwen-vl" },
			}),
		};
		const out = stripAiSecrets(g).defaults.ai.providers.deepseek;
		expect(out?.baseUrl).toBe("https://api.deepseek.com");
		expect(out?.model).toBe("deepseek-v4-pro");
		expect(out?.vision.baseUrl).toBe("https://other/v1");
		expect(out?.vision.model).toBe("qwen-vl");
	});

	it("不改动传进来的那份 —— 内存里的明文还要给引擎用", () => {
		const g = withAllBuckets();
		stripAiSecrets(g);
		expect(g.defaults.ai.providers.deepseek?.apiKey).toBe("sk-main-deepseek");
	});
});

describe("applyAiSecrets — 读回时灌回内存", () => {
	it("袋里的每一把都回到自己的桶", () => {
		const stripped = stripAiSecrets(withAllBuckets());
		const bag = collectAiSecrets(withAllBuckets());
		const out = applyAiSecrets(stripped, bag);
		for (const id of AI_PROVIDER_IDS) {
			expect(out.defaults.ai.providers[id]?.apiKey).toBe(`sk-main-${id}`);
			expect(out.defaults.ai.providers[id]?.vision.apiKey).toBe(`sk-v-${id}`);
		}
	});

	it("收集 → 剥离 → 回填 是个恒等回路", () => {
		// 这条一红,就意味着「重启一次配置就掉一部分」。
		const g = withAllBuckets();
		expect(applyAiSecrets(stripAiSecrets(g), collectAiSecrets(g))).toEqual(g);
	});

	it("袋里没有对应键的桶,key 归空串而不是 undefined", () => {
		// 下游 `!p.apiKey` 判「还没配齐」,undefined 也成立;但空串能与 zod
		// 的默认形状对上,避免 globals 偏离 parse 后的规范形态(那会让引擎的
		// config-changed diff 误判)。
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = { deepseek: profile({ apiKey: "sk-x" }) };
		const out = applyAiSecrets(stripAiSecrets(g), {});
		expect(out.defaults.ai.providers.deepseek?.apiKey).toBe("");
	});

	it("袋里有一把属于「还没添加的家」→ 忽略,不凭空造桶", () => {
		// 主人删掉一家但袋里还留着它的 key 时会走到这儿。造出桶来的话,
		// 设置页左栏会凭空多一块。
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = { deepseek: profile({ apiKey: "sk-x" }) };
		const out = applyAiSecrets(g, { deepseek: "sk-x", openrouter: "sk-ghost" });
		expect(Object.keys(out.defaults.ai.providers)).toEqual(["deepseek"]);
	});
});
