/**
 * 单元测试 — `BilibiliPush` master 可达性边沿状态机(Q5)。
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
	NotificationSink,
	PushTarget,
} from "@bilibili-notify/internal";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it } from "vite-plus/test";
import { BilibiliPush } from "../bilibili-push";

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

/** 可切换可达性的 sink。`box.up` 控制 isAvailable。 */
function makeSink(box: { up: boolean }): { sink: NotificationSink; sent: string[] } {
	const sent: string[] = [];
	const sink: NotificationSink = {
		isAvailable: () => box.up,
		send: async (id) => {
			sent.push(id);
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		sendPrivate: async (id) => {
			sent.push(id);
			return { ok: true, latencyMs: 1 } as DeliveryResult;
		},
		resolve: (id) => ({ id, name: id }) as unknown as PushTarget,
	};
	return { sink, sent };
}

const emptyStore: SubscriptionStore = {
	list: () => [],
	findByUid: () => undefined,
	findById: () => undefined,
	upsert: () => {},
	removeById: () => undefined,
	replaceAll: () => {},
};

const master = { id: "m1", name: "主人" } as unknown as PushTarget;
const text: NotificationPayload = { kind: "text", text: "hi" };

const lv = (logs: LogRec[], level: LogRec["level"], frag: string) =>
	logs.filter((l) => l.level === level && l.msg.includes(frag));

describe("BilibiliPush — master 可达性边沿状态机(Q5)", () => {
	it("持续不可达只 error 一次,后续 sendToMaster 走 debug 跳过", async () => {
		const box = { up: false };
		const { sink } = makeSink(box);
		const { logger, logs } = makeLogger();
		const push = new BilibiliPush({ sink, store: emptyStore, master, logger });

		push.start(); // 首次未知→不可达 → error 一次
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);

		expect(await push.sendToMaster(text)).toBeNull(); // 仍不可达
		expect(await push.sendToMaster(text)).toBeNull(); // 仍不可达
		// 不再追加 error;两次调用各一条 debug 跳过
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);
		expect(lv(logs, "debug", "跳过本次私信通知")).toHaveLength(2);
	});

	it("unreachable→available 恢复 → info 一次 + 私信真正投递", async () => {
		const box = { up: false };
		const { sink, sent } = makeSink(box);
		const { logger, logs } = makeLogger();
		const push = new BilibiliPush({ sink, store: emptyStore, master, logger });

		push.start(); // error 一次
		await push.sendToMaster(text); // debug 跳过

		box.up = true; // 恢复
		const res = await push.sendToMaster(text);
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(1);
		expect(res).not.toBeNull();
		expect(sent).toEqual(["m1"]); // 真正投递到 master
		// 不抖动:再次可达不重复 info
		await push.sendToMaster(text);
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(1);
	});

	it("健康启动(master 可达)→ 不打 error/info 噪音", () => {
		const box = { up: true };
		const { sink } = makeSink(box);
		const { logger, logs } = makeLogger();
		const push = new BilibiliPush({ sink, store: emptyStore, master, logger });
		push.start();
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(0);
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(0);
	});

	it("recheckMasterReachability:bot 上线后外部复检 → info 恢复一次,无需 sendToMaster", () => {
		// koishi 端在 login-updated/added(bot 上线)时调用它,把启动期那条「不可达」虚警
		// 收尾成「已恢复可达」,而不是干等下一次报错才复检。
		const box = { up: false };
		const { sink } = makeSink(box);
		const { logger, logs } = makeLogger();
		const push = new BilibiliPush({ sink, store: emptyStore, master, logger });

		push.start(); // 启动时 bot 未上线 → 不可达 error 一次
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);

		box.up = true; // bot 上线
		push.recheckMasterReachability();
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(1);

		// 再次复检不抖动(仍可达不重复 info)
		push.recheckMasterReachability();
		expect(lv(logs, "info", "master 目标已恢复可达")).toHaveLength(1);
	});

	it("recheckMasterReachability:无 master 时是 no-op,不抛", () => {
		const box = { up: true };
		const { sink } = makeSink(box);
		const { logger, logs } = makeLogger();
		const push = new BilibiliPush({ sink, store: emptyStore, master: null, logger });
		push.start();
		expect(() => push.recheckMasterReachability()).not.toThrow();
		expect(logs).toHaveLength(0);
	});

	it("setMaster 切目标重置边沿:新目标首次不可达是一次全新 error", async () => {
		const box = { up: true };
		const { sink } = makeSink(box);
		const { logger, logs } = makeLogger();
		const push = new BilibiliPush({ sink, store: emptyStore, master, logger });
		push.start(); // 可达,无 error

		box.up = false;
		push.setMaster({ id: "m2", name: "新主人" } as unknown as PushTarget); // 重置边沿
		await push.sendToMaster(text); // 新目标不可达 → 全新 error 一次
		expect(lv(logs, "error", "告警背channel已断")).toHaveLength(1);
	});
});
