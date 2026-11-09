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

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { recordingCtx } from "../../__tests__/support/command-ctx.js";
import { i18n } from "../../i18n/index.js";
import { createReportCommand, type ReportResult } from "../report-command.js";

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

const SENT: ReportResult = { kind: "sent", mode: "image", sent: 2, failed: [] };
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

function setup(outcome: ReportResult = SENT) {
	const replies: string[] = [];
	const run = vi.fn(async () => outcome);
	const spec = createReportCommand({
		run,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	});
	return {
		spec,
		replies,
		run,
		fire: (days?: number) => spec.run({ days } as never, recordingCtx(replies)),
	};
}

describe("report 指令", () => {
	it.each([
		[
			"en",
			{
				all: "Weekly report sent. All targets succeeded (total: 2).",
				one: "Weekly report sent: 2 succeeded, 1 failed.",
				two: "Weekly report sent: 2 succeeded, 2 failed.",
				days: "Days",
				description: "Generate a weekly report now",
				details:
					"This can take tens of seconds. Repeating the command while it runs will not start another report or incur another charge.",
				ack: "Generating the report. Please wait.",
			},
		],
		[
			"ja",
			{
				all: "週次レポートを送信しました。全2件の送信先で成功しました。",
				one: "週次レポートを送信しました：成功2件、失敗1件。",
				two: "週次レポートを送信しました：成功2件、失敗2件。",
				days: "日数",
				description: "今すぐ週次レポートを生成",
				details:
					"生成に数十秒かかることがあります。実行中に再度入力しても、重複生成や追加の課金は発生しません。",
				ack: "レポートを生成しています。しばらくお待ちください。",
			},
		],
		[
			"zh-TW",
			{
				all: "週報已傳送，全部 2 個目標皆成功。",
				one: "週報已傳送：成功 2 個，失敗 1 個。",
				two: "週報已傳送：成功 2 個，失敗 2 個。",
				days: "天數",
				description: "立即產生週報",
				details: "產生過程可能需要數十秒，執行期間重複輸入不會再次產生，也不會重複付費。",
				ack: "正在產生週報，請稍候。",
			},
		],
	] as const)(
		"%s localizes report metadata, immediate acknowledgment and delivery counts without duplicate generation",
		async (locale, text) => {
			let outcome: ReportResult = SENT;
			const replies: string[] = [];
			const run = vi.fn(async () => outcome);
			const spec = createReportCommand({
				run,
				logger: { debug() {}, info() {}, warn() {}, error() {} },
			});
			const gate = deferred<ReportResult>();
			const gatedRun = vi.fn(() => gate.promise);
			const gated = createReportCommand({
				run: gatedRun,
				logger: { debug() {}, info() {}, warn() {}, error() {} },
			});
			i18n.set({ locale, voice: "plain" });
			expect(spec.parameterLabels).toEqual({ days: text.days });
			expect(spec.description).toBe(text.description);
			expect(spec.details).toBe(text.details);
			for (const [failed, message] of [
				[[], text.all],
				[[{ targetId: "Original target", message: "Original diagnostic 原文" }], text.one],
				[
					[
						{ targetId: "Original target", message: "Original diagnostic 原文" },
						{ targetId: "Original second", message: "Original second diagnostic" },
					],
					text.two,
				],
			] as const) {
				outcome = { kind: "sent", mode: "image", sent: 2, failed: [...failed] };
				expect(await spec.run({ days: 7 }, recordingCtx(replies))).toEqual({ ok: true });
				expect(replies.slice(-2)).toEqual([text.ack, message]);
			}
			outcome = { kind: "pending-approval", draftId: "Original draft" };
			const previous = replies.length;
			expect(await spec.run({}, recordingCtx(replies))).toEqual({ ok: true });
			expect(replies.slice(previous)).toEqual([text.ack]);
			expect(run).toHaveBeenCalledTimes(4);
			const gatedReplies: string[] = [];
			const first = gated.run({ days: 7 }, recordingCtx(gatedReplies));
			try {
				await Promise.resolve();
				expect(gatedReplies).toEqual([text.ack]);
				expect(await gated.run({}, recordingCtx(gatedReplies))).toMatchObject({
					ok: false,
					code: "conflict",
				});
				expect(gatedRun).toHaveBeenCalledTimes(1);
			} finally {
				gate.resolve(SENT);
				await first;
			}
			expect(gatedReplies).toEqual([text.ack, text.all]);
		},
	);

	it.each([
		[
			"en",
			"Days must be between 1 and 90.",
			"A report is already running. Please wait.",
			"No push targets are configured for the report.",
		],
		[
			"ja",
			"日数は1〜90の範囲で指定してください。",
			"レポートを実行中です。しばらくお待ちください。",
			"レポートの送信先が設定されていません。",
		],
		[
			"zh-TW",
			"天數須介於 1 到 90 之間。",
			"報表仍在執行，請稍候。",
			"尚未設定推送目標，無法傳送週報。",
		],
	] as const)(
		"%s translates range, unavailable-target and busy replies while preserving the generation gate",
		async (locale, range, busy, noTargets) => {
			i18n.set({ locale, voice: "plain" });
			const empty = setup({ kind: "no-targets" });
			expect(await empty.fire(0)).toMatchObject({ ok: false, code: "invalid", message: range });
			expect(empty.run).not.toHaveBeenCalled();
			expect(await empty.fire()).toMatchObject({
				ok: false,
				code: "not_configured",
				message: noTargets,
			});
			const gate = deferred<ReportResult>();
			const run = vi.fn(() => gate.promise);
			const spec = createReportCommand({
				run,
				logger: { debug() {}, info() {}, warn() {}, error() {} },
			});
			const ctx = recordingCtx([]);
			i18n.set({ locale: "zh-CN", voice: "maid" });
			const inflight = spec.run({}, ctx);
			try {
				await Promise.resolve();
				i18n.set({ locale, voice: "plain" });
				expect(await spec.run({}, ctx)).toMatchObject({
					ok: false,
					code: "conflict",
					message: busy,
				});
				expect(run).toHaveBeenCalledTimes(1);
			} finally {
				gate.resolve(SENT);
				await inflight;
			}
		},
	);

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
		const gate = deferred<ReportResult>();
		const replies: string[] = [];
		const ctx = recordingCtx(replies);
		const spec = createReportCommand({
			run: () => gate.promise,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		const inflight = spec.run({} as never, ctx);
		await Promise.resolve();
		expect(replies).toHaveLength(1);
		expect(replies[0]).toContain("稍等");

		gate.resolve(SENT);
		await inflight;
		expect(replies).toHaveLength(2);
	});

	// 真正挡住重复 AI 调用的是这道闸,ack 只是止住手。
	it("跑着的时候再敲 → 不跑第二次", async () => {
		const gate = deferred<ReportResult>();
		const run = vi.fn(() => gate.promise);
		const replies: string[] = [];
		const ctx = recordingCtx(replies);
		const spec = createReportCommand({
			run,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		const first = spec.run({} as never, ctx);
		await Promise.resolve();
		// 第二次被挡回:失败交给分发器说(整句见 command-failure-texts.test.ts)。
		expect(await spec.run({} as never, ctx)).toMatchObject({
			ok: false,
			code: "conflict",
			message: "还在跑呢，稍等一下下～",
		});

		expect(run).toHaveBeenCalledTimes(1);

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
		const ctx = recordingCtx(replies);
		const run = vi.fn(async () => {
			throw new Error("模型超时");
		});
		const spec = createReportCommand({
			run,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		expect(await spec.run({} as never, ctx)).toMatchObject({
			ok: false,
			code: "unavailable",
			message: "模型超时",
		});

		await spec.run({} as never, ctx);
		expect(run).toHaveBeenCalledTimes(2);
	});

	// 「失败路径上也松开」不只指 run 炸:**ack 那句回复本身**也可能 reject(适配器
	// 瞬断)。它曾写在 running=true 之后、try 之前 —— reject 一次,finally 永不
	// 执行,running 卡死 true,此后每次 /report 都被「还在跑呢」挡到重启为止。
	it("ack 回复失败,闸也要松开(不能卡死在「还在跑」)", async () => {
		let ackShouldFail = true;
		const replies: string[] = [];
		const base = recordingCtx(replies);
		const ctx = {
			reply: async (payload: Parameters<typeof base.reply>[0]) => {
				if (ackShouldFail && typeof payload === "string" && payload.includes("在生成了")) {
					ackShouldFail = false;
					throw new Error("adapter 瞬断");
				}
				return base.reply(payload);
			},
		};
		const run = vi.fn(async () => ({ kind: "sent" }) as never);
		const spec = createReportCommand({
			run,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
		});
		await spec.run({} as never, ctx).catch(() => {});
		// 第二次必须能真的跑,而不是被卡死的闸挡回
		await spec.run({} as never, ctx);
		expect(run).toHaveBeenCalled();
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
		const { run, fire } = setup();
		// 光说「不行」等于让主人去猜,把区间说出来。
		expect(await fire(days)).toMatchObject({
			ok: false,
			code: "invalid",
			message: "天数要在 1 到 90 之间哦～",
		});
		expect(run).not.toHaveBeenCalled();
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
		const { fire } = setup({ kind: "no-targets" });
		expect(await fire()).toMatchObject({
			ok: false,
			code: "not_configured",
			message: "还没配推送目标呢，周报没地方发～",
		});
	});

	it("生成失败 → 带上原因", async () => {
		const { fire } = setup({
			kind: "gen-failed",
			code: "not_configured",
			message: "AI 还没配好",
		});
		// 码沿用生成失败自己的码;「周报没生成出来：」那个前缀改由分发器统一加。
		expect(await fire()).toMatchObject({
			ok: false,
			code: "not_configured",
			message: "AI 还没配好",
		});
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
			failed: [{ targetId: "t2", message: "timeout" }],
		});
		await fire();
		expect(replies.at(-1)).toContain("1");
		expect(replies.at(-1)).toContain("失败");
	});
});
