/**
 * System 页保存时发哪些块 —— 改了哪块发哪块,从 diff 推出来。
 *
 * 这页只发它真正改过的块(整份草稿发出去会让后端对 cardStyle / ai 跑探测)。挑块不靠
 * 手写清单:清单会漏 —— 链接解析那张卡就漏过一次,表现为「点了保存,草稿岛又弹出来」
 * (服务端根本没收到,原样返回,diff 还在)。所以这里断言的是**性质**:任何块只要与
 * 基线不同就在补丁里,没动的就不在;下一张新卡不用改这里就被覆盖到。
 *
 * 草稿是整份设置(`{ core, <集成键>… }`),块有两层:核心那份的块是 `core` 下的顶层键,集成的块是集成的整份。
 *
 * `buildPatch` 不是最小 diff:选中的块整份发,只把删掉的键变成 `null`。所以断言的是
 * 「在不在补丁里」,不是「补丁只有这一个键」。
 */

import type { SettingsResponse } from "@bilibili-notify/contract";
import { describe, expect, it } from "vite-plus/test";
import { buildSystemPatch } from "../system-save-patch";

const CORE = {
	logging: { level: "info" },
	master: { targetId: "t1" },
	commands: { enabled: true, prefix: "/", aliases: {} },
	linkPreview: { enabled: false, cooldownSec: 60 },
	defaults: { cardStyle: { enabled: true } },
};
const BILIBILI = { dynamicCron: "*/5 * * * *", healthCheckMinutes: 30 };

/**
 * `/api/settings` 下发的那一份:核心那份在 `core` 下,各集成的设置挂在自己的键下 —— `bilibili` 就是这样
 * 一个块(动态 cron / 登录心跳间隔两格在它里头,不在核心的 `logging` 里)。
 */
function settings(
	over: { core?: Record<string, unknown>; bilibili?: Record<string, unknown> } = {},
): SettingsResponse {
	return {
		core: { ...CORE, ...over.core },
		bilibili: over.bilibili ?? BILIBILI,
	} as unknown as SettingsResponse;
}

describe("buildSystemPatch", () => {
	it("核心那份哪个块变了,哪个就进补丁(挂在 core 下)—— 对基线里的每一块都成立,不靠谁记得加清单", () => {
		const base = settings();
		for (const [key, value] of Object.entries(CORE)) {
			const next = settings({ core: { [key]: { ...value, touched: 1 } } });
			const patch = buildSystemPatch(next, base);
			expect(Object.keys(patch), `改了 ${key}`).toEqual(["core"]);
			expect(Object.keys(patch.core ?? {}), `改了 ${key}`).toEqual([key]);
		}
	});

	it("链接解析的开关进补丁,没动的块(defaults 等)不发 —— 后端收到 defaults 会跑卡片 / AI 探测", () => {
		const base = settings();
		const next = settings({ core: { linkPreview: { enabled: true, cooldownSec: 60 } } });
		const patch = buildSystemPatch(next, base);
		expect(patch).toMatchObject({ core: { linkPreview: { enabled: true } } });
		expect(Object.keys(patch.core ?? {})).toEqual(["linkPreview"]);
	});

	it("清空的可选字段以 null 送出(删除哨兵),不是悄悄不提", () => {
		const base = settings();
		const next = settings({ core: { master: {} } });
		expect(buildSystemPatch(next, base)).toMatchObject({ core: { master: { targetId: null } } });
	});

	it("什么都没改 → 空补丁(连 core 都不带)", () => {
		expect(buildSystemPatch(settings(), settings())).toEqual({});
	});

	/**
	 * B 站的两格在它自己的设置里(`bilibili` 块),不在核心的 `logging` 里。集成的块按集成的键整份挑、不认得谁是谁:
	 * 改了 B 站的一格 → 补丁里是 `{ bilibili: {...} }`,不碰 `core`。
	 */
	describe("B 站的设置块(bilibili)", () => {
		it("只改 B 站的一格 → 补丁里只有 bilibili 块,没有 core", () => {
			const base = settings();
			const next = settings({
				bilibili: { dynamicCron: "0 */10 * * * *", healthCheckMinutes: 30 },
			});
			const patch = buildSystemPatch(next, base);
			expect(patch).toMatchObject({ bilibili: { dynamicCron: "0 */10 * * * *" } });
			expect(Object.keys(patch)).toEqual(["bilibili"]);
		});

		it("只改核心 logging 的一格 → 补丁里没有 bilibili(没动的集成设置不发)", () => {
			const base = settings();
			const next = settings({ core: { logging: { level: "debug" } } });
			const patch = buildSystemPatch(next, base);
			expect(Object.keys(patch)).toEqual(["core"]);
			expect(Object.keys(patch.core ?? {})).toEqual(["logging"]);
		});

		it("核心与 B 站一起改 → 两边各一块", () => {
			const base = settings();
			const next = settings({
				core: { logging: { level: "debug" } },
				bilibili: { dynamicCron: "0 */10 * * * *", healthCheckMinutes: 30 },
			});
			const patch = buildSystemPatch(next, base);
			expect(Object.keys(patch).sort()).toEqual(["bilibili", "core"]);
			expect(Object.keys(patch.core ?? {})).toEqual(["logging"]);
		});
	});
});
