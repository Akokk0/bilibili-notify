/**
 * 帮助渲染 —— 注册表做成数据之后,这东西几乎是白拿的。
 *
 * 而它必须**现场拼**:主人可以改前缀,改完第一个会看的就是帮助;硬编码 `/静音 3h`
 * 当示例的话,他把前缀改成 `bn ` 之后,帮助里每一个例子都是错的。
 */

import { describe, expect, it } from "vite-plus/test";
import { renderHelp } from "../command-help.js";

const COMMANDS = [
	{ name: "status", aliases: ["状态"], description: "看看现在怎么样" },
	{
		name: "mute",
		aliases: ["静音", "免打扰"],
		signature: "<duration:duration|时长>",
		description: "安静一会儿",
		details: "定时周报和锐评不受静音管，到点照发。",
		example: "3h",
	},
];

describe("renderHelp", () => {
	it("不带参数:列出全部指令", () => {
		const text = renderHelp(COMMANDS, "/");
		expect(text).toContain("status");
		expect(text).toContain("mute");
		expect(text).toContain("看看现在怎么样");
	});

	// 主名是英文,主人多半记的是中文那个 —— 帮助里不列出来他就不知道能敲什么。
	it("列出别名", () => {
		const text = renderHelp(COMMANDS, "/");
		expect(text).toContain("静音");
		expect(text).toContain("免打扰");
	});

	it("示例用**当前**前缀拼,不是硬编码的", () => {
		expect(renderHelp(COMMANDS, "/")).toContain("/mute");
	});

	// 方案里专门点了这条:主人改完前缀,帮助恰恰是他第一个会看的东西。
	it("前缀改了,帮助里的示例跟着变", () => {
		const text = renderHelp(COMMANDS, "bn ");
		expect(text).toContain("bn mute");
		expect(text).not.toContain("/mute");
	});

	it("带参数:只给那一条的详情,含用法", () => {
		const text = renderHelp(COMMANDS, "/", "mute");
		expect(text).toContain("/mute <时长>");
		expect(text).not.toContain("status");
	});

	// 主人多半是用中文别名敲的「/帮助 静音」,这时也得查得到。
	it("按别名也查得到详情", () => {
		const text = renderHelp(COMMANDS, "/", "静音");
		expect(text).toContain("安静一会儿");
	});

	// 有些注意事项只有在「我正打算敲这条」的时候才想知道 —— 比如静音管不管定时周报。
	it("详情里带上 details 那段补充", () => {
		const text = renderHelp(COMMANDS, "/", "mute");
		expect(text).toContain("定时周报");
	});

	// 列表是在手机上看的,每条挤一行。补充说明进详情,别把列表撑长。
	it("列表里不出现 details", () => {
		const text = renderHelp(COMMANDS, "/");
		expect(text).not.toContain("定时周报");
	});

	it("问一条不存在的指令 → 说清楚,而不是给一份空白帮助", () => {
		const text = renderHelp(COMMANDS, "/", "不存在");
		expect(text).toContain("不存在");
	});
});

/**
 * 大小写与空白 —— 手机输入法会把 `/help mute` 自动首字母大写成 `/help Mute`。
 * 严格比对的话主人收到的是「没有「Mute」这条指令」,而他看屏幕上那行字和帮助里
 * 印的一模一样,根本不知道差在哪。
 */
describe("renderHelp — 输入宽容度", () => {
	it("大小写不敏感", () => {
		expect(renderHelp(COMMANDS, "/", "Mute")).toContain("安静一会儿");
		expect(renderHelp(COMMANDS, "/", "MUTE")).toContain("安静一会儿");
	});

	it("两头空白不算数", () => {
		expect(renderHelp(COMMANDS, "/", " mute ")).toContain("安静一会儿");
	});
});

/**
 * 用法怎么印给主人看。
 *
 * 签名(`<duration:duration|时长>`)是**写给解析器**的:参数名进代码、类型驱动校验。
 * 把它原样端到主人面前,他要先看懂三段冒号竖线才知道该填什么 —— 那三段里有两段
 * 跟他无关。他要看的是「填一个时长」,以及最好直接给他一个能照抄的例子。
 */
describe("用法展示", () => {
	it("参数只印显示名,不印参数名与类型", () => {
		const text = renderHelp(COMMANDS, "/", "mute");
		expect(text).toContain("<时长>");
		expect(text).not.toContain("duration");
		expect(text).not.toContain(":");
	});

	it("列表里也是显示名", () => {
		const text = renderHelp(COMMANDS, "/");
		expect(text).toContain("<时长>");
		expect(text).not.toContain("duration:duration");
	});

	// 没写显示名的参数退回参数名 —— 总比印一段类型声明强。
	it("没写显示名 → 用参数名", () => {
		const text = renderHelp([{ name: "x", signature: "<uid:string>" }], "/", "x");
		expect(text).toContain("<uid>");
		expect(text).not.toContain("string");
	});

	it("可选参数保留方括号 —— 必填和可选得看得出区别", () => {
		const text = renderHelp([{ name: "x", signature: "[days:number|天数]" }], "/", "x");
		expect(text).toContain("[天数]");
	});

	// 一个能照抄的例子胜过一行语法说明。
	it("有示例就印出来,并且用**当前**前缀拼", () => {
		expect(renderHelp(COMMANDS, "/", "mute")).toContain("/mute 3h");
		expect(renderHelp(COMMANDS, "bn ", "mute")).toContain("bn mute 3h");
	});

	it("列表里也带示例", () => {
		expect(renderHelp(COMMANDS, "/")).toContain("/mute 3h");
	});

	it("没有示例的指令不硬凑一行", () => {
		const text = renderHelp([{ name: "status", description: "看看" }], "/", "status");
		expect(text).not.toContain("例");
	});

	it("不收参数的指令不留空的尖括号", () => {
		expect(renderHelp(COMMANDS, "/", "status")).toContain("/status");
		expect(renderHelp(COMMANDS, "/", "status")).not.toContain("<");
	});
});
