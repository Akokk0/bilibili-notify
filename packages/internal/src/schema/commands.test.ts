/**
 * 私聊指令的可配置项。这里钉的都是「配出来之后自己也用不了」的组合。
 */

import { describe, expect, it } from "vite-plus/test";
import { CommandConfigSchema } from "./commands";

describe("CommandConfigSchema", () => {
	it("空对象补出一套能用的默认", () => {
		expect(CommandConfigSchema.parse({})).toEqual({ enabled: true, prefix: "/", aliases: {} });
	});

	// 前缀为空 = 退化成整句精确匹配(而且未知指令必须静默,见 dispatcher)。
	it("前缀允许为空", () => {
		expect(CommandConfigSchema.parse({ prefix: "" }).prefix).toBe("");
	});

	// 带尾空格的前缀是正当写法:主人敲的是「bn 状态」。
	it("`bn ` 这种带尾空格的前缀是合法的", () => {
		expect(CommandConfigSchema.parse({ prefix: "bn " }).prefix).toBe("bn ");
	});

	// 纯空白 = 一个他自己都敲不出来的前缀,存进去等于把指令系统锁死。
	it("纯空白的前缀拒绝", () => {
		expect(() => CommandConfigSchema.parse({ prefix: "   " })).toThrow();
	});

	it("别名整份替换 —— 空数组是「一个别名都不要」,不是「没配」", () => {
		expect(CommandConfigSchema.parse({ aliases: { mute: [] } }).aliases).toEqual({ mute: [] });
	});

	// 两头带空白的别名永远匹配不上(入站文本先 trim),留着只会让主人以为配好了。
	it("别名带首尾空格拒绝", () => {
		expect(() => CommandConfigSchema.parse({ aliases: { mute: [" 静音"] } })).toThrow();
	});

	it("空别名拒绝", () => {
		expect(() => CommandConfigSchema.parse({ aliases: { mute: [""] } })).toThrow();
	});
});
