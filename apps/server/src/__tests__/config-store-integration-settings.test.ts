/**
 * 配置仓的「集成设置」:一个集成一个文件(`config/settings/<键>.json`),登记在组装处(ADR-0021 决策 42 下
 * 10-01 的 🔗)。这里钉仓这一半的通用机制 —— 用一个只在测试里用的小集成(`poke`、`other`)登记进去,不借真正的
 * B 站设置:
 *   - 读盘:没有就按格式的默认值建、有就读;内容读不懂不挡开机(一格坏了那一格退默认、整个文件读不懂整段退默认,
 *     盘上原文不动,读口交盘上那一份),读盘本身出错照旧挡开机;
 *   - 写:坏格的原文保存时留着(比值)、写失败按字节回滚、恢复备份以备份为准;
 *   - `patchSettings`:合并、落盘、只广播 `integration-settings`;格式 / 写入校验(`checkWrite`)不过整次作废,
 *     逐格原因的路径带集成的键;没登记的键整次拒收;核心与集成同一发时「要么全写要么全不写」;
 *   - `replaceSections({ integrations })`:整份替换(不是合并)、同一套校验、与别的分区同一个事务;
 *   - 登记时键重复、或与核心设置的顶层键撞名,构造就抛。
 *
 * B 站那份的具体格式与 cron 校验在 `bilibili/__tests__/settings.test.ts`。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConfigScope,
	GlobalConfigSchema,
	type MessageBus,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import type { BootstrapConfig } from "../config/schema.js";
import {
	CONFIG_DIR,
	CORE_SETTINGS_FILE,
	type ConfigStore,
	createConfigStore,
	type IntegrationSettingsSegment,
	integrationSettingsFile,
} from "../config/store.js";
import { createNodeMessageBus } from "../runtime/message-bus.js";

// ---------------------------------------------------------------------------
// 测试用的两个小集成
// ---------------------------------------------------------------------------

const PokeSchema = z.object({
	label: z.string().default("hello"),
	count: z.number().int().min(0).default(0),
	note: z.string().optional(),
});
type Poke = z.infer<typeof PokeSchema>;

const FORBIDDEN_LABEL = "forbidden";

const pokeSegment: IntegrationSettingsSegment<Poke> = {
	key: "poke",
	schema: PokeSchema,
	// 两条写入时才核的规矩(读盘不核):一个格子的禁用值;一个跨两格的(要看合并后的整份)。
	checkWrite(next) {
		const issues = [];
		if (next.label === FORBIDDEN_LABEL) {
			issues.push({ path: ["label"], message: "不许叫这个" });
		}
		if (next.label === "A" && next.count > 10) {
			issues.push({ path: ["count"], message: "A 的次数不能超过 10" });
		}
		return issues;
	},
};

const OtherSchema = z.object({ level: z.number().int().default(1) });
type Other = z.infer<typeof OtherSchema>;
const otherSegment: IntegrationSettingsSegment<Other> = { key: "other", schema: OtherSchema };

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

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

function makeBootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

let dataDir: string;
let bus: MessageBus;
/** `config-changed` 按序收到的 scope。 */
let scopes: ConfigScope[];

/** 仓里内存那一份(坏格是默认值),经全量图读出来。 */
const pokeOf = (store: ConfigStore) => store.getAllIntegrationSettings().poke as Poke;
const otherOf = (store: ConfigStore) => store.getAllIntegrationSettings().other as Other;

const pokeFile = () => join(dataDir, ...integrationSettingsFile("poke"));
const otherFile = () => join(dataDir, ...integrationSettingsFile("other"));
const coreFile = () => join(dataDir, ...CORE_SETTINGS_FILE);

function build(
	segments: readonly IntegrationSettingsSegment[] = [pokeSegment, otherSegment],
): ConfigStore {
	return createConfigStore({
		bootstrap: makeBootstrap(dataDir),
		dataRoot: dataDir,
		bus,
		serviceCtx: makeServiceCtx(),
		integrationSettings: segments,
	});
}

