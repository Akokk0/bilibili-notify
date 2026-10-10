/**
 * B 站设置(`config/settings/bilibili.json`):格式与读盘宽松、写入时核 cron、`watchSettings` 只在这一份
 * 真的变了时才通知(ADR-0021 决策 42 下 10-01 的 🔗)。配置仓那一半的通用机制在
 * `__tests__/config-store-integration-settings.test.ts`。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConfigScope,
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
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	type BiliSettings,
	BiliSettingsSchema,
	settingsOf,
	settingsSegment,
	watchSettings,
} from "../settings.js";

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

	it("没有文件 → 建一份默认的;settingsOf 读得到", async () => {
		const store = build();
		await store.load();

		expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: DEFAULT_HEALTH_CHECK_MINUTES,
		});
		expect(settingsOf(store)).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: DEFAULT_HEALTH_CHECK_MINUTES,
		});
	});

	it("盘上留着一条解析不了的老 cron:开机照常,不因为它失败(宽松读盘)", async () => {
		await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
		await writeFile(file(), JSON.stringify({ dynamicCron: "not a cron expr" }), "utf8");

		const store = build();
		await store.load();

		expect(settingsOf(store).dynamicCron).toBe("not a cron expr");
	});

	it("盘上留着一条解析不了的老 cron:改别的格照常存 —— 坏值不挡主人改健康检查间隔", async () => {
		await mkdir(join(dataDir, ...CONFIG_DIR, "settings"), { recursive: true });
		await writeFile(file(), JSON.stringify({ dynamicCron: "not a cron expr" }), "utf8");
		const store = build();
		await store.load();

		await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 45 } } });

		expect(settingsOf(store)).toEqual({
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
		expect(settingsOf(store).dynamicCron).toBe(DEFAULT_DYNAMIC_CRON);
	});

	it("写入合法的 cron → 落盘、settingsOf 读到新值", async () => {
		const store = build();
		await store.load();

		await store.patchSettings({ integrations: { bilibili: { dynamicCron: "*/5 * * * *" } } });

		expect(settingsOf(store).dynamicCron).toBe("*/5 * * * *");
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
			expect(settingsOf(store)).not.toHaveProperty("userAgent");
			expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({
				dynamicCron: DEFAULT_DYNAMIC_CRON,
				healthCheckMinutes: 45,
			});
		});

		it("PATCH 只带 bilibili.userAgent:当没改 —— 盘上这份设置不变,watchSettings 不叫", async () => {
			const store = build();
			await store.load();
			const apply = vi.fn();
			watchSettings(store, apply);
			const before = await readFile(file(), "utf8");

			await store.patchSettings({ integrations: { bilibili: { userAgent: "UA/2" } } });

			expect(await readFile(file(), "utf8")).toBe(before);
			expect(apply).not.toHaveBeenCalled();
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

			expect(settingsOf(store)).toEqual({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 });

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
		expect(settingsOf(store)).toEqual(restored);
		expect(JSON.parse(await readFile(file(), "utf8"))).toEqual(restored);
	});

	it("仓里登记的键就是 bilibili,文件就是 config/settings/bilibili.json", async () => {
		const store = build();
		await store.load();

		expect(Object.keys(store.getAllIntegrationSettings())).toEqual(["bilibili"]);
		expect(file()).toBe(join(dataDir, "config", "settings", "bilibili.json"));
		expect(await readFile(file(), "utf8")).toContain("healthCheckMinutes");
	});

	describe("watchSettings(接真仓)", () => {
		it("设置真的变了 → apply(prev, next);值没变的写入(同值再写一遍)→ 不叫", async () => {
			const store = build();
			await store.load();
			const apply = vi.fn();
			watchSettings(store, apply);

			await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 60 } } });
			expect(apply).toHaveBeenCalledTimes(1);
			expect(apply).toHaveBeenLastCalledWith(
				{ dynamicCron: DEFAULT_DYNAMIC_CRON, healthCheckMinutes: DEFAULT_HEALTH_CHECK_MINUTES },
				{ dynamicCron: DEFAULT_DYNAMIC_CRON, healthCheckMinutes: 60 },
			);

			// 同一个值再写一遍:仓照常广播 integration-settings,但 B 站这一份没变。
			await store.patchSettings({ integrations: { bilibili: { healthCheckMinutes: 60 } } });
			expect(apply).toHaveBeenCalledTimes(1);
		});
	});
});

