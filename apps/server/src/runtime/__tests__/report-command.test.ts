/**
 * `/report` —— 手动催一份周报。
 *
 * 这是五条指令里**唯一会花钱**的:每跑一次都是一次真实的 AI 调用,几十秒起。所以两件
 * 事必须做对,而且它们是同一件事的两面:
 *
 * - **立刻 ack**。不吭声的话主人会以为没收到,于是再敲一次。
 * - **跑着时不跑第二次**。ack 只是止住手,真正挡住重复调用的是这道闸。
 *
 * 闸还必须在**失败路径上也松开** —— 一次异常把它永久锁死的话,主人得重启服务才能
 * 再要一份周报,而他根本不会想到是这个原因。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { createReportCommand, type ReportOutcome } from "../report-command.js";

/** 手动控制的一轮运行:`finish` 之前一直挂着。 */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const SENT: ReportOutcome = { kind: "sent", mode: "image", sent: 2, failed: [] };

function setup(outcome: ReportOutcome = SENT) {
	const replies: string[] = [];
	const run = vi.fn(async () => outcome);
	const spec = createReportCommand({
		run,
		reply: async (text) => {
			replies.push(text);
		},
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	return { spec, replies, run, fire: (days?: number) => spec.run({ days } as never) };
}

describe("report 指令", () => {
	it("主名英文,中文走别名", () => {
		const { spec } = setup();
		expect(spec.name).toBe("report");
		expect(spec.aliases).toContain("周报");
	});

	it("跑完了报结果", async () => {
		const { replies, fire } = setup();
		await fire();
		expect(replies.at(-1)).toContain("发出去了");
	});

	// 几十秒的活儿不吭声,主人只会以为没收到,然后再敲一次 —— 而每一次都是真金白银。
	it("先 ack,不等跑完", async () => {
		const gate = deferred<ReportOutcome>();
		const replies: string[] = [];
		const spec = createReportCommand({
			run: () => gate.promise,
			reply: async (t) => {
				replies.push(t);
			},
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		const inflight = spec.run({} as never);
		await Promise.resolve();
		expect(replies).toHaveLength(1);
		expect(replies[0]).toContain("稍等");

		gate.resolve(SENT);
		await inflight;
		expect(replies).toHaveLength(2);
	});

	// 真正挡住重复 AI 调用的是这道闸,ack 只是止住手。
	it("跑着的时候再敲 → 不跑第二次", async () => {
		const gate = deferred<ReportOutcome>();
		const run = vi.fn(() => gate.promise);
		const replies: string[] = [];
		const spec = createReportCommand({
			run,
			reply: async (t) => {
				replies.push(t);
			},
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		const first = spec.run({} as never);
		await Promise.resolve();
		await spec.run({} as never);

		expect(run).toHaveBeenCalledTimes(1);
		expect(replies.at(-1)).toContain("还在跑");

		gate.resolve(SENT);
		await first;
	});

	it("跑完之后闸松开,可以再要一份", async () => {
		const { run, fire } = setup();
		await fire();
		await fire();
		expect(run).toHaveBeenCalledTimes(2);
	});

	// 一次异常把闸永久锁死的话,主人得重启服务才能再要一份周报 —— 而他绝想不到是这个。
	it("跑炸了闸也要松开", async () => {
		const replies: string[] = [];
		const run = vi.fn(async () => {
			throw new Error("模型超时");
		});
		const spec = createReportCommand({
			run,
			reply: async (t) => {
				replies.push(t);
			},
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		await spec.run({} as never);
		expect(replies.at(-1)).toContain("没成");

		await spec.run({} as never);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("天数透传给生成", async () => {
		const { run, fire } = setup();
		await fire(14);
		expect(run).toHaveBeenCalledWith(14);
	});

	it("不带天数 → 按配置里的来,不自己编一个默认值", async () => {
		const { run, fire } = setup();
		await fire();
		expect(run).toHaveBeenCalledWith(undefined);
	});

	// parser 只管格式(「是不是个整数」),范围是每条指令自己的业务规则 ——
	// 放进 parser 就得为每条指令在那儿开一个口子。
	it.each([0, -1, 91])("天数越界(%d)→ 挡下来,不去调 AI", async (days) => {
		const { run, replies, fire } = setup();
		await fire(days);
		expect(run).not.toHaveBeenCalled();
		// 光说「不行」等于让主人去猜,把区间说出来。
		expect(replies.at(-1)).toContain("90");
	});

	it("边界值 1 和 90 是合法的", async () => {
		const a = setup();
		await a.fire(1);
		expect(a.run).toHaveBeenCalledTimes(1);
		const b = setup();
		await b.fire(90);
		expect(b.run).toHaveBeenCalledTimes(1);
	});

	it("没配推送目标 → 说清楚,别只回一句失败", async () => {
		const { replies, fire } = setup({ kind: "no-targets" });
		await fire();
		expect(replies.at(-1)).toContain("推送目标");
	});

	it("生成失败 → 带上原因", async () => {
		const { replies, fire } = setup({ kind: "gen-failed", why: "AI 还没配好" });
		await fire();
		expect(replies.at(-1)).toContain("AI 还没配好");
	});

	// 审批开着时,调度器自己已经把草稿连同「回复 y <id>」私聊过去了。
	// 这里再补一句就是同一件事说两遍,而且两份措辞迟早会跑偏。
	it("等审批 → 不重复播报(调度器已经发过草稿了)", async () => {
		const { replies, fire } = setup({ kind: "pending-approval", draftId: "a3f" });
		await fire();
		// 只剩最开始那句 ack
		expect(replies).toHaveLength(1);
		expect(replies[0]).toContain("稍等");
	});

	it("部分目标失败 → 说明发了几个、丢了几个", async () => {
		const { replies, fire } = setup({
			kind: "sent",
			mode: "text",
			sent: 1,
			failed: [{ targetId: "t2", err: "timeout" }],
		});
		await fire();
		expect(replies.at(-1)).toContain("1");
		expect(replies.at(-1)).toContain("失败");
	});
});
