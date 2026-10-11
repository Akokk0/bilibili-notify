/**
 * B 站设置(`config/settings/bilibili.json`):格式与读盘宽松、写入时核 cron、两个读者各读自己那一格
 * (ADR-0021 决策 42 下 10-01 的 🔗)。配置仓那一半的通用机制在 `__tests__/config-store-integration-settings.test.ts`,
 * 把手的变了才叫在 `integrations/__tests__/settings-reader.test.ts`,来源怎么停与起在 `source-settings.test.ts`。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_DYNAMIC_CRON,
	DEFAULT_HEALTH_CHECK_MINUTES,
	type MessageBus,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeIntegrationSecrets } from "../../__tests__/support/backup-integration-secrets.js";
import { buildBackup } from "../../backup/envelope.js";
import { createBackupService } from "../../backup/service.js";
import type { BootstrapConfig } from "../../config/schema.js";
import {
	CONFIG_DIR,
	type ConfigStore,
	createConfigStore,
	integrationSettingsFile,
} from "../../config/store.js";
import { createSettingsReader } from "../../integrations/settings-reader.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	BiliDynamicSettingsSchema,
	BiliLoginCheckSettingsSchema,
	type BiliSettings,
	BiliSettingsSchema,
	settingsSegment,
} from "../settings.js";

/** 仓里内存那一份 B 站设置(坏格是默认值)。 */
const bili = (store: ConfigStore) => store.getAllIntegrationSettings().bilibili as BiliSettings;

// 这一份的 checkWrite 一定在;类型上它是可选的,取出来省得每处都 `!`。
function checkWrite(next: BiliSettings, prev?: BiliSettings) {
	const check = settingsSegment.checkWrite;
	if (!check) throw new Error("settingsSegment 应当带 checkWrite");
	return check(next, prev);
}

function parsed(over: Partial<BiliSettings>): BiliSettings {
	return BiliSettingsSchema.parse(over);
}

// ---------------------------------------------------------------------------
// 格式
// ---------------------------------------------------------------------------

