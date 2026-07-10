// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { copyToClipboard } from "./clipboard";

/**
 * 复制 UID 的坑:主人若用局域网 IP + http 打开面板(非安全上下文),
 * `navigator.clipboard` 直接是 undefined。copyToClipboard 要在安全上下文优先
 * 走异步 Clipboard API,否则回退到 textarea + execCommand,都不行才认输返回 false。
 */
describe("copyToClipboard", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		// jsdom v26 不再提供 document.execCommand;测试按需注入,收尾删掉防泄漏。
		Reflect.deleteProperty(document, "execCommand");
	});

	/** jsdom 无 execCommand,注入一个可控桩。 */
	function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
		const execCommand = vi.fn().mockReturnValue(result);
		Object.defineProperty(document, "execCommand", {
			value: execCommand,
			configurable: true,
			writable: true,
		});
		return execCommand;
	}

	it("安全上下文:调用 navigator.clipboard.writeText 并返回 true", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });

		const ok = await copyToClipboard("12345");

		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith("12345");
	});

	it("非安全上下文(navigator.clipboard 不存在):回退 textarea + execCommand,成功 → true", async () => {
		vi.stubGlobal("navigator", {}); // 无 clipboard 字段,模拟 http 局域网
		const execCommand = stubExecCommand(true);

		const ok = await copyToClipboard("999");

		expect(ok).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
	});

	it("clipboard 抛错(权限拒绝)后回落兜底,兜底也失败 → 返回 false", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const execCommand = stubExecCommand(false);

		const ok = await copyToClipboard("x");

		expect(ok).toBe(false);
		expect(execCommand).toHaveBeenCalledWith("copy"); // 抛错后确实落到了兜底
	});
});
