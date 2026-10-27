/**
 * `isThenable` / `catchThenableRejection` —— 三个同步读口(`publishView`、来源的 `health()`、开发入口的
 * `devtools()`)共用的一份判断。第三方交回的东西形状不受类型约束,`then` 还可能是个会抛的 getter。
 */

import { describe, expect, it } from "vite-plus/test";
import { catchThenableRejection, isThenable } from "../is-thenable.js";

describe("isThenable", () => {
	it.each([
		["原生 Promise", Promise.resolve(1), true],
		[
			"非原生 thenable",
			{
				// biome-ignore lint/suspicious/noThenProperty: 验的就是 thenable 的识别
				then() {},
			},
			true,
		],
		[
			"then 不是函数",
			// biome-ignore lint/suspicious/noThenProperty: 验的就是 then 不是函数时不算 thenable
			{ then: 1 },
			false,
		],
		[
			"then 是会抛的 getter",
			{
				// biome-ignore lint/suspicious/noThenProperty: 验的就是读 then 时抛错不算 thenable
				get then() {
					throw new Error("boom");
				},
			},
			false,
		],
		["null", null, false],
		["undefined", undefined, false],
		["字符串", "then", false],
		[
			"带 then 的函数对象",
			Object.assign(() => {}, {
				// biome-ignore lint/suspicious/noThenProperty: 验的就是 thenable 的识别
				then() {},
			}),
			true,
		],
		["普通函数", () => {}, false],
	])("%s", (_name, value, expected) => {
		expect(isThenable(value)).toBe(expected);
	});
});

describe("catchThenableRejection", () => {
	it("是 thenable:回 true,并且接住它日后的拒绝(不留未处理的 rejection)", async () => {
		const thenable = {
			// biome-ignore lint/suspicious/noThenProperty: 验的就是 thenable 的接住
			then(_resolve: unknown, reject: (err: Error) => void) {
				reject(new Error("late thenable failure"));
			},
		};
		expect(catchThenableRejection(thenable)).toBe(true);
		// 让那一发 rejection 落地 —— 没接住的话 vitest 会把它报成一条错误。
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("原生 Promise 拒绝:同样接住", async () => {
		expect(catchThenableRejection(Promise.reject(new Error("late failure")))).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("不是 thenable:回 false,不抛", () => {
		expect(catchThenableRejection(undefined)).toBe(false);
		// biome-ignore lint/suspicious/noThenProperty: 验的就是 then 不是函数时不算 thenable
		expect(catchThenableRejection({ then: 1 })).toBe(false);
		expect(
			catchThenableRejection({
				// biome-ignore lint/suspicious/noThenProperty: 验的就是读 then 时抛错不算 thenable
				get then() {
					throw new Error("boom");
				},
			}),
		).toBe(false);
	});
});
