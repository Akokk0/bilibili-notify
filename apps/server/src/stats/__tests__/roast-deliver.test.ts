/**
 * 锐评投递 —— 多目标发送里「停用的目标」怎么处理。
 *
 * 缝在 `deliverRoast`:目标 id 列表进,发了谁 / 跳过谁 / 谁失败出。投递本体(渲染、
 * 降级)不在这儿测;这里只看它对目标表与适配器表的判断。
 *
 * 「停用」在链接解析与周报里是同一个意思(主人定的):目标或它的适配器停用 = 暂停,勾着
 * 也不发。以前的做法是把停用目标扔给推送管线,管线判它不可达、退避重试到上限再报失败 ——
 * 一次停用换来一条失败通知,而且要等好几分钟。
 */

import type { PushAdapter, PushTarget } from "@bilibili-notify/internal";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { type BoardLike, deliverRoast, type RoastDeliverDeps } from "../roast-deliver.js";

const ADAPTER = "11111111-1111-4111-8111-111111111111";
const ADAPTER_OFF = "22222222-2222-4222-8222-222222222222";
const T_ON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_OFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_ON_ADAPTER_OFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const BOARD: BoardLike = {
	pushText: "本周榜单",
	pigeon: { uid: "1", reason: "鸽" },
	diligent: { uid: "2", reason: "勤" },
	roast: [],
	scores: [],
};

function target(id: string, adapterId: string, enabled: boolean): PushTarget {
	return {
		id,
		name: id.slice(0, 4),
		adapterId,
		scope: "group",
		enabled,
		platform: "onebot",
		session: { groupId: "123" },
	} as PushTarget;
}

function adapter(id: string, enabled: boolean): PushAdapter {
	return { id, name: "bot", enabled, platform: "onebot", config: {} } as unknown as PushAdapter;
}

function makeDeps() {
	const sendToTarget = vi.fn(async (_id: string) => ({ ok: true, latencyMs: 1 }));
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const deps = {
		runtime: {
			engines: { imageRenderer: null, push: { sendToTarget } },
			serviceCtx: { logger },
			subRuntimeStore: { get: () => undefined },
		},
		store: {
			getGlobals: () => makeDefaultGlobalConfig(),
			getSubscriptions: () => [],
			getTargets: () => [
				target(T_ON, ADAPTER, true),
				target(T_OFF, ADAPTER, false),
				target(T_ON_ADAPTER_OFF, ADAPTER_OFF, true),
			],
			getAdapters: () => [adapter(ADAPTER, true), adapter(ADAPTER_OFF, false)],
		},
	} as unknown as RoastDeliverDeps;
	return { deps, sendToTarget };
}

describe("deliverRoast — 停用的目标", () => {
	it("都启用 → 每个目标发一次,skipped 为空", async () => {
		const { deps, sendToTarget } = makeDeps();
		const out = await deliverRoast(deps, {
			kind: "board",
			result: BOARD,
			days: 7,
			targetIds: [T_ON],
		});
		expect(sendToTarget).toHaveBeenCalledTimes(1);
		expect(out.sent).toEqual([T_ON]);
		expect(out.skipped).toEqual([]);
		expect(out.failed).toEqual([]);
	});

	it("目标本身停用 → 跳过、记进 skipped、不算失败、不碰推送管线", async () => {
		const { deps, sendToTarget } = makeDeps();
		const out = await deliverRoast(deps, {
			kind: "board",
			result: BOARD,
			days: 7,
			targetIds: [T_ON, T_OFF],
		});
		expect(sendToTarget.mock.calls.map(([id]) => id)).toEqual([T_ON]);
		expect(out.sent).toEqual([T_ON]);
		expect(out.skipped).toEqual([T_OFF]);
		expect(out.failed).toEqual([]);
	});

	it("目标所属的适配器停用 → 同样跳过", async () => {
		const { deps, sendToTarget } = makeDeps();
		const out = await deliverRoast(deps, {
			kind: "board",
			result: BOARD,
			days: 7,
			targetIds: [T_ON_ADAPTER_OFF, T_ON],
		});
		expect(sendToTarget.mock.calls.map(([id]) => id)).toEqual([T_ON]);
		expect(out.skipped).toEqual([T_ON_ADAPTER_OFF]);
	});
});
