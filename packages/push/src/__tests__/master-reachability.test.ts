/**
 * 单元测试 — `PushRouter` master 可达性边沿状态机(Q5)。
 *
 * 契约(改坏 = 告警背channel断了运维不知道,或 per-tick 刷 error 复刻 Bug-1):
 *   - master available→unreachable 跳变(含首次未知→不可达)→ `error` 恰一次
 *   - 持续不可达 → 调用方各自 `debug` 跳过,**不再** error
 *   - unreachable→available 恢复 → `info` 恰一次,且私信真正投递
 *   - setMaster 切目标 → 重置边沿,新目标首次不可达是一次全新 error
 */

import type {
	DeliveryResult,
	Logger,
	NotificationPayload,
	PushTarget,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { PushRouter } from "../push-router";
import { type FakeDispatcher, pushBase } from "./helpers";

type LogRec = { level: "info" | "warn" | "error" | "debug"; msg: string };

function makeLogger(): { logger: Logger; logs: LogRec[] } {
	const logs: LogRec[] = [];
	const rec = (level: LogRec["level"]) => (msg: unknown) => {
		logs.push({ level, msg: String(msg) });
	};
	return {
		logger: { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") },
		logs,
	};
}

/** 可切换可达性的 dispatcher。`box.up` 控制 isAvailable。 */
function makeDispatcher(box: { up: boolean }): { dispatcher: FakeDispatcher; sent: string[] } {
	const sent: string[] = [];
	const dispatcher: FakeDispatcher = {
		isAvailable: () => box.up,
		isEnabled: () => true,
		send: async (id) => {
			sent.push(id);
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) => ({ id, name: id }) as unknown as PushTarget,
	};
	return { dispatcher, sent };
}

const emptyStore: SubscriptionStore = {
	list: () => [],
	findByIdentity: () => undefined,
	findById: () => undefined,
	upsert: () => {},
	removeById: () => undefined,
	replaceAll: () => {},
};

const master = {
	id: "m1",
	name: "主人",
	kind: "session",
	scope: "private",
} as unknown as PushTarget;
const text: NotificationPayload = { kind: "text", text: "hi" };

const lv = (logs: LogRec[], level: LogRec["level"], frag: string) =>
	logs.filter((l) => l.level === level && l.msg.includes(frag));

describe("PushRouter — master 可达性边沿状态机(Q5)", () => {
	it("持续不可达只 error 一次,后续 notifyMaster 走 debug 跳过", async () => {
		const box = { up: false };
		const { dispatcher } = makeDispatcher(box);
		const { logger, logs } = makeLogger();
		const push = new PushRouter({ ...pushBase(), dispatcher, store: emptyStore, master, logger });

		push.start(); // 首次未知→不可达 → error 一次
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);

		expect(await push.notifyMaster(text)).toMatchObject({ ok: false, code: "unavailable" }); // 仍不可达
		expect(await push.notifyMaster(text)).toMatchObject({ ok: false, code: "unavailable" }); // 仍不可达
		// 不再追加 error;两次调用各一条 debug 跳过
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);
		expect(lv(logs, "debug", "跳过本次私信通知")).toHaveLength(2);
	});

	it("unreachable→available 恢复 → info 一次 + 私信真正投递", async () => {
		const box = { up: false };
		const { dispatcher, sent } = makeDispatcher(box);
		const { logger, logs } = makeLogger();
		const push = new PushRouter({ ...pushBase(), dispatcher, store: emptyStore, master, logger });

		push.start(); // error 一次
		await push.notifyMaster(text); // debug 跳过

		box.up = true; // 恢复
		const res = await push.notifyMaster(text);
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(1);
		expect(res.ok).toBe(true);
		expect(sent).toEqual(["m1"]); // 真正投递到 master
		// 不抖动:再次可达不重复 info
		await push.notifyMaster(text);
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(1);
	});

	it("健康启动(master 可达)→ 不打 error/info 噪音", () => {
		const box = { up: true };
		const { dispatcher } = makeDispatcher(box);
		const { logger, logs } = makeLogger();
		const push = new PushRouter({ ...pushBase(), dispatcher, store: emptyStore, master, logger });
		push.start();
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(0);
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(0);
	});
	it("setMaster 切目标重置边沿:新目标首次不可达是一次全新 error", async () => {
		const box = { up: true };
		const { dispatcher } = makeDispatcher(box);
		const { logger, logs } = makeLogger();
		const push = new PushRouter({ ...pushBase(), dispatcher, store: emptyStore, master, logger });
		push.start(); // 可达,无 error

		box.up = false;
		push.setMaster({
			id: "m2",
			name: "新主人",
			kind: "session",
			scope: "private",
		} as unknown as PushTarget); // 重置边沿
		await push.notifyMaster(text); // 新目标不可达 → 全新 error 一次
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);
	});
});
