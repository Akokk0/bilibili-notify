/**
 * 登录系统(`createAuthSystem`)的生命周期:登录状态住在 B 站集成自己的存储里,关停的次序、建到一半失败、
 * 恢复备份之后的接线、登出。
 *
 * 真 `createAuthSystem` + 真 `Api` / `LoginFlow` + 真集成存储宿主(临时目录、真 FileKeyProvider);
 * 只把会联网的几处(探测、取页、POST、账号探测)按原型换成替身,不连 B 站。盘上是什么看 `secrets/bilibili/secrets.enc`
 * 解开后的内容,不看返回值。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CookieJar } from "@bilibili-notify/http";
import { fail, type Json, type Logger, type MessageBus, ok } from "@bilibili-notify/internal";
import { FileKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readIntegrationSecretsFile } from "../../../integration-store/files.js";
import { createIntegrationStore } from "../../../integration-store/store.js";
import { makeServiceContext } from "../../api/__tests__/support/make-api.js";
import { ApiClient } from "../../api/api-client.js";
import { Api } from "../../api/index.js";
import {
	type CreateAuthSystemOptions,
	createAuthSystem as createAuthSystemWith,
} from "../index.js";
import { LoginFlow } from "../login-flow.js";
import { testAuthDeps } from "./support/auth-deps.js";

/** 测试里不关心配置仓与图库:统一补上替身。 */
const createAuthSystem = (o: Omit<CreateAuthSystemOptions, "configStore" | "accountImages">) =>
	createAuthSystemWith({ ...testAuthDeps(), ...o });

const C0 = JSON.stringify([
	{ key: "SESSDATA", value: "sess0", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "bili_jct", value: "jct0", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "buvid3", value: "b3", domain: ".bilibili.com", path: "/", secure: true },
]);
const C1 = JSON.stringify([
	{ key: "SESSDATA", value: "sess1", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "bili_jct", value: "jct1", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "buvid3", value: "b3", domain: ".bilibili.com", path: "/", secure: true },
]);

const bus: MessageBus = { emit: vi.fn(), on: vi.fn(() => ({ dispose: vi.fn() })) };

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-auth-lifecycle-"));
	// 账号探测是联网的:登录流的这两个口换成空操作(它们的行为在 login-flow 的测试里钉着)。
	vi.spyOn(LoginFlow.prototype, "reportAccountInfo").mockResolvedValue();
	vi.spyOn(LoginFlow.prototype, "reportLoggedOut").mockImplementation(() => {});
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(dataDir, { recursive: true, force: true });
});

function world(logger?: Logger) {
	const host = makeServiceContext(logger);
	const fileKeys = new FileKeyProvider(join(dataDir, "secrets", "master.key"), host.logger);
	/**
	 * 数写盘次数:写 `secrets.enc` 每次都要取一次主密钥(读也取,所以只在读完之后的某一段里数),
	 * 一次取钥 = 一次写。内容看最后落在盘上的那份。
	 */
	let keyFetches = 0;
	const keyProvider: KeyProvider = {
		protected: fileKeys.protected,
		getKey: () => {
			keyFetches += 1;
			return fileKeys.getKey();
		},
	};
	const keyFetchCount = () => keyFetches;
	const store = createIntegrationStore({ dataRoot: dataDir, keyProvider, logger: host.logger });
	/** 上一次关停之后盘上这个集成的 `secrets` 整袋。 */
	const disk = async (): Promise<Map<string, Json>> => {
		const read = await readIntegrationSecretsFile({
			dataRoot: dataDir,
			key: "bilibili",
			logger: host.logger,
			keyProvider,
		});
		if (read.kind !== "ok") throw new Error(read.message);
		return read.entries;
	};
	/** 开机之前先在盘上放好:罐子(整段字符串)与令牌。 */
	const seed = async (entries: { cookies?: string; token?: string }) => {
		const handle = await store.open("bilibili");
		if (entries.cookies !== undefined)
			await handle.hostSecrets.set("http.cookies", entries.cookies);
		if (entries.token !== undefined) await handle.secrets.set("refreshToken", entries.token);
		handle.close();
	};
	const jarOf = (api: Api) => (api as unknown as { jar: CookieJar }).jar;
	return { host, store, disk, seed, jarOf, keyFetchCount };
}

/**
 * 把一轮续期停在「确认 POST」上:探测要刷新、取页、刷新 POST 都过了(罐子里已是新 cookie),确认 POST 悬着,
 * 等测试放行。罐子要等 `createAuthSystem` 返回才有 —— 链万一先跑到刷新 POST,就等 `setJar`(不抛、不吞)。
 */
