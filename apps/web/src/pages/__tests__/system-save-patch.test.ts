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
import type { GlobalConfig } from "../../types/globals";
import { buildSystemPatch } from "../system-save-patch";

function globals(over: Record<string, unknown> = {}): GlobalConfig {
	return {
		app: { dynamicCron: "*/5 * * * *" },
		master: { targetId: "t1" },
		commands: { enabled: true, prefix: "/", aliases: {} },
		linkParsing: { enabled: false, cooldownSeconds: 60 },
		defaults: { cardStyle: { enabled: true } },
		...over,
	} as unknown as GlobalConfig;
}

describe("buildSystemPatch", () => {
	it("哪个顶层块变了,哪个就进补丁 —— 对基线里的每一块都成立,不靠谁记得加清单", () => {
		const base = globals();
		for (const key of Object.keys(base) as (keyof GlobalConfig)[]) {
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
});
