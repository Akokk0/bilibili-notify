/**
 * 登录会话的边界:「一段登录成立」时请求客户端那一头该发生的事,三条路(开机恢复、恢复备份、扫码确认成功)都得一样。
 *
 * 真 `Api` + 真 `LoginFlow` + 真罐子与真存储规矩(`makeApi`),`onAuthLost` 照 `createAuthSystem` 的接法接到
 * `LoginFlow.handleAuthLost`;只把最底下那个 `HttpClient.fetch` 换成替身,**一个字节都不出网**。每个请求默认悬着,
 * 由用例决定什么时候回、回什么 —— 这里钉的全是「发出去的时候是哪一段登录、回来的时候已经换了一段」的交叠。
 *
 * 钉住的五件事(每条在统一的口出现之前都是红的):
 *  1. 扫码登上之后每小时的 cookie 续期要起来(没登录起步、登录失效之后重扫都是);
 *  2. 已登录时重扫成功,在途的旧续期链探测回 `-101`:不清刚登上的罐子、不报失效;
 *  3. 带着旧 cookie 发出去、新登录成立之后才回来的请求,它的 `-101` 不作数;也不吃掉 60 秒的去抖窗口;
 *  4. 恢复备份换罐之后同样是一段新登录:在途的旧心跳回 `-101` 不把换进来的登录判成失效;
 *  5. 扫码成功但落盘失败照样是一段新登录:上一段报过的 `-101` 不吞掉这一段的第一次 `-101`。
 *
 * 复发点:有人在 `pollOnce` 里把提交换回 `commitLogin`(绕过统一的口);把 `ApiClient` 取记号挪到请求回来之后;
 * 把 `-101` 的去抖改回只按时间记。
 */

import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeApi, makeServiceContext } from "../../api/__tests__/support/make-api";
import * as EP from "../../api/endpoints";
import { watchLoginEdges } from "../../login-edges";
import { LoginFlow } from "../login-flow";

const cookiesOf = (tag: string) =>
	JSON.stringify([
		{ key: "SESSDATA", value: `sess-${tag}`, domain: ".bilibili.com", path: "/", secure: true },
		{ key: "bili_jct", value: `jct-${tag}`, domain: ".bilibili.com", path: "/", secure: true },
		{ key: "buvid3", value: "b3", domain: ".bilibili.com", path: "/", secure: true },
	]);

const HOUR_MS = 3_600_000;
const HEALTH_MS = 60_000;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

type Reply = unknown | (() => unknown);

