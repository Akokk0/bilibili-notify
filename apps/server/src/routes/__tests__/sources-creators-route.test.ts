/**
 * `GET /api/sources/:sourceKey/creators?q=` —— 新建订阅时搜人(4-15,对拍 N01)。
 *
 * 跑真 app、真来源登记表、真图库;推送链路只挂搜人那一口,搜人走真的 `searchSourceCreators`(与女仆搜人
 * 同一个宿主外壳)。候选的头像引用由路由从图库读回字节、拼成 data URL 交给面板。来源回的失败码原样回:
 * 风控、没登录不再像旧的 `/api/subscriptions/lookup` 那样一律折成 404。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreatorsResponse } from "@bilibili-notify/contract";
import {
	type CreatorCandidate,
	fail,
	ok,
	type Result,
	type Source,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { noProfile } from "../../__tests__/support/no-candidates.js";
import { createApp, createCardSkinStore } from "../../app.js";
import { settingsSegment } from "../../bilibili/settings.js";
import type { BootstrapConfig } from "../../config/schema.js";
import { i18n } from "../../i18n/index.js";
import { createAppRuntime } from "../../runtime/bootstrap.js";
import type { PipelineRuntime } from "../../runtime/pipeline.js";
import { makeIntegration } from "../../subscriptions/__tests__/fixtures.js";
import { searchSourceCreators } from "../../subscriptions/search-source-creators.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

type Search = (query: string) => Promise<Result<{ candidates: CreatorCandidate[] }>>;

function sourceOf(searchCreators: Search): Source {
	return {
		descriptor: { label: "抖音", supportedFeatures: ["post"] },
		searchCreators: (query) => searchCreators(query),
		fetchProfile: noProfile,
		start: async () => {},
		stop: async () => {},
	};
}

async function failureOf(res: Response): Promise<{ code: string; message: string }> {
	return (await res.json()) as { code: string; message: string };
}

describe("GET /api/sources/:sourceKey/creators", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sources-creators-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	/** 在册一个 `douyin` 来源(它的搜人就是传进来的函数);`pipeline: false` = 推送链路还没挂上。 */
	async function boot(search: Search, opts: { pipeline?: boolean } = {}) {
		const runtime = createAppRuntime(
			{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" } as BootstrapConfig,
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		await runtime.sourceRegistry.register("douyin", sourceOf(search), makeIntegration() as never);
		if (opts.pipeline !== false) {
			runtime.attachPipeline({
				searchCreators: (sourceKey: string, query: string) =>
					searchSourceCreators(
						{ sources: runtime.sourceRegistry, logger: runtime.serviceCtx.logger },
						sourceKey,
						query,
					),
			} as unknown as PipelineRuntime);
		}
		const app = createApp(runtime, {
			cardSkins: { store: createCardSkinStore(runtime.dataRoot) },
			extensions: { loaded: () => [], mounts: { route: new Hono() } } as never,
		});
		return { app, runtime };
	}

	it("localizes source query rejection on a held route and preserves candidate data", async () => {
		const candidate = { externalId: "raw-77", name: "原名 / Mixed" };
		const search = vi.fn(async () => ok({ candidates: [candidate] }));
		const { app, runtime } = await boot(search);
		const previous = i18n.state();
		try {
			for (const [locale, message] of [
				["en", "q must not be blank."],
				["ja", "qを空にすることはできません。"],
				["zh-TW", "q 不能為空白。"],
			] as const) {
				i18n.set({ locale, voice: "plain" });
				const calls = search.mock.calls.length;
				const rejected = await app.request("/api/sources/douyin/creators?q=");
				expect(rejected.status).toBe(400);
				expect(await rejected.json()).toEqual({ code: "invalid", message });
				expect(search).toHaveBeenCalledTimes(calls);
				const accepted = await app.request(
					`/api/sources/douyin/creators?q=${encodeURIComponent("原查 Mixed")}`,
				);
				expect(accepted.status).toBe(200);
				expect(await accepted.json()).toEqual({ candidates: [candidate] });
				expect(search).toHaveBeenLastCalledWith("原查 Mixed");
			}
		} finally {
			i18n.set(previous);
			await runtime.dispose();
		}
	});

	it("一个都认不出 —— 200 加一张空表,不是 404", async () => {
		const { app } = await boot(async () => ok({ candidates: [] }));
		const res = await app.request("/api/sources/douyin/creators?q=nobody");
		expect(res.status).toBe(200);
		const body = (await res.json()) as CreatorsResponse;
		expect(body).toEqual({ candidates: [] });
	});

	/** 粘链接时带进来的首尾空白去掉;除此之外一个字不动 —— 怎么解读是来源的事。 */
	it("q 首尾的空白去掉再交给来源,中间的原样", async () => {
		const search = vi.fn(async () => ok({ candidates: [] }));
		const { app } = await boot(search);
		await app.request(
			`/api/sources/douyin/creators?q=${encodeURIComponent("  \t抖音 作者 名\n ")}`,
		);
		expect(search).toHaveBeenCalledWith("抖音 作者 名");
	});

	it.each<[string, string]>([
		["没带 q", ""],
		["q 是空串", "?q="],
		["q 只有空白", `?q=${encodeURIComponent("   ")}`],
		["q 超过 1024 字", `?q=${"字".repeat(1025)}`],
	])("%s —— 400 invalid,不往下问", async (_label, query) => {
		const search = vi.fn(async () => ok({ candidates: [] }));
		const { app } = await boot(search);
		const res = await app.request(`/api/sources/douyin/creators${query}`);
		expect(res.status).toBe(400);
		expect((await failureOf(res)).code).toBe("invalid");
		expect(search).not.toHaveBeenCalled();
	});

	it("q 正好 1024 字 —— 照常问", async () => {
		const search = vi.fn(async () => ok({ candidates: [] }));
		const { app } = await boot(search);
		const res = await app.request(`/api/sources/douyin/creators?q=${"字".repeat(1024)}`);
		expect(res.status).toBe(200);
		expect(search).toHaveBeenCalledOnce();
	});

	// 验红:路由把来源的失败一律折成 not_found(旧 `/lookup` 的做法),风控与没登录这两行红。
	it.each<[string, Result<{ candidates: CreatorCandidate[] }>, number, string]>([
		["风控", fail("rate_limited", "被风控了"), 429, "rate_limited"],
		["没登录", fail("unauthorized", "还没登录"), 403, "unauthorized"],
		["超时", fail("timeout", "来源超过 15 秒没回"), 504, "timeout"],
		["来源自己回失败", fail("unavailable", "cookie 过期了"), 503, "unavailable"],
		["来源交回坏形状", fail("invalid", "0.name 不合规矩"), 502, "invalid"],
	])("%s —— 状态码从标准码推,码与话原样", async (_label, outcome, status, code) => {
		const { app } = await boot(async () => outcome);
		const res = await app.request("/api/sources/douyin/creators?q=x");
		expect(res.status).toBe(status);
		const body = await failureOf(res);
		expect(body.code).toBe(code);
		expect(body.message).toBe(outcome.ok ? "" : outcome.message);
	});

	it("候选带图库引用 —— avatarUrl 是那张图的 data URL,其余格原样;图库里没有的那个只缺头像", async () => {
		let ref = "";
		const { app, runtime } = await boot(async () =>
			ok({
				candidates: [
					{ externalId: "sec-1", name: "作者", avatar: ref, bio: "简介", followers: 77 },
					{ externalId: "sec-2", name: "没图", avatar: `${"0".repeat(64)}.png` },
				],
			}),
		);
		// 图库同一份,哪个写口存的都读得回来;这里借资料头像那一口。
		const stored = await runtime.profileImages.put(PNG);
		if (!stored.ok) throw new Error(stored.message);
		ref = stored.ref;
		const res = await app.request("/api/sources/douyin/creators?q=x");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			candidates: [
				{ externalId: "sec-1", name: "作者", avatarUrl: PNG_URL, bio: "简介", followers: 77 },
				{ externalId: "sec-2", name: "没图" },
			],
		});
	});

	it("来源不在册 —— 404 not_found", async () => {
		const { app } = await boot(async () => ok({ candidates: [] }));
		const res = await app.request("/api/sources/other/creators?q=x");
		expect(res.status).toBe(404);
		expect((await failureOf(res)).code).toBe("not_found");
	});

	it("推送链路还没挂上 —— 503 unavailable,不当成来源不在", async () => {
		const search = vi.fn(async () => ok({ candidates: [] }));
		const { app } = await boot(search, { pipeline: false });
		const res = await app.request("/api/sources/douyin/creators?q=x");
		expect(res.status).toBe(503);
		expect((await failureOf(res)).code).toBe("unavailable");
		expect(search).not.toHaveBeenCalled();
	});
});
