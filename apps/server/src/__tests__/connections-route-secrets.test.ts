import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { settingsSegment } from "../bilibili/settings.js";
import { BUILTIN_INTEGRATION_KEYS } from "../compose.js";
import { createSecretCellsReader } from "../push/connection-settings.js";
import { createConnectionsRoute } from "../routes/connections.js";
import type { RouteDeps } from "../routes/types.js";
import { createAppRuntime } from "../runtime/bootstrap.js";
import { fakeAdapterContext } from "./support/adapter-ctx.js";
import { placeholderDescriptor } from "./support/adapter-descriptor.js";
import { registerBuiltinAdapterStubs } from "./support/builtin-adapter-stubs.js";
import { snapshotFor } from "./support/connection-snapshot.js";

/**
 * 连接的凭据下发打码(ADR-0021 决策 44):`GET /api/connections` 与写入的响应里,`settings` 里标了 `secret` 的格
 * (OneBot `accessToken`、webhook `url` / `secret`、QQ 官机 `appSecret`)是 `{ masked }`;`backupOnly`
 * 那档(OneBot 地址、请求头的值)照常明文。写回规矩:带着遮挡 → 400;不带 = 保留;清空交空串 / null。
 * 盘上照旧明文 —— 这一片只管线上的形状。
 *
 * 🔴 `settings` 的规则归适配器,外壳里它是 `z.unknown()`:适配器不在场 / 设置不合法时**整格**是 `{ masked }`,
 * 拓展适配器的密钥靠它**声明**的键。每一种情形都有「响应序列化后不含任何密钥原值」的朴素兜底。
 */
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LONG = `abcd${"x".repeat(20)}wxyz`;

const onebot = {
	id: ID(1),
	name: "NapCat",
	platform: "onebot",
	enabled: true,
	adapterKey: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: {
		transport: "http",
		baseUrl: "http://127.0.0.1:3000",
		accessToken: LONG,
		headers: { Authorization: "Bearer plain" },
	},
};
const webhook = {
	id: ID(2),
	name: "钉钉",
	platform: "dingtalk",
	enabled: true,
	adapterKey: "webhook",
	platformSnapshot: snapshotFor("dingtalk"),
	settings: {
		url: "https://oapi.dingtalk.com/robot/send?access_token=tok",
		secret: "SEC123",
		headers: {},
	},
};
const qq = {
	id: ID(3),
	name: "官机",
	platform: "qq-official",
	enabled: true,
	adapterKey: "qq-official",
	platformSnapshot: snapshotFor("qq-official"),
	settings: { appId: "102000000", appSecret: "app-secret-value" },
};
/** 适配器不在场的拓展连接:盘上有、登记表里没有。 */
const ghost = {
	id: ID(4),
	name: "没在跑的桥",
	platform: "telegram",
	enabled: true,
	adapterKey: "ghost-ext",
	platformSnapshot: snapshotFor("telegram"),
	settings: { botKey: "GHOST-SECRET", note: "家里那台" },
};
/** 适配器在场、设置过不了它的规则(缺 transport)的内置连接 —— 被隔离的那种。 */
const broken = {
	id: ID(5),
	name: "坏掉的 OneBot",
	platform: "onebot",
	enabled: true,
	adapterKey: "onebot",
	platformSnapshot: snapshotFor("onebot"),
	settings: { baseUrl: "http://127.0.0.1:3000", accessToken: "BROKEN-SECRET" },
};
/** 拓展适配器在场且声明了密钥键 `botKey`(它的 schema 上没有标记)。 */
const declared = {
	id: ID(6),
	name: "在跑的桥",
	platform: "telegram",
	enabled: true,
	adapterKey: "fake-ext",
	platformSnapshot: snapshotFor("telegram"),
	settings: { botKey: "DECLARED-SECRET", note: "公开的备注" },
};

/** 夹具里出现过的每一个密钥原值 —— 朴素兜底逐个查。 */
const SECRET_VALUES = [
	LONG,
	"SEC123",
	"access_token=tok",
	"app-secret-value",
	"GHOST-SECRET",
	"BROKEN-SECRET",
	"DECLARED-SECRET",
];

function jsonInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

