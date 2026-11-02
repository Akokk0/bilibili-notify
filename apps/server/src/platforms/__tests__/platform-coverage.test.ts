import { PLATFORM_REGISTRY } from "../platform-descriptors.js";
/**
 * 注册表里的每个平台都得有人接。
 *
 * `templatePlatforms` 是闭集,每一档说好了要配齐「一份 settings schema + 一个 server
 * adapter + 一排面板控件」。可 adapter 那一格没人核对过 —— 往注册表里加一档、忘了给它
 * 写 adapter,构建全绿、面板照样让主人建这条连接,只有真发的时候才在投递层报一句
 * `no platform adapter`。主人看到的是「配好了但发不出去」,而不是「这平台还没做」。
 *
 * 这条守卫把矩阵与词表钉在一起:多一档少一档都红。**不构造任何 I/O** —— 三个工厂在
 * 构造期只是拼闭包,连的时候才动网络。
 */

import type { Connection, PlatformAdapter, ServiceContext } from "@bilibili-notify/internal";

import { describe, expect, it, vi } from "vite-plus/test";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { adapterForConnection } from "../../push/dispatch.js";
import { createOnebotAdapter } from "../onebot.js";
import { createQQOfficialAdapter, createQQSessionRegistry } from "../qq-official.js";
import { createWebhookAdapter } from "../webhook.js";

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeServiceCtx(): ServiceContext {
	return {
		logger: makeLogger(),
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

/** 与 `index.ts` 装配的是同一份矩阵 —— 那边加一个 adapter,这边也要加。 */
function buildMatrix(): PlatformAdapter[] {
	const logger = makeLogger();
	const serviceCtx = makeServiceCtx();
	return [
		createOnebotAdapter({ logger, serviceCtx }),
		createQQOfficialAdapter({
			logger,
			serviceCtx,
			registry: createQQSessionRegistry(),
			locale: fixedLocale(),
		}),
		createWebhookAdapter({ logger }),
	];
}

/** 造一条该平台的连接 —— 分发只看 `adapterKey`,归属取平台注册表里那一行。 */
const templatePlatforms = Object.keys(PLATFORM_REGISTRY) as Array<keyof typeof PLATFORM_REGISTRY>;

function connectionOn(platform: (typeof templatePlatforms)[number]): Connection {
	return {
		adapterKey: PLATFORM_REGISTRY[platform].adapterKey,
		platform,
	} as unknown as Connection;
}

/**
 * 矩阵是按**适配器键**索引的。核心装配的这几个恰好覆盖平台词表 —— **拓展注册进来的那些
 * 不在这儿**:它们的键是拓展 id,由宿主填(ADR-0012 决策 28),盘上装了什么决定有几个,
 * 而这条守卫问的是「核心自己有没有漏掉一个平台」。
 */
describe("adapter 矩阵覆盖平台词表", () => {
	it("闭集里每个平台的连接,都恰好找得到一个 adapter", () => {
		const matrix = buildMatrix();
		for (const platform of templatePlatforms) {
			const claimers = matrix.filter(
				(adapter) => adapterForConnection([adapter], connectionOn(platform)) !== undefined,
			);
			expect(claimers.length, `平台 ${platform} 的 adapter`).toBe(1);
		}
	});

	it("也没有多出来的 —— 每个 adapter 的键都是某个平台的 adapterKey,键不重复", () => {
		const keys = buildMatrix().map((a) => a.adapterKey);
		const registryKeys = templatePlatforms.map((p) => PLATFORM_REGISTRY[p].adapterKey);
		expect([...keys].sort()).toEqual([...new Set(registryKeys)].sort());
	});
});

/**
 * 内置三个适配器各自列出的连接候选(ADR-0024 决策 4):从平台注册表现取自己那几行 ——
 * 个数、描述、平台名两两不重,都钉在这里。新建连接时宿主抄的快照就是候选里的 `platform`。
 */
describe("内置适配器的连接候选", () => {
	const candidatesOf = async (adapterKey: string) => {
		const adapter = buildMatrix().find((a) => a.adapterKey === adapterKey);
		if (!adapter?.listConnectionCandidates) {
			throw new Error(`${adapterKey} 没实现 listConnectionCandidates`);
		}
		return adapter.listConnectionCandidates(new AbortController().signal);
	};

	it.each([
		["onebot", ["onebot"]],
		["qq-official", ["qq-official"]],
		["webhook", ["feishu", "dingtalk", "wecom", "generic"]],
	] as const)("%s 的候选个数与平台名", async (adapterKey, platforms) => {
		const candidates = await candidatesOf(adapterKey);
		expect(candidates.map((c) => c.platform.platform).sort()).toEqual([...platforms].sort());
	});

	it("每个候选的描述逐格等于注册表那一行(去掉 adapterKey 加上 platform)", async () => {
		for (const adapterKey of ["onebot", "qq-official", "webhook"]) {
			for (const { platform } of await candidatesOf(adapterKey)) {
				const { adapterKey: rowKey, ...row } =
					PLATFORM_REGISTRY[platform.platform as keyof typeof PLATFORM_REGISTRY];
				expect(rowKey).toBe(adapterKey);
				expect(platform).toEqual({ platform: platform.platform, ...row });
			}
		}
	});

	it("OneBot 的那一份描述(字面钉一份,表被改歪了这里要红)", async () => {
		const [only] = await candidatesOf("onebot");
		expect(only?.platform).toEqual({
			platform: "onebot",
			label: "OneBot v11",
			shortLabel: "OneBot",
			color: "#3b82f6",
			icon: "qq",
			targetKind: "session",
			scopes: ["group", "private"],
			addressNouns: { group: "群", private: "用户" },
		});
	});

	// 验红:去掉 `builtin-candidates.ts` 里某一档的 `settings`,或者给模板候选塞一个 `boundConnectionId`,这条红。
	it("每个模板候选带 name(平台表的 label)与 settings 默认值,不带 boundConnectionId / selfId / via", async () => {
		const byPlatform = new Map<string, Awaited<ReturnType<typeof candidatesOf>>[number]>();
		for (const key of ["onebot", "qq-official", "webhook"]) {
			for (const c of await candidatesOf(key)) byPlatform.set(c.platform.platform, c);
		}
		expect([...byPlatform.keys()].sort()).toEqual(
			["dingtalk", "feishu", "generic", "onebot", "qq-official", "wecom"].sort(),
		);
		expect(Object.fromEntries([...byPlatform].map(([k, c]) => [k, c.name]))).toEqual({
			onebot: "OneBot v11",
			"qq-official": "QQ 官方机器人",
			feishu: "飞书机器人",
			dingtalk: "钉钉机器人",
			wecom: "企业微信机器人",
			generic: "未指明的 HTTP 端点",
		});
		expect(byPlatform.get("onebot")?.settings).toEqual({
			transport: "http",
			baseUrl: "http://127.0.0.1:3000",
			protocolVersion: "v11",
			headers: {},
			timeoutMs: 15000,
			imageMinTimeoutMs: 30000,
			mergeForwardMinTimeoutMs: 60000,
			maxRetries: 0,
			retryIntervalMs: 1000,
		});
		expect(byPlatform.get("qq-official")?.settings).toEqual({
			appId: "",
			appSecret: "",
			sandbox: false,
			botType: "public",
			logReconnects: false,
		});
		for (const p of ["feishu", "dingtalk", "wecom", "generic"]) {
			expect(byPlatform.get(p)?.settings, p).toEqual({
				url: "https://example.com/hook",
				headers: {},
			});
		}
		for (const [platform, c] of byPlatform) {
			for (const absent of ["boundConnectionId", "selfId", "via"]) {
				expect(absent in c, `${platform}.${absent}`).toBe(false);
			}
		}
	});

	it("三个适配器合起来的候选平台名两两不重,且恰好覆盖闭集", async () => {
		const all = (
			await Promise.all(["onebot", "qq-official", "webhook"].map((key) => candidatesOf(key)))
		).flatMap((cs) => cs.map((c) => c.platform.platform));
		expect(new Set(all).size).toBe(all.length);
		expect([...all].sort()).toEqual([...templatePlatforms].sort());
	});

	it("每个内置适配器都带 settingsSchema", () => {
		for (const adapter of buildMatrix()) {
			expect(adapter.settingsSchema, adapter.adapterKey).toBeDefined();
		}
	});
});
