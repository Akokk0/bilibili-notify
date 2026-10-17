/**
 * 回归守护 — P1 / ②3+②4:续期的失败处置 + 续期链的闸与提交。
 *
 * 不变量 1(②4,3b-18 起读请求层翻好的标准码):**只有 `-101`(unauthorized)是会话终态**;风控(`-352` / `-412` 等)、
 * `-403`、没对照的码(`-111`、`86038`……)、回应形状不对都是一时失败,下个小时再试,绝不登出。终态清理只在真终态触发
 * (dispose timer + 清 loginInfoLoaded + auth-lost);死会话靠普通请求撞 `-101` 时清。
 *
 * 不变量 2(3a-10·26):续期链进行中罐子不许自动存中间状态。闸**只在两种情况下放**:提交成功,或这一串根本没走到
 * 会改罐子的那一步(或被取代)。刷新 POST 走过之后的任何失败(确认遇风控、找不到新 `bili_jct`、提交失败)都得把闸
 * 留着 —— 放开的话盘上悄悄变成「新 cookie + 旧令牌」,类型与别的测试全绿。
 *
 * 复发点:有人把 -101 以外的码又当成终态;把 `checkIfTokenNeedRefresh` 的 `finally` 改成一律放闸;把令牌现读改回闭包。
 */

import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { makeApi, makeServiceContext } from "./support/make-api";

function makeHost() {
	const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	return makeServiceContext(logger);
}

/** 让已经排上的微任务与回调都跑完(假时钟不碰真定时器,这里用真的一拍)。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("stop — 作废在途的 cookie 刷新", () => {
	it("stop 之后,在途那轮等到回应也不再往下刷(关停返回后不许再回写 cookie)", async () => {
		const { serviceCtx } = makeHost();
		const { api } = await makeApi({ serviceCtx });
		let answer!: (info: unknown) => void;
		vi.spyOn(
			api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		).mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const importKey = vi.spyOn(globalThis.crypto.subtle, "importKey");

		const running = api.checkIfTokenNeedRefresh("refresh-token", "csrf");
		api.stop();
		answer({ code: 0, data: { refresh: true, timestamp: Date.now() } });
		await running;

		// 刷新链的下一步就是拿公钥算 correspond path;走到这里说明这轮没被作废。
		expect(importKey).not.toHaveBeenCalled();
		importKey.mockRestore();
	});
});

type Client = {
	get: (url: string) => Promise<unknown>;
	postForm: (url: string, body: Record<string, string>) => Promise<unknown>;
};

/**
 * ⑭a 起 cookie 罐只有一个、换号时原地换(`load()` / `clear()`),客户端也一直是同一个。刷新链里每跨一次 await 都要
 * 比对登录代(`generation`)—— 漏一处,换号之后这条旧链还会接着发请求:带的是新号的 cookie,回来的 `Set-Cookie` 会被当成新会话的收进罐子
 * (请求是换号之后才发的,罐子的换号计数对得上,`HttpClient` 的在途守卫挡不住)。从前每次换号都重建罐子与客户端,旧链手里
 * 握着旧罐子,这个缺口不咬人。
 */
describe("刷新链跨 await 之后都比对登录代 —— 换号以后旧链不再发请求", () => {
	async function startChain() {
		const { serviceCtx } = makeHost();
		const { api } = await makeApi({ serviceCtx });
		vi.spyOn(
			api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		).mockResolvedValue({ code: 0, data: { refresh: true, timestamp: Date.now() } });
		const client = (api as unknown as { client: Client }).client;
		return { api, client };
	}

	it("加密那几步期间会话被清掉 → 不再去取 correspond 页", async () => {
		const { api, client } = await startChain();
		const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
		const encrypt = vi
			.spyOn(globalThis.crypto.subtle, "encrypt")
			.mockImplementation(async (...args: Parameters<typeof realEncrypt>) => {
				await api.clearCookies();
				return realEncrypt(...args);
			});
		const get = vi.spyOn(client, "get").mockResolvedValue('<div id="1-name">rc</div>');
		const postForm = vi.spyOn(client, "postForm").mockResolvedValue({ code: 0, data: {} });

		await api.checkIfTokenNeedRefresh("refresh-token", "csrf").catch(() => {});

		expect(encrypt).toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		expect(postForm).not.toHaveBeenCalled();
		encrypt.mockRestore();
	});

	it("取 correspond 页期间会话被清掉 → 不再发刷新请求", async () => {
		const { api, client } = await startChain();
		const get = vi.spyOn(client, "get").mockImplementation(async () => {
			await api.clearCookies();
			return '<div id="1-name">rc</div>';
		});
		const postForm = vi.spyOn(client, "postForm").mockResolvedValue({ code: 0, data: {} });

		await api.checkIfTokenNeedRefresh("refresh-token", "csrf").catch(() => {});

		expect(get).toHaveBeenCalledTimes(1);
		expect(postForm).not.toHaveBeenCalled();
	});
});

