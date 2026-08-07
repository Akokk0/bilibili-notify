/**
 * 定时锐评调度器。
 *
 * 与手动推送最大的差别是**没人在场**:到点了生成不出来、群把机器人踢了、审批没人
 * 理,全都得自己有个交代。所以这里测的重点不是「顺利时发没发」,而是每条不顺的路
 * 上主人到底知不知情。
 *
 * cron 走 FakeCronJob 捕获 onTick(同 fans-poller / dynamic-engine 的套路),不真排程。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalConfig } from "@bilibili-notify/internal";
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/** 测试替身的统一收口 —— 只填被测路径真正读到的字段,其余不为测试再造一遍类型。 */
// biome-ignore lint/suspicious/noExplicitAny: 见上
type Any = any;

const cronMock = vi.hoisted(() => {
	const instances: Array<{ cronTime: string; onTick: () => void; stopped: boolean }> = [];
	class FakeCronJob {
		running = false;
		stopped = false;
		constructor(
			public cronTime: string,
			public onTick: () => void,
		) {
			// 与真实 CronJob 一致:表达式解析不了就同步抛。调度器不 catch 的话
			// 整个独立端会在启动期崩掉(fans-poller 注释里记着这个坑)。
			if (cronTime === "不是 cron") throw new Error("Unknown cron expression");
			instances.push(this);
		}
		start() {
			this.running = true;
		}
		stop() {
			this.running = false;
			this.stopped = true;
		}
	}
	return { instances, FakeCronJob };
});

vi.mock("cron", () => ({ CronJob: cronMock.FakeCronJob }));

const generateBoardRoast = vi.hoisted(() => vi.fn());
const generateSoloRoast = vi.hoisted(() => vi.fn());
const deliverRoast = vi.hoisted(() => vi.fn());
const buildRoastPayload = vi.hoisted(() => vi.fn());

vi.mock("../../stats/roast-generate.js", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	generateBoardRoast,
	generateSoloRoast,
}));
vi.mock("../../stats/roast-deliver.js", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	deliverRoast,
	buildRoastPayload,
}));

const { createRoastScheduler } = await import("../roast-scheduler.js");
const { createRoastDraftStore } = await import("../roast-draft-store.js");

const BOARD_RESULT = {
	pushText: "本周榜单",
	pigeon: { uid: "1", reason: "鸽" },
	diligent: { uid: "2", reason: "勤" },
	roast: [],
	scores: [],
};

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
} as Any;

let dataDir: string;

/** 真实临时目录 —— 草稿库本来就要落盘,假目录只会测出 ENOENT。 */
function memDrafts() {
	return createRoastDraftStore({ dataDir, logger });
}

let globals: GlobalConfig;
let tellMaster: ReturnType<typeof vi.fn>;
let tellMasterPayload: ReturnType<typeof vi.fn>;

function makeScheduler(over: { subs?: Array<Record<string, unknown>> } = {}) {
	const drafts = memDrafts();
	tellMaster = vi.fn(async () => {});
	tellMasterPayload = vi.fn(async () => {});
	const deps = {
		runtime: {
			engines: { api: {}, imageRenderer: null, push: {} },
			serviceCtx: { logger, setTimeout: () => ({ dispose() {} }) },
			subRuntimeStore: { get: () => undefined },
		},
		store: {
			getGlobals: () => globals,
			getSubscriptions: () => over.subs ?? [],
			getTargets: () => [{ id: "t1" }, { id: "t2" }],
		},
	} as Any;
	const sched = createRoastScheduler({
		deps,
		drafts,
		logger,
		fetchOverview: async () => ({ days: 7, rows: [] }),
		tellMaster: tellMaster as Any,
		tellMasterPayload: tellMasterPayload as Any,
	});
	return { sched, drafts };
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "roast-sched-"));
	cronMock.instances.length = 0;
	globals = makeDefaultGlobalConfig();
	generateBoardRoast.mockReset().mockResolvedValue({ ok: true, result: BOARD_RESULT });
	generateSoloRoast.mockReset().mockResolvedValue({ ok: true, result: BOARD_RESULT });
	deliverRoast.mockReset().mockResolvedValue({ mode: "text", sent: ["t1"], failed: [], text: "x" });
	buildRoastPayload.mockReset().mockResolvedValue({
		mode: "text",
		text: "本周榜单正文",
		payload: { kind: "text", text: "本周榜单正文" },
	});
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("调度器 — 排程", () => {
	it("关着的时候一条 job 都不建", () => {
		const { sched } = makeScheduler();
		sched.start();
		expect(cronMock.instances).toHaveLength(0);
	});

	it("开了就按配置的 cron 建一条", () => {
		globals.roastSchedule = { ...globals.roastSchedule, enabled: true, cron: "0 9 * * 1" };
		const { sched } = makeScheduler();
		sched.start();
		expect(cronMock.instances.map((i) => i.cronTime)).toEqual(["0 9 * * 1"]);
	});

	it("cron 写错了 → 记 error 但不抛,进程不能因为一个配置错误而挂", () => {
		globals.roastSchedule = { ...globals.roastSchedule, enabled: true, cron: "不是 cron" };
		const { sched } = makeScheduler();
		expect(() => sched.start()).not.toThrow();
		expect(logger.error).toHaveBeenCalled();
	});

	it("每位开了单人锐评的 UP 各一条 job", () => {
		const subs = [
			{
				id: "s1",
				uid: "1",
				roastSchedule: { enabled: true, cron: "0 9 * * 2", days: 7, targets: [] },
			},
			{
				id: "s2",
				uid: "2",
				roastSchedule: { enabled: false, cron: "0 9 * * 3", days: 7, targets: [] },
			},
		];
		const { sched } = makeScheduler({ subs });
		sched.start();
		expect(cronMock.instances.map((i) => i.cronTime)).toEqual(["0 9 * * 2"]);
	});
});