function stallRenewalAtConfirm() {
	vi.spyOn(
		Api.prototype as unknown as { fetchCookieInfo: () => Promise<unknown> },
		"fetchCookieInfo",
	).mockResolvedValue({ code: 0, data: { refresh: true, timestamp: Date.now() } });
	vi.spyOn(ApiClient.prototype, "get").mockResolvedValue('<div id="1-name">rc</div>');
	let confirmReached!: () => void;
	const reached = new Promise<void>((resolve) => {
		confirmReached = resolve;
	});
	let releaseConfirm!: (reply: unknown) => void;
	const confirmReply = new Promise<unknown>((resolve) => {
		releaseConfirm = resolve;
	});
	let setJar!: (jar: CookieJar) => void;
	const jarReady = new Promise<CookieJar>((resolve) => {
		setJar = resolve;
	});
	let posts = 0;
	vi.spyOn(ApiClient.prototype, "postForm").mockImplementation(async () => {
		posts += 1;
		if (posts === 1) {
			// 刷新 POST:罐子收到新 cookie、回新令牌。
			const jar = await jarReady;
			jar.setFromSetCookie(
				"SESSDATA=sess1; Domain=.bilibili.com; Path=/; Secure",
				"https://www.bilibili.com",
			);
			jar.setFromSetCookie(
				"bili_jct=jct1; Domain=.bilibili.com; Path=/; Secure",
				"https://www.bilibili.com",
			);
			return { code: 0, message: "0", data: { refresh_token: "T1" } };
		}
		confirmReached();
		return confirmReply;
	});
	return { reached, releaseConfirm, setJar };
}

describe("关停的次序", () => {
	it("续期停在确认之前时关停:盘上还是旧的一对(闸还在,不存中间状态)", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		const stalled = stallRenewalAtConfirm();

		// 开机顺带触发一次续期(盘上有令牌)。
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		stalled.setJar(w.jarOf(auth.api));
		await stalled.reached;

		await auth.dispose();
		stalled.releaseConfirm({ code: 0 });
		await Promise.all(w.host.tracked);
		await w.store.close();

		const disk = await w.disk();
		expect(disk.get("refreshToken")).toBe("T0");
		expect(String(disk.get("http.cookies"))).toContain("sess0");
		expect(String(disk.get("http.cookies"))).not.toContain("sess1");
	});

	it("停 Api 的收尾排在最后一次存盘之前:关停后迟到的确认回应是「被取代」,不是去撞已关的写道", async () => {
		const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const w = world(logger);
		vi.mocked(bus.emit).mockClear();
		await w.seed({ cookies: C0, token: "T0" });
		const stalled = stallRenewalAtConfirm();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		stalled.setJar(w.jarOf(auth.api));
		await stalled.reached;

		// 确认回应在关停进行的当口到:Api 必须已经先停了(否则这条链醒来就去提交)。
		const disposing = auth.dispose();
		stalled.releaseConfirm({ code: 0 });
		await disposing;
		await Promise.all(w.host.tracked);
		await w.store.close();

		// 先停了 Api:迟到的链看见自己被取代,安静丢弃。没先停的话,它会去提交,撞上已经关掉的写道:记 error。
		expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("被取代"));
		expect(logger.error).not.toHaveBeenCalled();
		expect(bus.emit).not.toHaveBeenCalledWith("cookies-refreshed", expect.anything());
	});

	it("没有在途续期、罐子里有没存的变化时关停:最后一次存盘落了", async () => {
		const w = world();
		await w.seed({ cookies: C0 });
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		// 假时钟不推进:攒着的那一下根本没到点。
		w.jarOf(auth.api).setFromSetCookie(
			"stray=late; Domain=.bilibili.com; Path=/",
			"https://www.bilibili.com",
		);

		await auth.dispose();
		await w.store.close();

		expect(String((await w.disk()).get("http.cookies"))).toContain("stray");
	});

	it("dispose 幂等,之后存储把手已关", async () => {
		const w = world();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		expect(w.store.isOpen("bilibili")).toBe(true);

		await auth.dispose();
		await auth.dispose();

		expect(w.store.isOpen("bilibili")).toBe(false);
		await w.store.close();
	});
});

describe("建到一半失败", () => {
	it("登录流启动失败:Api 停下、存储把手关上,下次 open 同一个键不抛", async () => {
		const w = world();
		const stop = vi.spyOn(Api.prototype, "stop");
		vi.spyOn(LoginFlow.prototype, "start").mockRejectedValueOnce(new Error("flow boom"));

		await expect(
			createAuthSystem({ serviceCtx: w.host.serviceCtx, bus, integrationStore: w.store }),
		).rejects.toThrow("flow boom");

		expect(stop).toHaveBeenCalled();
		expect(w.store.isOpen("bilibili")).toBe(false);
		const again = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		await again.dispose();
		await w.store.close();
	});
});

