/**
 * B 站上下文(`bilibili/context.ts`):开存储、建集成上下文、建请求客户端,与它的收尾次序。
 *
 * 用真的集成存储宿主(临时目录、真 FileKeyProvider)与真的 `createIntegrationHttp`;不连 B 站(请求只打回环 server)。
 * 钉四件事:重启后浏览器身份稳定;建到一半失败不留开着的把手;收尾先跑 `ctx.onDispose` 的钩子、再关把手,连接池
 * 放到 `drain` 段;`http.` 前缀的键 B 站自己写不进去。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpClient } from "@bilibili-notify/http";
import { ok } from "@bilibili-notify/internal";
import { FileKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { inertSettingsOf } from "../../__tests__/support/inert-settings.js";
import { inertTransitImages } from "../../__tests__/support/integration-io.js";
import { readIntegrationStateFile } from "../../integration-store/files.js";
import { createIntegrationStore } from "../../integration-store/store.js";
import { createIntegrationHttp } from "../../integrations/http.js";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { makeServiceContext } from "../api/__tests__/support/make-api.js";
import { createBiliContext } from "../context.js";

vi.mock("../../integrations/http.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../integrations/http.js")>();
	return { ...original, createIntegrationHttp: vi.fn(original.createIntegrationHttp) };
});

let dataDir: string;
let server: Server;
let baseURL: string;
let lastHeaders: IncomingMessage["headers"];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-bili-context-"));
	lastHeaders = {};
	server = createServer((req, res) => {
		lastHeaders = req.headers;
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ code: 0 }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(dataDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function makeStore() {
	const host = makeServiceContext();
	const keyProvider = new FileKeyProvider(join(dataDir, "secrets", "master.key"), host.logger);
	const redactor = createValueRedactor();
	const store = createIntegrationStore({
		dataRoot: dataDir,
		keyProvider,
		logger: host.logger,
		redactor,
	});
	return { host, store, redactor };
}

describe("createBiliContext", () => {
	it("重启后身份稳定:两次建上下文线上的 UA 相同,且就是 state.json 里 http.identity 写的那一份", async () => {
		const { host, store } = makeStore();
		const first = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});
		await first.ctx.http.fetch(`${baseURL}/x`);
		const firstUa = lastHeaders["user-agent"];
		await first.dispose();
		await store.close();

		// 模拟重启:同一个数据根、新的宿主与上下文。
		const again = makeStore();
		const second = await createBiliContext({
			transitImages: inertTransitImages,
			stores: again.store,
			serviceCtx: again.host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});
		await second.ctx.http.fetch(`${baseURL}/x`);
		const secondUa = lastHeaders["user-agent"];
		await second.dispose();
		await again.store.close();

		expect(firstUa).toBeTypeOf("string");
		expect(secondUa).toBe(firstUa);
		const stored = await readIntegrationStateFile({
			dataRoot: dataDir,
			key: "bilibili",
			logger: host.logger,
		});
		expect(stored.kind).toBe("ok");
		const identity =
			stored.kind === "ok" ? (stored.entries.get("http.identity") as Record<string, string>) : {};
		expect(identity.userAgent).toBe(firstUa);
	});

	it("罐子的 cookie 值与 secrets 的值经存储把手登记进打码登记册(B 站上下文不另收登记册),收摊后撤掉", async () => {
		const { host, store, redactor } = makeStore();
		const { ctx, dispose } = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});
		ctx.cookies.jar.load([
			{ key: "SESSDATA", value: "FAKE-JAR-COOKIE-1", domain: "bilibili.com", path: "/" },
		]);
		await ctx.secrets.set("refreshToken", "FAKE-REFRESH-TOKEN");
		// 还没存进 secrets 的临时凭据:ctx.redact 经同一个把手登记。
		ctx.redact("FAKE-TEMP-TOKEN-1");
		expect(
			redactor.scrub("jar=FAKE-JAR-COOKIE-1 token=FAKE-REFRESH-TOKEN temp=FAKE-TEMP-TOKEN-1"),
		).toBe("jar=*** token=*** temp=***");

		await dispose();
		expect(
			redactor.scrub("jar=FAKE-JAR-COOKIE-1 token=FAKE-REFRESH-TOKEN temp=FAKE-TEMP-TOKEN-1"),
		).toBe("jar=FAKE-JAR-COOKIE-1 token=FAKE-REFRESH-TOKEN temp=FAKE-TEMP-TOKEN-1");
		await store.close();
	});

	it("ctx 带着公共那一面、请求客户端与罐子的把手;`http.` 开头的键 B 站自己写不进去", async () => {
		const { host, store } = makeStore();
		const { ctx, dispose } = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});

		expect(ctx.http).toBeDefined();
		expect(ctx.cookies.jar).toBeDefined();
		expect(ctx.signal.aborted).toBe(false);
		const refused = await ctx.secrets.set("http.cookies", "[]");
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.code).toBe("invalid");
		expect((await ctx.secrets.set("refreshToken", "T0")).ok).toBe(true);
		expect(ctx.secrets.get("refreshToken")).toBe("T0");

		await dispose();
		await store.close();
	});

	it("建到一半失败:把手关上,下次 open 同一个键不抛「已经开着」", async () => {
		const { host, store } = makeStore();
		vi.mocked(createIntegrationHttp).mockRejectedValueOnce(new Error("boom"));

		await expect(
			createBiliContext({
				transitImages: inertTransitImages,
				stores: store,
				serviceCtx: host.serviceCtx,
				problems: ignoredProblems,
				settingsOf: inertSettingsOf,
			}),
		).rejects.toThrow("boom");

		expect(store.isOpen("bilibili")).toBe(false);
		const reopened = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});
		expect(store.isOpen("bilibili")).toBe(true);
		await reopened.dispose();
		await store.close();
	});

	it("收尾:先跑 ctx.onDispose 的钩子(后登记的先跑),再关把手;幂等", async () => {
		const { host, store } = makeStore();
		const handle = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});
		const order: string[] = [];
		handle.ctx.onDispose(() => {
			order.push(`first(open=${store.isOpen("bilibili")})`);
		});
		handle.ctx.onDispose(() => {
			order.push(`second(open=${store.isOpen("bilibili")})`);
		});

		await handle.dispose();
		await handle.dispose();

		expect(order).toEqual(["second(open=true)", "first(open=true)"]);
		expect(store.isOpen("bilibili")).toBe(false);
		await store.close();
	});

	it("连接池放在 drain 段收,不在上下文的收尾里:dispose() 不动客户端,跑 drain 钩子才收", async () => {
		const { host, store } = makeStore();
		const handle = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: inertSettingsOf,
		});
		const drain = host.disposers.filter((d) => d.phase === "drain");
		expect(drain).toHaveLength(1);
		// `ctx.http` 是窄面、没有 `dispose`:盯类上的方法(这个用例里只有这一个客户端)。
		const clientDispose = vi.spyOn(HttpClient.prototype, "dispose");

		await handle.dispose();
		expect(clientDispose).not.toHaveBeenCalled();

		await drain[0]?.fn();
		expect(clientDispose).toHaveBeenCalledTimes(1);
		await store.close();
	});

	// 验红:`createBiliContext` 里按别的键(例如 "onebot")向 `settingsOf` 要读法,这条红。
	it("B 站上下文要的是 bilibili 那一段的读法:ctx.settings(规则) 读到的是它", async () => {
		const { host, store } = makeStore();
		const asked: string[] = [];
		const handle = await createBiliContext({
			transitImages: inertTransitImages,
			stores: store,
			serviceCtx: host.serviceCtx,
			problems: ignoredProblems,
			settingsOf: (key) => {
				asked.push(key);
				return { read: () => ok({ settings: { key } }), onChanged: () => ({ dispose() {} }) };
			},
		});
		expect(asked).toEqual(["bilibili"]);
		expect(handle.ctx.settings(z.object({ key: z.string() })).get()).toEqual({
			ok: true,
			settings: { key: "bilibili" },
		});
		await handle.dispose();
		await store.close();
	});
});