async function world(opts: { cookies?: string; token?: string; healthCheckMs?: number } = {}) {
	const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const host = makeServiceContext(logger);
	let flow: LoginFlow | undefined;
	const onAuthLost = vi.fn(() => {
		void flow?.handleAuthLost();
	});
	const secrets: Record<string, string> = {};
	if (opts.cookies !== undefined) secrets["http.cookies"] = opts.cookies;
	if (opts.token !== undefined) secrets.refreshToken = opts.token;
	const w = await makeApi({ serviceCtx: host.serviceCtx, callbacks: { onAuthLost }, secrets });
	flow = new LoginFlow({
		serviceCtx: host.serviceCtx,
		api: w.api,
		healthCheckMs: opts.healthCheckMs ?? 0,
	});
	const theFlow = flow;
	const lost = vi.fn();
	watchLoginEdges(
		{ state: () => theFlow.authState(), onChange: (fn) => theFlow.onChange(fn) },
		{ onLost: lost, onRestored: vi.fn() },
	);

	// ---- 线:最底下的 fetch 换成替身。给了自动回应的地址立刻回,别的悬着等用例回。 ----
	const autos = new Map<string, Reply>();
	const pending: Array<{ url: string; resolve: (result: unknown) => void }> = [];
	const sent: string[] = [];
	const responseOf = (url: string, body: unknown) => ({
		ok: true,
		url,
		status: 200,
		headers: new Headers(),
		isSuccess: true,
		text: () => JSON.stringify(body),
	});
	vi.spyOn(w.http, "fetch").mockImplementation(((target: string | URL) => {
		const url = String(target);
		sent.push(url);
		for (const [prefix, reply] of autos) {
			if (!url.startsWith(prefix)) continue;
			const body = typeof reply === "function" ? (reply as () => unknown)() : reply;
			return Promise.resolve(responseOf(url, body));
		}
		return new Promise((resolve) => {
			pending.push({ url, resolve });
		});
	}) as never);
	const wire = {
		auto: (prefix: string, reply: Reply) => void autos.set(prefix, reply),
		manual: (prefix: string) => void autos.delete(prefix),
		/** 这个地址发出去过几次。 */
		count: (prefix: string) => sent.filter((url) => url.startsWith(prefix)).length,
		/** 这个地址还悬着几个。 */
		waiting: (prefix: string) => pending.filter((p) => p.url.startsWith(prefix)).length,
		/** 回掉这个地址最早悬着的那一个。 */
		async answer(prefix: string, body: unknown) {
			const at = pending.findIndex((p) => p.url.startsWith(prefix));
			if (at < 0) throw new Error(`没有悬着的请求: ${prefix}`);
			const [request] = pending.splice(at, 1);
			request?.resolve(responseOf(request.url, body));
			await pass();
		},
	};
	wire.auto(EP.MYSELF_INFO_URL, { code: 0, data: { mid: 42 } });
	wire.auto(EP.USER_CARD_URL, { code: 0, data: { card: { name: "up", face: "" } } });

	/** 推过 `ms`,让到点的定时器与它们排上的后续走完(不等悬着的请求)。 */
	async function pass(ms = 0) {
		host.advance(ms);
		for (let i = 0; i < 4; i++) await settle();
	}

	/** `createAuthSystem` 里 `resumeLogin` 做的那几步(开机一次;恢复备份之后宿主换好罐子再叫一次)。 */
	async function resumeLogin() {
		await w.api.resumeStoredLogin();
		if (w.jar.getValue("bili_jct") !== undefined) await theFlow.reportAccountInfo();
		else theFlow.reportLoggedOut("notLogin");
	}

	/** 发起扫码、下一拍轮询回「确认成功」:登录回应的 Set-Cookie 先进罐子,再带着令牌回来。 */
	async function scan(tag: string, token: string | undefined = `rt-${tag}`) {
		wire.auto(EP.LOGIN_QR_CODE_URL, { code: 0, data: { url: "https://qr", qrcode_key: tag } });
		wire.auto(EP.LOGIN_STATUS_URL, () => {
			for (const key of ["SESSDATA", "bili_jct"]) {
				w.jar.setFromSetCookie(
					`${key}=${key === "SESSDATA" ? "sess" : "jct"}-${tag}; Domain=.bilibili.com; Path=/; Secure`,
					"https://passport.bilibili.com",
				);
			}
			return { code: 0, data: { code: 0, refresh_token: token } };
		});
		expect((await theFlow.beginLogin(async () => "data:url")).ok).toBe(true);
		await pass(1_000);
	}

	return { ...w, host, flow: theFlow, onAuthLost, lost, wire, pass, resumeLogin, scan };
}

