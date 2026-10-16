/**
 * 安全守护 — 还没有 logger 时的兜底输出(`console.error` / `process.stderr.write`)也过同一份打码。
 *
 * 不变量:兜底路径写出去的字节里没有凭证明文;作为参数传进来的 `Error` 打码后仍带 message。
 * 复发点:兜底路径又退回原样 `console.error(msg, err)`。
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { consoleErrorRedacted, stderrLineRedacted } from "../console-fallback.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("兜底输出打码", () => {
	it("consoleErrorRedacted:msg 与 Error 参数里的凭证都被遮,message 仍在", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		consoleErrorRedacted("fatal Bearer msgmsgmsg1", new Error("boom Bearer jjjjjjjj77"));

		const written = JSON.stringify(spy.mock.calls);
		expect(written).toContain("fatal Bearer ***");
		expect(written).toContain("boom Bearer ***");
		expect(written).not.toContain("msgmsgmsg1");
		expect(written).not.toContain("jjjjjjjj77");
	});

	it("stderrLineRedacted:整行过打码再写 stderr,末尾补换行", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		stderrLineRedacted("bad config Bearer tttttttt.8888");

		expect(spy).toHaveBeenCalledWith("bad config Bearer ***\n");
	});
});