async function open(segments?: readonly IntegrationSettingsSegment[]): Promise<ConfigStore> {
	const store = build(segments);
	await store.load();
	scopes.length = 0; // load 本身不广播,保险起见清一次
	return store;
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-config-integration-"));
	bus = createNodeMessageBus();
	scopes = [];
	bus.on("config-changed", ({ scope }) => {
		scopes.push(scope);
	});
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

/** 在 `load()` 之前先把一个集成的设置文件摆到盘上。 */
async function placeFile(path: string, content: string): Promise<void> {
	await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
	await writeFile(path, content, "utf8");
}

// ---------------------------------------------------------------------------
// 读盘
// ---------------------------------------------------------------------------

describe("集成设置 — load", () => {
	it("文件不存在 → 按格式的默认值建一份 config/settings/<键>.json,内存里也是默认值", async () => {
		const store = await open();

		const defaults = { label: "hello", count: 0 };
		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual(defaults);
		expect(JSON.parse(await readFile(otherFile(), "utf8"))).toEqual({ level: 1 });
		expect(pokeOf(store)).toEqual(defaults);
	});

	it("文件已存在 → 读它,缺的格补默认值(对存量宽松)", async () => {
		await placeFile(pokeFile(), JSON.stringify({ count: 7, note: "from disk" }));

		const store = await open();

		expect(pokeOf(store)).toEqual({
			label: "hello",
			count: 7,
			note: "from disk",
		});
	});

	// 翻了的旧用例:从前「某一格不合格式 → 开机失败」。哪格坏停哪样(主人 10-11 定):坏格在内存里是默认值、别的格
	// 照盘上的值,读它的集成拿到的是盘上原文,文件一个字节不动。
	it("某一格不合格式 → 开机成功:那一格是默认值、别的格是盘上的值,文件字节不变,读口带原文", async () => {
		const text = JSON.stringify({ label: "from disk", count: "abc" });
		await placeFile(pokeFile(), text);

		const store = await open();

		expect(pokeOf(store)).toEqual({ label: "from disk", count: 0 });
		expect(store.readIntegrationSettings("poke")).toEqual({
			ok: true,
			settings: { label: "from disk", count: "abc" },
		});
		expect(await readFile(pokeFile(), "utf8")).toBe(text);
	});

	it("一格坏着开机:记一行 warn,点名那一格与原因,不带原文", async () => {
		await placeFile(pokeFile(), JSON.stringify({ count: "abc-secret" }));
		const ctx = makeServiceCtx();
		const store = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus,
			serviceCtx: ctx,
			integrationSettings: [pokeSegment, otherSegment],
		});

		await store.load();

		const lines = vi.mocked(ctx.logger.warn).mock.calls.map(([msg]) => String(msg));
		const mine = lines.filter((l) => l.includes("poke.json"));
		expect(mine).toHaveLength(1);
		expect(mine[0]).toContain("count");
		expect(mine[0]).not.toContain("abc-secret");
	});

	it("文件开头就是密钥样的裸串(V8 会把它抄进解析报错):原因、读口、日志里都没有那串字符", async () => {
		const leak = "sk-LEAKCANARY";
		// 前提:V8 的原话里真的有这串字符;没有的话这条测试什么都证明不了。
		expect(() => JSON.parse(leak)).toThrow(leak);
		await placeFile(pokeFile(), leak);
		const ctx = makeServiceCtx();
		const store = createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus,
			serviceCtx: ctx,
			integrationSettings: [pokeSegment, otherSegment],
		});

		await store.load();

		const r = store.readIntegrationSettings("poke");
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(leak);
		const logged = (["info", "warn", "error", "debug"] as const).flatMap((k) =>
			vi.mocked(ctx.logger[k]).mock.calls.map((c) => String(c[0])),
		);
		expect(logged.some((l) => l.includes("poke.json"))).toBe(true);
		expect(logged.join("\n")).not.toContain(leak);
	});

	it("读盘本身出错(路径是个目录)→ load 仍然抛,挡开机", async () => {
		await mkdir(pokeFile(), { recursive: true });

		await expect(build().load()).rejects.toThrow();
	});

	it("一个集成都没登记 → 照常开机,没有集成设置、也不建任何集成文件", async () => {
		const store = await open([]);

		expect(store.getAllIntegrationSettings()).toEqual({});
		const settingsDir = join(dataDir, ...CONFIG_DIR, "settings");
		expect(await readdir(settingsDir)).toEqual(["core.json"]);
	});
});

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