describe("恢复备份之后与登出", () => {
	it("宿主整袋换掉密钥之后:罐子换成新的、登录被重新恢复(重探账号)", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		const probe = vi.mocked(LoginFlow.prototype.reportAccountInfo);
		expect(probe).toHaveBeenCalledTimes(1);

		const restored = await w.store.restoreSecrets("bilibili", {
			"http.cookies": C1,
			refreshToken: "T9",
		});

		expect(restored.ok).toBe(true);
		expect(auth.api.getCookiesJson()).toContain("sess1");
		expect(auth.api.getCookiesJson()).not.toContain("sess0");
		// 开机一次 + 恢复一次:没登记 onRestored 的话这里还是 1。
		expect(probe).toHaveBeenCalledTimes(2);

		await auth.dispose();
		await w.store.close();
	});

	it("登出:罐子与令牌在同一次写里一起删,报未登录", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});

		const writesBefore = w.keyFetchCount();
		await auth.auth.logout();
		// 恰好一次写(取钥匙只发生在写 secrets.enc 的时候);落在盘上的就是这一次 —— 两个键都已经没了。
		expect(w.keyFetchCount() - writesBefore).toBe(1);
		await auth.dispose();
		await w.store.close();

		const disk = await w.disk();
		expect(disk.has("http.cookies")).toBe(false);
		expect(disk.has("refreshToken")).toBe(false);
		expect(LoginFlow.prototype.reportLoggedOut).toHaveBeenCalledWith("notLogin");
	});

	it("登出时存着的登录状态清不掉:回失败带原因,但内存里的罐子已清、照样报未登录", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		const clear = vi.spyOn(Api.prototype, "clearCookies");
		vi.spyOn(Api.prototype, "commitLogin").mockResolvedValue(fail("unavailable", "disk full"));
		vi.mocked(LoginFlow.prototype.reportLoggedOut).mockClear();

		const r = await auth.auth.logout();

		expect(r).toEqual(
			fail("unavailable", "已退出，但存着的登录状态没清掉：disk full，重启后可能还是登录着"),
		);
		expect(clear).toHaveBeenCalledTimes(1);
		expect(LoginFlow.prototype.reportLoggedOut).toHaveBeenCalledWith("notLogin");
		await auth.dispose();
		await w.store.close();
	});

	it("登出时提交写盘成功:回 ok", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});

		expect(await auth.auth.logout()).toEqual(ok());
		await auth.dispose();
		await w.store.close();
	});

	// 验红:删掉 `createAuthSystem` 里 `watchSettings(...)` 那一订阅(或把 `setHealthCheckMs` 那行去掉),第一条红。
	it("健康检查间隔:设置里改了就热换到心跳;别的集成改了不动;dispose 之后摘掉订阅", async () => {
		const w = world();
		let minutes = 30;
		const listeners: Array<(scope: string) => void> = [];
		const unsubscribed = vi.fn();
		const configStore = {
			getIntegrationSettings: () => ({
				dynamicCron: "30 */2 * * * *",
				healthCheckMinutes: minutes,
			}),
			onChange: (fn: (scope: string) => void) => {
				listeners.push(fn);
				return { dispose: unsubscribed };
			},
		} as unknown as CreateAuthSystemOptions["configStore"];
		const hot = vi.spyOn(LoginFlow.prototype, "setHealthCheckMs");
		const auth = await createAuthSystemWith({
			...testAuthDeps(),
			configStore,
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		expect(hot).not.toHaveBeenCalled(); // 开机按设置里的值起,不是热换

		// 事件来了但设置没变(别的集成改了)。
		for (const fn of listeners) fn("integration-settings");
		expect(hot).not.toHaveBeenCalled();

		minutes = 45;
		for (const fn of listeners) fn("integration-settings");
		expect(hot).toHaveBeenCalledTimes(1);
		expect(hot).toHaveBeenCalledWith(45 * 60_000);

		await auth.dispose();
		expect(unsubscribed).toHaveBeenCalledTimes(1);
		await w.store.close();
	});

	it("auth 口的 state() / account() 读的就是登录流程的对外状态;onChange 的订阅者在状态变时被叫", async () => {
		const w = world();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		// 开机的 reportAccountInfo / reportLoggedOut 在这个文件里被换成空操作:状态还是初值(开机没确认)。
		expect(auth.auth.state()).toEqual({
			status: "confirming",
			message: "正在向 B 站确认登录状态，暂时连不上的话会自动重试",
		});
		expect(auth.auth.account?.()).toBeNull();
		const changed = vi.fn();
		const sub = auth.auth.onChange(changed);
		// 经真 `LoginFlow` 的原型方法走一遍对外变化(reportLoggedOut 在这里是空操作,换用 beginLogin 的失败路径)。
		vi.spyOn(Api.prototype, "fetchLoginQrCode").mockResolvedValue({
			code: -352,
			data: null,
		} as never);
		await auth.auth.beginLogin();
		expect(changed).toHaveBeenCalledTimes(1);
		expect(auth.auth.state()).toMatchObject({ status: "error" });
		sub.dispose();
		await auth.dispose();
		await w.store.close();
	});

	it("手动刷新读的是存着的令牌与罐子里的 bili_jct", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		const check = vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		check.mockClear();

		await auth.refreshCookies();

		expect(check).toHaveBeenCalledWith("T0", "jct0");
		await auth.dispose();
		await w.store.close();
	});
});