describe("调度器 — 到点之后", () => {
	function armed(over: Record<string, unknown> = {}) {
		globals.roastSchedule = {
			...globals.roastSchedule,
			enabled: true,
			targets: ["t1", "t2"],
			...over,
		};
		return makeScheduler();
	}

	it("生成成功、审批关 → 直接发到配置的所有目标", async () => {
		const { sched } = armed();
		await sched.runBoardOnce();
		expect(deliverRoast).toHaveBeenCalledTimes(1);
		expect(deliverRoast.mock.calls[0]?.[1].targetIds).toEqual(["t1", "t2"]);
	});

	it("生成失败 + notifyOnError 开 → 私聊说清原因,不是干等着", async () => {
		generateBoardRoast.mockResolvedValue({ ok: false, kind: "too-few-ups" });
		const { sched } = armed({ notifyOnError: true });
		await sched.runBoardOnce();
		expect(deliverRoast).not.toHaveBeenCalled();
		expect(tellMaster).toHaveBeenCalledTimes(1);
		expect(String(tellMaster.mock.calls[0]?.[0])).toContain("2 位");
	});

	it("生成失败 + notifyOnError 关 → 只记日志,不打扰", async () => {
		generateBoardRoast.mockResolvedValue({ ok: false, kind: "too-few-ups" });
		const { sched } = armed({ notifyOnError: false });
		await sched.runBoardOnce();
		expect(tellMaster).not.toHaveBeenCalled();
	});

	it("一个目标都没配 → 跳过并说明,不白生成一份扔掉", async () => {
		const { sched } = armed({ targets: [] });
		await sched.runBoardOnce();
		expect(generateBoardRoast).not.toHaveBeenCalled();
		expect(deliverRoast).not.toHaveBeenCalled();
		expect(tellMaster).toHaveBeenCalledTimes(1);
	});

	it("审批开 → 存草稿,群里先不发", async () => {
		const { sched, drafts } = armed({ approval: true });
		await sched.runBoardOnce();
		expect(deliverRoast).not.toHaveBeenCalled();
		expect(drafts.list()).toHaveLength(1);
	});

	it("审批开 → 私聊里必须带上**正文**,否则「过目」根本没东西可看", async () => {
		const { sched } = armed({ approval: true });
		await sched.runBoardOnce();
		// 曾经这条私聊只有「已经生成好了」+ 编号 + 超时说明,一个字的内容都没有。
		// 主人对着它只能盲批 —— 审批这功能整个就是假的。
		const sent = tellMasterPayload.mock.calls[0]?.[0];
		expect(JSON.stringify(sent)).toContain("本周榜单正文");
	});

	it("审批开 → 同一条私聊里也要说清楚怎么批", async () => {
		const { sched, drafts } = armed({ approval: true });
		await sched.runBoardOnce();
		const sent = JSON.stringify(tellMasterPayload.mock.calls[0]?.[0]);
		expect(sent).toContain(drafts.list()[0]?.id);
		expect(sent).toContain("y ");
	});

	it("审批开 + 出图 → 私聊发的就是**将来真发出去的那张卡**,不是文字复述", async () => {
		const buf = Buffer.from("fake-png");
		buildRoastPayload.mockResolvedValue({
			mode: "image",
			text: "本周榜单正文",
			payload: {
				kind: "image",
				image: { buffer: buf, mime: "image/jpeg" },
				caption: "本周榜单正文",
			},
		});
		const { sched } = armed({ approval: true });
		await sched.runBoardOnce();
		const sent = tellMasterPayload.mock.calls[0]?.[0];
		expect(sent.kind).toBe("image");
		expect(sent.image.buffer).toBe(buf);
		// 说明文字挂在 caption 上 —— 图发不出去时那段字是唯一还读得到的东西。
		expect(String(sent.caption)).toContain("本周榜单正文");
	});

	it("审批开 → 草稿记下的是**这一刻**的目标快照", async () => {
		const { sched, drafts } = armed({ approval: true });
		await sched.runBoardOnce();
		expect(drafts.list()[0]?.targets).toEqual(["t1", "t2"]);
	});

	it("部分目标发失败 → 汇总告诉主人哪些没成", async () => {
		deliverRoast.mockResolvedValue({
			mode: "image",
			sent: ["t1"],
			failed: [{ targetId: "t2", err: "机器人不在群里" }],
			text: "x",
		});
		const { sched } = armed({ notifyOnError: true });
		await sched.runBoardOnce();
		const msg = String(tellMaster.mock.calls[0]?.[0]);
		expect(msg).toContain("机器人不在群里");
	});

	it("全都发成功 → 不打扰主人(「发成功了」不是需要私聊的事)", async () => {
		const { sched } = armed();
		await sched.runBoardOnce();
		expect(tellMaster).not.toHaveBeenCalled();
	});

	it("一轮里抛出的异常不能逃出 cron 回调 —— 独立端会因 unhandledRejection 关进程", async () => {
		// cron 的回调是同步签名。裸 `void run()` 把 rejected promise 扔进空气,
		// 而 server 的 unhandledRejection 处理器是**直接关掉整个进程**的:草稿
		// 落盘失败这种小事会变成服务停摆。
		globals.roastSchedule = {
			...globals.roastSchedule,
			enabled: true,
			cron: "0 9 * * 1",
			targets: ["t1"],
		};
		generateBoardRoast.mockRejectedValue(new Error("磁盘满了"));
		const { sched } = makeScheduler();
		sched.start();

		const tick = cronMock.instances[0]?.onTick;
		expect(tick).toBeTruthy();
		expect(() => tick?.()).not.toThrow();
		// 微任务跑完,rejection 应该已经被 catch 住并落成一条 error 日志。
		await new Promise((r) => setTimeout(r, 0));
		expect(logger.error).toHaveBeenCalled();
	});

	it("私聊自己抛错 → 不影响这一轮的结论(通知是锦上添花)", async () => {
		// 借一条一定会私聊的路(生成失败 + notifyOnError)来触发。
		generateBoardRoast.mockResolvedValue({ ok: false, kind: "too-few-ups" });
		const { sched } = armed({ notifyOnError: true });
		tellMaster.mockRejectedValue(new Error("master unreachable"));
		await expect(sched.runBoardOnce()).resolves.not.toThrow();
	});
});