describe("集成设置 — 读", () => {
	it("readIntegrationSettings 回深拷贝:改返回值不影响仓里那份", async () => {
		const store = await open();

		const got = store.readIntegrationSettings("poke");
		if (got.ok) (got.settings as Poke).label = "tampered";

		expect(pokeOf(store).label).toBe("hello");
	});

	it("readIntegrationSettings 按键回内存里那一份(ok),也是深拷贝", async () => {
		await placeFile(pokeFile(), JSON.stringify({ count: 7 }));
		const store = await open();

		const r = store.readIntegrationSettings("poke");
		expect(r).toEqual({ ok: true, settings: { label: "hello", count: 7 } });
		if (r.ok) (r.settings as Poke).label = "tampered";

		expect(store.readIntegrationSettings("poke")).toEqual({
			ok: true,
			settings: { label: "hello", count: 7 },
		});
	});

	it("readIntegrationSettings 没登记过的键 → 抛(组装处漏了)", async () => {
		const store = await open([pokeSegment]);

		expect(() => store.readIntegrationSettings("other")).toThrow(/没有登记/);
	});

	it("getAllIntegrationSettings 按集成的键给全部,也是深拷贝", async () => {
		const store = await open();

		const all = store.getAllIntegrationSettings() as { poke: Poke; other: Other };
		expect(all).toEqual({ poke: { label: "hello", count: 0 }, other: { level: 1 } });
		all.poke.label = "tampered";

		expect(pokeOf(store).label).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// patchSettings — 集成那一半
// ---------------------------------------------------------------------------

describe("集成设置 — patchSettings", () => {
	it("合并补丁、落盘,只广播 integration-settings(不广播 globals)", async () => {
		const store = await open();
		const globalsBefore = store.getGlobals();

		const snapshot = await store.patchSettings({ integrations: { poke: { count: 5 } } });

		expect(snapshot.integrations.poke).toEqual({ label: "hello", count: 5 });
		expect(pokeOf(store)).toEqual({ label: "hello", count: 5 });
		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "hello", count: 5 });
		expect(store.getGlobals()).toEqual(globalsBefore);
		expect(scopes).toEqual(["integration-settings"]);
	});

	it("补丁是深合并:没给的格保留原值", async () => {
		const store = await open();

		await store.patchSettings({ integrations: { poke: { label: "A" } } });
		await store.patchSettings({ integrations: { poke: { count: 2 } } });

		expect(pokeOf(store)).toEqual({ label: "A", count: 2 });
	});

	it("null 清除可选格;不带该键 ≠ 清除", async () => {
		const store = await open();
		await store.patchSettings({ integrations: { poke: { note: "keep me" } } });

		await store.patchSettings({ integrations: { poke: { count: 1 } } });
		expect(pokeOf(store).note).toBe("keep me");

		await store.patchSettings({ integrations: { poke: { note: null } } });
		expect(pokeOf(store).note).toBeUndefined();
		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).not.toHaveProperty("note");
	});

	it("一发改好几个集成:各写各的文件,只广播一次", async () => {
		const store = await open();

		await store.patchSettings({
			integrations: { poke: { count: 3 }, other: { level: 4 } },
		});

		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toMatchObject({ count: 3 });
		expect(JSON.parse(await readFile(otherFile(), "utf8"))).toEqual({ level: 4 });
		expect(scopes).toEqual(["integration-settings"]);
	});

	it("只送核心补丁:不碰集成,不广播 integration-settings", async () => {
		const store = await open();
		const pokeBytes = await readFile(pokeFile(), "utf8");

		await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });

		expect(scopes).toEqual(["globals"]);
		expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
	});

	describe("checkWrite 与格式校验", () => {
		it("checkWrite 拒绝 → invalid,逐格路径带集成的键;盘上与内存都不动,不广播", async () => {
			const store = await open();
			const before = await readFile(pokeFile(), "utf8");

			await expect(
				store.patchSettings({ integrations: { poke: { label: FORBIDDEN_LABEL } } }),
			).rejects.toMatchObject({
				name: "ConfigValidationError",
				code: "invalid",
				scope: "integration-settings",
				issues: [{ path: ["poke", "label"], message: "不许叫这个" }],
			});

			expect(await readFile(pokeFile(), "utf8")).toBe(before);
			expect(pokeOf(store).label).toBe("hello");
			expect(scopes).toEqual([]);
		});

		it("格式不过 → 同样 invalid,路径带集成的键,什么都不写", async () => {
			const store = await open();
			const before = await readFile(pokeFile(), "utf8");

			await expect(
				store.patchSettings({ integrations: { poke: { count: -1 } } }),
			).rejects.toMatchObject({
				code: "invalid",
				scope: "integration-settings",
				issues: [expect.objectContaining({ path: ["poke", "count"] })],
			});

			expect(await readFile(pokeFile(), "utf8")).toBe(before);
			expect(scopes).toEqual([]);
		});

		it("checkWrite 看到的是合并之后的整份,不只是补丁", async () => {
			const store = await open();
			await store.patchSettings({ integrations: { poke: { label: "A" } } });

			// 这一发只带 count;label 是 "A" 来自仓里原有的值 —— 两格凑在一起才违规。
			await expect(
				store.patchSettings({ integrations: { poke: { count: 11 } } }),
			).rejects.toMatchObject({
				code: "invalid",
				issues: [{ path: ["poke", "count"], message: "A 的次数不能超过 10" }],
			});
			expect(pokeOf(store).count).toBe(0);
		});

		it("没登记的集成键 → invalid,整次拒收:同一发里登记过的那份也不写,没建出新文件", async () => {
			const store = await open();
			const before = await readFile(pokeFile(), "utf8");

			await expect(
				store.patchSettings({
					integrations: { poke: { count: 3 }, ghost: { anything: true } },
				}),
			).rejects.toMatchObject({
				name: "ConfigValidationError",
				code: "invalid",
				scope: "integration-settings",
				issues: [expect.objectContaining({ path: ["ghost"] })],
			});

			expect(await readFile(pokeFile(), "utf8")).toBe(before);
			expect(pokeOf(store).count).toBe(0);
			expect(await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).not.toContain("ghost.json");
			expect(scopes).toEqual([]);
		});
	});

	describe("核心与集成一发送", () => {
		it("都合法:各写各的文件,两档各广播一次", async () => {
			const store = await open();

			await store.patchSettings({
				core: { profileRefreshCron: "*/9 * * * *" },
				integrations: { poke: { count: 6 } },
			});

			expect(store.getGlobals().profileRefreshCron).toBe("*/9 * * * *");
			expect(JSON.parse(await readFile(coreFile(), "utf8")).profileRefreshCron).toBe("*/9 * * * *");
			expect(JSON.parse(await readFile(pokeFile(), "utf8")).count).toBe(6);
			expect([...scopes].sort()).toEqual(["globals", "integration-settings"]);
		});

		it("核心校验不过 → 一个字都不写:集成文件字节原样、内存不变、不广播", async () => {
			const store = await open();
			const pokeBytes = await readFile(pokeFile(), "utf8");
			const coreBytes = await readFile(coreFile(), "utf8");

			await expect(
				store.patchSettings({
					core: { profileRefreshCron: 42 as unknown as string },
					integrations: { poke: { count: 9 } },
				}),
			).rejects.toMatchObject({ code: "invalid", scope: "globals" });

			expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
			expect(await readFile(coreFile(), "utf8")).toBe(coreBytes);
			expect(pokeOf(store).count).toBe(0);
			expect(scopes).toEqual([]);
		});

		it("集成校验不过 → 核心那份也不写", async () => {
			const store = await open();
			const coreBytes = await readFile(coreFile(), "utf8");
			const fansCron = store.getGlobals().profileRefreshCron;

			await expect(
				store.patchSettings({
					core: { profileRefreshCron: "*/9 * * * *" },
					integrations: { poke: { label: FORBIDDEN_LABEL } },
				}),
			).rejects.toMatchObject({ code: "invalid", scope: "integration-settings" });

			expect(await readFile(coreFile(), "utf8")).toBe(coreBytes);
			expect(store.getGlobals().profileRefreshCron).toBe(fansCron);
			expect(scopes).toEqual([]);
		});

		it("写核心失败(核心文件被占成目录)→ 已写的集成文件逐字节退回、内存不变、不广播", async () => {
			const store = await open();
			// 先写一次,让两份集成文件都有「上一次」的确切字节。
			await store.patchSettings({ integrations: { poke: { count: 1 }, other: { level: 2 } } });
			const pokeBytes = await readFile(pokeFile(), "utf8");
			const otherBytes = await readFile(otherFile(), "utf8");
			const fansCron = store.getGlobals().profileRefreshCron;
			scopes.length = 0;

			// 数组/集成先写、核心最后写:把核心文件占成目录,让最后一步失败。
			await rm(coreFile());
			await mkdir(coreFile());

			await expect(
				store.patchSettings({
					core: { profileRefreshCron: "*/9 * * * *" },
					integrations: { poke: { count: 2 }, other: { level: 5 } },
				}),
			).rejects.toThrow();

			expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
			expect(await readFile(otherFile(), "utf8")).toBe(otherBytes);
			expect(pokeOf(store).count).toBe(1);
			expect(otherOf(store).level).toBe(2);
			expect(store.getGlobals().profileRefreshCron).toBe(fansCron);
			expect(scopes).toEqual([]);
			// 推回去不留临时文件:设置目录里就这三样(核心那个是被我们占成目录的)。
			expect((await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).sort()).toEqual([
				"core.json",
				"other.json",
				"poke.json",
			]);
		});
	});
});

