/**
 * 五条内置指令办不成时,主人实际在私聊里收到的**整句话**。
 *
 * 经真的分发器验:喂一条私聊进去,断言回到会话里的那几句。「XX 没办成：」的前缀由分发器按
 * 主人敲的词统一加(本名敲本名、别名敲别名),实质的话来自各指令。
 * 办成了的回话不在这儿测,各指令自己的测试钉着。
 */

import { fail, type NotificationPayload, ok, type Result } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createCommandDispatcher } from "../command-dispatcher.js";
import { createLoginCommand } from "../login-command.js";
import { createMuteCommand } from "../mute-command.js";
import { createMuteState } from "../mute-state.js";
import { createReportCommand, type ReportOutcome } from "../report-command.js";
import { createStatusCommand } from "../status-command.js";

const MASTER = "10001";
const META = { connectionId: "a1", platform: "onebot" };
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 用真指令搭一个真分发器;返回喂私聊的函数,结果是会话里收到的每一句文字。 */
function harness(commands: Parameters<typeof createCommandDispatcher>[0]["commands"]) {
	const texts: string[] = [];
	const dispatcher = createCommandDispatcher({
		logger: quietLogger,
		masterIdentity: () => ({ platform: "onebot", address: MASTER }),
		sendToAddress: async (_c, _s, payload: NotificationPayload) => {
			if (payload.kind === "text") texts.push(payload.text);
			return ok({ latencyMs: 0 });
		},
		config: () => ({ enabled: true, prefix: "/", aliases: {} }),
		commands,
	});
	return {
		texts,
		send: async (text: string) => {
			texts.length = 0;
			await dispatcher.handleMessage({ userId: MASTER, text }, META);
			return [...texts];
		},
	};
}

const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function loginHarness(opts: {
	begin?: Result;
	state?: Parameters<typeof createLoginCommand>[0]["state"];
	imageSent?: boolean;
}) {
	const texts: string[] = [];
	const dispatcher = createCommandDispatcher({
		logger: quietLogger,
		masterIdentity: () => ({ platform: "onebot", address: MASTER }),
		sendToAddress: async (_c, _s, payload: NotificationPayload) => {
			if (payload.kind === "text") texts.push(payload.text);
			if (payload.kind === "image" && opts.imageSent === false) {
				return fail("unavailable", "测试里没送到");
			}
			return ok({ latencyMs: 0 });
		},
		config: () => ({ enabled: true, prefix: "/", aliases: {} }),
		commands: [
			createLoginCommand({
				begin: async () => opts.begin ?? ok(),
				state:
					opts.state ??
					(() => ({
						status: "awaiting-scan",
						qr: { dataUrl: QR_DATA_URL, expiresAt: "2026-10-13T00:03:00.000Z" },
					})),
				logger: quietLogger,
			}),
		],
	});
	return async (text: string) => {
		texts.length = 0;
		await dispatcher.handleMessage({ userId: MASTER, text }, META);
		return [...texts];
	};
}

describe("login 办不成", () => {
	it("发起就失败:把登录系统给的话原样放在前缀后(本名)", async () => {
		const send = loginHarness({ begin: fail("unavailable", "获取二维码失败，请重试") });
		expect(await send("/login")).toEqual(["『login』没办成：获取二维码失败，请重试"]);
	});

	it("发起就失败:敲别名就填别名", async () => {
		const send = loginHarness({ begin: fail("unavailable", "登录系统还没起来") });
		expect(await send("/扫码")).toEqual(["『扫码』没办成：登录系统还没起来"]);
	});

	it("状态是出错:转述状态自带的话", async () => {
		const send = loginHarness({
			state: () => ({ status: "error", message: "获取二维码失败，请重试" }),
		});
		expect(await send("/登录")).toEqual(["『登录』没办成：获取二维码失败，请重试"]);
	});

	it("没拿到码、状态里也没话:说「没拿到二维码」", async () => {
		const send = loginHarness({ state: () => ({ status: "logged-out" }) });
		expect(await send("/login")).toEqual(["『login』没办成：没拿到二维码，稍后再试试～"]);
	});

	it("二维码发不出去:让主人去控制台扫", async () => {
		const send = loginHarness({ imageSent: false });
		expect(await send("/login")).toEqual(["『login』没办成：二维码发不出去，去控制台扫吧～"]);
	});

	it("已扫码、等确认不是失败:直接转述,不加「没办成」", async () => {
		const send = loginHarness({
			state: () => ({ status: "confirming", message: "已扫码，请在手机上确认" }),
		});
		expect(await send("/login")).toEqual(["已扫码，请在手机上确认"]);
	});
});