/**
 * 一轮跑完到底发生了什么 —— 面板上的「试一次」按钮要靠这个返回值说话。
 *
 * cron 那条路不看返回值(它只需要日志与私聊),但按钮点下去必须能回答「成了没、
 * 发给了谁、还是在等我批」。落进日志的结论对着浏览器的人是看不见的。
 */
describe("调度器 — 一轮的结论", () => {
	function armed(over: Record<string, unknown> = {}) {
		globals.roastSchedule = {
			...globals.roastSchedule,
			enabled: true,
			targets: ["t1", "t2"],
			...over,
		};
		return makeScheduler();
	}

	it("直发成功 → sent,带上投递形态与成功条数", async () => {
		deliverRoast.mockResolvedValue({ mode: "image", sent: ["t1", "t2"], failed: [], text: "x" });
		const { sched } = armed();
		expect(await sched.runBoardOnce()).toEqual({
			kind: "sent",
			mode: "image",
			sent: 2,
			failed: [],
		});
	});

	it("部分失败 → 还是 sent,但把失败的目标原样带出来", async () => {
		deliverRoast.mockResolvedValue({
			mode: "text",
			sent: ["t1"],
			failed: [{ targetId: "t2", err: "机器人不在群里" }],
			text: "x",
		});
		const { sched } = armed();
		const out = await sched.runBoardOnce();
		expect(out).toMatchObject({ kind: "sent", sent: 1 });
		expect(out.kind === "sent" && out.failed).toEqual([{ targetId: "t2", err: "机器人不在群里" }]);
	});

	it("一个目标都没配 → no-targets", async () => {
		const { sched } = armed({ targets: [] });
		expect(await sched.runBoardOnce()).toEqual({ kind: "no-targets" });
	});

	it("生成失败 → gen-failed,带上给人看的原因", async () => {
		generateBoardRoast.mockResolvedValue({ ok: false, kind: "too-few-ups" });
		const { sched } = armed();
		const out = await sched.runBoardOnce();
		expect(out.kind).toBe("gen-failed");
		expect(out.kind === "gen-failed" && out.why).toContain("2 位");
	});

	it("审批开 → pending-approval,带上主人要回的那个编号", async () => {
		const { sched, drafts } = armed({ approval: true });
		const out = await sched.runBoardOnce();
		expect(out).toEqual({ kind: "pending-approval", draftId: drafts.list()[0]?.id });
	});
});
