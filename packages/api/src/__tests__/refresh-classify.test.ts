/**
 * 回归守护 — P1 / ②3+②4:刷新失败码判别式 + loadCookies 损坏 JSON 容错。
 *
 * 不变量 1(②4 判别式):`-352/-403` = 风控/限流 = **非会话终态**(必须
 * "risk-control",绝不 "terminal" —— 否则瞬时风控被误升级为被动登出);
 * `-101` 及其它非 0 = "terminal";`0` = "ok"。这条决定 ②3 的终态清理只在
 * 真终态触发(dispose timer + 清 loginInfoLoaded + auth-lost)。
 *
 * 不变量 2:loadCookies 拿到损坏 cookiesJson 不得 reject 裸 SyntaxError 把
 * 整条启动链带崩;记 error 后按未登录继续。
 *
 * 复发点:有人把 -352 改回 terminal、或把 JSON.parse 的 try/catch 去掉。
 */

import type { Logger, ServiceContext } from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
import { describe, expect, it, vi } from "vite-plus/test";
import { BilibiliAPI, classifyRefreshCode } from "../bilibili-api";

describe("classifyRefreshCode — ②4 判别式", () => {
	it("0 → ok", () => {
		expect(classifyRefreshCode(0)).toBe("ok");
	});
	it("-352 / -403 → risk-control(风控,非终态)", () => {
		expect(classifyRefreshCode(-352)).toBe("risk-control");
		expect(classifyRefreshCode(-403)).toBe("risk-control");
	});
	it("-101 及其它非0 → terminal(会话不可恢复)", () => {
		expect(classifyRefreshCode(-101)).toBe("terminal");
		expect(classifyRefreshCode(-111)).toBe("terminal");
		expect(classifyRefreshCode(86038)).toBe("terminal");
	});
});

function makeCtx(): { ctx: ServiceContext; logger: Logger } {
	const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const ctx: ServiceContext = {
		logger,
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: () => undefined,
	};
	return { ctx, logger };
}

describe("loadCookies — 损坏 JSON 不崩启动链 (P1)", () => {
	it("非法 JSON → 不抛、记 error、保持未登录", async () => {
		const { ctx, logger } = makeCtx();
		const api = new BilibiliAPI({ serviceCtx: ctx, config: {} });
		await expect(
			api.loadCookies({ cookiesJson: "{not-json" } as unknown as CookieData),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("解析失败"));
		expect(api.isLoginInfoLoaded()).toBe(false);
	});

	it("合法 JSON 但非数组 → 同样安全降级", async () => {
		const { ctx, logger } = makeCtx();
		const api = new BilibiliAPI({ serviceCtx: ctx, config: {} });
		await expect(
			api.loadCookies({ cookiesJson: '{"a":1}' } as unknown as CookieData),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("解析失败"));
		expect(api.isLoginInfoLoaded()).toBe(false);
	});
});
