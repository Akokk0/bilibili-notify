/**
 * B 站设置读不懂时,来源里哪一样停、怎么说、改好之后怎么起(主人 10-11 定:哪格坏停哪样)。
 *
 * 接真配置仓(临时目录里的真文件)、真来源上下文、真问题表、真动态引擎(cron 换成惰性的假件),只把登录检查的口换成
 * spy、B 站的 API 换成空的。坏文件怎么摆:开机之前在盘上放好。最后一组钉两条问题的文案。
 * 「经真路由存对」那一半在 `__tests__/builtin-source-boot-e2e.test.ts`。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_DYNAMIC_CRON,
	DEFAULT_HEALTH_CHECK_MINUTES as DEFAULT_HEALTH_MINUTES,
	type Disposable,
	ok,
} from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { switchableLocale } from "../../__tests__/support/fixed-locale.js";
import { createAiToolProviderRegistry } from "../../ai/tool-provider-registry.js";
import { createConfigStore, integrationSettingsFile } from "../../config/store.js";
import { createLinkResolverRegistry } from "../../link-preview/registry.js";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import {
	makeIntegration,
	makeLogger,
	makeSub,
	makeWorld,
	SOURCE_KEY,
} from "../../subscriptions/__tests__/fixtures.js";
import { registerBuiltinSource } from "../../subscriptions/builtin-sources.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import type { Api } from "../api/index.js";
import { PROBLEM_TEXTS } from "../problem-texts.js";
import { settingsSegment } from "../settings.js";
import { createBiliSource } from "../source.js";

const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; isActive: boolean; stopCount: number }> = [];
	class FakeCronJob {
		isActive = false;
		stopCount = 0;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			instances.push(this);
		}
		start(): void {
			this.isActive = true;
		}
		stop(): void {
			this.isActive = false;
			this.stopCount++;
		}
	}
	return { instances, FakeCronJob };
});
// 只换 `CronJob`:动态读者的「能解析」那一道用的是同一个包里的 `CronTime`,要留真的。
vi.mock("cron", async (importOriginal) => ({
	...(await importOriginal<typeof import("cron")>()),
	CronJob: cronMock.FakeCronJob,
}));

const DYNAMIC = "dynamic_settings_invalid";
const LOGIN_CHECK = "login_check_settings_invalid";
const HALF_JSON = '{"dynamicCron": "secret-cron-text", "healthCheckMinutes": ';

let dataDir: string;
let toDispose: Disposable[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-bili-source-settings-"));
	cronMock.instances.length = 0;
	toDispose = [];
});
afterEach(async () => {
	for (const d of toDispose.reverse()) d.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

const bilibiliFile = () => join(dataDir, ...integrationSettingsFile("bilibili"));

/** 开机之前在盘上放好 B 站设置文件。 */
async function place(content: string): Promise<void> {
	await mkdir(join(dataDir, "config", "settings"), { recursive: true });
	await writeFile(bilibiliFile(), content, "utf8");
}

