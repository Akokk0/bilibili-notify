/**
 * 指令参数 —— 签名声明与入参解析。
 *
 * 签名借 koishi 端的写法(`<必填:类型>` / `[可选:类型]`),跨端认知一致。但**只写参数
 * 部分**,不含指令名 —— 指令名与别名都在注册表里,而别名是主人可配的,让它再出现在
 * 签名里就得两处同步。
 *
 * 这里守的是「解析与执行分离」:handler 永远拿到已校验的值,拿不到就根本不该被调用。
 */

import { describe, expect, it } from "vite-plus/test";
import { parseSignature } from "../command-params.js";

describe("parseSignature", () => {
	it("尖括号 = 必填", () => {
		expect(parseSignature("<时长:duration>")).toEqual([
			{ name: "时长", type: "duration", required: true },
		]);
	});

	it("方括号 = 可选", () => {
		expect(parseSignature("[天数:number]")).toEqual([
			{ name: "天数", type: "number", required: false },
		]);
	});

	it("多个参数按声明顺序返回 —— 位置参数,顺序就是语义", () => {
		expect(parseSignature("<uid:string> [页:number]")).toEqual([
			{ name: "uid", type: "string", required: true },
			{ name: "页", type: "number", required: false },
		]);
	});

	it("没有参数就是空表", () => {
		expect(parseSignature("")).toEqual([]);
	});

	// 签名是**代码里写死的**,不是用户输入 —— 写错类型就是 bug,该在注册那一刻就炸,
	// 而不是等某天主人真敲了这条指令才发现参数没被校验。
	it("非法类型直接抛,不静默放过", () => {
		expect(() => parseSignature("<x:foo>")).toThrow(/foo/);
	});

	it("text 只能放最后 —— 它吞掉剩余全部,后面的参数永远拿不到值", () => {
		expect(() => parseSignature("<内容:text> <uid:string>")).toThrow(/text/);
	});

	it("text 放在最后是合法的", () => {
		expect(parseSignature("<uid:string> <内容:text>")).toEqual([
			{ name: "uid", type: "string", required: true },
			{ name: "内容", type: "text", required: true },
		]);
	});
});
