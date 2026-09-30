/**
 * 装配根(`index.ts`)里那几处「发出去不管」的后台活,要登记进 `ctx.track()`(切片 ③)。
 *
 * 入站私聊 / 群消息的处理、每小时的草稿过期清扫、拓展开关的同步 —— 它们都在 `startServer`
 * 这一个大闭包里现拼,单元测试够不着,e2e 又造不出「关停正好赶上它们在途」。所以这里钉**形状**:
 * 每一处的 promise 都交给 `serviceCtx.track(`,并且没有留下裸 `void <调用>`。形状不是性质 ——
 * 交进去的 promise 落定要晚于那笔写,靠各被调模块自己的测试(它们的返回 promise 本就包着写)。
 *
 * 门禁红了说明:有人把这几处改回了 `void x()`,关停不再等它们,各写道关门之后它们的写会被拒。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";

let code: string;

beforeAll(async () => {
	const source = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
	// 注释里常提到这几个名字 —— 剥掉再扫,免得注释把断言撑绿或撑红。块注释只认**行首**开头的:
	// 字符串里的 "/api/*" 会被当成块注释的起点,一路吞到下一个 `*/`,把要扫的代码也吞了。
	code = source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
});

/** 在 `serviceCtx.track(` 的括号里出现 `needle`(允许中间换行、缩进、链式调用)。 */
function trackedBeforeDots(needle: RegExp): boolean {
	return new RegExp(`serviceCtx\\.track\\(\\s*${needle.source}`).test(code);
}

describe("index.ts 里的后台活登记进 track", () => {
	it("入站私聊 → 指令分发", () => {
		expect(code).not.toMatch(/void\s+commandDispatcher\.handleMessage/);
		expect(trackedBeforeDots(/commandDispatcher\.handleMessage\(/)).toBe(true);
	});

	it("入站群消息 → 链接解析", () => {
		expect(code).not.toMatch(/void\s+linkParser\s*\.handleMessage/);
		expect(trackedBeforeDots(/linkParser\s*\.handleMessage\(/)).toBe(true);
	});

	it("每小时的草稿过期清扫", () => {
		expect(code).not.toMatch(/void\s+roastDrafts\s*\.sweep/);
		expect(trackedBeforeDots(/roastDrafts\s*\.sweep\(\)/)).toBe(true);
	});

	it("拓展开关的同步", () => {
		expect(code).not.toMatch(/void\s+extensions\.sync\(/);
		expect(trackedBeforeDots(/extensions\.sync\(\)/)).toBe(true);
	});
});
