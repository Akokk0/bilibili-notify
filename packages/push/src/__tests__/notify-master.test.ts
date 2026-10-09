/**
 * 单元测试 — `PushRouter.notifyMaster`(3a-18):告诉主人一声的唯一口。
 *
 * 契约:
 *   - 字符串当纯文字消息,消息体原样发;走普通的 `dispatcher.send`(没有「强制私聊」那条路了)
 *   - 结果码:已销毁 `unavailable`;没配主人 `not_configured`;主人目标不是私聊 `invalid`(发送时复检的兜底);
 *     主人目标不可达 `unavailable`;其余照派发器的结果
 *   - 只发、不记 error 日志(要记的由调用方自己打)
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

const emptyStore: SubscriptionStore = {
	list: () => [],
	findByIdentity: () => undefined,
	findById: () => undefined,
	upsert: () => {},
	removeById: () => undefined,
	replaceAll: () => {},
};

const PRIVATE = {
	id: "m1",
	name: "主人",
	kind: "session",
	scope: "private",
} as unknown as PushTarget;
const GROUP = { id: "g1", name: "群", kind: "session", scope: "group" } as unknown as PushTarget;

function setup(
	over: { master?: PushTarget | null; isAvailable?: boolean; result?: DeliveryResult } = {},
) {
	const sent: Array<{ id: string; payload: NotificationPayload }> = [];
	const dispatcher: FakeDispatcher = {
		isAvailable: () => over.isAvailable ?? true,
		supportsAtAll: () => true,
		isEnabled: () => true,
		send: async (id, payload) => {
			sent.push({ id, payload });
			return over.result ?? ({ ok: true, latencyMs: 1 } as DeliveryResult);
		},
		resolve: (id) => ({ id, name: id }) as unknown as PushTarget,
	};
	const { logger, logs } = makeLogger();
	const push = new PushRouter({
		...pushBase(),
		dispatcher,
		store: emptyStore,
		master: over.master === undefined ? PRIVATE : over.master,
		logger,
	});
	return { push, sent, logs };
}

describe("PushRouter.notifyMaster", () => {
	it("字符串 → 当纯文字消息发给主人目标", async () => {
		const { push, sent } = setup();
		const r = await push.notifyMaster("账号登录已失效");
		expect(r.ok).toBe(true);
		expect(sent).toEqual([{ id: "m1", payload: { kind: "text", text: "账号登录已失效" } }]);
	});

	it("消息体 → 原样发,不改写", async () => {
		const { push, sent } = setup();
		const payload: NotificationPayload = {
			kind: "image",
			image: { buffer: Buffer.from("x"), mime: "image/png" },
		};
		const r = await push.notifyMaster(payload);
		expect(r.ok).toBe(true);
		expect(sent).toEqual([{ id: "m1", payload }]);
	});

	it("已销毁 → unavailable,不发", async () => {
		const { push, sent } = setup();
		push.stop();
		expect(await push.notifyMaster("hi")).toMatchObject({ ok: false, code: "unavailable" });
		expect(sent).toHaveLength(0);
	});

	it("没配主人 → not_configured,不发", async () => {
		const { push, sent } = setup({ master: null });
		expect(await push.notifyMaster("hi")).toMatchObject({ ok: false, code: "not_configured" });
		expect(sent).toHaveLength(0);
	});

	it("主人目标是群 → invalid(发送时复检),不发", async () => {
		const { push, sent } = setup({ master: GROUP });
		expect(await push.notifyMaster("hi")).toMatchObject({ ok: false, code: "invalid" });
		expect(sent).toHaveLength(0);
	});

	it("主人目标不可达 → unavailable,不发", async () => {
		const { push, sent } = setup({ isAvailable: false });
		expect(await push.notifyMaster("hi")).toMatchObject({ ok: false, code: "unavailable" });
		expect(sent).toHaveLength(0);
	});

	it("其余照派发器的结果:失败原样带回", async () => {
		const failure: DeliveryResult = { ok: false, code: "rate_limited", message: "慢点" };
		const { push } = setup({ result: failure });
		expect(await push.notifyMaster("hi")).toEqual(failure);
	});

	it("只发、不记 error 日志(没配主人 / 目标是群 / 发送失败都一样)", async () => {
		for (const over of [
			{ master: null },
			{ master: GROUP },
			{ result: { ok: false, code: "unknown", message: "boom" } as DeliveryResult },
		]) {
			const { push, logs } = setup(over);
			await push.notifyMaster("hi");
			expect(logs.filter((l) => l.level === "error")).toEqual([]);
		}
	});
});
