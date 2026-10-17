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
import { createValueRedactor } from "../../../logs/value-redactor.js";
import { makeServiceContext } from "../../api/__tests__/support/make-api.js";
import { ApiClient } from "../../api/api-client.js";
import { Api } from "../../api/index.js";
import {
	type CreateAuthSystemOptions,
	createAuthSystem as createAuthSystemWith,
} from "../index.js";
import { LoginFlow } from "../login-flow.js";
import { testAuthDeps } from "./support/auth-deps.js";

/** 测试里不关心图库:统一补上替身。 */
const createAuthSystem = (
	o: Omit<CreateAuthSystemOptions, "accountImages" | "problems" | "settingsOf">,
) => createAuthSystemWith({ ...testAuthDeps(), ...o });

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
	const store = createIntegrationStore({
		dataRoot: dataDir,
		keyProvider,
		logger: host.logger,
		redactor: createValueRedactor(),
	});
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
		expect(logger.info).not.toHaveBeenCalledWith("[auth] 登录续期已落盘");
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

describe("日志跟 B 站那一格", () => {
	// 验红:`auth/index.ts` 开头那句 `forSubsystem(BILIBILI_SOURCE_KEY, BILIBILI_SOURCE_KEY)` 删掉、往下递原来的 `opts.serviceCtx`,
	// 这条红(登录、接口、集成上下文的日志落回核心那一格)。
	it("Api、LoginFlow、集成上下文、登录系统自己的日志器,拿到的都是 B 站那一格(标签与键都是来源键)", async () => {
		const baseLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const biliLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const w = world(baseLogger);
		const biliHost = makeServiceContext(biliLogger);
		const forSubsystem = vi.fn(() => biliHost.serviceCtx);
		const serviceCtx = { ...w.host.serviceCtx, forSubsystem };
		// 抓住登录系统内部造的 Api 与 LoginFlow(原样放行,只记下 this)。
		let api: Api | undefined;
		let flow: LoginFlow | undefined;
		const apiStart = Api.prototype.start;
		vi.spyOn(Api.prototype, "start").mockImplementation(function (this: Api) {
			api = this;
			return apiStart.call(this);
		});
		const flowStart = LoginFlow.prototype.start;
		vi.spyOn(LoginFlow.prototype, "start").mockImplementation(function (this: LoginFlow) {
			flow = this;
			return flowStart.call(this);
		});

		const auth = await createAuthSystem({ serviceCtx, bus, integrationStore: w.store });

		expect(forSubsystem).toHaveBeenCalledWith("bilibili", "bilibili");
		const held = (target: unknown) => target as { serviceCtx: unknown; logger: Logger };
		expect(held(api).serviceCtx).toBe(biliHost.serviceCtx);
		expect(held(api).logger).toBe(biliLogger);
		expect(held(flow).serviceCtx).toBe(biliHost.serviceCtx);
		expect(held(flow).logger).toBe(biliLogger);
		expect(auth.integration.logger).toBe(biliLogger);
		// 登录系统自己的几行也在 B 站那一格(没登录:「等待扫码登录」那一行)。
		expect(biliLogger.info).toHaveBeenCalledWith("[auth] 账号未登录，等待扫码登录");
		expect(baseLogger.info).not.toHaveBeenCalled();
		expect(baseLogger.debug).not.toHaveBeenCalled();

		await auth.dispose();
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

	// 3a-30 复审记一笔 2。验红:把 `logout` 里的 `reportLoggedOut("notLogin")` 挪回落盘之后,这两条红(状态序列里多出一帧 `expired`)。
	it.each([
		["落盘成功", ok()],
		["落盘失败", fail("unavailable", "disk full")],
	])(
		"主动退出、清存着的登录状态(%s)的途中来了 -101:不算登录失效,对外只有「没登录」这一帧",
		async (_name, saved) => {
			const w = world();
			await w.seed({ cookies: C0, token: "T0" });
			vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
			// 这一条要真的登录流程:开机探活回 0 进已登录,退出走真的 `reportLoggedOut`。
			vi.mocked(LoginFlow.prototype.reportAccountInfo).mockRestore();
			vi.mocked(LoginFlow.prototype.reportLoggedOut).mockRestore();
			vi.spyOn(Api.prototype, "fetchMyselfInfo").mockResolvedValue({
				code: 0,
				data: { mid: 42, uname: "n", face: "" },
			});
			vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue({
				code: 0,
				data: { card: { name: "n", face: "" } },
			} as never);
			const auth = await createAuthSystem({
				serviceCtx: w.host.serviceCtx,
				bus,
				integrationStore: w.store,
			});
			expect(auth.auth.state().status).toBe("logged-in");
			const seen: string[] = [];
			auth.auth.onChange(() => seen.push(auth.auth.state().status));
			vi.mocked(bus.emit).mockClear();
			// 落盘悬着的那一段里,一个带着旧 cookie 发出去的请求回了 -101(经 `Api` 的拦截器那个口进来)。
			const commit = vi.spyOn(Api.prototype, "commitLogin").mockImplementation(async () => {
				(auth.api as unknown as { maybeFireAuthLost(code: number): void }).maybeFireAuthLost(-101);
				await Promise.resolve();
				return saved;
			});

			const r = await auth.auth.logout();

			expect(commit).toHaveBeenCalledTimes(1);
			expect(r.ok).toBe(saved.ok);
			expect(seen).toEqual(["logged-out"]);
			expect(auth.auth.state()).toEqual({ status: "logged-out" });
			// 丢掉一个好会话:`auth-lost` 恰好一次(退出那一下),不因为那个 -101 再来一次。
			expect(
				vi.mocked(bus.emit).mock.calls.filter(([event]) => event === "auth-lost"),
			).toHaveLength(1);
			commit.mockRestore();
			await auth.dispose();
			await w.store.close();
		},
	);

	// 报未登录提到了最前面,`auth-lost` 的监听者同步抛错会从那一句传出来。
	// 验红:把 `logout` 里的 try / finally 拆掉(报未登录之后顺着写清罐与落盘),这条红(罐子没清、没落盘)。
	it("主动退出时 auth-lost 的监听者抛错:抛错照旧往外传,但罐子照样清、存着的登录状态照样删", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		vi.mocked(LoginFlow.prototype.reportAccountInfo).mockRestore();
		vi.mocked(LoginFlow.prototype.reportLoggedOut).mockRestore();
		vi.spyOn(Api.prototype, "fetchMyselfInfo").mockResolvedValue({
			code: 0,
			data: { mid: 42, uname: "n", face: "" },
		});
		vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue({
			code: 0,
			data: { card: { name: "n", face: "" } },
		} as never);
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		expect(auth.auth.state().status).toBe("logged-in");
		vi.mocked(bus.emit).mockImplementation((event: string) => {
			if (event === "auth-lost") throw new Error("listener boom");
		});

		await expect(auth.auth.logout()).rejects.toThrow("listener boom");
		vi.mocked(bus.emit).mockReset();

		expect(auth.auth.state()).toEqual({ status: "logged-out" });
		expect(auth.api.getCookiesJson()).toBe("[]");
		await auth.dispose();
		await w.store.close();
		const disk = await w.disk();
		expect(disk.has("http.cookies")).toBe(false);
		expect(disk.has("refreshToken")).toBe(false);
	});

	// 验红:把 `login-flow.ts` 的 `accountFromCardResponse` 里「非 0 码」与「缺名字」两道检查都去掉(把 `data` 原样当账号收),
	// 这条红(账号不是 null)。只去掉其中一道不红 —— 另一道会替它挡住(见 `login-flow.test.ts` 里各道检查单独的用例)。
	it("开机时卡片接口回了形状不对的数据:登录系统照常起来,已登录、账号是 null、不抛", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		// 这个文件的 beforeEach 把探活换成了空操作;这一条要真的走一遍收卡片那一段。
		vi.mocked(LoginFlow.prototype.reportAccountInfo).mockRestore();
		vi.spyOn(Api.prototype, "fetchMyselfInfo").mockResolvedValue({
			code: 0,
			data: { mid: 42, uname: "n", face: "" },
		});
		vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue({
			code: -352,
			data: { v_voucher: "voucher_x" },
		} as never);

		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});

		expect(auth.auth.state().status).toBe("logged-in");
		expect(auth.auth.account()).toBeNull();
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

	// 登录系统不再认识设置:登录检查的间隔由 B 站来源读了设置、经这一口递进来(`bilibili/__tests__/source-settings.test.ts`)。
	// 验红:把 `AuthSystem.setHealthCheckMs` 改成什么都不做,或不转给 `flowFinal`,这条红。
	it("setHealthCheckMs 原样转给登录流程:建好时不动它,给正数挂上心跳定时器,给 0 摘掉", async () => {
		const w = world();
		const hot = vi.spyOn(LoginFlow.prototype, "setHealthCheckMs");
		const intervals = vi.spyOn(w.host.serviceCtx, "setInterval");
		const auth = await createAuthSystem({
			serviceCtx: w.host.serviceCtx,
			bus,
			integrationStore: w.store,
		});
		const MS = 45 * 60_000;
		const beats = () => intervals.mock.calls.filter(([, ms]) => ms === MS);
		expect(hot).not.toHaveBeenCalled();
		expect(beats()).toHaveLength(0); // 起步停着:没有任何设置喂给它

		auth.setHealthCheckMs(MS);
		expect(hot).toHaveBeenLastCalledWith(MS);
		expect(beats()).toHaveLength(1);

		auth.setHealthCheckMs(0);
		expect(hot).toHaveBeenLastCalledWith(0);
		await auth.dispose();
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
});