async function boot() {
	const bus = createNodeMessageBus();
	const logger = makeLogger();
	const store = createConfigStore({
		bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" },
		dataRoot: dataDir,
		bus,
		serviceCtx: {
			logger,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
			signal: new AbortController().signal,
			track: () => {},
		},
		integrationSettings: [settingsSegment],
	});
	await store.load();

	const table = createProblemTable({ logger });
	// 来源每往表里报一次都过这里:同一句再报表不发变化,换语言重报要靠它看
	const reportSpy = vi.spyOn(table, "report");
	const locale = switchableLocale("zh-CN");
	const changes: ProblemChange[] = [];
	table.subscribe((c) => changes.push(c));
	const setHealthCheckMs = vi.fn<(ms: number) => void>();
	const attach = vi.fn();
	const world = makeWorld([makeSub("sub-1", "1")]);
	const source = createBiliSource({
		api: {
			fetchAllDynamic: async () => ok({ data: { items: [] } }),
		} as unknown as Api,
		bus: world.bus,
		loginCheck: { setHealthCheckMs },
		locale,
		setTimeout: () => ({ dispose() {} }),
		liveContext: {
			logger,
			signal: new AbortController().signal,
			setInterval: () => ({ dispose() {} }),
			setTimeout: () => ({ dispose() {} }),
			onDispose: () => {},
			track: () => {},
		},
		auth: {
			beginLogin: async () => ok(),
			logout: async () => ok(),
			// 已登录:这组测的是设置问题,别让宿主的登录问题(auth_lost)混进表里
			state: () => ({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" }),
			onChange: () => ({ dispose() {} }),
		},
		problems: {
			attach,
			detach: vi.fn(),
			reportRisk: vi.fn(),
			resolveRisk: vi.fn(),
			reportFailure: vi.fn(),
			resolveFailure: vi.fn(),
		},
	});
	const registration = await registerBuiltinSource({
		registry: createSourceRegistry(),
		linkResolvers: createLinkResolverRegistry(),
		aiToolProviders: createAiToolProviderRegistry(),
		source,
		// 读源从集成上下文那一侧给:来源经 `ctx.settings(规则)` 读,键(B 站)由造上下文的人挑好。
		integration: makeIntegration(logger, {
			read: () => store.readIntegrationSettings(SOURCE_KEY),
			onChanged: (fn) =>
				store.onChange((scope) => {
					if (scope === "integration-settings") fn();
				}),
		}),
		sourceKey: SOURCE_KEY,
		subscriptions: world.store,
		defaults: () => world.globals.defaults,
		bus: world.bus,
		logger,
		enqueue: vi.fn(),
		liveSignals: vi.fn(),
		liveInteractions: vi.fn(),
		problems: table,
	});
	toDispose.push(registration);
	const problems = () => table.list().map((p) => p.code);
	const message = (code: string) => table.list().find((p) => p.code === code)?.message ?? "";
	/** 往表里报过的次数(按 code)。 */
	const reportCount = (code: string) =>
		reportSpy.mock.calls.filter(([p]) => p.code === code).length;
	return {
		store,
		source,
		table,
		changes,
		setHealthCheckMs,
		attach,
		problems,
		message,
		logger,
		locale,
		reportCount,
	};
}

const MIN = 60_000;

describe("B 站来源 · 动态那一格读不懂", () => {
	// 验红:`applyDynamic` 读不懂时照样造引擎(`dynamic()` 就不是 undefined 了)。
	it("写成了数字:start 不抛、动态没起、只有 dynamic_settings_invalid 一条;登录检查按盘上的 45 分钟挂上;上报器接上", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }));

		const b = await boot();

		expect(b.source.dynamic()).toBeUndefined();
		expect(cronMock.instances).toHaveLength(0);
		expect(b.problems()).toEqual([DYNAMIC]);
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(45 * MIN);
		expect(b.attach).toHaveBeenCalledTimes(1);
		const text = b.message(DYNAMIC);
		expect(text).toContain("设置「动态检查频率」（dynamicCron）读不懂");
		// 平实句:不指路、不提面板上显示什么
		expect(text).not.toContain("默认值");
		expect(text).not.toContain("面板");
		// 只进问题表,不私聊
		expect(b.changes.map((c) => [c.kind, c.notify])).toEqual([["opened", false]]);
	});

	it("一条字符串但解析不了的 cron(读盘算好的):同样停动态、报一条,点名那一格", async () => {
		await place(JSON.stringify({ dynamicCron: "not a cron expr" }));

		const b = await boot();

		expect(b.source.dynamic()).toBeUndefined();
		expect(b.problems()).toEqual([DYNAMIC]);
		expect(b.message(DYNAMIC)).toContain("设置「动态检查频率」（dynamicCron）读不懂");
	});
});

describe("B 站来源 · 登录检查那一格读不懂", () => {
	// 验红:`applyLoginCheck` 读不懂时退成默认值(这正是被否的那个做法):最后一次调用就是 30 分钟、不是 0。
	it("间隔写成 1(越界):动态照常在跑、定时的登录检查停掉(0)、只有 login_check_settings_invalid 一条", async () => {
		await place(JSON.stringify({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 1 }));

		const b = await boot();

		expect(b.source.dynamic()?.isActive).toBe(true);
		expect(cronMock.instances[0]?.cronTime).toBe("*/5 * * * *");
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(0);
		expect(b.setHealthCheckMs).not.toHaveBeenCalledWith(30 * MIN);
		expect(b.problems()).toEqual([LOGIN_CHECK]);
		const text = b.message(LOGIN_CHECK);
		expect(text).toContain("设置「登录心跳间隔」（healthCheckMinutes）读不懂");
		expect(text).not.toContain("默认值");
		expect(text).not.toContain("面板");
		expect(b.changes.map((c) => [c.kind, c.notify])).toEqual([["opened", false]]);
	});
});

