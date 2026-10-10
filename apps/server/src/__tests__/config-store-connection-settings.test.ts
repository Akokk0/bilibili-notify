import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BusEvents,
	type Connection,
	type Disposable,
	type MessageBus,
	neutralPlatformSnapshot,
	OnebotConnectionSettingsSchema,
	type ServiceContext,
	WebhookConnectionSettingsSchema,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ZodType } from "zod";
import {
	CONFIG_DIR,
	type ConfigStore,
	ConfigValidationError,
	createConfigStore,
} from "../config/store.js";
import { routeConnection } from "../push/dispatch.js";
import { snapshotFor } from "./support/connection-snapshot.js";

/**
 * 配置仓对连接 `settings` 的处理(3a-22-2):
 * - 读盘只有**外壳**(id / name / enabled / adapterKey / platform)坏了才挡开机;`settings` 不解、不补默认值,
 *   过不过得了适配器的规则要等适配器在场才知道 —— 读盘那一刻一个适配器都不在场;
 * - 保存时适配器在场就验 `settings`(`connectionSettingsSchemaOf`),不在场原样存;
 * - PATCH 只有补丁里带了 `settings` 才验(被隔离的连接才能改名、能停用);
 * - 整节替换(恢复备份)不验 `settings`;
 * - 身份格(adapterKey / platform)不许改;探测状态只换那一格。
 */

function makeBus(): MessageBus & { events: Array<[keyof BusEvents, unknown]> } {
	const events: Array<[keyof BusEvents, unknown]> = [];
	return {
		events,
		emit(event, payload?: unknown) {
			events.push([event, payload]);
		},
		on(): Disposable {
			return { dispose() {} };
		},
	};
}