// ---------------------------------------------------------------------------
// watchSettings(替身仓:只有 getIntegrationSettings 与 onChange)
// ---------------------------------------------------------------------------

describe("watchSettings", () => {
	/** 一个手动驱动的仓:改 `state`、再 `fire(scope)` 模拟配置仓广播。 */
	function makeFakeStore(initial: BiliSettings) {
		const bus = createNodeMessageBus();
		let state = initial;
		return {
			set(next: BiliSettings) {
				state = next;
			},
			fire(scope: ConfigScope) {
				bus.emit("config-changed", { scope });
			},
			store: {
				getIntegrationSettings: (() =>
					structuredClone(state)) as ConfigStore["getIntegrationSettings"],
				onChange: (handler: (scope: ConfigScope) => void) =>
					bus.on("config-changed", ({ scope }) => handler(scope)),
			},
		};
	}

	it("变了才叫 apply:带上变之前与变之后的整份", () => {
		const f = makeFakeStore(parsed({}));
		const apply = vi.fn();
		watchSettings(f.store, apply);

		f.set(parsed({ dynamicCron: "*/9 * * * *" }));
		f.fire("integration-settings");

		expect(apply).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledWith(parsed({}), parsed({ dynamicCron: "*/9 * * * *" }));
	});

	it("事件来了但设置没变(比如别的集成改了)→ 不叫", () => {
		const f = makeFakeStore(parsed({}));
		const apply = vi.fn();
		watchSettings(f.store, apply);

		f.fire("integration-settings");

		expect(apply).not.toHaveBeenCalled();
	});

	it("连着变两次:第二次的 prev 是第一次的 next", () => {
		const f = makeFakeStore(parsed({}));
		const apply = vi.fn();
		watchSettings(f.store, apply);
		const first = parsed({ healthCheckMinutes: 45 });
		const second = parsed({ healthCheckMinutes: 90 });

		f.set(first);
		f.fire("integration-settings");
		f.set(second);
		f.fire("integration-settings");

		expect(apply).toHaveBeenCalledTimes(2);
		expect(apply).toHaveBeenNthCalledWith(2, first, second);
	});

	it("基线是开始监听那一刻的值,不是格式的默认值", () => {
		// 开始监听之前设置就已经不是默认值了;之后事件来了、值没动 → 不算变。
		const f = makeFakeStore(parsed({ healthCheckMinutes: 45 }));
		const apply = vi.fn();
		watchSettings(f.store, apply);

		f.fire("integration-settings");

		expect(apply).not.toHaveBeenCalled();
	});

	it("只认 integration-settings 这一档:别的 scope 的事件不叫,哪怕这一份已经变了", () => {
		const f = makeFakeStore(parsed({}));
		const apply = vi.fn();
		watchSettings(f.store, apply);

		f.set(parsed({ healthCheckMinutes: 45 }));
		f.fire("globals");
		f.fire("subscriptions");
		expect(apply).not.toHaveBeenCalled();

		f.fire("integration-settings");
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("dispose 之后不再叫", () => {
		const f = makeFakeStore(parsed({}));
		const apply = vi.fn();
		const handle = watchSettings(f.store, apply);

		handle.dispose();
		f.set(parsed({ healthCheckMinutes: 45 }));
		f.fire("integration-settings");

		expect(apply).not.toHaveBeenCalled();
	});
});
