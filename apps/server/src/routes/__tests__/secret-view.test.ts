/**
 * 单元测试 —— 下发给浏览器的核心设置:密钥格换 `{ masked }`(ADR-0021 决策 44)。
 *
 * 密钥数量随「各家一套配置」翻了好几倍:**每个服务商桶里两把**(主模型的 `apiKey` 与看图副模型的
 * `vision.apiKey`),外加联网搜索每个后端一把。副模型常在另一家,所以那把是真正独立的密钥。
 *
 * 判据是 schema 上的 `secret` 标记,不是键名 —— 所以这里刻意**遍历所有桶**去断言:写死家数 / 键名的
 * 实现会在注册表加一家时静默漏掉那一家,那就是明文 key 直接进浏览器。
 */

import { AI_PROVIDER_IDS, makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { globalConfigView } from "../secret-view.js";

const DOTS = "••••••••";

/** 造一份「每家都配齐、两把 key 都填了」的 globals,key 里嵌 provider 名便于溯源。 */
function withAllBuckets() {
	const g = makeDefaultGlobalSettings();
	g.ai.providers = Object.fromEntries(
		AI_PROVIDER_IDS.map((id) => [
			id,
			{
				provider: id,
				label: "",
				apiKey: `sk-main-${id}`,
				baseUrl: "https://x/v1",
				model: "m",
				apiFlavor: "chat" as const,
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

function bucket(apiKey: string, visionKey = "") {
	return {
		provider: "deepseek" as const,
		label: "",
		apiKey,
		baseUrl: "",
		model: "",
		apiFlavor: "chat" as const,
		enableThinking: false,
		thinkingLevel: "medium" as const,
		extraParams: "",
		enableVision: false,
		vision: { baseUrl: "", apiKey: visionKey, model: "qwen-vl" },
	};
}

describe("globalConfigView — 每个桶的两把 key 都要打码", () => {
	it("所有桶、两把 key 全换成 { masked }", () => {
		const out = globalConfigView(withAllBuckets());
		for (const id of AI_PROVIDER_IDS) {
			expect(out.ai.providers[id]?.apiKey).toEqual({ masked: DOTS });
			expect(out.ai.providers[id]?.vision.apiKey).toEqual({ masked: DOTS });
		}
	});

	it("整个响应里搜不到任何一段真 key", () => {
		// 兜底:哪怕将来加了新的密钥字段,只要它带 `sk-` 前缀又标了 secret 就会被这里抓到。
		const json = JSON.stringify(globalConfigView(withAllBuckets()));
		expect(json).not.toContain("sk-main-");
		expect(json).not.toContain("sk-vision-");
	});

	it("baseUrl 是仅备份那一档,面板照常看见明文", () => {
		const out = globalConfigView(withAllBuckets());
		expect(out.ai.providers.deepseek?.baseUrl).toBe("https://x/v1");
	});

	it("空值保持空串 —— 前端要靠它区分「未配置」和「已配置」", () => {
		const g = makeDefaultGlobalSettings();
		g.ai.providers = { deepseek: bucket("") };
		const out = globalConfigView(g);
		expect(out.ai.providers.deepseek?.apiKey).toBe("");
		expect(out.ai.providers.deepseek?.vision.apiKey).toBe("");
	});

	it("只有副模型 key 的桶也照样打码 —— 别看主 key 空就跳过整桶", () => {
		const g = makeDefaultGlobalSettings();
		g.ai.providers = { deepseek: bucket("", "sk-vision-only") };
		expect(globalConfigView(g).ai.providers.deepseek?.vision.apiKey).toEqual({
			masked: DOTS,
		});
	});

	it("没添加过的家不会被凭空造出来", () => {
		const g = makeDefaultGlobalSettings();
		g.ai.providers = { deepseek: bucket("sk-x") };
		expect(Object.keys(globalConfigView(g).ai.providers)).toEqual(["deepseek"]);
	});

	it("联网搜索的 key:非空换遮挡,空的保持空串", () => {
		const g = makeDefaultGlobalSettings();
		g.ai.search.keys = { bocha: "sk-bocha", tavily: "" };
		const out = globalConfigView(g);
		expect(out.ai.search.keys.bocha).toEqual({ masked: DOTS });
		expect(out.ai.search.keys.tavily).toBe("");
		expect(JSON.stringify(out)).not.toContain("sk-bocha");
	});

	it("24 位及以上露头尾各 4 位", () => {
		const g = makeDefaultGlobalSettings();
		g.ai.providers = { deepseek: bucket(`sk-a${"x".repeat(20)}-end`) };
		expect(globalConfigView(g).ai.providers.deepseek?.apiKey).toEqual({
			masked: `sk-a${DOTS}-end`,
		});
	});

	it("不改传进来的那份(store 里仍是真 key)", () => {
		const g = withAllBuckets();
		globalConfigView(g);
		expect(g.ai.providers.deepseek?.apiKey).toBe("sk-main-deepseek");
	});
});