// ---------------------------------------------------------------------------
// replaceSections({ integrations }) —— 恢复备份与迁移走的整份替换
// ---------------------------------------------------------------------------

describe("集成设置 — replaceSections", () => {
	it("整份替换(不是合并):没给的格回到默认值;没给的集成保持不动;广播 integration-settings", async () => {
		const store = await open();
		await store.patchSettings({
			integrations: { poke: { label: "A", count: 9, note: "n" }, other: { level: 3 } },
		});
		scopes.length = 0;

		const changed = await store.replaceSections({ integrations: { poke: { label: "B" } } });

		expect(changed).toEqual(["integration-settings"]);
		expect(pokeOf(store)).toEqual({ label: "B", count: 0 });
		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "B", count: 0 });
		expect(otherOf(store)).toEqual({ level: 3 });
		expect(scopes).toEqual(["integration-settings"]);
	});

	it("checkWrite 拒绝 → invalid,路径带集成的键;同一发里合法的别的集成也不写", async () => {
		const store = await open();
		const pokeBytes = await readFile(pokeFile(), "utf8");
		const otherBytes = await readFile(otherFile(), "utf8");

		await expect(
			store.replaceSections({
				integrations: { other: { level: 8 }, poke: { label: FORBIDDEN_LABEL } },
			}),
		).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "invalid",
			scope: "integration-settings",
			issues: [{ path: ["poke", "label"], message: "不许叫这个" }],
		});

		expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
		expect(await readFile(otherFile(), "utf8")).toBe(otherBytes);
		expect(otherOf(store).level).toBe(1);
		expect(scopes).toEqual([]);
	});

	it("没登记的集成键 → 整次拒收:同一发里登记过的那份也不写", async () => {
		const store = await open();
		const pokeBytes = await readFile(pokeFile(), "utf8");

		await expect(
			store.replaceSections({
				integrations: { poke: { label: "B" }, ghost: { anything: true } },
			}),
		).rejects.toMatchObject({ code: "invalid", scope: "integration-settings" });

		expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
		expect(pokeOf(store).label).toBe("hello");
		expect(await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).not.toContain("ghost.json");
		expect(scopes).toEqual([]);
	});

	it("与别的分区同一个事务:核心最后一步写失败 → 集成文件逐字节退回,不留回滚副本", async () => {
		const store = await open();
		const pokeBytes = await readFile(pokeFile(), "utf8");
		await rm(coreFile());
		await mkdir(coreFile());
		const globals = store.getGlobals();
		const fansCron = globals.profileRefreshCron;

		await expect(
			store.replaceSections({
				integrations: { poke: { label: "B", count: 4 } },
				globals: { ...globals, profileRefreshCron: "*/9 * * * *" },
			}),
		).rejects.toThrow();

		expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
		expect(pokeOf(store)).toEqual({ label: "hello", count: 0 });
		expect(store.getGlobals().profileRefreshCron).toBe(fansCron);
		expect(
			(await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).filter((n) =>
				n.endsWith(".restore.bak"),
			),
		).toEqual([]);
		expect(scopes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 坏格与读不懂的文件:内存里永远合法、盘上原文只在重存那一格时才换
// ---------------------------------------------------------------------------

describe("集成设置 — 坏格与读不懂的文件", () => {
	/** 把核心文件占成目录:写核心(最后一步)必失败,用来逼出回滚。 */
	async function breakCoreWrite(): Promise<void> {
		await rm(coreFile());
		await mkdir(coreFile());
	}

	describe("整个文件读不懂", () => {
		it("半截 JSON → 开机成功;读口回 invalid(一条、不带 path、原因不带文件内容);全量图里键在、值是整段默认;文件字节不变", async () => {
			const text = '{"label": "secret-label-xyz", "count": ';
			await placeFile(pokeFile(), text);

			const store = await open();

			const r = store.readIntegrationSettings("poke");
			expect(r.ok).toBe(false);
			if (r.ok) return;
			expect(r.code).toBe("invalid");
			expect(r.issues).toHaveLength(1);
			expect(r.issues?.[0]).not.toHaveProperty("path");
			expect(JSON.stringify(r)).not.toContain("secret-label-xyz");
			expect(store.getAllIntegrationSettings()).toHaveProperty("poke", {
				label: "hello",
				count: 0,
			});
			expect(await readFile(pokeFile(), "utf8")).toBe(text);
		});

		it("顶层是数组 → 与半截 JSON 同样处理(整段读不懂、整段默认、文件不动)", async () => {
			const text = '[{"label":"x"}]';
			await placeFile(pokeFile(), text);

			const store = await open();

			const r = store.readIntegrationSettings("poke");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.issues?.[0]).not.toHaveProperty("path");
			expect(pokeOf(store)).toEqual({ label: "hello", count: 0 });
			expect(await readFile(pokeFile(), "utf8")).toBe(text);
		});

		it("读不懂的只是一个集成:别的集成照常读", async () => {
			await placeFile(pokeFile(), "{");
			await placeFile(otherFile(), JSON.stringify({ level: 7 }));

			const store = await open();

			expect(store.readIntegrationSettings("other")).toEqual({ ok: true, settings: { level: 7 } });
		});

		it("补丁带了这一段 → 整文件重写成合法的、原因清掉、广播", async () => {
			await placeFile(pokeFile(), '{"label": ');
			const store = await open();

			await store.patchSettings({ integrations: { poke: { label: "A", count: 0 } } });

			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "A", count: 0 });
			expect(store.readIntegrationSettings("poke")).toEqual({
				ok: true,
				settings: { label: "A", count: 0 },
			});
			expect(scopes).toEqual(["integration-settings"]);
		});

		it("核心那份写失败 → 文件字节退回那份半截 JSON、读口仍然 invalid、不广播", async () => {
			const text = '{"label": ';
			await placeFile(pokeFile(), text);
			const store = await open();
			await breakCoreWrite();

			await expect(
				store.patchSettings({
					core: { profileRefreshCron: "*/9 * * * *" },
					integrations: { poke: { label: "A" } },
				}),
			).rejects.toThrow();

			expect(await readFile(pokeFile(), "utf8")).toBe(text);
			expect(store.readIntegrationSettings("poke").ok).toBe(false);
			expect(pokeOf(store)).toEqual({ label: "hello", count: 0 });
			expect(scopes).toEqual([]);
		});

		it("恢复备份带了这一段 → 原因清掉、盘上以备份那份为准", async () => {
			await placeFile(pokeFile(), "{");
			const store = await open();

			await store.replaceSections({ integrations: { poke: { label: "B", count: 3 } } });

			expect(store.readIntegrationSettings("poke")).toEqual({
				ok: true,
				settings: { label: "B", count: 3 },
			});
			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "B", count: 3 });
		});
	});

	describe("一格坏着", () => {
		const BAD = JSON.stringify({ label: "from disk", count: "abc" });

		// 系统页保存的真实形状:同一块的格子一起发,坏格显示的是默认值,所以补丁里它的值就是默认值。
		it("补丁带这一段、坏格的值等于默认 → 那格盘上仍是原文、读口仍带原文、另一格是新值", async () => {
			await placeFile(pokeFile(), BAD);
			const store = await open();

			await store.patchSettings({ integrations: { poke: { label: "new", count: 0 } } });

			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({
				label: "new",
				count: "abc",
			});
			expect(store.readIntegrationSettings("poke")).toEqual({
				ok: true,
				settings: { label: "new", count: "abc" },
			});
			expect(pokeOf(store)).toEqual({ label: "new", count: 0 });
		});

		it("补丁压根没带坏格 → 同样留着原文", async () => {
			await placeFile(pokeFile(), BAD);
			const store = await open();

			await store.patchSettings({ integrations: { poke: { label: "new" } } });

			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({
				label: "new",
				count: "abc",
			});
		});

		it("重存坏格(值与默认不同)→ 盘上是新值、坏格记录没了、广播", async () => {
			await placeFile(pokeFile(), BAD);
			const store = await open();

			await store.patchSettings({ integrations: { poke: { label: "from disk", count: 5 } } });

			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({
				label: "from disk",
				count: 5,
			});
			expect(store.readIntegrationSettings("poke")).toEqual({
				ok: true,
				settings: { label: "from disk", count: 5 },
			});
			expect(scopes).toEqual(["integration-settings"]);
			// 之后再存别的格:不会再有原文被放回。
			await store.patchSettings({ integrations: { poke: { label: "again" } } });
			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "again", count: 5 });
		});

		it("核心那份写失败 → 文件字节退回(坏格原文还在)、坏格记录与内存都没变、不广播", async () => {
			await placeFile(pokeFile(), BAD);
			const store = await open();
			await breakCoreWrite();

			await expect(
				store.patchSettings({
					core: { profileRefreshCron: "*/9 * * * *" },
					integrations: { poke: { label: "new", count: 9 } },
				}),
			).rejects.toThrow();

			expect(await readFile(pokeFile(), "utf8")).toBe(BAD);
			expect(store.readIntegrationSettings("poke")).toEqual({
				ok: true,
				settings: { label: "from disk", count: "abc" },
			});
			expect(pokeOf(store)).toEqual({ label: "from disk", count: 0 });
			expect(scopes).toEqual([]);
		});

		it("只带核心补丁、只带别的集成 → 这个文件的字节不变", async () => {
			await placeFile(pokeFile(), BAD);
			const store = await open();

			await store.patchGlobals({ profileRefreshCron: "*/9 * * * *" });
			await store.patchSettings({ integrations: { other: { level: 4 } } });

			expect(await readFile(pokeFile(), "utf8")).toBe(BAD);
		});

		it("恢复备份带了这一段 → 坏格记录清掉、盘上是备份那份(即使备份里那格正好等于默认)", async () => {
			await placeFile(pokeFile(), BAD);
			const store = await open();

			await store.replaceSections({ integrations: { poke: { label: "B", count: 0 } } });

			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "B", count: 0 });
			expect(store.readIntegrationSettings("poke")).toEqual({
				ok: true,
				settings: { label: "B", count: 0 },
			});
			// 记录已清:再存别的格,不会把旧原文放回来。
			await store.patchSettings({ integrations: { poke: { label: "C" } } });
			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "C", count: 0 });
		});

		it("可选格(没有默认)坏了:内存里键不在、读口带原文、保存别的格时原文留着", async () => {
			await placeFile(pokeFile(), JSON.stringify({ note: 42 }));
			const store = await open();

			expect(pokeOf(store)).toEqual({ label: "hello", count: 0 });
			expect(store.readIntegrationSettings("poke")).toMatchObject({
				ok: true,
				settings: { note: 42 },
			});

			await store.patchSettings({ integrations: { poke: { count: 1 } } });
			expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toMatchObject({ note: 42, count: 1 });
		});
	});
});

// ---------------------------------------------------------------------------
// 登记
// ---------------------------------------------------------------------------

describe("集成设置 — 登记", () => {
	it("格式过不了空对象(有必填格没默认值)→ 构造就抛:坏格退默认与文件不在建一份都靠它", () => {
		const needsLabel = z.object({ label: z.string() });
		expect(() => build([{ key: "needy", schema: needsLabel }])).toThrow(/空对象/);
	});

	it("同一个键登记两次 → 构造就抛", () => {
		expect(() => build([pokeSegment, { ...pokeSegment }])).toThrow(/登记了两次/);
	});

	it("键与核心设置的任何一个顶层键同名 → 构造就抛(/api/settings 把两者摆在同一层)", () => {
		const coreKeys = Object.keys(GlobalConfigSchema.shape);
		// 守住「核心顶层键」这张表本身没变空,免得下面的循环空转。
		expect(coreKeys).toContain("logging");
		for (const key of coreKeys) {
			expect(() => build([{ ...otherSegment, key }]), key).toThrow(/撞名/);
		}
	});
});
