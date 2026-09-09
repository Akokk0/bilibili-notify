/**
 * 桥接入那一支 —— 数据模型认不认得它。
 *
 * 桥连接**没有 `platform`**(它后面挂着哪些平台是握手时报的、是运行时知识),而配置层
 * 有好几处一直假定「一条连接就是一个平台」。最凶的一处是**加载器那个跑在 parse 之前的
 * 过滤器**:它拿原始 JSON 问「这个 platform 认得吗」,桥那一支根本没有那一格 →
 * 开机时被当成「已撤下平台」**静默丢掉**,而且下一次任何写入都会把这个丢弃**写实到盘上**。
 * 主人看到的是「桥接入自己消失了」,没有任何报错。
 *
 * 这个文件钉的就是那条链:存得下、重启还在、目标挂得上、身份轴改不动。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Connection,
	connectionDispatchKey,
	type Disposable,
	type MessageBus,
	type PushTarget,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BootstrapConfig } from "../config/schema.js";
import { type ConfigStore, ConfigValidationError, createConfigStore } from "../config/store.js";

function makeFakeBus(): MessageBus {
	return {
		emit() {},
		on(): Disposable {
			return { dispose() {} };
		},
	} as unknown as MessageBus;
}

function makeFakeServiceCtx(): ServiceContext {
	return {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setTimeout: () => ({ dispose() {} }),
		setInterval: () => ({ dispose() {} }),
		onDispose() {},
	} as unknown as ServiceContext;
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

const BRIDGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function bridgeConnection(over: Partial<Connection> = {}): Connection {
	return {
		id: BRIDGE_ID,
		name: "家里那台 koishi",
		enabled: true,
		kind: "extension",
		extensionId: "bridge",
		config: { token: "t0ken", bridgeKind: "koishi" },
		...over,
	} as Connection;
}

/** 桥驮来的目标 —— 平台是桥报的,连接侧没有这一格可比。 */
function telegramTarget(): PushTarget {
	return {
		id: TARGET_ID,
		name: "电报群",
		connectionId: BRIDGE_ID,
		kind: "session",
		platform: "telegram",
		scope: "group",
		enabled: true,
		address: "-1001234567890",
		botId: "bot-1",
	} as PushTarget;
}

describe("桥接入", () => {
	let dataDir: string;
	let stateDir: string;
	let store: ConfigStore;

	async function reopen(): Promise<ConfigStore> {
		const next = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			bus: makeFakeBus(),
			serviceCtx: makeFakeServiceCtx(),
		});
		await next.load();
		return next;
	}

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-bridge-test-"));
		stateDir = join(dataDir, "state");
		store = await reopen();
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	it("存得下,而且落盘的那份没有 platform", async () => {
		await store.upsertConnection(bridgeConnection());
		const raw = JSON.parse(await readFile(join(stateDir, "connections.json"), "utf8"));
		expect(raw).toHaveLength(1);
		expect(raw[0].kind).toBe("extension");
		expect(raw[0].extensionId).toBe("bridge");
		expect(raw[0]).not.toHaveProperty("platform");
		expect(raw[0]).not.toHaveProperty("connector");
		expect(raw[0].config).toEqual({ token: "t0ken", bridgeKind: "koishi" });
	});

	it("**重启之后还在** —— 这条就是那个 parse 前过滤器的守卫", async () => {
		await store.upsertConnection(bridgeConnection());
		const store2 = await reopen();
		expect(store2.getConnections().map((c) => c.id)).toEqual([BRIDGE_ID]);
	});

	it("盘上直接摆一条桥接入也读得回来(不经过 upsert 那条路)", async () => {
		await writeFile(
			join(stateDir, "connections.json"),
			JSON.stringify([bridgeConnection()], null, 2),
		);
		const store2 = await reopen();
		expect(store2.getConnections()).toHaveLength(1);
	});

	it("已撤下平台的直连照旧静默丢掉 —— 别把这道门一起拆了", async () => {
		await writeFile(
			join(stateDir, "connections.json"),
			JSON.stringify([
				bridgeConnection(),
				{
					id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
					name: "老 koishi bot",
					platform: "koishi-bot",
				},
			]),
		);
		const store2 = await reopen();
		expect(store2.getConnections().map((c) => c.id)).toEqual([BRIDGE_ID]);
	});

	it("桥驮来的目标挂得上 —— 连接侧没有平台可比,只校验连接存在", async () => {
		await store.upsertConnection(bridgeConnection());
		await store.upsertTarget(telegramTarget());
		expect(store.getTargets().map((t) => t.platform)).toEqual(["telegram"]);
	});

	it("挂到一条不存在的连接上照旧拒绝", async () => {
		await expect(
			store.upsertTarget({ ...telegramTarget(), connectionId: BRIDGE_ID }),
		).rejects.toBeInstanceOf(ConfigValidationError);
	});

	it("kind 改不动 —— 换 kind 等于换了一条连接,而目标还挂在那个 id 上", async () => {
		await store.upsertConnection(bridgeConnection());
		await expect(
			store.upsertConnection({
				id: BRIDGE_ID,
				name: "偷换成 OneBot",
				enabled: true,
				kind: "direct",
				connector: "http",
				platform: "onebot",
				config: { transport: "http", baseUrl: "http://127.0.0.1:3000" },
			} as unknown as Connection),
		).rejects.toBeInstanceOf(ConfigValidationError);
		expect(store.getConnections()[0]?.kind).toBe("extension");
	});
});

describe("connectionDispatchKey", () => {
	it("直连给平台名,桥接入给 bridge —— 两种桥共用一套实现", () => {
		expect(connectionDispatchKey(bridgeConnection())).toBe("bridge");
		expect(
			connectionDispatchKey(
				bridgeConnection({ config: { token: "", bridgeKind: "astrbot" } } as never),
			),
		).toBe("bridge");
		expect(connectionDispatchKey({ kind: "direct", platform: "onebot" })).toBe("onebot");
	});
});
