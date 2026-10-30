/**
 * `/api/ext/:id/settings` —— 拓展设置自己的读写口(ADR-0019 决策 35)。
 *
 * 存储在拓展自己的文件 `config/settings/extensions/<id>.json`(不在核心设置里);路由管的是**怎么读、怎么写**:
 * - 读:密钥格换成服务端算好的遮挡,原文永不下发;带一个版本号。
 * - 写:按项操作(顶层按格 `set`、列表逐条 `add` / `update` / `remove`),版本号对不上 409;
 *   **只校验这次动到的**,存量里别的不合规的不连坐。
 * - 拓展在跑时,写入再过它自己交过的那份 zod —— 只拦**这次写入新冒出来的**问题。
 * - 写完发一帧「这个拓展的设置变了」。
 *
 * 搭的是**真的**一整条:真的 ConfigStore(落盘、排队)、真的装载器(拓展经 `ctx.settings(schema)`
 * 交 zod,宿主从跑着的那份把手上取)、真的 bus → WS 帧接线。零件各自绿证明不了接上了。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ErrorResponse,
	ExtensionSettingsIssue,
	ExtensionSettingsResponse,
	ExtensionSettingsWriteResponse,
} from "@bilibili-notify/contract";
import type { ServiceContext } from "@bilibili-notify/internal";
import type { ExtensionContext } from "@bilibili-notify/internal/extension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { fixedLocale } from "../../__tests__/support/fixed-locale.js";
import { ignoredProblems } from "../../__tests__/support/ignored-problems.js";
import { inertTransitImages } from "../../__tests__/support/integration-io.js";
import { memoryIntegrationStore } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createApp, createCardSkinStore } from "../../app.js";
import { settingsSegment } from "../../bilibili/settings.js";
import type { BootstrapConfig } from "../../config/schema.js";
import { extensionSettingsFile } from "../../config/store.js";
import { type LoadedExtensions, loadExtensions } from "../../extensions/loader.js";
import { createExtensionMounts } from "../../extensions/mount.js";
import { createExtensionUpgrades } from "../../extensions/upgrade.js";
import { createPlatformAdapterRegistry } from "../../push/registry.js";
import { type AppRuntime, createAppRuntime } from "../../runtime/bootstrap.js";
import { attachChannelWiring } from "../../ws/channels.js";
import { createLogChannel } from "../../ws/log-channel.js";
import type { WsEventEnvelope } from "../../ws/types.js";

/** 一枚 32 位小写十六进制 token —— BN 生成的就是这个格式。 */
const TOKEN = "0123456789abcdef0123456789abcdef";

const DOUYIN = {
	id: "douyin",
	name: "抖音订阅",
	description: "测试用",
	version: "0.1.0",
	apiVersion: 3,
	settings: {
		fields: [
			{ key: "cookie", type: "string", label: "Cookie", secret: true },
			// 只标了 generate、没标 secret —— 一律按密钥算。
			{ key: "apiKey", type: "string", label: "Key", generate: true },
			{ key: "interval", type: "number", label: "间隔", min: 30, max: 600, default: 60 },
			{
				key: "links",
				type: "list",
				label: "接入",
				title: "name",
				fields: [
					{ key: "name", type: "string", label: "名字", required: true },
					{
						key: "token",
						type: "string",
						label: "token",
						secret: true,
						generate: true,
						default: "",
					},
					{ key: "enabled", type: "boolean", label: "启用", default: true },
				],
			},
		],
	},
	contributes: {
		subscription: {
			label: "抖音",
			shortLabel: "抖",
			color: "#fe2c55",
			supportedFeatures: ["post"],
		},
	},
};

/**
 * 拓展自己那份 zod —— 比清单多两道清单表达不了的规矩:间隔必须是**整数**,名字里不许有「坏」字
 * (**异步** refine:同步解析一碰就抛,宿主必须 `safeParseAsync`)。
 */
const DOUYIN_ZOD = z.object({
	cookie: z.string().optional(),
	apiKey: z.string().optional(),
	interval: z.number().int().min(30).max(600).default(60),
	links: z
		.array(
			z.object({
				id: z.string().min(1),
				name: z
					.string()
					.min(1)
					.refine(async (name) => !name.includes("坏"), "名字里不许有「坏」字"),
				token: z.string().default(""),
				enabled: z.boolean().default(true),
			}),
		)
		.default([]),
});

