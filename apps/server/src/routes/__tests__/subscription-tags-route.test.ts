/**
 * `/api/subs/tags`(ADR-0034):`GET` 读整张标签表,`PUT` 整张换。规矩(名字、删标签清引用)在配置仓里,
 * 所以这里接真的配置仓,只看路由把结果与失败原样交出去。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CONFIG_DIR, type ConfigStore, createConfigStore } from "../../config/store.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { createSubscriptionTagsRoute } from "../subscription-tags.js";
import type { RouteDeps } from "../types.js";

const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const CHAT = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };

function makeServiceCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

let dataDir: string;
let store: ConfigStore;
let app: ReturnType<typeof createSubscriptionTagsRoute>;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-subscription-tags-route-"));
	await mkdir(join(dataDir, ...CONFIG_DIR), { recursive: true });
	store = createConfigStore({
		bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" },
		dataRoot: dataDir,
		bus: createNodeMessageBus(),
		serviceCtx: makeServiceCtx(),
	});
	await store.load();
	app = createSubscriptionTagsRoute({ store } as unknown as RouteDeps);
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

const put = (body: string) =>
	app.request("/", { method: "PUT", headers: { "content-type": "application/json" }, body });

describe("/api/subs/tags", () => {
	it("GET:按表里的顺序回整张表", async () => {
		await store.replaceSubscriptionTags([CHAT, GAME]);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([CHAT, GAME]);
	});

	it("PUT:整张换掉,回存下的那张(名字去掉了首尾空白)", async () => {
		const res = await put(JSON.stringify([GAME, { ...CHAT, name: " 杂谈 " }]));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([GAME, CHAT]);
		expect(store.getSubscriptionTags()).toEqual([GAME, CHAT]);
	});

	it("PUT 重名:400 invalid,原因点到是哪一格;表不动", async () => {
		await store.replaceSubscriptionTags([GAME]);
		const res = await put(JSON.stringify([GAME, { ...CHAT, name: "游戏" }]));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; issues?: Array<{ path?: unknown[] }> };
		expect(body.code).toBe("invalid");
		expect(body.issues?.some((i) => JSON.stringify(i.path) === JSON.stringify([1, "name"]))).toBe(
			true,
		);
		expect(store.getSubscriptionTags()).toEqual([GAME]);
	});

	it("PUT 不是合法的 JSON:400 invalid", async () => {
		const res = await put("{not json");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe("invalid");
	});
});