describe("connections route — 凭据下发打码(真 store)", () => {
	let dataDir: string;
	let runtime: ReturnType<typeof createAppRuntime>;
	let app: ReturnType<typeof createConnectionsRoute>;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-conn-secret-"));
		runtime = createAppRuntime(
			{ server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		await runtime.configStore.load();
		// 先存、后登记适配器:此刻没有任何适配器在场,存什么都不验 settings —— 这样才存得下
		// 「适配器不在场」与「设置不合法」这两种连接(它们在生产里正是这么来的:读盘时适配器还没登记)。
		for (const c of [onebot, webhook, qq, ghost, broken, declared]) {
			await runtime.configStore.upsertConnection(c as never);
		}
		await registerBuiltinAdapterStubs(runtime.adapterRegistry);
		await runtime.adapterRegistry.register(
			{
				adapterKey: "fake-ext",
				settingsSchema: z.object({ botKey: z.string(), note: z.string() }),
				descriptor: placeholderDescriptor(),
				isAvailable: () => true,
				send: async () => ({ ok: true, latencyMs: 1 }),
				probe: async () => ({ ok: true, latencyMs: 1 }),
				listConnectionCandidates: async () => [],
				start() {},
				stop() {},
			},
			fakeAdapterContext().ctx,
		);
		app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
				adapterRegistry: runtime.adapterRegistry,
			},
			store: runtime.configStore,
			connectionSecrets: createSecretCellsReader(runtime.adapterRegistry, (key) =>
				BUILTIN_INTEGRATION_KEYS.includes(key)
					? []
					: ((key) => (key === "fake-ext" ? ["botKey"] : undefined))(key),
			),
			puppeteer: null,
			wsTicketStore: null,
		} as unknown as RouteDeps);
	});
	afterEach(async () => {
		await runtime.dispose();
		await rm(dataDir, { recursive: true, force: true });
	});

	const stored = (id: string) =>
		runtime.configStore.getConnection(id) as never as {
			settings: Record<string, unknown>;
		};
	type Row = { id: string; settings: Record<string, unknown>; settingsIssues?: unknown[] };
	const rowOf = (rows: Row[], id: string) => rows.find((r) => r.id === id) as Row;
	const getRows = async () => (await (await app.request("/")).json()) as Row[];

	it("GET:四个凭据格是 { masked },空串与没配照旧,backupOnly 那档照常明文", async () => {
		const rows = await getRows();
		expect(rowOf(rows, ID(1)).settings).toMatchObject({
			accessToken: { masked: "abcd••••••••wxyz" },
			baseUrl: "http://127.0.0.1:3000",
			headers: { Authorization: "Bearer plain" },
		});
		expect(rowOf(rows, ID(2)).settings).toMatchObject({
			url: { masked: "http••••••••=tok" },
			secret: { masked: "••••••••" },
		});
		expect(rowOf(rows, ID(3)).settings).toMatchObject({
			appId: "102000000",
			appSecret: { masked: "••••••••" },
		});
		expect(JSON.stringify(rows)).not.toContain("app-secret-value");
		expect(JSON.stringify(rows)).not.toContain("SEC123");
		expect(JSON.stringify(rows)).not.toContain("access_token=tok");
	});

	it("适配器不在场 → settings 整格是 { masked },没有 settingsIssues", async () => {
		const row = rowOf(await getRows(), ID(4));
		expect(row.settings).toEqual({ masked: "••••••••" });
		expect(row).not.toHaveProperty("settingsIssues");
	});

	it("设置不合法(被隔离)→ settings 整格是 { masked },另带 settingsIssues 点名原因", async () => {
		const row = rowOf(await getRows(), ID(5));
		expect(row.settings).toEqual({ masked: "••••••••" });
		expect(row.settingsIssues?.length).toBeGreaterThan(0);
	});

	it("拓展适配器在场且声明了密钥键 → 那一格是 { masked },没声明的照常", async () => {
		const row = rowOf(await getRows(), ID(6));
		expect(row.settings).toEqual({ botKey: { masked: "••••••••" }, note: "公开的备注" });
	});

	it("朴素兜底:GET 与 PATCH 响应序列化后不含夹具里任何一个密钥原值", async () => {
		const get = JSON.stringify(await getRows());
		for (const secret of SECRET_VALUES) expect(get, secret).not.toContain(secret);
		for (const id of [ID(1), ID(2), ID(3), ID(4), ID(5), ID(6)]) {
			const res = await app.request(`/${id}`, jsonInit("PATCH", { name: "改名" }));
			expect(res.status).toBe(200);
			const text = JSON.stringify(await res.json());
			for (const secret of SECRET_VALUES) expect(text, `${id} ${secret}`).not.toContain(secret);
		}
	});

	it("被隔离 / 适配器不在场的连接能改名、能停用:PATCH 不带 settings 就不验它", async () => {
		const res = await app.request(`/${ID(5)}`, jsonInit("PATCH", { name: "改名", enabled: false }));
		expect(res.status).toBe(200);
		expect(runtime.configStore.getConnection(ID(5))).toMatchObject({
			name: "改名",
			enabled: false,
		});
		// 原文没被动
		expect(stored(ID(5)).settings).toEqual(broken.settings);
		const ghostRes = await app.request(`/${ID(4)}`, jsonInit("PATCH", { enabled: false }));
		expect(ghostRes.status).toBe(200);
	});

	it("PATCH 带 settings 才验:动到的 settings 过不了适配器的规则 → 400,盘上不变", async () => {
		const res = await app.request(`/${ID(1)}`, jsonInit("PATCH", { settings: { timeoutMs: -1 } }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["settings", "timeoutMs"] }],
		});
		expect(stored(ID(1)).settings).toEqual(onebot.settings);
	});

	it("PATCH { settings: { masked } } 整格遮挡写回 → 400,盘上不变", async () => {
		for (const id of [ID(4), ID(5)]) {
			const before = JSON.stringify(stored(id).settings);
			const res = await app.request(
				`/${id}`,
				jsonInit("PATCH", { settings: { masked: "••••••••" } }),
			);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "invalid" });
			expect(JSON.stringify(stored(id).settings)).toBe(before);
		}
	});

	it("没配的凭据格保持原样(没有 / 空串),面板分得开「没配」", async () => {
		await runtime.configStore.patchConnection(ID(1), { settings: { accessToken: null } } as never);
		await runtime.configStore.patchConnection(ID(3), { settings: { appSecret: "" } } as never);
		const rows = await getRows();
		expect(rowOf(rows, ID(1)).settings).not.toHaveProperty("accessToken");
		expect(rowOf(rows, ID(3)).settings.appSecret).toBe("");
	});

	it("PATCH 的响应同样打码", async () => {
		const res = await app.request(`/${ID(1)}`, jsonInit("PATCH", { name: "改名" }));
		const body = (await res.json()) as Row;
		expect(body.settings.accessToken).toEqual({ masked: "abcd••••••••wxyz" });
	});

	it("POST 新建:响应里整张表都是打码的", async () => {
		const fresh = { ...qq, id: ID(9), settings: { appId: "1", appSecret: "brand-new-secret" } };
		const res = await app.request("/", jsonInit("POST", fresh));
		expect(res.status).toBe(200);
		const rows = (await res.json()) as Row[];
		expect(rowOf(rows, ID(9)).settings.appSecret).toEqual({ masked: "••••••••" });
		expect(JSON.stringify(rows)).not.toContain("brand-new-secret");
		// 盘上照旧明文:这一片不动盘。
		expect(stored(ID(9)).settings.appSecret).toBe("brand-new-secret");
	});

	it("POST 带着遮挡 → 400,issues 指到那一格", async () => {
		const bad = { ...qq, id: ID(9), settings: { appId: "1", appSecret: { masked: "••••••••" } } };
		const res = await app.request("/", jsonInit("POST", bad));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["settings", "appSecret"] }],
		});
		expect(runtime.configStore.getConnection(ID(9))).toBeUndefined();
	});

	it("POST 只管新建:同 id 已存在 → 409 conflict,存着的不动", async () => {
		const res = await app.request("/", jsonInit("POST", { ...qq, name: "覆盖?" }));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "conflict" });
		expect((runtime.configStore.getConnection(ID(3)) as { name: string }).name).toBe("官机");
	});

	it("PATCH 带着遮挡 → 400,存着的凭据没被盖掉", async () => {
		const res = await app.request(
			`/${ID(1)}`,
			jsonInit("PATCH", { settings: { accessToken: { masked: "abcd••••••••wxyz" } } }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["settings", "accessToken"] }],
		});
		expect(stored(ID(1)).settings.accessToken).toBe(LONG);
	});

	it("PATCH 没带凭据格 = 保留已存的", async () => {
		await app.request(`/${ID(1)}`, jsonInit("PATCH", { settings: { timeoutMs: 20_000 } }));
		expect(stored(ID(1)).settings.accessToken).toBe(LONG);
		expect(stored(ID(1)).settings.timeoutMs).toBe(20_000);
	});

	it("PATCH 换新明文 / 可选的交 null 清掉 / 必填的交空串清空", async () => {
		await app.request(`/${ID(1)}`, jsonInit("PATCH", { settings: { accessToken: "fresh" } }));
		expect(stored(ID(1)).settings.accessToken).toBe("fresh");
		await app.request(`/${ID(1)}`, jsonInit("PATCH", { settings: { accessToken: null } }));
		expect(stored(ID(1))).not.toHaveProperty("settings.accessToken");
		await app.request(`/${ID(2)}`, jsonInit("PATCH", { settings: { secret: null } }));
		expect(stored(ID(2)).settings).not.toHaveProperty("secret");
		const res = await app.request(`/${ID(3)}`, jsonInit("PATCH", { settings: { appSecret: "" } }));
		expect(res.status).toBe(200);
		expect(stored(ID(3)).settings.appSecret).toBe("");
	});

	it("PATCH 切 OneBot transport:消失的键交 null 才过 .strict();不交就被拒", async () => {
		const bare = await app.request(
			`/${ID(1)}`,
			jsonInit("PATCH", { settings: { transport: "ws", url: "ws://bot:3001" } }),
		);
		expect(bare.status).toBe(400);
		const res = await app.request(
			`/${ID(1)}`,
			jsonInit("PATCH", {
				settings: { transport: "ws", url: "ws://bot:3001", baseUrl: null },
			}),
		);
		expect(res.status).toBe(200);
		expect(stored(ID(1)).settings).toMatchObject({ transport: "ws", url: "ws://bot:3001" });
		expect(stored(ID(1)).settings).not.toHaveProperty("baseUrl");
		expect(stored(ID(1)).settings.accessToken).toBe(LONG);
	});
});