describe("① 扫码登上之后续期要起来", () => {
	it("开机没登录 → 扫码登上:标成已载入;不立刻探(cookie 刚发下来),满一小时触发一次续期检查", async () => {
		const w = await world();
		await w.resumeLogin();
		expect(w.flow.authState().status).toBe("logged-out");

		await w.scan("new");

		expect(w.flow.authState().status).toBe("logged-in");
		expect(w.api.isLoginInfoLoaded()).toBe(true);
		expect(w.wire.count(EP.COOKIE_INFO_URL)).toBe(0);

		await w.pass(HOUR_MS);

		expect(w.wire.count(EP.COOKIE_INFO_URL)).toBe(1);
	});

	// 对照,恒绿:没有令牌时「不探」有两道挡着(`loginEstablished` 不挂定时器;挂了,`triggerRefreshCheck` 现读不到令牌
	// 也不发),改坏其中一道红不了。「没挂定时器」本身由 refresh-classify 的「存储里没有令牌」那条钉着。
	it("登录回应里没有令牌:续期起不来(没有令牌可刷),一小时后也不探", async () => {
		const w = await world();
		await w.resumeLogin();

		await w.scan("new", "");
		await w.pass(HOUR_MS);

		expect(w.flow.authState().status).toBe("logged-in");
		expect(w.wire.count(EP.COOKIE_INFO_URL)).toBe(0);
	});

	it("续期链判了登录失效(定时器被摘掉)→ 重扫登上:续期重新起来", async () => {
		const w = await world({ cookies: cookiesOf("old"), token: "rt-old" });
		await w.resumeLogin();
		// 开机那一轮续期检查:探测回 -101,会话终态。
		await w.wire.answer(EP.COOKIE_INFO_URL, { code: -101 });
		expect(w.flow.authState().status).toBe("expired");
		await w.pass(HOUR_MS);
		expect(w.wire.count(EP.COOKIE_INFO_URL)).toBe(1); // 对照:终态之后定时器确实摘了

		await w.scan("new");
		expect(w.flow.authState().status).toBe("logged-in");
		await w.pass(HOUR_MS);

		expect(w.wire.count(EP.COOKIE_INFO_URL)).toBe(2);
	});

	it("扫码成功但落盘失败:这一段的令牌没存下来,不拿存储里上一段的旧令牌去续期", async () => {
		const w = await world({ cookies: cookiesOf("old"), token: "rt-old" });
		await w.resumeLogin();
		await w.wire.answer(EP.COOKIE_INFO_URL, { code: 0, data: { refresh: false } });
		w.secrets.failNext(1);

		await w.scan("new");
		expect(w.flow.authState().status).toBe("logged-in");
		expect(w.ctx.secrets.get("refreshToken")).toBe("rt-old");
		await w.pass(HOUR_MS);

		// 开机那一次之外没有新的探测:旧令牌配新 cookie 去刷,只会把刚登上的会话刷成终态。
		expect(w.wire.count(EP.COOKIE_INFO_URL)).toBe(1);
	});
});

describe("② 已登录时重扫成功:在途的旧续期链不作数", () => {
	it("旧链的探测回 -101:不清刚登上的罐子、不报失效、状态还是已登录", async () => {
		const w = await world({ cookies: cookiesOf("old"), token: "rt-old" });
		await w.resumeLogin();
		expect(w.wire.waiting(EP.COOKIE_INFO_URL)).toBe(1); // 开机那一轮续期检查悬在探测上

		await w.scan("new");
		expect(w.jar.getValue("bili_jct")).toBe("jct-new");

		await w.wire.answer(EP.COOKIE_INFO_URL, { code: -101 });
		await Promise.all(w.host.tracked);

		expect(w.jar.getValue("bili_jct")).toBe("jct-new");
		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.flow.authState().status).toBe("logged-in");
	});
});

