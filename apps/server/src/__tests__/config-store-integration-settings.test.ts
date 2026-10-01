/**
 * 配置仓的「集成设置」:一个集成一个文件(`config/settings/<键>.json`),登记在组装处(ADR-0021 决策 42 下
 * 10-01 的 🔗)。这里钉仓这一半的通用机制 —— 用一个只在测试里用的小集成(`poke`、`other`)登记进去,不借真正的
 * B 站设置:
 *   - 读盘:没有就按格式的默认值建、有就读、读坏了开机失败;
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
		expect(store.getIntegrationSettings(pokeSegment)).toEqual(defaults);
	});

	it("文件已存在 → 读它,缺的格补默认值(对存量宽松)", async () => {
		await placeFile(pokeFile(), JSON.stringify({ count: 7, note: "from disk" }));

		const store = await open();

		expect(store.getIntegrationSettings(pokeSegment)).toEqual({
			label: "hello",
			count: 7,
			note: "from disk",
		});
	});

	it("文件存在但不合格式 → 开机失败:ConfigValidationError,scope 是 integration-settings", async () => {
		await placeFile(pokeFile(), JSON.stringify({ count: "abc" }));

		await expect(build().load()).rejects.toMatchObject({
			name: "ConfigValidationError",
			code: "invalid",
			scope: "integration-settings",
			message: expect.stringContaining("settings/poke.json"),
		});
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
	it("getIntegrationSettings 回深拷贝:改返回值不影响仓里那份", async () => {
		const store = await open();

		const got = store.getIntegrationSettings(pokeSegment);
		got.label = "tampered";

		expect(store.getIntegrationSettings(pokeSegment).label).toBe("hello");
	});

	it("没登记过的 segment → 抛(组装处漏了),不是回一份空的", async () => {
		const store = await open([pokeSegment]);

		expect(() => store.getIntegrationSettings(otherSegment)).toThrow(/没有登记/);
	});

	it("getAllIntegrationSettings 按集成的键给全部,也是深拷贝", async () => {
		const store = await open();

		const all = store.getAllIntegrationSettings() as { poke: Poke; other: Other };
		expect(all).toEqual({ poke: { label: "hello", count: 0 }, other: { level: 1 } });
		all.poke.label = "tampered";

		expect(store.getIntegrationSettings(pokeSegment).label).toBe("hello");
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
		expect(store.getIntegrationSettings(pokeSegment)).toEqual({ label: "hello", count: 5 });
		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "hello", count: 5 });
		expect(store.getGlobals()).toEqual(globalsBefore);
		expect(scopes).toEqual(["integration-settings"]);
	});

	it("补丁是深合并:没给的格保留原值", async () => {
		const store = await open();

		await store.patchSettings({ integrations: { poke: { label: "A" } } });
		await store.patchSettings({ integrations: { poke: { count: 2 } } });

		expect(store.getIntegrationSettings(pokeSegment)).toEqual({ label: "A", count: 2 });
	});

	it("null 清除可选格;不带该键 ≠ 清除", async () => {
		const store = await open();
		await store.patchSettings({ integrations: { poke: { note: "keep me" } } });

		await store.patchSettings({ integrations: { poke: { count: 1 } } });
		expect(store.getIntegrationSettings(pokeSegment).note).toBe("keep me");

		await store.patchSettings({ integrations: { poke: { note: null } } });
		expect(store.getIntegrationSettings(pokeSegment).note).toBeUndefined();
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

		await store.patchGlobals({ app: { fansCron: "*/9 * * * *" } });

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
			expect(store.getIntegrationSettings(pokeSegment).label).toBe("hello");
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
			expect(store.getIntegrationSettings(pokeSegment).count).toBe(0);
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
			expect(store.getIntegrationSettings(pokeSegment).count).toBe(0);
			expect(await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).not.toContain("ghost.json");
			expect(scopes).toEqual([]);
		});
	});

	describe("核心与集成一发送", () => {
		it("都合法:各写各的文件,两档各广播一次", async () => {
			const store = await open();

			await store.patchSettings({
				core: { app: { fansCron: "*/9 * * * *" } },
				integrations: { poke: { count: 6 } },
			});

			expect(store.getGlobals().app.fansCron).toBe("*/9 * * * *");
			expect(JSON.parse(await readFile(coreFile(), "utf8")).app.fansCron).toBe("*/9 * * * *");
			expect(JSON.parse(await readFile(pokeFile(), "utf8")).count).toBe(6);
			expect([...scopes].sort()).toEqual(["globals", "integration-settings"]);
		});

		it("核心校验不过 → 一个字都不写:集成文件字节原样、内存不变、不广播", async () => {
			const store = await open();
			const pokeBytes = await readFile(pokeFile(), "utf8");
			const coreBytes = await readFile(coreFile(), "utf8");

			await expect(
				store.patchSettings({
					core: { app: { fansCron: 42 as unknown as string } },
					integrations: { poke: { count: 9 } },
				}),
			).rejects.toMatchObject({ code: "invalid", scope: "globals" });

			expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
			expect(await readFile(coreFile(), "utf8")).toBe(coreBytes);
			expect(store.getIntegrationSettings(pokeSegment).count).toBe(0);
			expect(scopes).toEqual([]);
		});

		it("集成校验不过 → 核心那份也不写", async () => {
			const store = await open();
			const coreBytes = await readFile(coreFile(), "utf8");
			const fansCron = store.getGlobals().app.fansCron;

			await expect(
				store.patchSettings({
					core: { app: { fansCron: "*/9 * * * *" } },
					integrations: { poke: { label: FORBIDDEN_LABEL } },
				}),
			).rejects.toMatchObject({ code: "invalid", scope: "integration-settings" });

			expect(await readFile(coreFile(), "utf8")).toBe(coreBytes);
			expect(store.getGlobals().app.fansCron).toBe(fansCron);
			expect(scopes).toEqual([]);
		});

		it("写核心失败(核心文件被占成目录)→ 已写的集成文件逐字节退回、内存不变、不广播", async () => {
			const store = await open();
			// 先写一次,让两份集成文件都有「上一次」的确切字节。
			await store.patchSettings({ integrations: { poke: { count: 1 }, other: { level: 2 } } });
			const pokeBytes = await readFile(pokeFile(), "utf8");
			const otherBytes = await readFile(otherFile(), "utf8");
			const fansCron = store.getGlobals().app.fansCron;
			scopes.length = 0;

			// 数组/集成先写、核心最后写:把核心文件占成目录,让最后一步失败。
			await rm(coreFile());
			await mkdir(coreFile());

			await expect(
				store.patchSettings({
					core: { app: { fansCron: "*/9 * * * *" } },
					integrations: { poke: { count: 2 }, other: { level: 5 } },
				}),
			).rejects.toThrow();

			expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
			expect(await readFile(otherFile(), "utf8")).toBe(otherBytes);
			expect(store.getIntegrationSettings(pokeSegment).count).toBe(1);
			expect(store.getIntegrationSettings(otherSegment).level).toBe(2);
			expect(store.getGlobals().app.fansCron).toBe(fansCron);
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
		expect(store.getIntegrationSettings(pokeSegment)).toEqual({ label: "B", count: 0 });
		expect(JSON.parse(await readFile(pokeFile(), "utf8"))).toEqual({ label: "B", count: 0 });
		expect(store.getIntegrationSettings(otherSegment)).toEqual({ level: 3 });
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
		expect(store.getIntegrationSettings(otherSegment).level).toBe(1);
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
		expect(store.getIntegrationSettings(pokeSegment).label).toBe("hello");
		expect(await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).not.toContain("ghost.json");
		expect(scopes).toEqual([]);
	});

	it("与别的分区同一个事务:核心最后一步写失败 → 集成文件逐字节退回,不留回滚副本", async () => {
		const store = await open();
		const pokeBytes = await readFile(pokeFile(), "utf8");
		await rm(coreFile());
		await mkdir(coreFile());
		const globals = store.getGlobals();
		const fansCron = globals.app.fansCron;

		await expect(
			store.replaceSections({
				integrations: { poke: { label: "B", count: 4 } },
				globals: { ...globals, app: { ...globals.app, fansCron: "*/9 * * * *" } },
			}),
		).rejects.toThrow();

		expect(await readFile(pokeFile(), "utf8")).toBe(pokeBytes);
		expect(store.getIntegrationSettings(pokeSegment)).toEqual({ label: "hello", count: 0 });
		expect(store.getGlobals().app.fansCron).toBe(fansCron);
		expect(
			(await readdir(join(dataDir, ...CONFIG_DIR, "settings"))).filter((n) =>
				n.endsWith(".restore.bak"),
			),
		).toEqual([]);
		expect(scopes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 登记
// ---------------------------------------------------------------------------

describe("集成设置 — 登记", () => {
	it("同一个键登记两次 → 构造就抛", () => {
		expect(() => build([pokeSegment, { ...pokeSegment }])).toThrow(/登记了两次/);
	});

	it("键与核心设置的任何一个顶层键同名 → 构造就抛(/api/globals 把两者摆在同一层)", () => {
		const coreKeys = Object.keys(GlobalConfigSchema.shape);
		// 守住「核心顶层键」这张表本身没变空,免得下面的循环空转。
		expect(coreKeys).toContain("app");
		for (const key of coreKeys) {
			expect(() => build([{ ...otherSegment, key }]), key).toThrow(/撞名/);
		}
	});
});
