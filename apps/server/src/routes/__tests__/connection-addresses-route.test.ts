/**
 * `GET /api/connections/:id/addresses?scope=group|private|channel` —— 这条连接上可挑的地址。
 *
 * 路由只管三件事:校验 `scope`、问引擎、把结果翻成响应。适配器怎么列(QQ 的群 / 私聊来自内存发现表、
 * 频道现去拉)由适配器与派发器自己的测试管;这里另用**真派发器 + 内置适配器的真壳**证明
 * 「没有这个成员的适配器(OneBot)回的码」「连接不在回 404」不是只在 fake 里成立。
 */

import type { Connection } from "@bilibili-notify/internal";
import { fail, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { registryOf } from "../../__tests__/support/adapter-ctx.js";
import { builtinAdapterStubs } from "../../__tests__/support/builtin-adapter-stubs.js";
import { snapshotFor } from "../../__tests__/support/connection-snapshot.js";
import type { ConfigStore } from "../../config/store.js";
import { createTargetDispatcher } from "../../push/target-dispatcher.js";
import { createConnectionsRoute } from "../connections.js";
import type { RouteDeps } from "../types.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function depsOf(pipeline: unknown): RouteDeps {
	return {
		runtime: { serviceCtx: { logger }, pipeline },
		store: { getConnections: () => [] },
		puppeteer: null,
		wsTicketStore: null,
	} as unknown as RouteDeps;
}

describe("GET /api/connections/:id/addresses — 请求与响应", () => {
	it("scope 不合法 / 缺省 → 400 invalid,不去问引擎", async () => {
		const listAddressCandidates = vi.fn();
		const app = createConnectionsRoute(depsOf({ listAddressCandidates }));
		for (const url of ["/a1/addresses?scope=nope", "/a1/addresses"]) {
			const res = await app.request(url);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "invalid", issues: [{ path: ["scope"] }] });
		}
		expect(listAddressCandidates).not.toHaveBeenCalled();
	});

	it("成功:回 { candidates },连接 id / scope / 请求的 signal 都递给引擎", async () => {
		const candidates = [
			{ address: "C1", name: "公告", parentAddress: "G1", parentName: "频道甲" },
			{ address: "C2" },
		];
		const listAddressCandidates = vi.fn(async () => ok({ candidates }));
		const app = createConnectionsRoute(depsOf({ listAddressCandidates }));
		const res = await app.request("/a1/addresses?scope=channel");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ candidates });
		expect(listAddressCandidates).toHaveBeenCalledWith("a1", "channel", expect.any(AbortSignal));
	});

	it("引擎回的失败经 respondFailure 翻成状态码", async () => {
		const app = createConnectionsRoute(
			depsOf({
				listAddressCandidates: async () => fail("unavailable", "列出频道失败：401"),
			}),
		);
		const res = await app.request("/a1/addresses?scope=channel");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ code: "unavailable", message: "列出频道失败：401" });
	});

	it("引擎还没起来 → 503 unavailable", async () => {
		const app = createConnectionsRoute(depsOf(undefined));
		const res = await app.request("/a1/addresses?scope=group");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: "unavailable" });
	});
});

describe("GET /api/connections/:id/addresses — 真派发器 + 内置适配器", () => {
	function connection(id: string, platform: string, settings: Record<string, unknown>): Connection {
		return {
			id,
			name: id,
			adapterKey: platform,
			platform,
			platformSnapshot: snapshotFor(platform),
			enabled: true,
			settings,
		} as unknown as Connection;
	}

	function appOver(connections: Connection[]) {
		const dispatcher = createTargetDispatcher({
			store: {
				getConnections: () => connections,
				getConnection: (id: string) => connections.find((c) => c.id === id),
				getTargets: () => [],
			} as unknown as ConfigStore,
			adapters: registryOf(builtinAdapterStubs()),
			logger,
		});
		return createConnectionsRoute(depsOf(dispatcher));
	}

	it("适配器没有这个成员(OneBot)→ 400 unsupported", async () => {
		const app = appOver([connection("ob", "onebot", { transport: "ws-reverse", port: 5701 })]);
		const res = await app.request("/ob/addresses?scope=group");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ code: "unsupported", message: "这种连接没有可列的地址" });
	});

	it("连接不在 → 404 not_found", async () => {
		const app = appOver([]);
		const res = await app.request("/ghost/addresses?scope=group");
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
	});

	it("QQ 官方连接的群 / 私聊:发现表是空的就回空列表,200", async () => {
		const app = appOver([
			connection("qq", "qq-official", {
				appId: "APPID",
				appSecret: "SECRET",
				sandbox: false,
				botType: "public",
			}),
		]);
		const res = await app.request("/qq/addresses?scope=private");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ candidates: [] });
	});
});
