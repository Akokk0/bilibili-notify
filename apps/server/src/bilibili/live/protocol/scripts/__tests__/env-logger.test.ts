/**
 * 真机脚本共用的 `consoleLogger`(读真登录态的脚本用它打日志)也过与服务端同一个遮法:
 * 不然脚本一打 cookie 就是明文落在终端里。按值那一遍的登记由 `openReadonlyApi` 经内存把手接上(要读真盘,
 * 这里测不了);这里钉固定形状那一遍确实在 `consoleLogger` 上。
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { consoleLogger } from "./_env.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("真机脚本的 consoleLogger", () => {
	it("msg 与参数里的凭证形状被遮,其余原样", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleLogger.info("login Bearer fakefake1234", { cookie: "Bearer fakefake5678", n: 7 });
		expect(log).toHaveBeenCalledWith("login Bearer ***", { cookie: "Bearer ***", n: 7 });
	});

	it("warn / error 也走 console 对应的口,同样遮", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		consoleLogger.warn("w Bearer fakefake1234");
		consoleLogger.error("e Bearer fakefake1234567");
		expect(warn).toHaveBeenCalledWith("w Bearer ***");
		expect(error).toHaveBeenCalledWith("e Bearer ***");
	});
});
