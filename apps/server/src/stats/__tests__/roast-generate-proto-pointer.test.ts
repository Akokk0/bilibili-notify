/**
 * `ai.activeProfile` 写成原型名(`constructor` 这类)而表里没有这一家:锐评不抛,按「AI 没配齐」回失败。
 *
 * 用真配置仓与真的点评生成器(不 mock `@bilibili-notify/ai`):指针取到原型上的函数时,
 * `toGeneratorConfig` 读 `vision.baseUrl` 就抛 TypeError,路由回 503「服务端出错了」。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatsOverviewResponse } from "@bilibili-notify/contract";
import type { BusEvents, Disposable, MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConfigStore } from "../../config/store.js";
import { generateBoardRoast, generateSoloRoast, type RoastGenDeps } from "../roast-generate.js";

function makeBus(): MessageBus {
	const listeners = new Map<keyof BusEvents, Set<(...a: unknown[]) => void>>();
	return {
		emit(event, ...args) {
			for (const h of [...(listeners.get(event) ?? [])]) (h as (...a: unknown[]) => void)(...args);
		},
		on(event, handler): Disposable {
			let s = listeners.get(event);
			if (!s) {
				s = new Set();
				listeners.set(event, s);
			}
			const w = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
			s.add(w);
			return { dispose: () => listeners.get(event)?.delete(w) };
		},
	};
}

function makeCtx(): ServiceContext {
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
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-roast-proto-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const row = (uid: string) => ({
	subscriptionId: `sub-${uid}`,
	identity: { sourceKey: "bilibili", externalId: uid },
	net7d: 1,
	netWindow: 2,
	videoPosts: 3,
	posts: 7,
	liveSessions: 5,
	liveHours: 6,
	lastActivityAt: "2026-08-01T00:00:00.000Z",
});
const overview = async () => ({ rows: [row("1"), row("2")] }) as unknown as StatsOverviewResponse;

async function depsWithPointer(pointer: string): Promise<RoastGenDeps> {
	const serviceCtx = makeCtx();
	const store = createConfigStore({
		bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" },
		dataRoot: dataDir,
		bus: makeBus(),
		serviceCtx,
	});
	await store.load();
	await store.patchGlobals({ ai: { enabled: true } });
	// 指针不经配置仓的写口放进去:schema 现在拒原型名(这道门先挡一次)。这里钉的是第二道 —— 万一有哪条路
	// 绕过了 schema,取值那头也不能从原型上摸东西。
	const getGlobals = store.getGlobals.bind(store);
	store.getGlobals = () => {
		const globals = getGlobals();
		return { ...globals, ai: { ...globals.ai, activeProfile: pointer } };
	};
	return {
		runtime: {
			engines: { extensionPlatformLabel: () => undefined },
			serviceCtx,
			subscriptionStateStore: { get: () => ({ cachedProfile: undefined }) },
			sourceRegistry: {
				get: () => ({ descriptor: { label: "B 站" } }),
				list: () => [{ sourceKey: "bilibili" }],
			},
		},
		store,
	} as unknown as RoastGenDeps;
}

describe("指针是原型名且表里没有这一家", () => {
	it("榜单锐评:不抛,回「AI apiKey 未配置」这一种失败,与指着普通的不存在的名字一致", async () => {
		const args = { days: 7, tz: 0, fetchOverview: overview };
		const proto = await generateBoardRoast(await depsWithPointer("constructor"), args);
		const plain = await generateBoardRoast(await depsWithPointer("nope"), args);
		expect(proto).toEqual(plain);
		expect(proto).toMatchObject({ ok: false, code: "unavailable" });
		expect(JSON.stringify(proto)).toContain("AI apiKey 未配置");
	});

	it("单人锐评:同样不抛", async () => {
		const deps = await depsWithPointer("constructor");
		(deps.store as unknown as { getSubscriptions: () => unknown }).getSubscriptions = () => [
			{ id: "sub-1", identity: { sourceKey: "bilibili", externalId: "1" }, overrides: {} },
		];
		const got = await generateSoloRoast(deps, {
			subscriptionId: "sub-1",
			days: 7,
			tz: 0,
			fetchOverview: overview,
		});
		expect(got).toMatchObject({ ok: false, code: "unavailable" });
		expect(JSON.stringify(got)).toContain("AI apiKey 未配置");
	});
});
