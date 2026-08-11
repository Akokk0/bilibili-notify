/**
 * 帮助渲染 —— 注册表做成数据之后,这东西几乎是白拿的。
 *
 * 而它必须**现场拼**:主人可以改前缀,改完第一个会看的就是帮助;硬编码 `/静音 3h`
 * 当示例的话,他把前缀改成 `bn ` 之后,帮助里每一个例子都是错的。
 */

import { describe, expect, it } from "vite-plus/test";
import { renderHelp } from "../command-help.js";

const COMMANDS = [
	{ name: "状态", description: "看看现在怎么样" },
	{ name: "静音", signature: "<时长:duration>", description: "安静一会儿" },
];

describe("renderHelp", () => {
	it("不带参数:列出全部指令", () => {
		const text = renderHelp(COMMANDS, "/");
		expect(text).toContain("状态");
		expect(text).toContain("静音");
		expect(text).toContain("看看现在怎么样");
	});

	it("示例用**当前**前缀拼,不是硬编码的", () => {
		expect(renderHelp(COMMANDS, "/")).toContain("/静音");
	});

	// 方案里专门点了这条:主人改完前缀,帮助恰恰是他第一个会看的东西。
	it("前缀改了,帮助里的示例跟着变", () => {
		const text = renderHelp(COMMANDS, "bn ");
		expect(text).toContain("bn 静音");
		expect(text).not.toContain("/静音");
	});

	it("带参数:只给那一条的详情,含签名", () => {
		const text = renderHelp(COMMANDS, "/", "静音");
		expect(text).toContain("<时长:duration>");
		expect(text).not.toContain("状态");
	});

	it("问一条不存在的指令 → 说清楚,而不是给一份空白帮助", () => {
		const text = renderHelp(COMMANDS, "/", "不存在");
		expect(text).toContain("不存在");
	});
});
