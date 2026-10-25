/**
 * 登录系统(`createAuthSystem`)的生命周期:登录状态住在 B 站集成自己的存储里,停的次序、起到一半失败、
 * 恢复备份之后的接线、登出。关停时「先停登录、再最后一次存盘、再关存储把手」的整条次序在 `compose.test.ts` 钉着
 * (上下文由 `compose.ts` 开与收,这里的 `dispose()` 是测试辅助:`stop()` 再收上下文)。
 *
 * 真 `createAuthSystem` + 真 `Api` / `LoginFlow` + 真集成存储宿主(临时目录、真 FileKeyProvider);
 * 只把会联网的几处(探测、取页、POST、账号探测)按原型换成替身,不连 B 站。盘上是什么看 `secrets/bilibili/secrets.enc`
 * 解开后的内容,不看返回值。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, type Logger, ok } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { inertTransitImages } from "../../../__tests__/support/integration-io.js";
import { makeServiceContext } from "../../api/__tests__/support/make-api.js";
import { Api } from "../../api/index.js";
import { failureFromBili } from "../../error-codes.js";
import { watchLoginEdges } from "../../login-edges.js";
import { LoginFlow } from "../login-flow.js";
import { openAuthSystem, startAuthSystem } from "./support/auth-deps.js";
import { authWorld, C0, C1 } from "./support/auth-world.js";

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

const world = (logger?: Logger) => authWorld(dataDir, logger);

describe("停与存储把手", () => {
	it("stop 幂等、没起过也能调;收上下文之后存储把手已关(登录系统自己不关它)", async () => {
		const w = world();
		const auth = await openAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
			integrationStore: w.store,
		});
		auth.stop(); // 没起过
		await auth.start();
		auth.stop();
		auth.stop();
		expect(w.store.isOpen("bilibili")).toBe(true);

		await auth.dispose();
		await auth.dispose();

		expect(w.store.isOpen("bilibili")).toBe(false);
		await w.store.close();
	});
});

describe("日志跟给它的那个宿主上下文", () => {
	// 登录系统不自己要「B 站那一格」:来源把 B 站那一格递进来(`compose.test.ts` 钉着 `forSubsystem("bilibili", "bilibili")` 要得对、
	// 递得对),这里钉的是递进来的那一个被原样用到底:Api、LoginFlow、登录系统自己的日志器都是它的。
	// 验红:`auth/index.ts` 里往 `new Api` / `new LoginFlow` 递别的上下文(或日志用别的 logger),这条红。
	it("Api、LoginFlow、登录系统自己的日志器,拿到的都是递进来的宿主上下文", async () => {
		const baseLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const biliLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		const w = world(baseLogger);
		const biliHost = makeServiceContext(biliLogger);
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

		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: biliHost.serviceCtx,
			integrationStore: w.store,
		});

		const held = (target: unknown) => target as { serviceCtx: unknown; logger: Logger };
		expect(held(api).serviceCtx).toBe(biliHost.serviceCtx);
		expect(held(api).logger).toBe(biliLogger);
		expect(held(flow).serviceCtx).toBe(biliHost.serviceCtx);
		expect(held(flow).logger).toBe(biliLogger);
		expect(auth.context.ctx.logger).toBe(biliLogger);
		// 登录系统自己的几行也在那一格(没登录:「等待扫码登录」那一行)。
		expect(biliLogger.info).toHaveBeenCalledWith("[auth] 账号未登录，等待扫码登录");
		expect(baseLogger.info).not.toHaveBeenCalled();
		expect(baseLogger.debug).not.toHaveBeenCalled();

		await auth.dispose();
		await w.store.close();
	});
});

describe("起到一半失败", () => {
	it("登录流启动失败:start 抛出、Api 停下(作废在途续期),存储把手归收上下文的一方关,之后重来不抛", async () => {
		const w = world();
		const stop = vi.spyOn(Api.prototype, "stop");
		vi.spyOn(LoginFlow.prototype, "start").mockRejectedValueOnce(new Error("flow boom"));
		const opened = await openAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
			integrationStore: w.store,
		});

		await expect(opened.start()).rejects.toThrow("flow boom");

		expect(stop).toHaveBeenCalled();
		// 登录系统不开也不关存储:把手还开着,等收上下文的一方(`compose.ts`)来关。
		expect(w.store.isOpen("bilibili")).toBe(true);
		await opened.dispose();
		expect(w.store.isOpen("bilibili")).toBe(false);
		const again = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
			vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue(
				ok({ data: { card: { name: "n", face: "" } } }) as never,
			);
			const auth = await startAuthSystem({
				transitImages: inertTransitImages,
				serviceCtx: w.host.serviceCtx,
				integrationStore: w.store,
			});
			expect(auth.auth.state().status).toBe("logged-in");
			const lost = vi.fn();
			watchLoginEdges(auth.auth, { onLost: lost, onRestored: vi.fn() });
			const seen: string[] = [];
			auth.auth.onChange(() => seen.push(auth.auth.state().status));
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
			// 丢掉一个好会话:登录失效恰好一次(退出那一下),不因为那个 -101 再来一次。
			expect(lost).toHaveBeenCalledTimes(1);
			commit.mockRestore();
			await auth.dispose();
			await w.store.close();
		},
	);

	it("主动退出时登录失效回调抛错:不影响退出,罐子照样清、存着的登录状态照样删", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		vi.mocked(LoginFlow.prototype.reportAccountInfo).mockRestore();
		vi.mocked(LoginFlow.prototype.reportLoggedOut).mockRestore();
		vi.spyOn(Api.prototype, "fetchMyselfInfo").mockResolvedValue({
			code: 0,
			data: { mid: 42, uname: "n", face: "" },
		});
		vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue(
			ok({ data: { card: { name: "n", face: "" } } }) as never,
		);
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
			integrationStore: w.store,
		});
		expect(auth.auth.state().status).toBe("logged-in");
		const lost = vi.fn(() => {
			throw new Error("listener boom");
		});
		watchLoginEdges(auth.auth, { onLost: lost, onRestored: vi.fn() });

		await expect(auth.auth.logout()).resolves.toEqual(ok());

		expect(lost).toHaveBeenCalledTimes(1);
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
		vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue(
			fail("rate_limited", "风控", { upstreamCode: -352 }) as never,
		);

		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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

	it("handleAuthLost 判失效但留下 cookie;reportAccountInfo 拿现成 cookie 再探后回到已登录", async () => {
		const w = world();
		await w.seed({ cookies: C0, token: "T0" });
		vi.spyOn(Api.prototype, "checkIfTokenNeedRefresh").mockResolvedValue();
		vi.mocked(LoginFlow.prototype.reportAccountInfo).mockRestore();
		vi.mocked(LoginFlow.prototype.reportLoggedOut).mockRestore();
		vi.spyOn(Api.prototype, "fetchMyselfInfo").mockResolvedValue({
			code: 0,
			data: { mid: 42, uname: "n", face: "" },
		});
		vi.spyOn(Api.prototype, "fetchUserCard").mockResolvedValue(
			ok({ data: { card: { name: "n", face: "" } } }) as never,
		);
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
			integrationStore: w.store,
		});
		expect(auth.auth.state().status).toBe("logged-in");
		const cookies = auth.api.getCookiesJson();

		await auth.handleAuthLost();

		expect(auth.auth.state()).toEqual({
			status: "expired",
			message: "账号登录已失效，请重新扫码登录",
		});
		expect(auth.api.getCookiesJson()).toBe(cookies);

		await auth.reportAccountInfo();

		expect(auth.auth.state()).toMatchObject({ status: "logged-in" });
		expect(auth.api.getCookiesJson()).toBe(cookies);
		await auth.dispose();
		await w.store.close();
	});

	it("auth 口的 state() / account() 读的就是登录流程的对外状态;onChange 的订阅者在状态变时被叫", async () => {
		const w = world();
		const auth = await startAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: w.host.serviceCtx,
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
		vi.spyOn(Api.prototype, "fetchLoginQrCode").mockResolvedValue(failureFromBili(-352, "风控"));
		await auth.auth.beginLogin();
		expect(changed).toHaveBeenCalledTimes(1);
		expect(auth.auth.state()).toMatchObject({ status: "error" });
		sub.dispose();
		await auth.dispose();
		await w.store.close();
	});
});