/** 第 1 版的清单(退路已删):装载时判「版本不合」,没有清单可读,也就没有能照着管的设置项。 */
const OLD_V1 = {
	id: "legacy",
	name: "老格式",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 1,
	provides: ["push"],
};

const BARE_V2 = {
	id: "bare",
	name: "没设置项",
	description: "测试用",
	version: "1.0.0",
	apiVersion: 3,
	contributes: DOUYIN.contributes,
};

function quietHost(): ServiceContext {
	const noop = () => {};
	return {
		logger: { info: noop, warn: noop, error: noop, debug: noop },
		setInterval: () => ({ dispose: noop }),
		setTimeout: () => ({ dispose: noop }),
		onDispose: noop,
		signal: new AbortController().signal,
		track: () => {},
	};
}

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" };
}

let dataDir: string;
let runtime: AppRuntime | undefined;
let loaded: LoadedExtensions | undefined;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-ext-settings-route-"));
});

afterEach(async () => {
	await loaded?.dispose();
	loaded = undefined;
	await runtime?.dispose();
	runtime = undefined;
	await rm(dataDir, { recursive: true, force: true });
});

async function plant(manifest: { id: string }): Promise<void> {
	const dir = join(dataDir, "extensions", manifest.id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "extension.json"), JSON.stringify(manifest));
	// 入口的内容无所谓:import 那一步换成了下面的 importModule。
	await writeFile(join(dir, "index.mjs"), "export function activate() {}");
}

/**
 * 起一整条。`running` 决定抖音拓展开没开 —— 开着时它在 `activate` 里交那份 zod。
 * `settings` 是开机前存着的那份(直接写进 store,不过任何校验:存量里的坏项就这么来)。
 * 开着、而存着的那份过不了它的 zod 时,它起不来(`state` 是「设置读不了」,ADR-0019 决策 36)。
 */