describe("B 站来源 · 整个文件读不懂", () => {
	// 验红:文案只写「那一格」那一支(文件那一支不存在),`file` 那句话里的「设置文件不是合法的 JSON」找不到。
	it("半截 JSON:两样都停、两条都在、文案走「文件」那一支、原因不带文件内容;登录与上报器照常", async () => {
		await place(HALF_JSON);

		const b = await boot();

		expect(b.source.dynamic()).toBeUndefined();
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(0);
		expect([...b.problems()].sort()).toEqual([DYNAMIC, LOGIN_CHECK].sort());
		for (const code of [DYNAMIC, LOGIN_CHECK]) {
			expect(b.message(code)).toContain("设置文件不是合法的 JSON");
			// 宿主的存储路径不写进集成的句子
			expect(b.message(code)).not.toContain("config/settings/bilibili.json");
			expect(b.message(code)).not.toContain("secret-cron-text");
		}
		expect(b.attach).toHaveBeenCalledTimes(1);
		// 文件字节没动
		expect(await readFile(bilibiliFile(), "utf8")).toBe(HALF_JSON);
	});
});

describe("B 站来源 · 改好保存当场起来(经配置仓的写口,不用重启)", () => {
	// 验红:起来之后不清问题;`applyDynamic` 不判引擎在不在(第二次保存会再造一个引擎)。
	it("动态那格坏着开机 → 存成合法 cron:引擎起来、那一条没了且没有补「已恢复」;再存别的 cron:同一个引擎换节奏", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 30 }));
		const b = await boot();
		expect(b.problems()).toEqual([DYNAMIC]);

		// 系统页的真实形状:同一块两格一起发。
		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 } },
		});

		const engine = b.source.dynamic();
		expect(engine?.isActive).toBe(true);
		expect(cronMock.instances).toHaveLength(1);
		expect(cronMock.instances[0]?.cronTime).toBe("*/5 * * * *");
		expect(b.problems()).toEqual([]);
		expect(b.changes.map((c) => [c.kind, c.notify])).toEqual([
			["opened", false],
			["closed", false],
		]);
		expect(JSON.parse(await readFile(bilibiliFile(), "utf8"))).toEqual({
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: 30,
		});

		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: "*/9 * * * *", healthCheckMinutes: 30 } },
		});
		expect(b.source.dynamic()).toBe(engine);
		expect(cronMock.instances[0]?.stopCount).toBe(1);
		expect(cronMock.instances).toHaveLength(2);
		expect(cronMock.instances[1]?.cronTime).toBe("*/9 * * * *");
		expect(cronMock.instances[1]?.isActive).toBe(true);
	});

	it("只改登录心跳间隔、动态那格带的是面板上显示的默认值:动态仍停着、那一条还在、原文留着;心跳当场换", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 30 }));
		const b = await boot();

		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: DEFAULT_DYNAMIC_CRON, healthCheckMinutes: 45 } },
		});

		expect(b.source.dynamic()).toBeUndefined();
		expect(b.problems()).toEqual([DYNAMIC]);
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(45 * MIN);
		expect(JSON.parse(await readFile(bilibiliFile(), "utf8"))).toEqual({
			dynamicCron: 123,
			healthCheckMinutes: 45,
		});
	});

	it("登录检查那格坏着开机 → 把间隔存对:定时检查按新值挂上、那一条没了;动态不受影响", async () => {
		await place(JSON.stringify({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 1 }));
		const b = await boot();
		const engine = b.source.dynamic();
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(0);

		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 } },
		});

		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(45 * MIN);
		expect(b.problems()).toEqual([]);
		expect(b.source.dynamic()).toBe(engine);
		expect(cronMock.instances).toHaveLength(1);
	});

	it("整个文件读不懂 → 任意改一格保存:整文件重写成合法的、两样都起、两条都没了", async () => {
		await place(HALF_JSON);
		const b = await boot();
		expect(b.problems()).toHaveLength(2);

		await b.store.patchSettings({
			integrations: {
				bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: DEFAULT_HEALTH_MINUTES },
			},
		});

		expect(b.source.dynamic()?.isActive).toBe(true);
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(DEFAULT_HEALTH_MINUTES * MIN);
		expect(b.problems()).toEqual([]);
		expect(JSON.parse(await readFile(bilibiliFile(), "utf8"))).toEqual({
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: DEFAULT_HEALTH_MINUTES,
		});
	});

	it("两格都坏:各改各的,改了哪格哪样起", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: "x" }));
		const b = await boot();
		expect([...b.problems()].sort()).toEqual([DYNAMIC, LOGIN_CHECK].sort());

		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 } },
		});

		// 登录检查那格的补丁值恰好等于默认(30):算没动,仍停着;动态那格改了新值,起来。
		expect(b.source.dynamic()?.isActive).toBe(true);
		expect(b.problems()).toEqual([LOGIN_CHECK]);
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(0);

		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 } },
		});
		expect(b.problems()).toEqual([]);
		expect(b.setHealthCheckMs).toHaveBeenLastCalledWith(45 * MIN);
	});
});

