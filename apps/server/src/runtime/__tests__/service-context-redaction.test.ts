/**
 * 安全守护 — 日志调用的入口打码一次,stdout(pino)、环形缓冲 / 归档(钩子)三处出口看到的是同一份。
 *
 * 不变量:`logger.<level>(msg, ...args)` 里的凭证明文,不出现在 pino 写给 destination 的那一行,
 * 也不出现在交给 `setLogHook` 的条目里;作为参数传进来的 `Error` 打码后仍带 message / stack。
 * 复发点:打码退回到钩子那一头(stdout 又是明文)/ `Error` 经打码变成 `{}`。
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { createValueRedactor } from "../../logs/value-redactor.js";
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
		ctx.logger.info("cookie Bearer abcdefgh123", "Bearer jjjjjjjj77", {
			h: "Bearer tttttttt.8888",
		});

		const stdout = lines.join("");
		expect(stdout).toContain("Bearer ***");
		expect(stdout).not.toContain("abcdefgh123");
		expect(stdout).not.toContain("jjjjjjjj77");
		expect(stdout).not.toContain("tttttttt.8888");

		expect(seen).toHaveLength(1);
		const hooked = JSON.stringify(seen[0]);
		expect(hooked).toContain("Bearer ***");
		expect(hooked).not.toContain("abcdefgh123");
		expect(hooked).not.toContain("jjjjjjjj77");
		expect(hooked).not.toContain("tttttttt.8888");
	});

	it("msg 里带 %s 占位时,pino 会把参数拼进 stdout 那一行:拼进去的也是打过码的", () => {
		const { ctx, lines } = harness();
		ctx.logger.info("dump %s", "Bearer interp1234");

		const stdout = lines.join("");
		expect(stdout).toContain("dump Bearer ***");
		expect(stdout).not.toContain("interp1234");
	});

	it("Error 参数:钩子收到带 message 的普通对象(已打码),不是 {}", () => {
		const { ctx, seen } = harness();
		ctx.logger.error("拉动态失败", new Error("boom Bearer zzzzzzzz9"));

		const arg = seen[0]?.args[0] as { name: string; message: string; stack: string };
		expect(arg.name).toBe("Error");
		expect(arg.message).toBe("boom Bearer ***");
		expect(arg.stack).toContain("Bearer ***");
		expect(arg.stack).not.toContain("zzzzzzzz9");
	});

	it("Error 的 cause 与自带的可枚举属性也保留并打码", () => {
		const { ctx, seen } = harness();
		const err = Object.assign(
			new TypeError("outer", { cause: new Error("inner Bearer cccccccc1") }),
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
		expect(arg.cause.message).toBe("inner Bearer ***");
	});

	it("后续参数进 stdout:Error 的 message 在那一行里(args 字段),不再只剩一句 failed", () => {
		const { ctx, lines } = harness();
		ctx.logger.error("POST /api/targets failed", new Error("boom"));

		const row = JSON.parse(lines.join("")) as {
			msg: string;
			args: Array<{ name: string; message: string }>;
		};
		expect(row.msg).toBe("POST /api/targets failed");
		expect(row.args[0]?.name).toBe("Error");
		expect(row.args[0]?.message).toBe("boom");
	});

	it("后续参数写进 stdout 时也是打过码的(Error 与对象)", () => {
		const { ctx, lines } = harness();
		ctx.logger.error("x failed", new Error("x Bearer zzzzzzzz9"), {
			cookie: "Bearer abcdefgh1",
		});

		const stdout = lines.join("");
		expect(stdout).toContain("Bearer ***");
		expect(stdout).not.toContain("zzzzzzzz9");
		expect(stdout).not.toContain("abcdefgh1");
	});

	it("pretty 模式(开发彩色输出)也看得到后续参数,且是打过码的", () => {
		const lines: string[] = [];
		const destination = new Writable({
			write(chunk, _enc, cb) {
				lines.push(String(chunk));
				cb();
			},
		});
		const ctx = createNodeServiceContext({ name: "svc", pretty: true, destination });
		ctx.logger.error("POST /api/targets failed", new Error("boom Bearer zzzzzzzz9"));

		const out = lines.join("");
		expect(out).toContain("POST /api/targets failed");
		expect(out).toContain("boom Bearer ***");
		expect(out).not.toContain("zzzzzzzz9");
	});

	it("没有后续参数时,stdout 那一行不多出 args 字段", () => {
		const { ctx, lines } = harness();
		ctx.logger.info("plain");

		const row = JSON.parse(lines.join("")) as Record<string, unknown>;
		expect(Object.keys(row).sort()).toEqual(["hostname", "level", "msg", "name", "pid", "time"]);
		expect(row.msg).toBe("plain");
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

/**
 * 按值打码(登记册):登记过的值在 msg、字符串参数、对象参数、`Error` 里都被遮,stdout 与钩子(环形缓冲 / 归档)
 * 同一份;值遮完,固定正则那一遍照跑。值都是一眼看得出的假值。
 */
describe("createNodeServiceContext — 按值打码", () => {
	function valueHarness() {
		const valueRedactor = createValueRedactor();
		valueRedactor.replace("demo", "secrets", ["FAKE-SECRET-VALUE-1"]);
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
			valueRedactor,
		});
		return { ctx, lines, seen, valueRedactor };
	}

	it("msg、字符串参数、对象参数、Error 里的登记值:stdout 与钩子都遮", () => {
		const { ctx, lines, seen } = valueHarness();
		ctx.logger.info("拿到 FAKE-SECRET-VALUE-1", "x=FAKE-SECRET-VALUE-1", {
			nested: { token: "FAKE-SECRET-VALUE-1" },
		});
		ctx.logger.error("failed", new Error("boom FAKE-SECRET-VALUE-1"));

		const stdout = lines.join("");
		const hooked = JSON.stringify(seen);
		for (const out of [stdout, hooked]) {
			expect(out).not.toContain("FAKE-SECRET-VALUE-1");
			expect(out).toContain("拿到 ***");
			expect(out).toContain("boom ***");
		}
	});

	it("带着 cookie 名字打出来的登记值:靠值遮(核心里没有按名字的正则),名字原样留着好诊断", () => {
		const { ctx, seen } = valueHarness();
		ctx.logger.info("SESSDATA=FAKE-SECRET-VALUE-1; other=FAKE-NOT-REGISTERED");
		expect(seen[0]?.msg).toBe("SESSDATA=***; other=FAKE-NOT-REGISTERED");
	});

	it("值换掉之后,旧值不再遮(登记册现读,不在建上下文时拍快照)", () => {
		const { ctx, seen, valueRedactor } = valueHarness();
		valueRedactor.replace("demo", "secrets", ["FAKE-SECRET-VALUE-2"]);
		ctx.logger.info("a FAKE-SECRET-VALUE-1 b FAKE-SECRET-VALUE-2");
		expect(seen[0]?.msg).toBe("a FAKE-SECRET-VALUE-1 b ***");
	});
});
