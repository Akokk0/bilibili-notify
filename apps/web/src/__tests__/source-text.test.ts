/**
 * 静态守卫的地基 —— 它坏掉的样子是**三道守卫一起安静地漏检**。
 *
 * 隔壁 `walk.ts` 没有测试,这份有,差别在失败的形态:遍历错了会少扫一整个目录,
 * 断言当场就红;而注释抹错只是让某几行在守卫眼里变成空白 —— 不报错、不失败,
 * 只是从此看不见那里的违规。收编前有三份实现,其中一份正是这样坏着的,并排放了
 * 很久也没人发现,因为**没有哪条断言看得见它**。
 *
 * 所以这里钉的不是「函数返回什么」,而是那几种具体的骗法。
 */

import { describe, expect, it } from "vite-plus/test";
import { blankComments } from "./source-text.js";

describe("blankComments", () => {
	it("行注释里的 `/*` 骗不走它 —— 正则版就是栽在这里", () => {
		// 收编前 `skin-hook-coverage` 用的正则版先跑块注释那条,于是从第一行那个
		// `/*` 一路匹配到底下的收尾符,把中间的真代码一起抹白。
		const src = ["// 说明 /* 这不是块注释开头", 'const a = "font-mono";', "/* 真注释 */"].join(
			"\n",
		);

		expect(blankComments(src)).toContain("font-mono");
	});

	it("`https://` 不当行注释 —— 否则整行的 class 都看不见了", () => {
		// 站里真实的写法。抹白的话守卫就此扫不到这一行,而它同样不会红。
		const src = '<a href="https://x.com" className="font-mono">';

		expect(blankComments(src)).toContain("font-mono");
	});

	it("行号一个不差 —— 守卫要按行号报位置", () => {
		const src = ["const a = 1;", "/* 跨了", "   两行 */", "const b = 2;"].join("\n");

		expect(blankComments(src).split("\n")).toHaveLength(4);
	});

	it("真注释确实被抹掉 —— 少了这条,原样返回也能过上面三条", () => {
		const src = ["// 以前写的是 text-white", "/* 这里也提过 text-white */"].join("\n");

		expect(blankComments(src)).not.toContain("text-white");
	});
});
