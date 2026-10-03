/**
 * System 页保存时发哪些块 —— 改了哪块发哪块,从 diff 推出来。
 *
 * 这页只发它真正改过的块(整份草稿发出去会让后端对 cardStyle / ai 跑探测)。挑块不靠
 * 手写清单:清单会漏 —— 链接解析那张卡就漏过一次,表现为「点了保存,草稿岛又弹出来」
 * (服务端根本没收到,原样返回,diff 还在)。所以这里断言的是**性质**:任何顶层块只要与
 * 基线不同就在补丁里,没动的就不在;下一张新卡不用改这里就被覆盖到。
 *
 * `buildPatch` 不是最小 diff:选中的块整份发,只把删掉的键变成 `null`。所以断言的是
 * 「在不在补丁里」,不是「补丁只有这一个键」。
 */

import { describe, expect, it } from "vite-plus/test";
import type { GlobalsResponse } from "../../types/globals";
import { buildSystemPatch } from "../system-save-patch";

/**
 * `/api/settings` 下发的那一份:核心设置的顶层块,外加各集成的设置挂在自己的键下 —— `bilibili` 就是这样
 * 一个块(动态 cron / UA / 登录心跳间隔三格在它里头,不在核心的 `app` 里)。
 */
function globals(over: Record<string, unknown> = {}): GlobalsResponse {
	return {
		app: { logLevel: "info" },
		bilibili: { dynamicCron: "*/5 * * * *", userAgent: "UA/1", healthCheckMinutes: 30 },
		master: { targetId: "t1" },
		commands: { enabled: true, prefix: "/", aliases: {} },
		linkParsing: { enabled: false, cooldownSeconds: 60 },
		defaults: { cardStyle: { enabled: true } },
		...over,
	} as unknown as GlobalsResponse;
}

describe("buildSystemPatch", () => {
	it("哪个顶层块变了,哪个就进补丁 —— 对基线里的每一块都成立,不靠谁记得加清单", () => {
		const base = globals();
		for (const key of Object.keys(base)) {
			const next = globals({ [key]: { ...(base[key] as object), touched: 1 } });
			expect(Object.keys(buildSystemPatch(next, base)), `改了 ${key}`).toEqual([key]);
		}
	});

	it("链接解析的开关进补丁,没动的块(defaults 等)不发 —— 后端收到 defaults 会跑卡片 / AI 探测", () => {
		const base = globals();
		const next = globals({ linkParsing: { enabled: true, cooldownSeconds: 60 } });
		const patch = buildSystemPatch(next, base);
		expect(patch).toMatchObject({ linkParsing: { enabled: true } });
		expect(Object.keys(patch)).toEqual(["linkParsing"]);
	});

	it("清空的可选字段以 null 送出(删除哨兵),不是悄悄不提", () => {
		const base = globals();
		const next = globals({ master: {} });
		expect(buildSystemPatch(next, base)).toMatchObject({ master: { targetId: null } });
	});

	/**
	 * B 站的三格在它自己的设置里(`bilibili` 块),不在核心的 `app` 里。挑块按顶层键、不认得谁是谁:
	 * 改了 B 站的一格 → 补丁里是 `{ bilibili: {...} }`,**绝不**再出现 `app.dynamicCron` 那种老路径 ——
	 * 服务端按块分文件落盘,发到 `app` 底下的 B 站键会被核心设置当成未知键拒收。
	 */
	describe("B 站的设置块(bilibili)", () => {
		it("只改 B 站的一格 → 补丁里只有 bilibili 块,没有 app", () => {
			const base = globals();
			const next = globals({
				bilibili: { dynamicCron: "0 */10 * * * *", userAgent: "UA/1", healthCheckMinutes: 30 },
			});
			const patch = buildSystemPatch(next, base);
			expect(patch).toMatchObject({ bilibili: { dynamicCron: "0 */10 * * * *" } });
			expect(Object.keys(patch)).toEqual(["bilibili"]);
			expect(patch).not.toHaveProperty("app");
		});

		it("清空 B 站的 userAgent → bilibili 块里以 null 送出", () => {
			const base = globals();
			const next = globals({ bilibili: { dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 } });
			expect(buildSystemPatch(next, base)).toMatchObject({ bilibili: { userAgent: null } });
		});

		it("只改核心 app 的一格 → 补丁里没有 bilibili(没动的集成设置不发)", () => {
			const base = globals();
			const next = globals({ app: { logLevel: "debug" } });
			const patch = buildSystemPatch(next, base);
			expect(Object.keys(patch)).toEqual(["app"]);
			expect(patch).not.toHaveProperty("bilibili");
		});
	});
});
