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
import { parseArgs, parseSignature, type Values } from "../command-params.js";

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

describe("parseArgs", () => {
	it("string:取一段不含空白的文本", () => {
		const specs = parseSignature("<uid:string>");
		expect(parseArgs(specs, "12345")).toEqual({ ok: true, values: { uid: "12345" } });
	});
	it("必填参数缺了 → 报错,并说清缺的是哪个", () => {
		const specs = parseSignature("<时长:duration>");
		const r = parseArgs(specs, "");
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toMatch(/时长/);
	});
	it("number:转成数字,不是字符串", () => {
		const specs = parseSignature("[天数:number]");
		expect(parseArgs(specs, "7")).toEqual({ ok: true, values: { 天数: 7 } });
	});

	it("number:不是整数 → 报错,并说清是哪个参数", () => {
		const specs = parseSignature("[天数:number]");
		const r = parseArgs(specs, "七天");
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toMatch(/天数/);
	});
	// 静音专用的领域类型。主人在手机上敲,中英文都得认。
	it.each([
		["3h", 3 * 3600_000],
		["30m", 30 * 60_000],
		["2小时", 2 * 3600_000],
		["30分钟", 30 * 60_000],
		["1天", 24 * 3600_000],
	])("duration:%s → %d 毫秒", (input, ms) => {
		const specs = parseSignature("<时长:duration>");
		expect(parseArgs(specs, input)).toEqual({ ok: true, values: { 时长: ms } });
	});

	it("duration:看不懂的写法 → 报错", () => {
		const specs = parseSignature("<时长:duration>");
		const r = parseArgs(specs, "一会儿");
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.message).toMatch(/时长/);
	});
	it("text:吞掉剩余全部,连中间的空白也原样保留", () => {
		const specs = parseSignature("<uid:string> <备注:text>");
		expect(parseArgs(specs, "12345 前面   后面")).toEqual({
			ok: true,
			values: { uid: "12345", 备注: "前面   后面" },
		});
	});

	it("text 是可选且没填 → 不塞进 values", () => {
		const specs = parseSignature("<uid:string> [备注:text]");
		expect(parseArgs(specs, "12345")).toEqual({ ok: true, values: { uid: "12345" } });
	});
	// 静默忽略会让主人以为参数生效了 —— 比如「周报 7 天」,「7」被吃掉、「天」被丢掉,
	// 结果和他想的一样,下次写「周报 一 周」就莫名其妙不灵了。
	it("多给了参数 → 报错,不静默丢掉", () => {
		const specs = parseSignature("<时长:duration>");
		const r = parseArgs(specs, "3h 还有别的");
		expect(r.ok).toBe(false);
	});

	it("无参数指令收到参数 → 同样报错", () => {
		const r = parseArgs(parseSignature(""), "多余的");
		expect(r.ok).toBe(false);
	});
	// 类型推导要求「必填在前、可选在后」—— 支持交错顺序会让类型体操撞上
	// `Type instantiation is excessively deep`。类型和运行时不能各说各话,
	// 所以这条约定在运行时也钉死。
	it("可选参数后面不能再出现必填 —— 类型推导指着这条约定", () => {
		expect(() => parseSignature("[页:number] <uid:string>")).toThrow(/可选/);
	});

	it("全必填、全可选、先必填后可选都合法", () => {
		expect(() => parseSignature("<a:string> <b:string>")).not.toThrow();
		expect(() => parseSignature("[a:string] [b:string]")).not.toThrow();
		expect(() => parseSignature("<a:string> [b:string]")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 类型层面的断言。这些不在运行时跑,但 typecheck 会验 —— 推导错了这个文件编译不过。
// 光看「编译通过」不算数:得钉死推出来的到底是什么形状。
// ---------------------------------------------------------------------------

type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _必填推成对应类型 = Assert<Equals<Values<"<时长:duration>">, { 时长: number }>>;
type _可选带上undefined = Assert<Equals<Values<"[天数:number]">, { 天数?: number | undefined }>>;
type _string与text都是字符串 = Assert<
	Equals<Values<"<uid:string> [备注:text]">, { uid: string; 备注?: string | undefined }>
>;
/** 没有签名 → 一个键都没有(直接跟 `{}` 比会被索引签名之类的细节绊住)。 */
type _没有签名就是一个键都没有 = Assert<Equals<keyof Values<"">, never>>;

// 这几个类型只为让 tsc 检查,运行时用不到 —— 导出以免被当成未使用。
export type {
	_string与text都是字符串,
	_可选带上undefined,
	_必填推成对应类型,
	_没有签名就是一个键都没有,
};