function makeServiceCtx(warn: (msg: string) => void = () => {}): ServiceContext {
	return {
		logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

const onebot = (over: Partial<Connection> = {}): Connection => ({
	id: randomUUID(),
	name: "NapCat",
	platform: "onebot",
	enabled: true,
	adapterKey: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: { transport: "http", baseUrl: "http://127.0.0.1:3000" },
	...over,
});

const webhook = (over: Partial<Connection> = {}): Connection => ({
	id: randomUUID(),
	name: "钉钉",
	platform: "dingtalk",
	enabled: true,
	adapterKey: "webhook",
	platformSnapshot: snapshotFor("dingtalk"),
	settings: { url: "https://example.com/hook" },
	...over,
});

describe("ConfigStore — 连接的 settings", () => {
	let dir: string;
	let present: Map<string, ZodType>;
	let warn: ReturnType<typeof vi.fn<(msg: string) => void>>;
	let bus: ReturnType<typeof makeBus>;
	let store: ConfigStore;

	const open = async (): Promise<ConfigStore> => {
		const next = createConfigStore({
			bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir: dir, logLevel: "info" },
			dataRoot: dir,
			bus,
			serviceCtx: makeServiceCtx(warn),
			connectionSettingsSchemaOf: (key) => present.get(key),
		});
		await next.load();
		return next;
	};
	const connectionsFile = () => join(dir, ...CONFIG_DIR, "connections.json");
	const rawOnDisk = async () => JSON.parse(await readFile(connectionsFile(), "utf8")) as unknown[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bn-cs-settings-"));
		present = new Map();
		warn = vi.fn<(msg: string) => void>();
		bus = makeBus();
		store = await open();
	});
	afterEach(async () => {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	});

	describe("读盘:只有外壳挡开机", () => {
		it("settings 坏的连接开得了机、getConnections() 里有它、settings 原文留着,派发被拒 not_configured", async () => {
			const broken = onebot({ settings: { baseUrl: 42 } }); // 缺 transport、baseUrl 不是字符串
			await store.close();
			await writeFile(connectionsFile(), JSON.stringify([broken]));

			store = await open();

			expect(store.getConnections()).toEqual([broken]);
			// 适配器在场时:把连接递给适配器之前先解一遍,解不过就是 not_configured(不调适配器)
			const routed = routeConnection(
				[{ adapterKey: "onebot", settingsSchema: OnebotConnectionSettingsSchema }],
				store.getConnections()[0] as Connection,
			);
			expect(routed).toMatchObject({ ok: false, code: "not_configured" });
			expect(routed.ok ? "" : routed.message).toMatch(/^连接设置不合法：/);
		});

		it("外壳坏了(adapterKey 空)→ 挡开机,话里指到哪一行", async () => {
			await store.close();
			await writeFile(connectionsFile(), JSON.stringify([onebot({ adapterKey: "" })]));
			await expect(open()).rejects.toBeInstanceOf(ConfigValidationError);
			await expect(open()).rejects.toThrow(/connections\.json 第 1 行/);
			// 因为 open 抛了,afterEach 里的 close 作用在旧 store 上
			store = createConfigStore({
				bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir: dir, logLevel: "info" },
				dataRoot: dir,
				bus,
				serviceCtx: makeServiceCtx(),
			});
		});

		it("platformSnapshot 坏了 → 不挡开机,退成中性快照并记一行日志,盘上不动", async () => {
			const bad = { ...onebot(), platformSnapshot: { label: 1 } };
			await store.close();
			await writeFile(connectionsFile(), JSON.stringify([bad]));

			store = await open();

			expect(store.getConnections()[0]?.platformSnapshot).toEqual(
				neutralPlatformSnapshot("onebot"),
			);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("platformSnapshot"));
			expect(await rawOnDisk()).toEqual([bad]);
		});

		it("probeState 坏了 → 当作没探过", async () => {
			const bad = { ...onebot(), probeState: { status: "???" } };
			await store.close();
			await writeFile(connectionsFile(), JSON.stringify([bad]));

			store = await open();

			expect(store.getConnections()[0]).not.toHaveProperty("probeState");
		});
	});

	describe("保存:适配器在场才验 settings", () => {
		it("适配器在场:upsert 验 settings,过的存解过的值(补默认值);不过抛 invalid,issues 的路径以 settings 打头", async () => {
			present.set("onebot", OnebotConnectionSettingsSchema);
			const good = onebot();
			await store.upsertConnection(good);
			expect(store.getConnections()[0]?.settings).toMatchObject({
				transport: "http",
				baseUrl: "http://127.0.0.1:3000",
				timeoutMs: 15_000,
			});

			await expect(
				store.upsertConnection(onebot({ id: randomUUID(), settings: { transport: "http" } })),
			).rejects.toMatchObject({
				code: "invalid",
				issues: [expect.objectContaining({ path: ["settings", "baseUrl"] })],
			});
		});

		it("适配器不在场:原样存,什么都不验", async () => {
			const odd = onebot({ settings: { whatever: 1 } });
			await store.upsertConnection(odd);
			expect(store.getConnections()).toEqual([odd]);
		});

		it("PATCH 不带 settings 不验:被隔离的连接能改名、能停用;原文不被动", async () => {
			const broken = onebot({ settings: { baseUrl: 42 } });
			await store.upsertConnection(broken); // 适配器还不在场,存得进
			present.set("onebot", OnebotConnectionSettingsSchema); // 适配器来了,这条连接成了被隔离的

			const patched = await store.patchConnection(broken.id, { name: "改名", enabled: false });

			expect(patched).toMatchObject({ name: "改名", enabled: false });
			expect(patched.settings).toEqual({ baseUrl: 42 });
		});

		it("PATCH 带了 settings 才验:不过 400 级 invalid,盘上不变", async () => {
			present.set("onebot", OnebotConnectionSettingsSchema);
			const good = onebot();
			await store.upsertConnection(good);
			const before = await readFile(connectionsFile(), "utf8");

			await expect(
				store.patchConnection(good.id, { settings: { timeoutMs: -1 } } as never),
			).rejects.toMatchObject({
				code: "invalid",
				issues: [expect.objectContaining({ path: ["settings", "timeoutMs"] })],
			});
			expect(await readFile(connectionsFile(), "utf8")).toBe(before);

			const ok = await store.patchConnection(good.id, { settings: { timeoutMs: 20_000 } } as never);
			expect((ok.settings as { timeoutMs: number }).timeoutMs).toBe(20_000);
		});

		it("PATCH 带来的 platformSnapshot / probeState 一律忽略(只有宿主写)", async () => {
			const c = onebot();
			await store.upsertConnection(c);

			const patched = await store.patchConnection(c.id, {
				name: "改名",
				platformSnapshot: { label: "伪造" },
				probeState: { status: "reachable", lastCheckedAt: "t" },
			} as never);

			expect(patched.platformSnapshot).toEqual(snapshotFor("onebot"));
			expect(patched).not.toHaveProperty("probeState");
		});
	});

	describe("createConnection(新建)", () => {
		const draft = (c: Connection) => {
			const { platformSnapshot: _s, probeState: _p, ...rest } = c;
			return rest;
		};

		it("落盘的是体 + 宿主给的快照;体里带来的 platformSnapshot / probeState 被剥掉", async () => {
			const c = webhook();
			await store.createConnection(
				{
					...draft(c),
					platformSnapshot: { label: "伪造", shortLabel: "伪", color: "#000" },
					probeState: { status: "reachable", lastCheckedAt: "t" },
				},
				snapshotFor("dingtalk"),
			);

			const saved = store.getConnection(c.id);
			expect(saved?.platformSnapshot).toEqual(snapshotFor("dingtalk"));
			expect(saved).not.toHaveProperty("probeState");
			// 端点形态的连接带出托管目标
			expect(store.getTargets().map((t) => t.connectionId)).toEqual([c.id]);
		});

		it("同 id 已存在 → conflict,存着的不动", async () => {
			const c = webhook();
			await store.createConnection(draft(c), snapshotFor("dingtalk"));
			await expect(
				store.createConnection({ ...draft(c), name: "覆盖?" }, snapshotFor("dingtalk")),
			).rejects.toMatchObject({ code: "conflict" });
			expect(store.getConnection(c.id)?.name).toBe("钉钉");
		});

		it("外壳不合法 → invalid;适配器在场时 settings 不合法 → invalid", async () => {
			await expect(
				store.createConnection({ id: "not-a-uuid" }, snapshotFor("onebot")),
			).rejects.toMatchObject({ code: "invalid" });

			present.set("webhook", WebhookConnectionSettingsSchema);
			await expect(
				store.createConnection(
					{ ...draft(webhook()), settings: { url: "no" } },
					snapshotFor("dingtalk"),
				),
			).rejects.toMatchObject({
				code: "invalid",
				issues: [expect.objectContaining({ path: ["settings", "url"] })],
			});
			expect(store.getConnections()).toEqual([]);
		});
	});

	describe("身份与探测状态", () => {
		it("身份守卫:换 adapterKey 被拒,话是「连接的适配器不能改」", async () => {
			const c = onebot();
			await store.upsertConnection(c);
			await expect(store.upsertConnection({ ...c, adapterKey: "bridge" })).rejects.toMatchObject({
				code: "invalid",
				message: expect.stringContaining("连接的适配器不能改（onebot → bridge）"),
				issues: [expect.objectContaining({ path: ["adapterKey"] })],
			});
		});

		it("身份守卫:换 platform 被拒", async () => {
			const c = onebot();
			await store.upsertConnection(c);
			await expect(
				store.patchConnection(c.id, { platform: "qq-official" } as never),
			).rejects.toMatchObject({
				code: "invalid",
				message: expect.stringContaining("连接的平台不能改"),
			});
		});

		it("托管目标跟着 platformSnapshot.targetKind 走:endpoint 有、session 没有", async () => {
			await store.upsertConnection(onebot());
			expect(store.getTargets()).toEqual([]);
			const hook = webhook();
			await store.upsertConnection(hook);
			expect(store.getTargets()).toEqual([
				expect.objectContaining({
					connectionId: hook.id,
					kind: "endpoint",
					managedBy: "connection",
				}),
			]);
		});

		it("recordConnectionProbeState 只换探测状态那一格:不验 settings、不动托管目标,发 config-changed connections", async () => {
			present.set("onebot", OnebotConnectionSettingsSchema);
			const broken = onebot({ settings: { baseUrl: 42 } });
			await store.close();
			await writeFile(connectionsFile(), JSON.stringify([broken]));
			store = await open();
			bus.events.length = 0;

			const state = { status: "unsupported" as const, lastCheckedAt: "2026-06-06T00:00:00.000Z" };
			const saved = await store.recordConnectionProbeState(broken.id, state);

			expect(saved).toEqual({ ...broken, probeState: state });
			expect(((await rawOnDisk())[0] as Connection).probeState).toEqual(state);
			expect(bus.events).toEqual([["config-changed", { scope: "connections" }]]);
			await expect(
				store.recordConnectionProbeState("00000000-0000-4000-8000-000000000000", state),
			).rejects.toMatchObject({ code: "not_found" });
		});
	});

	describe("整节替换(恢复备份)不验 settings", () => {
		it("settings 不合法的连接换得进来,原文留着(进来后照读盘的规矩被隔离)", async () => {
			present.set("onebot", OnebotConnectionSettingsSchema);
			const broken = onebot({ settings: { baseUrl: "" } });

			await store.replaceSections({ connections: [broken] });

			expect(store.getConnections()).toEqual([broken]);
		});

		it("外壳坏了的照样拒收,不写半个", async () => {
			await expect(
				store.replaceSections({ connections: [{ ...onebot(), adapterKey: "" }] }),
			).rejects.toBeInstanceOf(ConfigValidationError);
			expect(store.getConnections()).toEqual([]);
		});
	});
});
