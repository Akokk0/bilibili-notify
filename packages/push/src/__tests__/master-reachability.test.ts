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
import { createI18n, type Locale } from "@bilibili-notify/internal/i18n";
import {
	bindPackageText,
	PACKAGE_DICTS,
	type PackageTextKey,
} from "@bilibili-notify/internal/texts";
import type { SubscriptionStore } from "@bilibili-notify/subscription";
import { describe, expect, it, vi } from "vite-plus/test";
import { PushRouter } from "../push-router";
import { type FakeDispatcher, pushBase } from "./helpers";

type LogRec = { level: "info" | "warn" | "error" | "debug"; msg: string; args: readonly unknown[] };

function makeLogger(): { logger: Logger; logs: LogRec[] } {
	const logs: LogRec[] = [];
	const rec =
		(level: LogRec["level"]) =>
		(msg: string, ...args: unknown[]) => {
			logs.push({ level, msg, args });
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
		supportsAtAll: () => true,
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
	listByIdentity: () => [],
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
		expect(lv(logs, "error", "运行状态通知将无法送达")).toHaveLength(1);

		expect(await push.notifyMaster(text)).toMatchObject({ ok: false, code: "unavailable" }); // 仍不可达
		expect(await push.notifyMaster(text)).toMatchObject({ ok: false, code: "unavailable" }); // 仍不可达
		// 不再追加 error;两次调用各一条 debug 跳过
		expect(lv(logs, "error", "运行状态通知将无法送达")).toHaveLength(1);
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
		expect(lv(logs, "info", "通知目标已恢复可达")).toHaveLength(1);
		expect(res.ok).toBe(true);
		expect(sent).toEqual(["m1"]); // 真正投递到 master
		// 不抖动:再次可达不重复 info
		await push.notifyMaster(text);
		expect(lv(logs, "info", "通知目标已恢复可达")).toHaveLength(1);
	});

	it("健康启动(master 可达)→ 不打 error/info 噪音", () => {
		const box = { up: true };
		const { dispatcher } = makeDispatcher(box);
		const { logger, logs } = makeLogger();
		const push = new PushRouter({ ...pushBase(), dispatcher, store: emptyStore, master, logger });
		push.start();
		expect(lv(logs, "error", "运行状态通知将无法送达")).toHaveLength(0);
		expect(lv(logs, "info", "通知目标已恢复可达")).toHaveLength(0);
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
		expect(lv(logs, "error", "运行状态通知将无法送达")).toHaveLength(1);
	});
});

describe("推送日志语言", () => {
	it("通知目标不可达的说明按当前四语输出，口吻保持平实且不重复报错", async () => {
		const texts = createI18n<PackageTextKey, Locale>({
			dicts: PACKAGE_DICTS,
			fallback: "zh-CN",
			locale: "zh-CN",
			voice: "maid",
		});
		const binding = bindPackageText(texts.t);
		try {
			for (const [locale, expected] of [
				[
					"en",
					"Notification target is unreachable; runtime status notifications cannot be delivered",
				],
				["ja", "通知先に接続できないため、稼働状態の通知を配信できません"],
				["zh-TW", "通知目標無法連線，執行狀態通知將無法送達"],
				["zh-CN", "通知目标不可达，运行状态通知将无法送达"],
			] as const) {
				texts.set({ locale, voice: "maid" });
				const { dispatcher } = makeDispatcher({ up: false });
				const { logger, logs } = makeLogger();
				const router = new PushRouter({
					...pushBase(),
					dispatcher,
					store: emptyStore,
					master,
					logger,
				});
				router.start();
				await router.notifyMaster(text);
				await router.notifyMaster(text);
				expect(logs.filter(({ level }) => level === "error")).toEqual([
					{
						level: "error",
						msg: expected,
						args: [{ event: "push.master_unreachable", targetId: "m1" }],
					},
				]);
				expect(logs.filter(({ level }) => level === "debug")).toHaveLength(2);
				texts.set({ locale: "zh-CN" });
				expect(logs[0]?.msg).toBe(expected);
				router.stop();
			}
		} finally {
			binding.dispose();
		}
	});
});

it("派发器抛错时保留原错误与 cause，日志明确结果不明且不自动重试", async () => {
	const texts = createI18n<PackageTextKey, Locale>({
		dicts: PACKAGE_DICTS,
		fallback: "zh-CN",
		locale: "en",
		voice: "maid",
	});
	const binding = bindPackageText(texts.t);
	try {
		const cause = new Error("socket closed after write");
		const error = new Error("uncertain delivery", { cause });
		const send = vi.fn(async () => {
			throw error;
		});
		const { dispatcher } = makeDispatcher({ up: true });
		const { logger, logs } = makeLogger();
		const router = new PushRouter({
			...pushBase(),
			dispatcher: { ...dispatcher, send },
			store: emptyStore,
			logger,
		});
		const result = await router.sendToTarget("target-1", text);
		expect(result).toEqual({ ok: false, code: "indeterminate", message: "uncertain delivery" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(logs).toEqual([
			{
				level: "error",
				msg: "Dispatch threw; delivery is indeterminate and will not be retried automatically",
				args: [{ event: "push.delivery_indeterminate", targetId: "target-1" }, error],
			},
		]);
		expect(logs[0]?.args[1]).toBe(error);
		router.stop();
	} finally {
		binding.dispose();
	}
});
