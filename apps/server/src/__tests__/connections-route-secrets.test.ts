import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createConnectionsRoute } from "../routes/connections.js";
import type { RouteDeps } from "../routes/types.js";
import { createAppRuntime } from "../runtime/bootstrap.js";

/**
 * 连接的凭据下发打码(ADR-0021 决策 44):`GET /api/connections` 与写入的响应里,标了 `secret` 的格
 * (OneBot `accessToken`、webhook `url` / `secret`、QQ 官机 `appSecret`)是 `{ masked }`;`backupOnly`
 * 那档(OneBot 地址、请求头的值)照常明文。写回规矩:带着遮挡 → 400;不带 = 保留;清空交空串 / null。
 * 盘上照旧明文 —— 这一片只管线上的形状。
 */
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LONG = `abcd${"x".repeat(20)}wxyz`;

const onebot = {
	id: ID(1),
	name: "NapCat",
	platform: "onebot",
	enabled: true,
	kind: "direct",
	connector: "http",
	config: {
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
	kind: "direct",
	connector: "webhook",
	config: {
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
	kind: "direct",
	connector: "ws",
	config: { appId: "102000000", appSecret: "app-secret-value" },
};

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
		);
		await runtime.configStore.load();
		app = createConnectionsRoute({
			runtime: {
				serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
			},
			store: runtime.configStore,
			puppeteer: null,
			wsTicketStore: null,
		} as unknown as RouteDeps);
		for (const c of [onebot, webhook, qq]) await runtime.configStore.upsertConnection(c as never);
	});
	afterEach(async () => {
		await runtime.dispose();
		await rm(dataDir, { recursive: true, force: true });
	});

	const stored = (id: string) =>
		runtime.configStore.getConnection(id) as never as {
			config: Record<string, unknown>;
		};
	type Row = { id: string; config: Record<string, unknown> };
	const rowOf = (rows: Row[], id: string) => rows.find((r) => r.id === id) as Row;

	it("GET:四个凭据格是 { masked },空串与没配照旧,backupOnly 那档照常明文", async () => {
		const rows = (await (await app.request("/")).json()) as Row[];
		expect(rowOf(rows, ID(1)).config).toMatchObject({
			accessToken: { masked: "abcd••••••••wxyz" },
			baseUrl: "http://127.0.0.1:3000",
			headers: { Authorization: "Bearer plain" },
		});
		expect(rowOf(rows, ID(2)).config).toMatchObject({
			url: { masked: "http••••••••=tok" },
			secret: { masked: "••••••••" },
		});
		expect(rowOf(rows, ID(3)).config).toMatchObject({
			appId: "102000000",
			appSecret: { masked: "••••••••" },
		});
		expect(JSON.stringify(rows)).not.toContain("app-secret-value");
		expect(JSON.stringify(rows)).not.toContain("SEC123");
		expect(JSON.stringify(rows)).not.toContain("access_token=tok");
	});

	it("没配的凭据格保持原样(没有 / 空串),面板分得开「没配」", async () => {
		await runtime.configStore.patchConnection(ID(1), { config: { accessToken: null } } as never);
		await runtime.configStore.patchConnection(ID(3), { config: { appSecret: "" } } as never);
		const rows = (await (await app.request("/")).json()) as Row[];
		expect(rowOf(rows, ID(1)).config).not.toHaveProperty("accessToken");
		expect(rowOf(rows, ID(3)).config.appSecret).toBe("");
	});

	it("PATCH 的响应同样打码", async () => {
		const res = await app.request(`/${ID(1)}`, jsonInit("PATCH", { name: "改名" }));
		const body = (await res.json()) as Row;
		expect(body.config.accessToken).toEqual({ masked: "abcd••••••••wxyz" });
	});

	it("POST 新建:响应里整张表都是打码的", async () => {
		const fresh = { ...qq, id: ID(9), config: { appId: "1", appSecret: "brand-new-secret" } };
		const res = await app.request("/", jsonInit("POST", fresh));
		expect(res.status).toBe(200);
		const rows = (await res.json()) as Row[];
		expect(rowOf(rows, ID(9)).config.appSecret).toEqual({ masked: "••••••••" });
		expect(JSON.stringify(rows)).not.toContain("brand-new-secret");
		// 盘上照旧明文:这一片不动盘。
		expect(stored(ID(9)).config.appSecret).toBe("brand-new-secret");
	});

	it("POST 带着遮挡 → 400,issues 指到那一格", async () => {
		const bad = { ...qq, id: ID(9), config: { appId: "1", appSecret: { masked: "••••••••" } } };
		const res = await app.request("/", jsonInit("POST", bad));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["config", "appSecret"] }],
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
			jsonInit("PATCH", { config: { accessToken: { masked: "abcd••••••••wxyz" } } }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "invalid",
			issues: [{ path: ["config", "accessToken"] }],
		});
		expect(stored(ID(1)).config.accessToken).toBe(LONG);
	});

	it("PATCH 没带凭据格 = 保留已存的", async () => {
		await app.request(`/${ID(1)}`, jsonInit("PATCH", { config: { timeoutMs: 20_000 } }));
		expect(stored(ID(1)).config.accessToken).toBe(LONG);
		expect(stored(ID(1)).config.timeoutMs).toBe(20_000);
	});

	it("PATCH 换新明文 / 可选的交 null 清掉 / 必填的交空串清空", async () => {
		await app.request(`/${ID(1)}`, jsonInit("PATCH", { config: { accessToken: "fresh" } }));
		expect(stored(ID(1)).config.accessToken).toBe("fresh");
		await app.request(`/${ID(1)}`, jsonInit("PATCH", { config: { accessToken: null } }));
		expect(stored(ID(1))).not.toHaveProperty("config.accessToken");
		await app.request(`/${ID(2)}`, jsonInit("PATCH", { config: { secret: null } }));
		expect(stored(ID(2)).config).not.toHaveProperty("secret");
		const res = await app.request(`/${ID(3)}`, jsonInit("PATCH", { config: { appSecret: "" } }));
		expect(res.status).toBe(200);
		expect(stored(ID(3)).config.appSecret).toBe("");
	});

	it("PATCH 切 OneBot transport:消失的键交 null 才过 .strict();不交就被拒", async () => {
		const bare = await app.request(
			`/${ID(1)}`,
			jsonInit("PATCH", { connector: "ws", config: { transport: "ws", url: "ws://bot:3001" } }),
		);
		expect(bare.status).toBe(400);
		const res = await app.request(
			`/${ID(1)}`,
			jsonInit("PATCH", {
				connector: "ws",
				config: { transport: "ws", url: "ws://bot:3001", baseUrl: null },
			}),
		);
		expect(res.status).toBe(200);
		expect(stored(ID(1)).config).toMatchObject({ transport: "ws", url: "ws://bot:3001" });
		expect(stored(ID(1)).config).not.toHaveProperty("baseUrl");
		expect(stored(ID(1)).config.accessToken).toBe(LONG);
	});
});
