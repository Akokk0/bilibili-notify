/**
 * 安全守护 — 日志调用的入口打码一次,stdout(pino)、环形缓冲 / 归档(钩子)三处出口看到的是同一份。
 *
 * 不变量:`logger.<level>(msg, ...args)` 里的凭证明文,不出现在 pino 写给 destination 的那一行,
 * 也不出现在交给 `setLogHook` 的条目里;作为参数传进来的 `Error` 打码后仍带 message / stack。
 * 复发点:打码退回到钩子那一头(stdout 又是明文)/ `Error` 经打码变成 `{}`。
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import type { LogEntry } from "../../ws/types.js";
import { createNodeServiceContext } from "../service-context.js";

function harness() {
	const lines: string[] = [];
	const destination = new Writable({
		write(chunk, _enc, cb) {
			lines.push(String(chunk));
			cb();
		},
	});
	const seen: LogEntry[] = [];
	const ctx = createNodeServiceContext({
		name: "svc",
		level: "debug",
		pretty: false,
		destination,
		onLog: (e) => seen.push(e),
	});
	return { ctx, lines, seen };
}

describe("createNodeServiceContext — 入口打码", () => {
	it("msg 与字符串 / 对象参数里的凭证:stdout 与钩子拿到的都是打过码的", () => {
		const { ctx, lines, seen } = harness();
		ctx.logger.info("cookie SESSDATA=abcdefgh123", "bili_jct=jjjjjjjj77", {
			h: "Bearer tttttttt.8888",
		});

		const stdout = lines.join("");
		expect(stdout).toContain("SESSDATA=***");
		expect(stdout).not.toContain("abcdefgh123");
		expect(stdout).not.toContain("jjjjjjjj77");
		expect(stdout).not.toContain("tttttttt.8888");

		expect(seen).toHaveLength(1);
		const hooked = JSON.stringify(seen[0]);
		expect(hooked).toContain("SESSDATA=***");
		expect(hooked).not.toContain("abcdefgh123");
		expect(hooked).not.toContain("jjjjjjjj77");
		expect(hooked).not.toContain("tttttttt.8888");
	});

	it("msg 里带 %s 占位时,pino 会把参数拼进 stdout 那一行:拼进去的也是打过码的", () => {
		const { ctx, lines } = harness();
		ctx.logger.info("dump %s", "SESSDATA=interp1234");

		const stdout = lines.join("");
		expect(stdout).toContain("dump SESSDATA=***");
		expect(stdout).not.toContain("interp1234");
	});

	it("Error 参数:钩子收到带 message 的普通对象(已打码),不是 {}", () => {
		const { ctx, seen } = harness();
		ctx.logger.error("拉动态失败", new Error("boom SESSDATA=zzzzzzzz9"));

		const arg = seen[0]?.args[0] as { name: string; message: string; stack: string };
		expect(arg.name).toBe("Error");
		expect(arg.message).toBe("boom SESSDATA=***");
		expect(arg.stack).toContain("SESSDATA=***");
		expect(arg.stack).not.toContain("zzzzzzzz9");
	});

	it("Error 的 cause 与自带的可枚举属性也保留并打码", () => {
		const { ctx, seen } = harness();
		const err = Object.assign(
			new TypeError("outer", { cause: new Error("inner bili_jct=cccccccc1") }),
			{
				code: "E_X",
			},
		);
		ctx.logger.warn("w", err);

		const arg = seen[0]?.args[0] as {
			name: string;
			code: string;
			cause: { message: string };
		};
		expect(arg.name).toBe("TypeError");
		expect(arg.code).toBe("E_X");
		expect(arg.cause.message).toBe("inner bili_jct=***");
	});

	it("打码本身抛错(参数带会抛的 getter)不弄断日志:钩子与 stdout 照样收到这一条", () => {
		const { ctx, lines, seen } = harness();
		const hostile = {
			get boom(): string {
				throw new Error("getter exploded");
			},
		};
		expect(() => ctx.logger.info("still logs", hostile)).not.toThrow();
		expect(lines.join("")).toContain("still logs");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.msg).toBe("still logs");
	});
});