describe("report 办不成", () => {
	function reportHarness(outcome: ReportOutcome | Error, gate?: Promise<void>) {
		return harness([
			createReportCommand({
				logger: quietLogger,
				run: async () => {
					await gate;
					if (outcome instanceof Error) throw outcome;
					return outcome;
				},
			}),
		]);
	}

	it("天数越界:把区间说出来", async () => {
		const { send } = reportHarness({ kind: "sent", mode: "text", sent: 1, failed: [] });
		expect(await send("/report 0")).toEqual(["『report』没办成：天数要在 1 到 90 之间哦～"]);
		expect(await send("/周报 91")).toEqual(["『周报』没办成：天数要在 1 到 90 之间哦～"]);
	});

	it("还没配推送目标", async () => {
		const { send } = reportHarness({ kind: "no-targets" });
		expect(await send("/report")).toEqual([
			"好的，在生成了，稍等～",
			"『report』没办成：还没配推送目标呢，周报没地方发～",
		]);
	});

	it("生成失败:带上原因", async () => {
		const { send } = reportHarness({
			kind: "gen-failed",
			code: "not_configured",
			message: "AI 还没配好",
		});
		expect(await send("/周报")).toEqual(["好的，在生成了，稍等～", "『周报』没办成：AI 还没配好"]);
	});

	it("跑的过程中抛错:原因跟在前缀后", async () => {
		const { send } = reportHarness(new Error("模型超时"));
		expect(await send("/report")).toEqual(["好的，在生成了，稍等～", "『report』没办成：模型超时"]);
	});

	it("上一份还在跑:这次被挡回", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { send } = reportHarness({ kind: "pending-approval", draftId: "a3f" }, gate);
		// 第一条同步跑到「running = true」才让出;第二条此时敲进来就是「上一份还在跑」。
		const first = send("/report");
		const second = await send("/report");
		release();
		await first;
		expect(second).toEqual(["『report』没办成：还在跑呢，稍等一下下～"]);
	});

	it("部分目标失败不算办不成:正常回话", async () => {
		const { send } = reportHarness({
			kind: "sent",
			mode: "text",
			sent: 1,
			failed: [{ targetId: "t2", message: "timeout" }],
		});
		expect(await send("/report")).toEqual([
			"好的，在生成了，稍等～",
			"周报发出去了：1 个成功，1 个失败。",
		]);
	});
});

describe("mute / status 没有失败分支", () => {
	it("mute 办成只有它自己的回话,框架不加", async () => {
		let stored = 0;
		const { send } = harness([
			createMuteCommand({
				muteState: createMuteState({
					read: () => stored,
					write: async (v) => {
						stored = v;
					},
				}),
			}),
		]);
		const out = await send("/mute 3h");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("之前不打扰你");
		expect(out[0]).not.toContain("没办成");
	});

	it("status 办成只有状态那一段", async () => {
		const { send } = harness([
			createStatusCommand({
				probe: () => ({
					login: { status: "logged-out" },
					sources: [],
					renderQueue: 0,
					connections: [],
					mutedUntil: 0,
				}),
			}),
		]);
		const out = await send("/status");
		expect(out).toHaveLength(1);
		expect(out[0]).not.toContain("没办成");
	});
});