/**
 * 关停(切片 ③)。开机的恢复与每小时的定时器都会发起一轮刷新检查 —— 刷新链最后一步把新 cookie 与新令牌提交落盘。
 * 发出去不管的话,关停对它一无所知,写道关门时它可能还没落完;登记进 `ctx.track()`,关停才等得到它。
 */
describe("triggerRefreshCheck — 登记进 track", () => {
	const COOKIES = JSON.stringify([
		{ key: "SESSDATA", value: "s", domain: ".bilibili.com", path: "/", secure: true },
		{ key: "bili_jct", value: "csrf", domain: ".bilibili.com", path: "/", secure: true },
	]);

	it("恢复登录发起的那轮刷新登记进 track:刷新链走完它才落定", async () => {
		const host = makeHost();
		const { api, loadSession } = await makeApi({ serviceCtx: host.serviceCtx });
		let finish!: () => void;
		const running = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const check = vi.spyOn(api, "checkIfTokenNeedRefresh").mockReturnValue(running);

		await loadSession(COOKIES, "rt");

		expect(check).toHaveBeenCalledTimes(1);
		expect(host.tracked).toHaveLength(1);
		let settled = false;
		void host.tracked[0]?.then(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);

		finish();
		await host.tracked[0];
		expect(settled).toBe(true);
	});

	it("刷新检查抛错:登记进去的这件事不拒,记一条 warn,并放开「已在刷新」的闸", async () => {
		const host = makeHost();
		const { api, loadSession } = await makeApi({ serviceCtx: host.serviceCtx });
		vi.spyOn(api, "checkIfTokenNeedRefresh").mockRejectedValue(new Error("network down"));

		await loadSession(COOKIES, "rt");

		await expect(host.tracked[0]).resolves.toBeUndefined();
		expect(host.logger.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
		// 闸放开了:再来一次(重新恢复登录)照样发起新的一轮。
		await loadSession(COOKIES, "rt");
		expect(host.tracked).toHaveLength(2);
	});

	it("存储里没有令牌:开机不触发刷新,也不起每小时的定时器", async () => {
		/** 开机之后让攒着的那一次自动存走完:剩下还挂着的定时器就只可能是每小时那一个。 */
		async function timersAfterBoot(token?: string) {
			const host = makeHost();
			const { api, loadSession } = await makeApi({ serviceCtx: host.serviceCtx });
			const check = vi.spyOn(api, "checkIfTokenNeedRefresh").mockResolvedValue();
			await loadSession(COOKIES, token);
			host.advance(3_000);
			await settle();
			return { host, check, pending: host.pendingTimers() };
		}

		// 对照:有令牌,每小时的定时器就挂在那里(没有这条对照,「没挂」可能只是假时钟根本没排它)。
		const withToken = await timersAfterBoot("rt");
		expect(withToken.pending).toBe(1);

		const noToken = await timersAfterBoot();
		expect(noToken.pending).toBe(0);
		noToken.host.advance(3_600_000 * 2);
		expect(noToken.check).not.toHaveBeenCalled();
		expect(noToken.host.tracked).toHaveLength(0);
	});

	it("令牌触发时现读:定时器起来之后令牌没了,到点不触发", async () => {
		const host = makeHost();
		const { api, ctx, loadSession } = await makeApi({ serviceCtx: host.serviceCtx });
		const check = vi.spyOn(api, "checkIfTokenNeedRefresh").mockResolvedValue();
		await loadSession(COOKIES, "rt");
		await host.tracked[0];
		expect(check).toHaveBeenCalledTimes(1);

		// 对照:令牌还在,推一小时 → 到点触发一次。
		host.advance(3_600_000);
		await host.tracked[1];
		expect(check).toHaveBeenCalledTimes(2);

		await ctx.secrets.delete("refreshToken");
		host.advance(3_600_000);

		// 定时器照样到点了,但现读不到令牌:没有新的触发。
		expect(check).toHaveBeenCalledTimes(2);
		expect(host.tracked).toHaveLength(2);
	});
});

/**
 * 续期链:每一类出口对三件事的处置 —— 盘上那一袋、还有没有闸、续期成功的回调(`onCookiesRefreshed`)叫没叫。
 *
 * 「闸还在不在」的观察办法:让罐子变一下、把假时钟推过 2 秒、数落盘次数。每条「不写」的断言后面都跟一条「放闸 / 到点
 * 之后写了」的对照(假定时器下定时器根本没起也会让「不写」通过)。落盘是内存版把手记的一笔(`secrets.persists`),
 * 起始那袋是 `http.cookies`(C0)+ `refreshToken`(T0)。
 */
describe("续期链:闸与提交", () => {
	const C0 = JSON.stringify([
		{ key: "SESSDATA", value: "sess0", domain: ".bilibili.com", path: "/", secure: true },
		{ key: "bili_jct", value: "jct0", domain: ".bilibili.com", path: "/", secure: true },
		{ key: "buvid3", value: "b3", domain: ".bilibili.com", path: "/", secure: true },
	]);

	interface Script {
		/** `fetchCookieInfo` 的回应。 */
		probe?: unknown;
		/** correspond 页。 */
		page?: string;
		/** 刷新 POST:默认让罐子收到新 cookie、回新令牌 T1。 */
		refresh?: (jar: SetJar) => unknown;
		/** 确认 POST。 */
		confirm?: (jar: SetJar) => unknown;
		/** 探测那次请求本身抛错(给了它就不看 `probe`)。 */
		probeThrows?: Error;
	}
	type SetJar = { setFromSetCookie(line: string, url: string): void; clear(): void };

	async function world(script: Script = {}) {
		const host = makeHost();
		const onCookiesRefreshed = vi.fn();
		const onAuthLost = vi.fn();
		const w = await makeApi({
			serviceCtx: host.serviceCtx,
			callbacks: { onCookiesRefreshed, onAuthLost },
			secrets: { "http.cookies": C0, refreshToken: "T0" },
		});
		const fetchCookieInfo = vi.spyOn(
			w.api as unknown as { fetchCookieInfo: () => Promise<unknown> },
			"fetchCookieInfo",
		);
		if (script.probeThrows) fetchCookieInfo.mockRejectedValue(script.probeThrows);
		else
			fetchCookieInfo.mockResolvedValue(
				script.probe ?? { code: 0, data: { refresh: true, timestamp: Date.now() } },
			);
		const client = (w.api as unknown as { client: Client }).client;
		vi.spyOn(client, "get").mockResolvedValue(script.page ?? '<div id="1-name">rc</div>');
		const refreshBodies: Array<Record<string, string>> = [];
		const defaultRefresh = (jar: SetJar) => {
			jar.setFromSetCookie(
				"SESSDATA=sess1; Domain=.bilibili.com; Path=/; Secure",
				"https://www.bilibili.com",
			);
			jar.setFromSetCookie(
				"bili_jct=jct1; Domain=.bilibili.com; Path=/; Secure",
				"https://www.bilibili.com",
			);
			return { code: 0, message: "0", data: { refresh_token: "T1" } };
		};
		let call = 0;
		const postForm = vi.spyOn(client, "postForm").mockImplementation(async (_url, body) => {
			call += 1;
			if (call === 1) {
				refreshBodies.push(body);
				return (script.refresh ?? defaultRefresh)(w.jar);
			}
			return (script.confirm ?? (() => ({ code: 0 })))(w.jar);
		});
		return { ...w, host, onCookiesRefreshed, onAuthLost, postForm, refreshBodies };
	}
	type World = Awaited<ReturnType<typeof world>>;

	/** 让罐子里多一条零散 cookie,把时钟推过 2 秒:罐子的变化落盘了几次。 */
	async function savesAfterTouch(w: World): Promise<number> {
		const before = w.secrets.persists.length;
		w.jar.setFromSetCookie(
			`stray${before}=${Math.random()}; Domain=.bilibili.com; Path=/`,
			"https://www.bilibili.com",
		);
		w.host.advance(2_500);
		await settle();
		return w.secrets.persists.length - before;
	}

	const run = (w: World, generation?: number) =>
		generation === undefined
			? w.api.checkIfTokenNeedRefresh("T0", "jct0")
			: w.api.checkIfTokenNeedRefresh("T0", "jct0", generation);

	it("成功:一次写里是新 cookie + 新令牌;事件在提交之后发;之后零散变化照常自动存", async () => {
		const w = await world();
		// 事件发出去的那一刻,盘上必须已经是新的一对(回调里抛的断言会被链吞掉,所以先记下来、事后再断言)。
		let persistsAtEvent = -1;
		w.onCookiesRefreshed.mockImplementation(() => {
			persistsAtEvent = w.secrets.persists.length;
		});

		await run(w);

		expect(w.secrets.persists).toHaveLength(1);
		const bag = w.secrets.persists[0] as Map<string, unknown>;
		expect(bag.get("refreshToken")).toBe("T1");
		expect(String(bag.get("http.cookies"))).toContain("sess1");
		expect(String(bag.get("http.cookies"))).toContain("jct1");
		expect(w.onCookiesRefreshed).toHaveBeenCalledTimes(1);
		expect(persistsAtEvent).toBe(1);
		expect(w.ctx.secrets.get("refreshToken")).toBe("T1");
		// 闸放了:罐子再变,到点照常存。
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("确认那一步遇风控:罐里已是新 cookie、新令牌没存 —— 盘上不动,罐子再变也不落盘;提交成功之后才放", async () => {
		const w = await world({ confirm: () => ({ code: -352 }) });

		await run(w).catch(() => {});

		expect(w.secrets.persists).toHaveLength(0);
		expect(w.onCookiesRefreshed).not.toHaveBeenCalled();
		// 闸留着:零散变化到点也不写(「新 cookie + 旧令牌」不许落盘)。
		expect(await savesAfterTouch(w)).toBe(0);
		expect(await savesAfterTouch(w)).toBe(0);
		// 对照:提交成功把留着的闸放掉,之后到点写了。
		expect((await w.api.commitLogin("T1")).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("刷新那一步遇风控:保守当罐子动过,闸留着", async () => {
		const w = await world({ refresh: () => ({ code: -352, message: "risk" }) });

		await run(w).catch(() => {});

		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin("T0")).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	// 只有 -101(请求层翻成 unauthorized)才是会话终态;别的码(含没对照的)都当一时失败,下个小时再试。
	it("刷新那一步回 -412:不登出、auth-lost 不发、罐子不清、闸留着、记一条 warn", async () => {
		const w = await world({ refresh: () => ({ code: -412, message: "被拦截" }) });

		await run(w).catch(() => {});

		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.jar.serialize()).not.toEqual([]);
		expect(w.host.logger.warn).toHaveBeenCalledWith(expect.stringContaining("-412"));
		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin("T0")).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("刷新那一步回没对照的码(-111):不登出,闸留着,下个小时的定时触发照样再试", async () => {
		const w = await world({ refresh: () => ({ code: -111, message: "csrf 校验失败" }) });

		await run(w).catch(() => {});

		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.jar.serialize()).not.toEqual([]);
		expect(await savesAfterTouch(w)).toBe(0);

		// 下一轮没被"会话已终态"拦住:又往下发了 POST(world 的脚本只认第一次,后面的回应是默认值,所以只看总次数多了)。
		const before = w.postForm.mock.calls.length;
		await run(w).catch(() => {});
		expect(w.postForm.mock.calls.length).toBeGreaterThan(before);
	});

	it("确认那一步回 86038(没对照的码):不登出,闸留着", async () => {
		const w = await world({ confirm: () => ({ code: 86038 }) });

		await run(w).catch(() => {});

		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.jar.serialize()).not.toEqual([]);
		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin("T1")).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("探测回 -412:跳过本轮(记 warn),不登出、没有刷新 POST,闸放了", async () => {
		const w = await world({ probe: { code: -412, message: "被拦截" } });

		await run(w);

		expect(w.postForm).not.toHaveBeenCalled();
		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.host.logger.warn).toHaveBeenCalledWith(expect.stringContaining("-412"));
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("刷新后罐里找不到新 bili_jct:动过罐子,闸留着", async () => {
		const w = await world({
			refresh: (jar) => {
				jar.clear();
				return { code: 0, message: "0", data: { refresh_token: "T1" } };
			},
		});

		await run(w).catch(() => {});

		expect(w.postForm).toHaveBeenCalledTimes(1); // 没走到确认
		expect(w.secrets.persists).toHaveLength(0);
		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin("T0")).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("提交失败:记 error、事件不发、闸留着;下一次提交成功才放", async () => {
		const w = await world();
		w.secrets.failNext(1);

		await run(w);

		expect(w.host.logger.error).toHaveBeenCalledWith(expect.stringContaining("存盘失败"));
		expect(w.onCookiesRefreshed).not.toHaveBeenCalled();
		expect(w.secrets.persists).toHaveLength(0);
		// 闸留着(失败那一次已经用掉了):到点也不写 —— 否则盘上是「新 cookie + 旧令牌」。
		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin("T1")).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("探测遇风控 / 用不着刷新:没动罐子,闸放了,零散变化到点照常存", async () => {
		for (const probe of [
			{ code: -352 },
			{ code: 0, data: { refresh: false } },
			{ code: 0, data: undefined },
		]) {
			const w = await world({ probe });
			await run(w).catch(() => {});
			expect(w.postForm).not.toHaveBeenCalled();
			expect(w.onCookiesRefreshed).not.toHaveBeenCalled();
			expect(await savesAfterTouch(w)).toBe(1);
		}
	});

	it("探测那次请求抛错:跳过本轮(不强制刷新、不抛),没有刷新 POST,闸放了,零散变化到点照常存", async () => {
		const w = await world({ probeThrows: new Error("network down") });

		await run(w); // 探测失败在链内接住,不往外抛

		expect(w.postForm).not.toHaveBeenCalled();
		expect(w.onCookiesRefreshed).not.toHaveBeenCalled();
		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.host.logger.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("correspond 页解析不出:没动罐子(只读了一页),闸放了", async () => {
		const w = await world({ page: "<html></html>" });

		await run(w).catch(() => {});

		expect(w.postForm).not.toHaveBeenCalled();
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("进门就被取代:还没拿闸,零散变化照常存,不提交", async () => {
		const w = await world();

		await run(w, -1);

		expect(w.postForm).not.toHaveBeenCalled();
		expect(w.secrets.persists).toHaveLength(0);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("探测回 -101(会话终态):罐子被清、盘上留着上一对;终态那道闸留着,这条链自己的放了", async () => {
		const w = await world({ probe: { code: -101 } });

		await run(w);

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
		expect(w.secrets.persists).toHaveLength(0);
		expect(w.jar.serialize()).toEqual([]);
		// 空罐不许自动存成「空罐 + 旧令牌」。
		expect(await savesAfterTouch(w)).toBe(0);
		// 只剩 terminateSession 那一道:一次提交成功就全放了(链自己那道没有残留)。
		expect((await w.api.commitLogin(undefined)).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("刷新回终态码:terminateSession 留一道,这条链的放了", async () => {
		const w = await world({ refresh: () => ({ code: -101, message: "dead" }) });

		await run(w).catch(() => {});

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin(undefined)).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("确认回终态码:同上", async () => {
		const w = await world({ confirm: () => ({ code: -101 }) });

		await run(w).catch(() => {});

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
		expect(await savesAfterTouch(w)).toBe(0);
		expect((await w.api.commitLogin(undefined)).ok).toBe(true);
		expect(await savesAfterTouch(w)).toBe(1);
	});

	// 去抖按登录代记(`Api.authLostReported`)。验红:把 `fireAuthLost` 里比代的那一半去掉(只按时间去抖),第二条红
	// (第一条是对照,恒绿)。
	it("-101 的 60 秒去抖:同一段登录里连着来的只报一次(对照)", async () => {
		const w = await world();
		const fire = () =>
			(w.api as unknown as { maybeFireAuthLost(code: number): void }).maybeFireAuthLost(-101);

		fire();
		fire();

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
	});

	it("一次 -101 后 60 秒内重新登录成功(提交成功)、新会话又回 -101:照样报上去", async () => {
		const w = await world();
		const fire = () =>
			(w.api as unknown as { maybeFireAuthLost(code: number): void }).maybeFireAuthLost(-101);
		fire();
		expect(w.onAuthLost).toHaveBeenCalledTimes(1);

		// 重新登录 = 扫码确认成功走的那个口(一段新登录成立);光是一次提交(续期、登出也提交)不算。
		expect((await w.api.commitScannedLogin("T1")).ok).toBe(true);
		fire();

		expect(w.onAuthLost).toHaveBeenCalledTimes(2);
	});

	it("续期成功(同一段登录里的一次提交)不开新的去抖窗口", async () => {
		const w = await world();
		const fire = () =>
			(w.api as unknown as { maybeFireAuthLost(code: number): void }).maybeFireAuthLost(-101);
		fire();

		expect((await w.api.commitLogin("T1")).ok).toBe(true);
		fire();

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
	});

	// 与上一条成对:光是一次提交,成也好败也好,都不是「一段新登录」。验红:`commitLogin` 的失败那一支里把去抖的记账
	// 清掉(`authLostReported = undefined`),这条红。它**不**钉「落盘失败的扫码算不算新一段」—— 那个答案是「算」,
	// 由 `login-session-boundary.test.ts` ⑤ 钉着(扫码走的是 `commitScannedLogin`,代在落盘之前就走了)。
	it("同一段登录里的一次提交失败了(续期、登出的落盘失败):同样不开新的去抖窗口", async () => {
		const w = await world();
		const fire = () =>
			(w.api as unknown as { maybeFireAuthLost(code: number): void }).maybeFireAuthLost(-101);
		fire();

		w.secrets.failNext(1);
		expect((await w.api.commitLogin("T1")).ok).toBe(false);
		fire();

		expect(w.onAuthLost).toHaveBeenCalledTimes(1);
	});

	it("刷新那一步期间被取代(换号 / 登出):丢弃,不提交,闸放了", async () => {
		const w = await world({
			refresh: () => {
				// 刷新往返期间用户登出了:登录代加一,罐子归新状态。
				void w.api.clearCookies();
				return { code: 0, message: "0", data: { refresh_token: "T1" } };
			},
		});

		await run(w).catch(() => {});

		expect(w.postForm).toHaveBeenCalledTimes(1);
		expect(w.secrets.persists).toHaveLength(0);
		expect(w.onCookiesRefreshed).not.toHaveBeenCalled();
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("确认那一步期间被取代:不回写持久化、事件不发,闸放了", async () => {
		const w = await world({
			confirm: () => {
				void w.api.clearCookies();
				return { code: 0 };
			},
		});

		await run(w).catch(() => {});

		expect(w.postForm).toHaveBeenCalledTimes(2);
		expect(w.secrets.persists).toHaveLength(0);
		expect(w.ctx.secrets.get("refreshToken")).toBe("T0");
		expect(w.onCookiesRefreshed).not.toHaveBeenCalled();
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("确认那一步期间被取代、确认回终态码:被取代的链不看码 —— 不清别人的罐子、不发 auth-lost、不留新闸", async () => {
		const w = await world({
			confirm: () => {
				// 确认往返期间链被取代(这里用 stop():登录代加一,罐子不动);罐里是此刻活着的会话,不是这条链的。
				w.api.stop();
				return { code: -101 };
			},
		});

		await run(w).catch(() => {});

		expect(w.postForm).toHaveBeenCalledTimes(2);
		expect(w.onAuthLost).not.toHaveBeenCalled();
		expect(w.jar.getValue("bili_jct")).toBe("jct1"); // 罐子没被清
		expect(w.secrets.persists).toHaveLength(0);
		// 没留新闸:零散变化到点照常存(终态那道闸若被留下,这里是 0)。
		expect(await savesAfterTouch(w)).toBe(1);
	});

	it("续期成功之后:下一次定时触发带的是新令牌,不是开机那一刻的旧令牌", async () => {
		const w = await world();

		await w.api.resumeStoredLogin(); // 开机:触发一次续期、起每小时的定时器
		await Promise.all(w.host.tracked);
		expect(w.refreshBodies.map((b) => b.refresh_token)).toEqual(["T0"]);
		expect(w.ctx.secrets.get("refreshToken")).toBe("T1");

		// 下一小时:定时器到点,现读到的是新令牌。第二次刷新的 POST 在这里换成回 -352(风控,这一轮不会走到提交),这里只看带的令牌。
		w.postForm.mockImplementation(async (_url, body) => {
			w.refreshBodies.push(body);
			return { code: -352, message: "risk" };
		});
		w.host.advance(3_600_000);
		// 等第二轮刷新链走完,而不是等一段时间:链里有真的 RSA(`crypto.subtle` 的 importKey / encrypt,在线程池里算),
		// 耗时随机器负载变,固定睡几毫秒会偶发赶不上。定时器到点那一刻 `triggerRefreshCheck` 已把这一轮登记进 track,
		// 等 `tracked` 里的 promise 全落定就是等确定的事件(第一轮的早已落定)。
		await Promise.all(w.host.tracked);

		expect(w.refreshBodies.map((b) => b.refresh_token)).toEqual(["T0", "T1"]);
	});
});