describe("B 站来源 · 换语言时把读不懂的那一句再报一遍", () => {
	// 验红:start 里不订 `locale.onChange`,前两条红;重报改成重跑 apply*,第三条红(心跳计时被重挂)。
	it("动态那一格读不懂:切语言,再往表里报一次、同 code", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }));
		const b = await boot();
		expect(b.reportCount(DYNAMIC)).toBe(1);

		b.locale.set("en");

		expect(b.reportCount(DYNAMIC)).toBe(2);
		expect(b.reportCount(LOGIN_CHECK)).toBe(0);
	});

	it("两格都读不懂:切语言,两条都再报", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 1 }));
		const b = await boot();

		b.locale.set("en");

		expect(b.reportCount(DYNAMIC)).toBe(2);
		expect(b.reportCount(LOGIN_CHECK)).toBe(2);
	});

	it("切语言不重跑 apply*:不碰登录心跳的计时、不造引擎", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }));
		const b = await boot();
		const heartbeatCalls = b.setHealthCheckMs.mock.calls.length;

		b.locale.set("en");
		b.locale.set("ja");

		expect(b.setHealthCheckMs.mock.calls.length).toBe(heartbeatCalls);
		expect(cronMock.instances).toHaveLength(0);
	});

	it("读得懂:切语言什么都不报", async () => {
		await place(JSON.stringify({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 }));
		const b = await boot();

		b.locale.set("en");

		expect(b.reportCount(DYNAMIC)).toBe(0);
		expect(b.reportCount(LOGIN_CHECK)).toBe(0);
	});

	it("改好之后(读得懂了):切语言不再报那一条", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }));
		const b = await boot();
		await b.store.patchSettings({
			integrations: { bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 } },
		});
		expect(b.problems()).toEqual([]);
		const before = b.reportCount(DYNAMIC);

		b.locale.set("en");

		expect(b.reportCount(DYNAMIC)).toBe(before);
	});

	it("来源停下之后切语言:不报", async () => {
		await place(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }));
		const b = await boot();
		await b.source.stop();
		const before = b.reportCount(DYNAMIC);

		b.locale.set("en");

		expect(b.reportCount(DYNAMIC)).toBe(before);
	});
});

describe("B 站设置读不懂的两条问题 · 文案", () => {
	const REASON = "Invalid input: expected number, received string";

	// 整句的字面量钉在 `problem-texts.test.ts`;这里钉「原因原话带进来、停的是哪一样、不指路」。
	it("动态:点名停的是哪一样(动态)、因为哪一格(叫法 + 键名)与原因;登录检查与直播照常", () => {
		const cell = PROBLEM_TEXTS.settingsCause.cell("动态检查频率", "dynamicCron", REASON);
		const text = PROBLEM_TEXTS.dynamicSettingsInvalid.text(cell);

		expect(text).toContain("动态先停着没在拉");
		expect(text).toContain("设置「动态检查频率」（dynamicCron）读不懂");
		expect(text).toContain(REASON);
		expect(text).toContain("登录、登录检查和直播照常");
		expect(text).not.toContain("面板");
		expect(PROBLEM_TEXTS.dynamicSettingsInvalid.notify).toBe(false);
	});

	it("登录检查:点名停的是哪一样(定时的登录检查)、因为哪一格;登录本身照常", () => {
		const cell = PROBLEM_TEXTS.settingsCause.cell("登录心跳间隔", "healthCheckMinutes", REASON);
		const text = PROBLEM_TEXTS.loginCheckSettingsInvalid.text(cell);

		expect(text).toContain("定时的登录检查先停着");
		expect(text).toContain("设置「登录心跳间隔」（healthCheckMinutes）读不懂");
		expect(text).toContain("登录失效了照样会发现");
		expect(text).not.toContain("面板");
		expect(PROBLEM_TEXTS.loginCheckSettingsInvalid.notify).toBe(false);
	});

	it("整个文件那一支点名「不是合法的 JSON」与原因,不带宿主的存储路径", () => {
		const file = PROBLEM_TEXTS.settingsCause.file("Unexpected end of JSON input");
		expect(file).toContain("设置文件不是合法的 JSON");
		expect(file).not.toContain("config/settings/bilibili.json");
		expect(file).toContain("Unexpected end of JSON input");
	});
});
