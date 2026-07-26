/**
 * 单元测试 —— globals 的密钥脱敏。
 *
 * 密钥数量随「各家一套配置」翻了好几倍:**每个服务商桶里两把**(主模型的
 * `apiKey` 与看图副模型的 `vision.apiKey`),而桶最多五个。副模型常在另一家
 * (DeepSeek 没有视觉模型,跨厂商是常态而非例外),所以那把是真正独立的密钥。
 *
 * 每一把都得走同一套:GET 出去要打码,PATCH 回来见到打码占位要**保留原值**。
 * 漏掉任何一把的后果都很具体 —— 漏了脱敏,那把 key 就明文躺在浏览器的响应里;
 * 漏了 strip,主人在页面上随便改一项别的设置、点保存,就会把真 key 覆盖成
 * `__BN_REDACTED__` 这个字符串,而且**没有任何报错**,直到下次调用失败才发现。
 *
 * 所以这里刻意**遍历所有桶**去断言,而不是只挑一两家试 —— 写死家数的实现会在
 * 注册表加一家时静默漏掉那一家。
 */

import { AI_PROVIDER_IDS, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { REDACTED_API_KEY, redactGlobals, stripRedactedSecrets } from "../globals.js";

/** 造一份「每家都配齐、两把 key 都填了」的 globals,key 里嵌 provider 名便于溯源。 */
function withAllBuckets() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.providers = Object.fromEntries(
		AI_PROVIDER_IDS.map((id) => [
			id,
			{
				apiKey: `sk-main-${id}`,
				baseUrl: "https://x/v1",
				model: "m",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium" as const,
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: `sk-vision-${id}`, model: "" },
			},
		]),
	);
	return g;
}

describe("redactGlobals — 每个桶的两把 key 都要打码", () => {
	it("所有桶、两把 key 全替换成占位", () => {
		const out = redactGlobals(withAllBuckets());
		for (const id of AI_PROVIDER_IDS) {
			expect(out.defaults.ai.providers[id]?.apiKey).toBe(REDACTED_API_KEY);
			expect(out.defaults.ai.providers[id]?.vision.apiKey).toBe(REDACTED_API_KEY);
		}
	});

	it("整个响应里搜不到任何一段真 key", () => {
		// 这条是兜底:哪怕将来加了新的密钥字段,只要它带 `sk-` 前缀就会被这里抓到。
		const json = JSON.stringify(redactGlobals(withAllBuckets()));
		expect(json).not.toContain("sk-main-");
		expect(json).not.toContain("sk-vision-");
	});

	it("空值保持空 —— 前端要靠它区分「未配置」和「已配置」", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = {
			deepseek: {
				apiKey: "",
				baseUrl: "",
				model: "",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
			},
		};
		const out = redactGlobals(g);
		expect(out.defaults.ai.providers.deepseek?.apiKey).toBe("");
		expect(out.defaults.ai.providers.deepseek?.vision.apiKey).toBe("");
	});

	it("只有副模型 key 的桶也照样打码 —— 别看主 key 空就跳过整桶", () => {
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = {
			deepseek: {
				apiKey: "",
				baseUrl: "",
				model: "",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "sk-vision-only", model: "qwen-vl" },
			},
		};
		expect(redactGlobals(g).defaults.ai.providers.deepseek?.vision.apiKey).toBe(REDACTED_API_KEY);
	});

	it("没添加过的家不会被凭空造出来", () => {
		// 打码顺手补全五个桶的话,设置页左栏会凭空多出四家。
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.providers = {
			deepseek: {
				apiKey: "sk-x",
				baseUrl: "",
				model: "",
				temperature: 0.7,
				enableThinking: false,
				thinkingLevel: "medium",
				extraParams: "",
				enableVision: false,
				vision: { baseUrl: "", apiKey: "", model: "" },
			},
		};
		expect(Object.keys(redactGlobals(g).defaults.ai.providers)).toEqual(["deepseek"]);
	});

	it("一把 key 都没配时原对象直出,不做无谓复制", () => {
		const g = makeDefaultGlobalConfig();
		expect(redactGlobals(g)).toBe(g);
	});
});

describe("stripRedactedSecrets — 占位回传即保留原值", () => {
	type AiPatch = { defaults: { ai: { providers: Record<string, Record<string, unknown>> } } };
	/** 取一个桶。tsconfig 开了 noUncheckedIndexedAccess,索引结果要兜一下才能断言。 */
	const bucket = (out: unknown, id: string): Record<string, unknown> =>
		(out as AiPatch).defaults.ai.providers[id] ?? {};

	it("桶里的主 key 是占位 → 剔除,不覆盖真值", () => {
		const patch = {
			defaults: { ai: { providers: { deepseek: { apiKey: REDACTED_API_KEY, model: "ds" } } } },
		};
		const out = stripRedactedSecrets(patch);
		expect(bucket(out, "deepseek")).not.toHaveProperty("apiKey");
		// 同一桶的其他字段必须留着 —— 主人这次改的就是模型名。
		expect(bucket(out, "deepseek").model).toBe("ds");
	});

	it("桶里的副模型 key 是占位 → 剔除,同层其他字段留着", () => {
		const patch = {
			defaults: {
				ai: {
					providers: { deepseek: { vision: { apiKey: REDACTED_API_KEY, model: "qwen-vl" } } },
				},
			},
		};
		const out = stripRedactedSecrets(patch);
		const vision = bucket(out, "deepseek").vision as Record<string, unknown>;
		expect(vision).not.toHaveProperty("apiKey");
		expect(vision.model).toBe("qwen-vl");
	});

	it("多个桶同时回传占位 → 每桶两把都剔除", () => {
		const patch = {
			defaults: {
				ai: {
					providers: {
						deepseek: { apiKey: REDACTED_API_KEY, vision: { apiKey: REDACTED_API_KEY } },
						openrouter: { apiKey: REDACTED_API_KEY, vision: { apiKey: REDACTED_API_KEY } },
					},
				},
			},
		};
		const out = stripRedactedSecrets(patch);
		for (const id of ["deepseek", "openrouter"]) {
			expect(bucket(out, id)).not.toHaveProperty("apiKey");
			expect(bucket(out, id).vision).not.toHaveProperty("apiKey");
		}
	});

	it("主人真的换了 key → 原样放行,不能当占位吞掉", () => {
		const patch = {
			defaults: {
				ai: {
					providers: {
						deepseek: { apiKey: "sk-brand-new", vision: { apiKey: "sk-vision-new" } },
					},
				},
			},
		};
		const out = stripRedactedSecrets(patch);
		expect(bucket(out, "deepseek").apiKey).toBe("sk-brand-new");
		expect((bucket(out, "deepseek").vision as Record<string, unknown>).apiKey).toBe(
			"sk-vision-new",
		);
	});

	it("只改了别的设置(patch 里压根没有 providers)时不炸也不改动", () => {
		const patch = { defaults: { ai: { provider: "deepseek" } } };
		expect(stripRedactedSecrets(patch)).toBe(patch);
	});

	it("patch 里完全没碰 ai 时原样返回", () => {
		const patch = { defaults: { cardStyle: { enabled: false } } };
		expect(stripRedactedSecrets(patch)).toBe(patch);
	});
});