describe("③ 请求级的迟到 -101", () => {
	it("带着旧 cookie 发出去、新登录成立之后才回 -101:不作数;新登录自己的 -101 照样报(去抖窗口没被吃掉)", async () => {
		const w = await world({ cookies: cookiesOf("old") });
		await w.resumeLogin();
		const late = w.api.fetchAllDynamic();
		await w.pass();
		expect(w.wire.waiting(EP.ALL_DYNAMIC_URL)).toBe(1);

		await w.scan("new");
		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		// 调用方照样拿到回应(请求层翻成 unauthorized),只是不当成这一段登录失效
		expect(await late).toMatchObject({ ok: false, code: "unauthorized", upstreamCode: -101 });

		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.flow.authState().status).toBe("logged-in");

		// 对照:新登录成立之后才发出去的请求回 -101 —— 这一段真的失效了,立刻报。
		const fresh = w.api.fetchAllDynamic();
		await w.pass();
		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		await fresh;

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
		expect(w.flow.authState().status).toBe("expired");
	});

	// 登录代在认出「确认成功」的那一拍就走,不等落盘。验红:把 `loginEstablished` 里代往前走挪到提交之后,这条红。
	it("确认成功、登录状态还在落盘的那一段里,旧请求回 -101:同样不作数(不先报一句失效再报恢复)", async () => {
		const w = await world({ cookies: cookiesOf("old") });
		await w.resumeLogin();
		const late = w.api.fetchAllDynamic();
		await w.pass();
		const finishSaving = w.secrets.holdNext();

		await w.scan("new");
		expect(w.secrets.persists).toHaveLength(0); // 提交悬在落盘上
		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		await late;

		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.flow.authState().status).not.toBe("expired");

		finishSaving();
		await w.pass();

		expect(w.secrets.persists).toHaveLength(1);
		expect(w.flow.authState().status).toBe("logged-in");
		expect(w.lost).not.toHaveBeenCalled();
	});

	it("同一段登录里连着来的 -101 只报一次(去抖还在)", async () => {
		const w = await world({ cookies: cookiesOf("old") });
		await w.resumeLogin();
		const first = w.api.fetchAllDynamic();
		const second = w.api.fetchAllDynamic();
		await w.pass();

		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		await Promise.all([first, second]);

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
	});
});

describe("④ 恢复备份换罐之后也是一段新登录", () => {
	it("旧心跳在途 → 恢复备份 → 旧心跳回 -101:换进来的登录不被判失效;它自己的探活照常落地", async () => {
		const w = await world({ cookies: cookiesOf("old"), healthCheckMs: HEALTH_MS });
		await w.resumeLogin();
		expect(w.flow.authState().status).toBe("logged-in");
		// 心跳到点,探活悬着(带的是旧罐子的 cookie)。
		w.wire.manual(EP.MYSELF_INFO_URL);
		await w.pass(HEALTH_MS);
		expect(w.wire.waiting(EP.MYSELF_INFO_URL)).toBe(1);

		// 恢复备份:宿主把罐子整个换掉,再叫一次 resumeLogin(它的探活也悬着)。
		w.jar.load(JSON.parse(cookiesOf("restored")));
		const resumed = w.resumeLogin();
		await w.pass();
		expect(w.wire.waiting(EP.MYSELF_INFO_URL)).toBe(2);

		await w.wire.answer(EP.MYSELF_INFO_URL, { code: -101 }); // 最早悬着的:旧心跳

		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.flow.authState().status).not.toBe("expired");
		expect(w.lost).not.toHaveBeenCalled();

		await w.wire.answer(EP.MYSELF_INFO_URL, { code: 0, data: { mid: 7 } });
		await resumed;

		expect(w.flow.authState().status).toBe("logged-in");
		expect(w.jar.getValue("bili_jct")).toBe("jct-restored");
	});
});

describe("⑤ 落盘失败的扫码成功照样是一段新登录", () => {
	it("上一段报过 -101 → 60 秒内重扫成功但落盘失败 → 新登录又回 -101:照样报上去", async () => {
		const w = await world({ cookies: cookiesOf("old") });
		await w.resumeLogin();
		const dead = w.api.fetchAllDynamic();
		await w.pass();
		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		await dead;
		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
		expect(w.flow.authState().status).toBe("expired");

		w.secrets.failNext(1);
		await w.scan("new");
		expect(w.host.logger.error).toHaveBeenCalledWith(
			"B站扫码登录状态保存失败",
			expect.objectContaining({ code: "unavailable", message: expect.any(String) }),
		);
		expect(w.flow.authState().status).toBe("logged-in");

		const again = w.api.fetchAllDynamic();
		await w.pass();
		await w.wire.answer(EP.ALL_DYNAMIC_URL, { code: -101 });
		await again;

		expect(w.onAuthLost).toHaveBeenCalledTimes(2);
		expect(w.flow.authState().status).toBe("expired");
	});
});
