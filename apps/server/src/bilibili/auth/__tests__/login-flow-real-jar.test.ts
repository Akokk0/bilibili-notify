/**
 * 扫码登录那条路,用**真的** cookie 罐子与真的存储规矩(`makeApi` 拼的真上下文,落盘是内存版记一笔)走一遍:
 * `login-flow.test.ts` 用的是假 `Api`,只看得到「拿闸 / 放闸 / 提交」被叫了,看不到罐子真的会不会被零散的自动存写出去。
 *
 * - 扫码进行中罐子变了(登录回应的 Set-Cookie 先进罐子、令牌后到):过了攒的时长也不许落盘;
 * - 登录成功:恰好一次写,里面 cookie 与令牌都在;
 * - 登录成功但提交失败:盘上还是上一对,之后罐子再变也不落盘(留着的闸),下一次提交成功才放。
 *
 * 不连 B 站:二维码、轮询、账号探测都换成替身。
 */

import type { Logger, MessageBus } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { COOKIE_SAVE_DELAY_MS } from "../../../integrations/http";
import { makeApi, makeServiceContext } from "../../api/__tests__/support/make-api";
import { LoginFlow } from "../login-flow";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function scanWorld() {
	const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const host = makeServiceContext(logger);
	const w = await makeApi({ serviceCtx: host.serviceCtx });
	const bus: MessageBus = { emit: vi.fn(), on: vi.fn(() => ({ dispose: vi.fn() })) };
	const flow = new LoginFlow({ serviceCtx: host.serviceCtx, api: w.api, bus, healthCheckMs: 0 });

	vi.spyOn(w.api, "fetchLoginQrCode").mockResolvedValue({
		code: 0,
		data: { url: "https://qr", qrcode_key: "k" },
	} as never);
	// 默认:还在等扫码。
	const status = vi
		.spyOn(w.api, "fetchLoginStatus")
		.mockResolvedValue({ code: 0, data: { code: 86101 } } as never);
	vi.spyOn(w.api, "fetchMyselfInfo").mockResolvedValue({ code: 0, data: { mid: 42 } } as never);
	vi.spyOn(w.api, "fetchUserCard").mockResolvedValue({
		code: 0,
		data: { card: { mid: "42" } },
	} as never);

	/** 下一次轮询回「扫码成功」:登录回应的 Set-Cookie 先进罐子,再带着令牌回来。 */
	const scanSucceeds = () =>
		status.mockImplementation((async () => {
			w.jar.setFromSetCookie(
				"SESSDATA=sess-new; Domain=.bilibili.com; Path=/; Secure",
				"https://passport.bilibili.com",
			);
			w.jar.setFromSetCookie(
				"bili_jct=jct-new; Domain=.bilibili.com; Path=/; Secure",
				"https://passport.bilibili.com",
			);
			return { code: 0, data: { code: 0, refresh_token: "rt-new" } };
		}) as never);

	/** 推过 `ms`,让到点的轮询 / 自动存与它们排上的后续都走完。 */
	const pass = async (ms: number) => {
		host.advance(ms);
		await settle();
		await Promise.all(host.tracked);
	};

	/** 罐子里多一条零散 cookie,过了攒的时长:落了几次盘。 */
	const savesAfterTouch = async (): Promise<number> => {
		const before = w.secrets.persists.length;
		w.jar.setFromSetCookie(
			`stray${before}=${Math.random()}; Domain=.bilibili.com; Path=/`,
			"https://www.bilibili.com",
		);
		await pass(COOKIE_SAVE_DELAY_MS + 500);
		return w.secrets.persists.length - before;
	};

	return { ...w, host, flow, scanSucceeds, pass, savesAfterTouch };
}

describe("扫码登录(真罐子)", () => {
	it("扫码进行中罐子变了:过了攒的时长也不落盘;登录成功恰好一次写,cookie 与令牌都在,闸放了", async () => {
		const w = await scanWorld();
		await w.flow.beginLogin(async () => "data:url");

		// 等扫码的这段:罐子变了(Set-Cookie 先到的样子),攒的时长过了也不写。
		w.jar.setFromSetCookie(
			"early=1; Domain=.bilibili.com; Path=/",
			"https://passport.bilibili.com",
		);
		await w.pass(COOKIE_SAVE_DELAY_MS + 500);
		expect(w.secrets.persists).toHaveLength(0);

		// 扫码成功:提交是同一次原子写。
		w.scanSucceeds();
		await w.pass(1_000);

		expect(w.secrets.persists).toHaveLength(1);
		const bag = w.secrets.persists[0] as Map<string, unknown>;
		expect(String(bag.get("http.cookies"))).toContain("sess-new");
		expect(String(bag.get("http.cookies"))).toContain("jct-new");
		expect(bag.get("refreshToken")).toBe("rt-new");
		// 闸放了:之后罐子再变,到点照常存。
		expect(await w.savesAfterTouch()).toBe(1);
	});

	it("扫码成功但提交失败:盘上不动,之后罐子再变也不落盘;下一次提交成功才放", async () => {
		const w = await scanWorld();
		await w.flow.beginLogin(async () => "data:url");
		w.secrets.failNext(1);
		w.scanSucceeds();

		await w.pass(1_000);

		expect(w.host.logger.error).toHaveBeenCalledWith(expect.stringContaining("保存登录状态失败"));
		expect(w.secrets.persists).toHaveLength(0);
		// 扫码那道闸已放,但提交失败留下了新的一道:零散变化到点也不写(「新 cookie + 旧令牌」不许落盘)。
		expect(await w.savesAfterTouch()).toBe(0);
		expect(await w.savesAfterTouch()).toBe(0);
		// 对照:提交成功之后,闸放了,到点写了。
		expect((await w.api.commitLogin("rt-new")).ok).toBe(true);
		expect(await w.savesAfterTouch()).toBe(1);
	});
});