async function boot(opts: {
	running: boolean;
	settings?: unknown;
	state?: "running" | "disabled" | "settings-invalid";
	/** 拓展交的 zod,缺省是 {@link DOUYIN_ZOD}。 */
	zod?: z.ZodType;
	/** 开机前就躺在盘上的抖音设置文件原文(可以不是合法 JSON)。 */
	rawFile?: string;
}) {
	await plant(DOUYIN);
	await plant(OLD_V1);
	await plant(BARE_V2);
	const rt = createAppRuntime(
		makeBootstrap(dataDir),
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
	runtime = rt;
	if (opts.rawFile !== undefined) {
		const file = join(dataDir, ...extensionSettingsFile("douyin"));
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, opts.rawFile, "utf8");
	}
	await rt.configStore.load();
	if (opts.settings !== undefined) {
		await rt.configStore.updateExtensionSettings("douyin", () => opts.settings);
	}
	const mounts = createExtensionMounts({ logger: silentLogger });
	/** activate 跑了几次 —— 「改对了才起、还坏着不重跑」看它。 */
	let activations = 0;
	const loader = await loadExtensions({
		transitImages: inertTransitImages,
		locale: fixedLocale(),
		root: join(dataDir, "extensions"),
		host: quietHost(),
		loggerOf: () => quietHost().logger,
		integrationStore: memoryIntegrationStore(),
		problems: ignoredProblems,
		mounts,
		adapters: createPlatformAdapterRegistry(),
		connections: () => [],
		onConnectionsChanged: () => ({ dispose() {} }),
		settings: (id) => rt.configStore.getExtensionSettings(id),
		settingsIssue: (id) => rt.configStore.extensionSettingsIssue(id),
		// 与 index.ts 同一根线:拓展设置落盘(`integration-settings` 那一档)→ 装载器与 ctx 各自判「我这一份动没动」。
		onSettingsChanged: (fn) =>
			rt.bus.on("config-changed", ({ scope }) => {
				if (scope === "integration-settings") fn();
			}),
		inbound: {},
		upgrades: createExtensionUpgrades(),
		isEnabled: (id) => opts.running && id === "douyin",
		maxFailures: 3,
		importModule: async () => ({
			activate(ctx: ExtensionContext) {
				activations += 1;
				ctx.settings(opts.zod ?? DOUYIN_ZOD);
			},
		}),
	});
	loaded = loader;
	const douyin = () => loader.list().find((entry) => entry.id === "douyin");
	expect(douyin()?.state).toBe(opts.state ?? (opts.running ? "running" : "disabled"));

	const frames: WsEventEnvelope[] = [];
	attachChannelWiring({ bus: rt.bus, log: createLogChannel(), publish: (e) => frames.push(e) });

	const app = createApp(rt, {
		cardSkins: { store: createCardSkinStore(dataDir) },
		extensions: {
			mounts,
			loaded: () => loader.list(),
			status: (id) => loader.status(id),
			settingsSchemas: (id) => loader.settingsSchemas(id),
		},
	});
	const get = (id = "douyin") => app.request(`/api/ext/${id}/settings`);
	const patch = (body: unknown, id = "douyin") =>
		app.request(`/api/ext/${id}/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	/** 现在存着的那份(原文,不遮)。 */
	const stored = () => rt.configStore.getExtensionSettings("douyin");
	const revision = async () => ((await (await get()).json()) as ExtensionSettingsResponse).revision;
	const settingsFrames = () =>
		frames.filter((frame) => frame.event === "extension-settings-changed");
	return {
		get,
		patch,
		stored,
		revision,
		settingsFrames,
		douyin,
		activations: () => activations,
		/** 装载器那条队排空 —— 「设置变了」那一趟对账走完了。 */
		settled: () => loader.sync(),
		/** 旁路写一次(恢复备份 / 手改文件那一类):不经这个路由,也就不过拓展的 zod。 */
		bypass: (settings: unknown) => rt.configStore.updateExtensionSettings("douyin", () => settings),
	};
}

/** 一条存量:名字合规矩的一项、一项名字是空串(照清单就不合规矩)。 */
const GOOD_LINK = { id: "good-1", name: "家里那台", token: TOKEN, enabled: true };
const BAD_LINK = { id: "bad-1", name: "", token: "", enabled: true };

function issuesOf(body: unknown): ExtensionSettingsIssue[] {
	return (body as { issues: ExtensionSettingsIssue[] }).issues;
}

/**
 * 非 2xx 的体是平铺的 `{ code, message }`(+ 可选 `issues`):键集合钉死 —— 旧形状的 `error` /
 * `revision` 一个都不许再出现(ADR-0026 决策 6)。
 */
async function failureOf(res: Response): Promise<ErrorResponse> {
	const body = (await res.json()) as ErrorResponse;
	expect(Object.keys(body).every((key) => ["code", "message", "issues"].includes(key))).toBe(true);
	expect(typeof body.message).toBe("string");
	expect(body.message).not.toBe("");
	return body;
}

describe("GET /api/ext/:id/settings", () => {
	it("密钥不下发原文:不到 24 位整段打点,24 位及以上只露头尾各四位;空串照旧是空串", async () => {
		const h = await boot({
			running: false,
			settings: {
				cookie: "sessionid=abc123",
				apiKey: TOKEN,
				interval: 90,
				links: [GOOD_LINK, { ...GOOD_LINK, id: "empty", name: "新的", token: "" }],
			},
		});
		const res = await h.get();
		expect(res.status).toBe(200);
		const text = await res.text();
		// 原文一个字都不许出现在回应里。
		expect(text).not.toContain("sessionid=abc123");
		expect(text).not.toContain(TOKEN);
		const body = JSON.parse(text) as ExtensionSettingsResponse;
		expect(body.values).toEqual({
			cookie: { masked: "••••••••" },
			// generate 的格没标 secret 也遮。
			apiKey: { masked: "0123••••••••cdef" },
			interval: 90,
			links: [
				{ ...GOOD_LINK, token: { masked: "0123••••••••cdef" } },
				{ ...GOOD_LINK, id: "empty", name: "新的", token: "" },
			],
		});
		expect(body.revision).toMatch(/^[0-9a-f]{16,}$/);
	});

	it("遮挡门槛就在 24 位:23 位整段打点,不泄露长度", async () => {
		const h = await boot({
			running: false,
			settings: { cookie: "a".repeat(23), apiKey: "b".repeat(24) },
		});
		const body = (await (await h.get()).json()) as ExtensionSettingsResponse;
		expect(body.values.cookie).toEqual({ masked: "••••••••" });
		expect(body.values.apiKey).toEqual({ masked: "bbbb••••••••bbbb" });
	});

	it("没设过 —— 空的那份,照样有版本号", async () => {
		const h = await boot({ running: false });
		const body = (await (await h.get()).json()) as ExtensionSettingsResponse;
		expect(body.values).toEqual({});
		expect(body.revision).toMatch(/^[0-9a-f]{16,}$/);
	});

	it("版本号是那份设置的内容摘要:内容不变它不变,内容一变它就变", async () => {
		const h = await boot({ running: false, settings: { interval: 90 } });
		const first = await h.revision();
		expect(await h.revision()).toBe(first);
		const res = await h.patch({
			revision: first,
			ops: [{ op: "set", key: "interval", value: 120 }],
		});
		expect(res.status).toBe(200);
		expect(await h.revision()).not.toBe(first);
	});

	it.each([
		["没装这个拓展", "nope", /没有装/],
		["第 1 版的拓展(版本不合,读不出清单)", "legacy", /版本不合/],
		["清单没声明设置项", "bare", /没声明设置项/],
	])("%s —— 404 not_found,并说清为什么", async (_label, id, reason) => {
		const h = await boot({ running: false });
		const res = await h.get(id);
		expect(res.status).toBe(404);
		const body = await failureOf(res);
		expect(body.code).toBe("not_found");
		expect(body.message).toMatch(reason);
	});

	it("id 不合规矩 —— 400 invalid,读与写都一样", async () => {
		const h = await boot({ running: false });
		const read = await h.get("Bad_ID");
		expect(read.status).toBe(400);
		expect(await failureOf(read)).toEqual({
			code: "invalid",
			message: "主人，这个拓展 id 不合规矩。",
		});
		const write = await h.patch(
			{ revision: "x", ops: [{ op: "set", key: "interval", value: 90 }] },
			"Bad_ID",
		);
		expect(write.status).toBe(400);
		expect((await failureOf(write)).code).toBe("invalid");
	});
});

describe("PATCH /api/ext/:id/settings —— 版本号", () => {
	it("对不上 → 409 conflict,只有 { code, message }(不再带现在的版本号),一个字都没写", async () => {
		const h = await boot({ running: false, settings: { interval: 90 } });
		const res = await h.patch({
			revision: "stale",
			ops: [{ op: "set", key: "interval", value: 120 }],
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body).toEqual({
			code: "conflict",
			message: "主人，设置在你打开后被改过了，请重新读一遍再改，别盖掉刚保存的内容。",
		});
		expect(body).not.toHaveProperty("revision");
		expect(h.stored()).toEqual({ interval: 90 });
	});

	/**
	 * 🔴 比对与写入必须在同一个排队里:两发带着同一个版本号同时到,先读后写的话两发都比对通过,
	 * 后落盘的那发拿着它读到的旧名单整份写回 —— 先写的那条接入静默消失。
	 */
	it("两发带同一个版本号同时到 → 一发 200、一发 409,先写的那条没被盖掉", async () => {
		const h = await boot({ running: false, settings: { links: [GOOD_LINK] } });
		const rev = await h.revision();
		const add = (name: string) =>
			h.patch({ revision: rev, ops: [{ op: "add", list: "links", item: { name } }] });
		const [a, b] = await Promise.all([add("甲"), add("乙")]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		// 输的那一发在排队里比对,回的也是同一个 conflict。
		const loser = a.status === 409 ? a : b;
		expect((await failureOf(loser)).code).toBe("conflict");
		const links = (h.stored() as { links: Array<{ name: string }> }).links;
		expect(links.map((link) => link.name)).toHaveLength(2);
		expect(links[0]?.name).toBe("家里那台");
	});
});

describe("PATCH /api/ext/:id/settings —— 按项写", () => {
	it("set / add / update / remove 一发写完;add 回来的 id 就是存下的那个;回应同 GET(遮着)", async () => {
		const h = await boot({
			running: false,
			settings: {
				interval: 90,
				links: [GOOD_LINK, { ...GOOD_LINK, id: "gone", name: "要删的" }],
			},
		});
		const res = await h.patch({
			revision: await h.revision(),
			ops: [
				{ op: "set", key: "interval", value: 120 },
				{ op: "set", key: "cookie", value: "c=1" },
				{ op: "add", list: "links", item: { name: "新来的", token: TOKEN } },
				{ op: "update", list: "links", id: "good-1", values: { name: "改了名", enabled: false } },
				{ op: "remove", list: "links", id: "gone" },
			],
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as ExtensionSettingsWriteResponse;
		expect(body.added).toHaveLength(1);
		const newId = body.added[0] as string;
		expect(newId).toMatch(/^[0-9a-f-]{36}$/);

		expect(h.stored()).toEqual({
			interval: 120,
			cookie: "c=1",
			links: [
				{ ...GOOD_LINK, name: "改了名", enabled: false },
				{ id: newId, name: "新来的", token: TOKEN },
			],
		});
		// 回应就是写完之后的 GET:版本号对得上,密钥照样遮着。
		const after = (await (await h.get()).json()) as ExtensionSettingsResponse;
		expect(body.revision).toBe(after.revision);
		expect(body.values).toEqual(after.values);
		expect(JSON.stringify(body)).not.toContain(TOKEN);
	});

	it("set 的值是 null = 清掉那一格", async () => {
		const h = await boot({ running: false, settings: { cookie: "c=1", interval: 90 } });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "cookie", value: null }],
		});
		expect(res.status).toBe(200);
		expect(h.stored()).toEqual({ interval: 90 });
	});

	/**
	 * 决策 35「存量里别的不合规的不连坐」:清单一收紧(或者手改过文件),存量里就可能躺着一条坏项。
	 * 整份校验的话,连删掉它都被拒 —— 那条坏项就永远删不掉了。
	 */
	it("存量里躺着一条坏项:删掉它、改另一条、再加一条 —— 都放行", async () => {
		const h = await boot({ running: false, settings: { links: [GOOD_LINK, BAD_LINK] } });
		const renamed = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "good-1", values: { name: "改了名" } }],
		});
		expect(renamed.status).toBe(200);
		const added = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "add", list: "links", item: { name: "又一台" } }],
		});
		expect(added.status).toBe(200);
		const removed = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "remove", list: "links", id: "bad-1" }],
		});
		expect(removed.status).toBe(200);
		const links = (h.stored() as { links: Array<{ id: string; name: string }> }).links;
		expect(links.map((link) => link.name)).toEqual(["改了名", "又一台"]);
	});

	it("改那条坏项时照清单校验合并之后的那一项:改对了放行,没改对的拦下", async () => {
		const h = await boot({ running: false, settings: { links: [GOOD_LINK, BAD_LINK] } });
		const still = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "bad-1", values: { enabled: false } }],
		});
		expect(still.status).toBe(400);
		expect(issuesOf(await still.json()).map((issue) => issue.path)).toEqual([
			["links", "bad-1", "name"],
		]);
		const fixed = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "bad-1", values: { name: "修好了" } }],
		});
		expect(fixed.status).toBe(200);
	});
});

describe("PATCH /api/ext/:id/settings —— 400 点名到那一格,一个字都不写", () => {
	it.each([
		[
			"照清单写坏了(越界)",
			{ op: "set", key: "interval", value: 10 },
			{ op: 0, path: ["interval"] },
		],
		["清单里没这一格", { op: "set", key: "nope", value: 1 }, { op: 0, path: ["nope"] }],
		[
			"对列表的键用 set(列表只能逐项改)",
			{ op: "set", key: "links", value: [] },
			{ op: 0, path: ["links"] },
		],
		[
			"值是下发时的密钥遮挡(原样回传会把真密钥盖成一个对象)",
			{ op: "set", key: "cookie", value: { masked: "••••••••" } },
			// 点名是遮挡,不是笼统的「类型不对」—— 面板得知道自己回传了占位。
			{ op: 0, path: ["cookie"], message: expect.stringMatching(/遮挡/) },
		],
		[
			"update 里带 id(id 由 BN 管、不许改)",
			{ op: "update", list: "links", id: "good-1", values: { id: "hijack" } },
			{ op: 0, path: ["links", "good-1", "id"] },
		],
		[
			"update 的项里多一格清单没声明的",
			{ op: "update", list: "links", id: "good-1", values: { nope: 1 } },
			{ op: 0, path: ["links", "good-1", "nope"] },
		],
		[
			"update 回传了遮挡",
			{ op: "update", list: "links", id: "good-1", values: { token: { masked: "x" } } },
			{ op: 0, path: ["links", "good-1", "token"], message: expect.stringMatching(/遮挡/) },
		],
		[
			"update 找不到那一项",
			{ op: "update", list: "links", id: "ghost", values: { name: "x" } },
			{ op: 0, path: ["links", "ghost"] },
		],
		[
			"remove 找不到那一项",
			{ op: "remove", list: "links", id: "ghost" },
			{ op: 0, path: ["links", "ghost"] },
		],
		[
			"add 到一个不是列表的键",
			{ op: "add", list: "interval", item: { name: "x" } },
			{ op: 0, path: ["interval"] },
		],
	])("%s", async (_label, op, expected) => {
		const h = await boot({ running: false, settings: { interval: 90, links: [GOOD_LINK] } });
		const before = structuredClone(h.stored());
		const res = await h.patch({ revision: await h.revision(), ops: [op] });
		expect(res.status).toBe(400);
		const body = await failureOf(res);
		expect(body.code).toBe("invalid");
		// message 一句概括;逐条原因(路径 + op)在 issues 里,面板据此标红。
		expect(body.message).toBe("主人，拓展设置没通过检查，共 1 条，请看看对应的格子。");
		expect(issuesOf(body)).toEqual([expect.objectContaining(expected)]);
		expect(h.stored()).toEqual(before);
		expect(h.settingsFrames()).toEqual([]);
	});

	it("add 照清单校验那一项:缺了必填的名字 → 拦下,点名到那一格,带上是第几步", async () => {
		const h = await boot({ running: false, settings: { links: [GOOD_LINK] } });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [
				{ op: "set", key: "interval", value: 120 },
				{ op: "add", list: "links", item: { token: TOKEN } },
			],
		});
		expect(res.status).toBe(400);
		const [issue, ...rest] = issuesOf(await res.json());
		expect(rest).toEqual([]);
		expect(issue?.op).toBe(1);
		expect(issue?.path?.[0]).toBe("links");
		expect(issue?.path?.at(-1)).toBe("name");
		// 一步不合规矩,整发都不写 —— 前面那步合规矩的 set 也不写。
		expect(h.stored()).toEqual({ links: [GOOD_LINK] });
	});

	it("add 里带 id —— 拦下(id 由 BN 生成)", async () => {
		const h = await boot({ running: false });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "add", list: "links", item: { id: "mine", name: "x" } }],
		});
		expect(res.status).toBe(400);
		expect(issuesOf(await res.json())[0]?.path?.at(-1)).toBe("id");
		expect(h.stored()).toBeUndefined();
	});

	it("请求体不成形状(没带版本号 / 一步都没有 / 不认识的 op)—— 400", async () => {
		const h = await boot({ running: false });
		for (const body of [
			{ ops: [{ op: "set", key: "interval", value: 90 }] },
			{ revision: await h.revision(), ops: [] },
			{ revision: await h.revision(), ops: [{ op: "replace", key: "interval", value: 90 }] },
		]) {
			const res = await h.patch(body);
			expect(res.status).toBe(400);
			const failure = await failureOf(res);
			expect(failure.code).toBe("invalid");
			// zod 自己的字段(code / expected / received …)不往外甩:每条只有路径与原话。
			for (const issue of failure.issues ?? []) {
				expect(Object.keys(issue).every((key) => key === "path" || key === "message")).toBe(true);
			}
			expect(failure.issues?.length).toBeGreaterThan(0);
		}
		expect(h.stored()).toBeUndefined();
	});
});

/**
 * 决策 35 第三点:清单造出来的校验表达不了整数、正则、跨字段规则 —— 放行的值拓展一读就整份失败。
 * 所以拓展在跑时,写入再过它自己那份 zod;判据是**这次写入之后新冒出来的**问题,存量里本来就
 * 坏的不连坐(否则连删掉坏项都被拒)。
 */
describe("PATCH /api/ext/:id/settings —— 拓展在跑时再过它自己的 zod", () => {
	it("清单放行、拓展的 zod 不收的(间隔不是整数)—— 拦下,点名到那一格", async () => {
		const h = await boot({ running: true, settings: { interval: 90 } });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 90.5 }],
		});
		expect(res.status).toBe(400);
		expect(issuesOf(await res.json())).toEqual([
			expect.objectContaining({ op: 0, path: ["interval"] }),
		]);
		expect(h.stored()).toEqual({ interval: 90 });
	});

	it("拓展的异步 refine 照样拦得住(新加的那一项名字带「坏」)", async () => {
		const h = await boot({ running: true, settings: { links: [GOOD_LINK] } });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "add", list: "links", item: { name: "坏掉的" } }],
		});
		expect(res.status).toBe(400);
		const [issue] = issuesOf(await res.json());
		expect(issue?.op).toBe(0);
		expect(issue?.message).toMatch(/坏/);
		expect(h.stored()).toEqual({ links: [GOOD_LINK] });
	});

	// 拓展的校验代码自己抛了(不是 zod 的报错):对端的错,原话给主人 —— unavailable,不是 500。
	it("拓展自己的校验抛了 —— 503 unavailable,话里点名是哪个拓展、带它的原话;一个字不写", async () => {
		const h = await boot({
			running: true,
			settings: { interval: 90 },
			// 与清单声明的格对得上(宿主起拓展时要对表),再多一道会抛的规矩。
			zod: DOUYIN_ZOD.refine((value) => {
				if (value.interval === 111) throw new Error("校验里访问了 undefined");
				return true;
			}),
		});
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 111 }],
		});
		expect(res.status).toBe(503);
		expect(await failureOf(res)).toEqual({
			code: "unavailable",
			message: "主人，拓展 douyin 的设置校验代码出错了：校验里访问了 undefined",
		});
		expect(h.stored()).toEqual({ interval: 90 });
		expect(h.settingsFrames()).toEqual([]);
	});

	const ROTTEN = { ...GOOD_LINK, id: "rotten", name: "坏的那台" };

	// 存量里坏着,它就起不来(「设置读不了」)—— 写入照样过它留下的那份 zod。
	it("存量里本来就坏的(名字带「坏」):改另一条放行,改对它放行", async () => {
		const h = await boot({
			running: true,
			settings: { links: [ROTTEN, GOOD_LINK] },
			state: "settings-invalid",
		});
		// 坏的那条还在,但那不是这次写入冒出来的。
		const other = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "good-1", values: { name: "改了名" } }],
		});
		expect(other.status).toBe(200);
		const fixed = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "rotten", values: { name: "好了" } }],
		});
		expect(fixed.status).toBe(200);
		expect(h.stored()).toEqual({
			links: [
				{ ...ROTTEN, name: "好了" },
				{ ...GOOD_LINK, name: "改了名" },
			],
		});
	});

	/**
	 * 删掉排在坏项前面的那条,坏项的下标从 1 挪到 0 —— 仍是同一条。按下标比的话它成了「新冒出来的」,
	 * 连删一条好项都被拒;所以比对时按 id 认项。
	 */
	it("存量里本来就坏的:删它前面那条(下标挪了)放行,删它自己也放行", async () => {
		const h = await boot({
			running: true,
			settings: { links: [GOOD_LINK, ROTTEN] },
			state: "settings-invalid",
		});
		const removedFirst = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "remove", list: "links", id: "good-1" }],
		});
		expect(removedFirst.status).toBe(200);
		const removedRotten = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "remove", list: "links", id: "rotten" }],
		});
		expect(removedRotten.status).toBe(200);
		expect(h.stored()).toEqual({ links: [] });
	});

	it("拓展没在跑 —— 只有清单那一道(间隔 90.5 清单放行)", async () => {
		const h = await boot({ running: false, settings: { interval: 90 } });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 90.5 }],
		});
		expect(res.status).toBe(200);
		expect(h.stored()).toEqual({ interval: 90.5 });
	});
});

/**
 * 拓展处在「设置读不了」(ADR-0019 决策 36):存着的那份过不了它自己的 zod,它不跑 —— 设置照样能改,
 * 写入照样过它**收摊前留下的那份 zod**(只拦新冒出来的),改对了自己起来。
 */
describe("PATCH /api/ext/:id/settings —— 拓展处在「设置读不了」", () => {
	const ROTTEN = { ...GOOD_LINK, id: "rotten", name: "坏的那台" };
	const ROTTEN_2 = { ...GOOD_LINK, id: "rotten-2", name: "坏的第二台" };

	it("写入照样过它留下的那份 zod:清单放行、它不收的(间隔不是整数)拦下", async () => {
		const h = await boot({
			running: true,
			settings: { links: [ROTTEN] },
			state: "settings-invalid",
		});
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 90.5 }],
		});
		expect(res.status).toBe(400);
		expect(issuesOf(await res.json())).toEqual([
			expect.objectContaining({ op: 0, path: ["interval"] }),
		]);
		expect(h.stored()).toEqual({ links: [ROTTEN] });
	});

	it("经这里改对 → 自己跑起来,不用拨开关、不用重启", async () => {
		const h = await boot({
			running: true,
			settings: { links: [ROTTEN] },
			state: "settings-invalid",
		});
		expect(h.douyin()?.detail).toContain("「坏的那台」");
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "rotten", values: { name: "好了" } }],
		});
		expect(res.status).toBe(200);
		await h.settled();
		expect(h.douyin()?.state).toBe("running");
		expect(h.activations()).toBe(2);
	});

	it("改对一处、还有一处坏着 → 不起,原因换成剩下那处,activate 不重跑", async () => {
		const h = await boot({
			running: true,
			settings: { links: [ROTTEN, ROTTEN_2] },
			state: "settings-invalid",
		});
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "update", list: "links", id: "rotten", values: { name: "好了" } }],
		});
		expect(res.status).toBe(200);
		await h.settled();
		expect(h.douyin()?.state).toBe("settings-invalid");
		expect(h.douyin()?.detail).toContain("「坏的第二台」");
		expect(h.douyin()?.detail).not.toContain("「坏的那台」");
		expect(h.activations()).toBe(1);
	});

	/**
	 * 跑着时经这个路由的写入过了它的 zod,撞上的只剩旁路。它的 zod 带**异步** refine:ctx 同步判不完,
	 * 异步判坏了要自己喊装载器来收 —— 光靠「设置落盘」那一趟对账,那时候判决还没回来。
	 */
	it("跑着时被旁路写坏(异步 refine)→ 收掉,那一行变「设置读不了」", async () => {
		const h = await boot({ running: true, settings: { links: [GOOD_LINK] } });
		await h.bypass({ links: [GOOD_LINK, ROTTEN] });
		await vi.waitFor(() => expect(h.douyin()?.state).toBe("settings-invalid"));
		expect(h.douyin()?.detail).toContain("名字里不许有「坏」字");
	});
});

describe("PATCH /api/ext/:id/settings —— 写完发一帧", () => {
	it("写成了 → WS state 频道一帧 extension-settings-changed,只带 extensionId", async () => {
		const h = await boot({ running: false });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 120 }],
		});
		expect(res.status).toBe(200);
		expect(h.settingsFrames()).toEqual([
			expect.objectContaining({
				type: "state",
				event: "extension-settings-changed",
				data: { extensionId: "douyin" },
			}),
		]);
	});

	it("409 不发", async () => {
		const h = await boot({ running: false });
		const res = await h.patch({
			revision: "stale",
			ops: [{ op: "set", key: "interval", value: 120 }],
		});
		expect(res.status).toBe(409);
		expect(h.settingsFrames()).toEqual([]);
	});
});

describe("PATCH /api/ext/:id/settings —— 存到哪", () => {
	/**
	 * 一个拓展的设置住它自己的文件(ADR-0021 决策 42),不进核心设置:写成了,盘上那个文件就是新的那份;
	 * 读回来的与盘上的是同一份(从文件里读回的,不是内存里的另一份副本)。
	 */
	it("写成了 → config/settings/extensions/<id>.json 就是新的那份", async () => {
		const h = await boot({ running: false, settings: { interval: 90 } });
		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 120 }],
		});
		expect(res.status).toBe(200);
		const onDisk = JSON.parse(
			await readFile(join(dataDir, ...extensionSettingsFile("douyin")), "utf8"),
		);
		expect(onDisk).toEqual({ interval: 120 });
		expect(h.stored()).toEqual(onDisk);
	});

	it("409 不写盘:文件还是写前那份", async () => {
		const h = await boot({ running: false, settings: { interval: 90 } });
		const res = await h.patch({
			revision: "stale",
			ops: [{ op: "set", key: "interval", value: 120 }],
		});
		expect(res.status).toBe(409);
		const onDisk = JSON.parse(
			await readFile(join(dataDir, ...extensionSettingsFile("douyin")), "utf8"),
		);
		expect(onDisk).toEqual({ interval: 90 });
	});
});

/**
 * 设置文件不是合法 JSON:拓展停在「设置读不了」,面板照样能存;存一次 = 整份以新值为准,
 * 配置仓清掉原因,装载器再把它叫起来。钉的是整条接线(路由 → 配置仓清表 → 装载器再起)。
 */
describe("PATCH /api/ext/:id/settings —— 设置文件不是合法 JSON", () => {
	it("存一次 → 文件写好、原因清掉、拓展起来", async () => {
		const h = await boot({
			running: true,
			rawFile: '{"links": [',
			state: "settings-invalid",
		});
		expect(h.douyin()?.detail).toContain("不是合法的 JSON");
		expect(h.activations()).toBe(0);
		expect(runtime?.configStore.extensionSettingsIssue("douyin")).toBeDefined();

		const res = await h.patch({
			revision: await h.revision(),
			ops: [{ op: "set", key: "interval", value: 90 }],
		});
		expect(res.status).toBe(200);
		await h.settled();

		expect(runtime?.configStore.extensionSettingsIssue("douyin")).toBeUndefined();
		expect(
			JSON.parse(await readFile(join(dataDir, ...extensionSettingsFile("douyin")), "utf8")),
		).toEqual({
			interval: 90,
		});
		expect(h.douyin()?.state).toBe("running");
		expect(h.activations()).toBe(1);
	});
});
