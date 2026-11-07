/**
 * 私聊指令的可配置项。这里钉的都是「配出来之后自己也用不了」的组合。
 */

import { describe, expect, it } from "vite-plus/test";
import { bindPackageText } from "../../texts";
import { CommandSettingsSchema } from "../commands";

/** 第一条拒收的原因。 */
const reasonOf = (input: unknown): string | undefined =>
	CommandSettingsSchema.safeParse(input).error?.issues[0]?.message;

describe("CommandSettingsSchema", () => {
	it("空对象补出一套能用的默认", () => {
		expect(CommandSettingsSchema.parse({})).toEqual({ enabled: true, prefix: "/", aliases: {} });
	});

	// 前缀为空 = 退化成整句精确匹配(而且未知指令必须静默,见 dispatcher)。
	it("前缀允许为空", () => {
		expect(CommandSettingsSchema.parse({ prefix: "" }).prefix).toBe("");
	});

	// 带尾空格的前缀是正当写法:主人敲的是「bn 状态」。
	it("`bn ` 这种带尾空格的前缀是合法的", () => {
		expect(CommandSettingsSchema.parse({ prefix: "bn " }).prefix).toBe("bn ");
	});

	// 纯空白 = 一个他自己都敲不出来的前缀,存进去等于把指令系统锁死。
	it("纯空白的前缀拒绝", () => {
		expect(() => CommandSettingsSchema.parse({ prefix: "   " })).toThrow();
	});

	// dispatcher 匹配前先把入站文本 trim 两头 —— 以空白开头的前缀(" /")
	// 永远匹配不上,和纯空白同一种「敲不出来」,存进去照样锁死全部指令。
	it("以空白开头的前缀拒绝(入站会先 trim,首空格永远匹配不上)", () => {
		expect(() => CommandSettingsSchema.parse({ prefix: " /" })).toThrow();
		expect(() => CommandSettingsSchema.parse({ prefix: "\t/" })).toThrow();
	});

	it("别名整份替换 —— 空数组是「一个别名都不要」,不是「没配」", () => {
		expect(CommandSettingsSchema.parse({ aliases: { mute: [] } }).aliases).toEqual({ mute: [] });
	});

	// 两头带空白的别名永远匹配不上(入站文本先 trim),留着只会让主人以为配好了。
	it("别名带首尾空格拒绝", () => {
		expect(() => CommandSettingsSchema.parse({ aliases: { mute: [" 静音"] } })).toThrow();
	});

	it("空别名拒绝", () => {
		expect(() => CommandSettingsSchema.parse({ aliases: { mute: [""] } })).toThrow();
	});

	it("拒收的原因是今天那三句中文", () => {
		expect(reasonOf({ prefix: "   " })).toBe("前缀不能是纯空白");
		expect(reasonOf({ prefix: " /" })).toBe("前缀不能以空白开头");
		expect(reasonOf({ aliases: { mute: [" 静音"] } })).toBe("别名不能为空或带首尾空格");
	});

	// 规则在加载时就建好了,原因要等校验那一刻才取:两端交了取字口,原因就跟着那一端的语言走
	it("拒收的原因在校验那一刻取字:交了取字口就走它", () => {
		const binding = bindPackageText((key) => `译:${key}`);
		try {
			expect(reasonOf({ prefix: "   " })).toBe("译:internal.commands.prefixBlank");
			expect(reasonOf({ prefix: " /" })).toBe("译:internal.commands.prefixLeadingSpace");
			expect(reasonOf({ aliases: { mute: [""] } })).toBe("译:internal.commands.aliasBlank");
		} finally {
			binding.dispose();
		}
	});
});
