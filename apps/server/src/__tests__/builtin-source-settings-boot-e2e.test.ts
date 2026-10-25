/**
 * 🔴 **B 站设置坏着开机,起得来、坏的那一样没起、问题表里有对应的一条;经真路由把那一格存对,那一样起来、那条没了。**
 *
 * 配置仓怎么读坏文件、把手怎么变了才叫、来源怎么停与起,各有直测;要真能「坏着开机 → 经面板的设置口存对 →
 * 当场起来」,还得 `pipeline.registerSource` 把读口与通知口接上、设置路由把 `bilibili` 键认成集成的补丁(配置仓全量图里
 * 这个键一直在)。剪断任何一处,零件测试全绿而这条红。
 *
 * 走真入口、真 `compose.ts`、真登记表、真来源与真动态引擎(没有订阅,不起 cron、不连网);坏文件怎么摆照
 * `extension-broken-settings-boot-e2e.test.ts`:先空启动一趟让数据代就位,再改写在用那一代里的设置文件,再起第二趟。
 * 来源 `start` 里把登录检查的间隔经登录系统挂上,也在这里钉着:用的是真登录系统,探的是
 * `LoginFlow.prototype.setHealthCheckMs`,把 `bilibili/source.ts` 里那一跳剪成空操作,「间隔按盘上的值挂上」几条都红(心跳本身不会真探活)。
 * 它证明不了的:「没有私聊」在 `source-settings.test.ts` 钉(问题条目不带 notify)。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DYNAMIC_CRON } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LoginFlow } from "../bilibili/auth/login-flow.js";
import type { BiliSource } from "../bilibili/source.js";
import { integrationSettingsFile } from "../config/store.js";
import { type ServerHandle, startServer } from "../index.js";
import { activeGeneration } from "./support/generation.js";

const built = vi.hoisted(() => ({ sources: [] as unknown[] }));

// 真来源,只多记一份引用(读 `dynamic()`)。
vi.mock("../bilibili/source.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../bilibili/source.js")>();
	return {
		...real,
		createBiliSource: (deps: Parameters<typeof real.createBiliSource>[0]) => {
			const source = real.createBiliSource(deps);
			built.sources.push(source);
			return source;
		},
	};
});

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

const DYNAMIC = "dynamic_settings_invalid";
const LOGIN_CHECK = "login_check_settings_invalid";
const MIN = 60_000;

describe("B 站设置坏着开机 e2e:哪格坏停哪样,经真路由存对当场起来", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;
	let setHealthCheckMs: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-bili-settings-boot-e2e-"));
		built.sources.length = 0;
		setHealthCheckMs = vi.spyOn(LoginFlow.prototype, "setHealthCheckMs");
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		vi.restoreAllMocks();
		await rm(dataDir, { recursive: true, force: true });
	});

	const boot = async (listenPort: number) =>
		startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(listenPort),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});

	/** 先空启动一趟让数据代就位,把 B 站设置文件改写成 `content`,再起第二趟(两趟之间的记录清掉)。 */
	async function bootWith(content: string): Promise<string> {
		const seed = await boot(await findFreePort());
		await seed.close("seed");
		const file = join(await activeGeneration(dataDir), ...integrationSettingsFile("bilibili"));
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, content);
		built.sources.length = 0;
		setHealthCheckMs.mockClear();
		port = await findFreePort();
		handle = await boot(port);
		return file;
	}

	const url = (path: string) => `http://127.0.0.1:${port}${path}`;
	const source = () => built.sources[0] as BiliSource;
	const problemCodes = async () =>
		(
			(await (await fetch(url("/api/problems"))).json()) as {
				problems: Array<{ reporter: string; code: string }>;
			}
		).problems
			.filter((p) => p.reporter === "bilibili")
			.map((p) => p.code)
			.filter((code) => code === DYNAMIC || code === LOGIN_CHECK)
			.sort();
	const panelSettings = async () =>
		(
			(await (await fetch(url("/api/settings"))).json()) as {
				bilibili: { dynamicCron: string; healthCheckMinutes: number };
			}
		).bilibili;
	const save = (bilibili: { dynamicCron: string; healthCheckMinutes: number }) =>
		fetch(url("/api/settings"), {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bilibili }),
		});

	// 验红:剪 `pipeline.registerSource` 里 `settings.read`(接成恒成功的默认值)→ 开机那一幕红(问题表里没有那一条);
	// 剪 `onChanged` → 存对之后引擎没起来,红;让全量图在坏格时不带 `bilibili` 键 → PATCH 被当成核心补丁回 200 而盘上没变,红。
	it("动态那格写成数字:起得来、动态没起、问题表有一条;面板拿到默认值;经真路由存对 → 动态起来、那条没了、文件是新值", async () => {
		const file = await bootWith(JSON.stringify({ dynamicCron: 123, healthCheckMinutes: 45 }));

		expect(source().dynamic()).toBeUndefined();
		expect(await problemCodes()).toEqual([DYNAMIC]);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(45 * MIN);
		// 面板读到的:坏的那格是默认值、好的那格是盘上的值,键一直在。
		expect(await panelSettings()).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: 45,
		});
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			dynamicCron: 123,
			healthCheckMinutes: 45,
		});

		// 系统页保存的真实形状:同一块两格一起发。
		const res = await save({ dynamicCron: "*/5 * * * *", healthCheckMinutes: 45 });

		expect(res.status).toBe(200);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			dynamicCron: "*/5 * * * *",
			healthCheckMinutes: 45,
		});
		expect(source().dynamic()).toBeDefined();
		expect(await problemCodes()).toEqual([]);
	});

	it("登录检查那格越界:起得来、定时登录检查停着(0)、动态照常、问题表有一条;存对 → 按新值挂上、那条没了", async () => {
		await bootWith(JSON.stringify({ dynamicCron: DEFAULT_DYNAMIC_CRON, healthCheckMinutes: 1 }));

		expect(source().dynamic()).toBeDefined();
		expect(await problemCodes()).toEqual([LOGIN_CHECK]);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
		expect(await panelSettings()).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: 30,
		});

		const res = await save({ dynamicCron: DEFAULT_DYNAMIC_CRON, healthCheckMinutes: 45 });

		expect(res.status).toBe(200);
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(45 * MIN);
		expect(await problemCodes()).toEqual([]);
	});

	it("整个文件是半截 JSON:起得来、两样都停、两条都在;任意存一格 → 两样都起、两条都没了、文件是合法的两格", async () => {
		const file = await bootWith('{"dynamicCron": "*/5 * * * *", "healthCheckMinutes": ');

		expect(source().dynamic()).toBeUndefined();
		expect(await problemCodes()).toEqual([DYNAMIC, LOGIN_CHECK].sort());
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(0);
		expect(await panelSettings()).toEqual({
			dynamicCron: DEFAULT_DYNAMIC_CRON,
			healthCheckMinutes: 30,
		});

		const res = await save({ dynamicCron: "*/7 * * * *", healthCheckMinutes: 30 });

		expect(res.status).toBe(200);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			dynamicCron: "*/7 * * * *",
			healthCheckMinutes: 30,
		});
		expect(source().dynamic()).toBeDefined();
		expect(setHealthCheckMs).toHaveBeenLastCalledWith(30 * MIN);
		expect(await problemCodes()).toEqual([]);
	});
});