describe("B 站设置 — 格式", () => {
	it("全空 → 取默认值", () => {
		expect(BiliSettingsSchema.parse({})).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: DEFAULT_HEALTH_CHECK_MINUTES,
		});
	});

	// 自定义 UA 从格式里删了(浏览器身份一律由 packages/http 生成,ADR-0025 决策 7)。格式不是 strict:老值读进来
	// 不拒收、静默剥掉 —— 盘上留着一份老 bilibili.json、或备份里带着这一格,都不该让开机 / 恢复失败。
	it("userAgent 不是格:带了不拒收,解析出来没有它,别的格不受影响", () => {
		const parsedWithStale = BiliSettingsSchema.parse({
			userAgent: "UA/1.0",
			healthCheckMinutes: 45,
		});

		expect(parsedWithStale).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: 45,
		});
		expect(parsedWithStale).not.toHaveProperty("userAgent");
	});

	it("读盘对 cron 宽松:一条解析不了的存量值照读,不抛(能不能解析归写入那一道管)", () => {
		const stored = BiliSettingsSchema.parse({ dynamicCron: "not a cron expr" });

		expect(stored.dynamicCron).toBe("not a cron expr");
		// 同一份值,写入那一道会拦。
		expect(checkWrite(stored)).toHaveLength(1);
	});

	it("healthCheckMinutes 的范围:5 到 180 的整数分钟", () => {
		const accepts = (n: number) => BiliSettingsSchema.safeParse({ healthCheckMinutes: n }).success;

		expect(accepts(5)).toBe(true);
		expect(accepts(180)).toBe(true);
		expect(accepts(4)).toBe(false);
		expect(accepts(181)).toBe(false);
		expect(accepts(30.5)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 两个读者各读自己那一格
// ---------------------------------------------------------------------------

describe("B 站设置 — 两个读者的 schema", () => {
	it("动态读者只看 dynamicCron:登录检查那格坏成什么样都不碍它", () => {
		const r = BiliDynamicSettingsSchema.safeParse({
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: "x",
		});
		expect(r.success && r.data).toEqual({ dynamicCron: "*/5 * * * *" });
	});

	it("登录检查读者只看 healthCheckMinutes:动态那格坏成什么样都不碍它", () => {
		const r = BiliLoginCheckSettingsSchema.safeParse({ dynamicCron: 123, healthCheckMinutes: 45 });
		expect(r.success && r.data).toEqual({ healthCheckMinutes: 45 });
	});

	it("动态读者比读盘 schema 多一道「能解析」:一条字符串但解析不了的 cron 读盘算好的、动态读者读不过(路径点名那一格)", () => {
		const cron = "not a cron expr";
		expect(BiliSettingsSchema.safeParse({ dynamicCron: cron }).success).toBe(true);

		const r = BiliDynamicSettingsSchema.safeParse({ dynamicCron: cron });

		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.path).toEqual(["dynamicCron"]);
	});

	it("动态读者缺省取默认 cron(默认值本身解析得了)", () => {
		const r = BiliDynamicSettingsSchema.safeParse({});
		expect(r.success && r.data).toEqual({ dynamicCron: DEFAULT_DYNAMIC_CRON });
	});

	it("登录检查读者越界 / 非整数 / 非数字都读不过,路径点名那一格", () => {
		for (const bad of [4, 181, 30.5, "45", null]) {
			const r = BiliLoginCheckSettingsSchema.safeParse({ healthCheckMinutes: bad });
			expect(r.success, JSON.stringify(bad)).toBe(false);
			expect(r.error?.issues[0]?.path).toEqual(["healthCheckMinutes"]);
		}
	});
});

// ---------------------------------------------------------------------------
// 写入时核 cron
// ---------------------------------------------------------------------------

describe("B 站设置 — checkWrite(写入时核 cron)", () => {
	it("放行合法的 5 字段与 6 字段 cron(含默认值)", () => {
		for (const cron of ["*/5 * * * *", "0 0 * * *", "30 */2 * * * *", DEFAULT_DYNAMIC_CRON]) {
			expect(checkWrite(parsed({ dynamicCron: cron })), cron).toEqual([]);
		}
	});

	it("拒绝解析不了的表达式:逐格原因点名 dynamicCron 并带上原值", () => {
		for (const cron of ["not a cron expr", "", "* * *", "99 * * * *", "* * * * * * *"]) {
			expect(checkWrite(parsed({ dynamicCron: cron })), JSON.stringify(cron)).toEqual([
				{ path: ["dynamicCron"], message: `不是合法的 cron 表达式："${cron}"` },
			]);
		}
	});

	it("只核这次改了的 cron:没改的哪怕解析不了也放行,改成另一条坏的才拒", () => {
		const stale = parsed({ dynamicCron: "not a cron expr" });
		expect(
			checkWrite(parsed({ dynamicCron: "not a cron expr", healthCheckMinutes: 45 }), stale),
		).toEqual([]);
		expect(checkWrite(parsed({ dynamicCron: "still not" }), stale)).toEqual([
			{ path: ["dynamicCron"], message: '不是合法的 cron 表达式："still not"' },
		]);
	});
});

// ---------------------------------------------------------------------------
// 配置仓 + 登记(真仓)
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

describe("B 站设置 — 经配置仓", () => {
	let dataDir: string;
	let bus: MessageBus;
	const file = () => join(dataDir, ...integrationSettingsFile("bilibili"));

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-bilibili-settings-"));
		bus = createNodeMessageBus();
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	function build(): ConfigStore {
		return createConfigStore({
			bootstrap: makeBootstrap(dataDir),
			dataRoot: dataDir,
			bus,
			serviceCtx: makeServiceCtx(),
			integrationSettings: [settingsSegment],
		});
	}

	it("没有文件 → 建一份默认的;全量图里读得到", async () => {
		const store = build();
		await store.load();

		expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: DEFAULT_HEALTH_CHECK_MINUTES,
		});
		expect(bili(store)).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: DEFAULT_HEALTH_CHECK_MINUTES,
		});
	});

	it("盘上留着一条解析不了的老 cron:开机照常,不因为它失败(宽松读盘)", async () => {
		await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
		await writeFile(file(), JSON.stringify({ dynamicCron: "not a cron expr" }), "utf8");

		const store = build();
		await store.load();

		expect(bili(store).dynamicCron).toBe("not a cron expr");
	});

	it("盘上留着一条解析不了的老 cron:改别的格照常存 —— 坏值不挡主人改健康检查间隔", async () => {
		await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
		await writeFile(file(), JSON.stringify({ dynamicCron: "not a cron expr" }), "utf8");
		const store = build();
		await store.load();

		await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 45 } } });

		expect(bili(store)).toEqual({
			dynamicCron: "not a cron expr",
			healthCheckMinutes: 45,
		});
		await expect(
			store.patchSettings({ integrations: { bilibili: { dynamicCron: "still not" } } }),
		).rejects.toMatchObject({ code: "invalid", issues: [{ path: ["bilibili", "dynamicCron"] }] });
	});

	it("写入一条解析不了的 cron → 拒,issues 路径是 bilibili.dynamicCron;盘上不动", async () => {
		const store = build();
		await store.load();
		const before = await readFile(file(), "utf8");

		await expect(
			store.patchSettings({ integrations: { bilibili: { dynamicCron: "not a cron expr" } } }),
		).rejects.toMatchObject({
			code: "invalid",
			scope: "integration-settings",
			issues: [{ path: ["bilibili", "dynamicCron"] }],
		});

		expect(await readFile(file(), "utf8")).toBe(before);
		expect(bili(store).dynamicCron).toBe(DEFAULT_DYNAMIC_CRON);
	});

	it("写入合法的 cron → 落盘、全量图里读到新值", async () => {
		const store = build();
		await store.load();

		await store.patchSettings({ integrations: { bilibili: { dynamicCron: "*/5 * * * *" } } });

		expect(bili(store).dynamicCron).toBe("*/5 * * * *");
		expect(JSON.parse(await readFile(file(), "utf8")).dynamicCron).toBe("*/5 * * * *");
	});

	describe("自定义 UA 已删:`userAgent` 不是这份设置的格", () => {
		it("PATCH 带 bilibili.userAgent:不拒收(格式不是 strict),别的格照存;这一格既不落盘也读不到", async () => {
			const store = build();
			await store.load();

			const snapshot = await store.patchSettings({
				integrations: { bilibili: { userAgent: "UA/2", healthCheckMinutes: 45 } },
			});

			expect(snapshot.integrations.bilibili).toEqual({
				dynamicCron: DEFAULT_DYNAMIC_CRON,
				healthCheckMinutes: 45,
			});
			expect(bili(store)).not.toHaveProperty("userAgent");
			expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
				dynamicCron: DEFAULT_DYNAMIC_CRON,
				healthCheckMinutes: 45,
			});
		});

		it("PATCH 只带 bilibili.userAgent:当没改 —— 盘上这份设置不变,读者不被叫", async () => {
			const store = build();
			await store.load();
			const changed = vi.fn();
			watchOf(store, BiliSettingsSchema).reader.onChange(changed);
			const before = await readFile(file(), "utf8");

			await store.patchSettings({ integrations: { bilibili: { userAgent: "UA/2" } } });

			expect(await readFile(file(), "utf8")).toBe(before);
			expect(changed).not.toHaveBeenCalled();
		});

		it("盘上留着一份带 userAgent 的老 bilibili.json:开机照常、读不到这一格;下次写入时落盘的那份也没有它", async () => {
			await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
			await writeFile(
				file(),
				JSON.stringify({ userAgent: "UA/old", dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 }),
				"utf8",
			);
			const store = build();
			await store.load();

			expect(bili(store)).toEqual({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 });

			await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 60 } } });

			expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
				dynamicCron: "*/5 * * * *",
				healthCheckMinutes: 60,
			});
		});
	});

	// 备份的格式版本没抬:自定义 UA 删之前导出的备份,B 站那一节里多一格 userAgent,照常恢复。接的是**真仓**
	// (备份服务的替身仓不过格式,这条在那边是空绿):整份换进去时按登记的格式解析,剥掉这一格再落盘。
	it("恢复一份带 userAgent 的备份:照常恢复(不拒收),别的格进了盘,盘上与读出来都没有 userAgent", async () => {
		const store = build();
		await store.load();
		const service = createBackupService({
			configStore: store,
			integrationSecrets: fakeIntegrationSecrets(),
		});
		const envelope = buildBackup({
			kind: "sanitized",
			createdAt: "2026-10-03T00:00:00.000Z",
			sections: {
				integrations: {
					bilibili: { userAgent: "UA/old", dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 },
				},
			},
		});

		const result = await service.importBackup({ envelope, mode: "overwrite" });

		expect(result.globalsApplied).toBe(true);
		const restored = { dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 };
		expect(bili(store)).toEqual(restored);
		expect(JSON.parse(await readFile(file(), "utf8"))).toEqual(restored);
	});

	it("仓里登记的键就是 bilibili,文件就是 config/settings/bilibili.json", async () => {
		const store = build();
		await store.load();

		expect(Object.keys(store.getAllIntegrationSettings())).toEqual(["bilibili"]);
		expect(file()).toBe(join(dataDir, "config", "settings", "bilibili.json"));
		expect(await readFile(file(), "utf8")).toContain("healthCheckMinutes");
	});

	describe("读者接真仓", () => {
		it("自己那一格真的变了才叫;另一格变了、同值再写一遍都不叫", async () => {
			const store = build();
			await store.load();
			const changed = vi.fn();
			watchOf(store, BiliLoginCheckSettingsSchema).reader.onChange(changed);

			await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 60 } } });
			expect(changed).toHaveBeenCalledTimes(1);

			// 同一个值再写一遍:仓照常广播 integration-settings,但这一格没变。
			await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 60 } } });
			expect(changed).toHaveBeenCalledTimes(1);

			// 另一格(动态)变了:登录检查读者不叫。
			await store.patchSettings({ integrations: { bilibili: { dynamicCron: "*/9 * * * *" } } });
			expect(changed).toHaveBeenCalledTimes(1);
		});

		it("动态那格是数字(写坏了):动态读者读不过、登录检查读者照常读得懂自己的那格", async () => {
			await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
			await writeFile(file(), JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }), "utf8");
			const store = build();
			await store.load();

			const dynamic = watchOf(store, BiliDynamicSettingsSchema).reader.get();
			const loginCheck = watchOf(store, BiliLoginCheckSettingsSchema).reader.get();

			expect(dynamic.ok).toBe(false);
			if (!dynamic.ok) expect(dynamic.issues?.[0]?.path).toEqual(["dynamicCron"]);
			expect(loginCheck).toEqual({ ok: true, settings: { healthCheckMinutes: 45 } });
			// 面板拿到的全量图里两格都在、都合法:坏的那格是默认值,好的那格是盘上的值。
			expect(bili(store)).toEqual({ dynamicCron: DEFAULT_DYNAMIC_CRON, healthCheckMinutes: 45 });
		});

		it("登录检查那格越界:登录检查读者读不过、动态读者照常读得懂自己的那格", async () => {
			await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
			await writeFile(
				file(),
				JSON.stringify({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 1 }),
				"utf8",
			);
			const store = build();
			await store.load();

			const loginCheck = watchOf(store, BiliLoginCheckSettingsSchema).reader.get();
			const dynamic = watchOf(store, BiliDynamicSettingsSchema).reader.get();

			expect(loginCheck.ok).toBe(false);
			expect(dynamic).toEqual({ ok: true, settings: { dynamicCron: "*/5 * * * *" } });
		});
	});

	/** 照宿主的做法给这份设置造一个读者(读口、通知口都是真仓的)。 */
	function watchOf<T>(
		store: ConfigStore,
		schema: Parameters<typeof createSettingsReader<T>>[0]["schema"],
	) {
		return createSettingsReader({
			schema,
			read: () => store.readIntegrationSettings("bilibili"),
			onChanged: (fn) =>
				store.onChange((scope) => {
					if (scope === "integration-settings") fn();
				}),
			logger: makeServiceCtx().logger,
		});
	}
});
