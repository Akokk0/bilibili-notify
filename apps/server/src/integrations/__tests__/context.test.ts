/**
 * 集成上下文 —— 「名册 + 收尾钩子 + 时限 + 停后拒收」这套生命周期。
 *
 * 只经 `createIntegrationContext` 这个工厂测对外行为:拓展上下文、平台适配器、B 站都建在它上面。
 */

import { fail, type Logger, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { inertSettings } from "../../__tests__/support/inert-settings.js";
import { integrationIo } from "../../__tests__/support/integration-io.js";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import { createIntegrationContext } from "../context.js";

function recordingLogger() {
	const lines: string[] = [];
	const logger: Logger = {
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
		debug: (m) => lines.push(`debug ${m}`),
	};
	return { logger, lines };
}

function make(extra: Partial<Parameters<typeof createIntegrationContext>[0]> = {}) {
	const { logger, lines } = recordingLogger();
	const problems = createProblemTable({ logger: silentLogger });
	const redactor = createValueRedactor();
	const handle = createIntegrationContext({
		...integrationIo(),
		logger,
		stopReason: "它停用了",
		...memoryStores(),
		problems,
		reporter: "demo",
		label: () => "演示集成",
		rejectedProblemLevel: "error",
		// 与真装配同形状:每次交来的是这个集成登记过的全部值,按种类整批换。
		redactValues: (values) => redactor.replace("demo", "redact", values),
		settings: inertSettings(),
		...extra,
	});
	return { handle, lines, problems, redactor };
}

describe("createIntegrationContext", () => {
	it("收尾钩子后登记的先跑", async () => {
		const { handle } = make();
		const order: string[] = [];
		handle.ctx.onDispose(() => void order.push("first"));
		handle.ctx.onDispose(() => void order.push("second"));
		handle.ctx.onDispose(async () => {
			await Promise.resolve();
			order.push("third");
		});
		await handle.dispose();
		expect(order).toEqual(["third", "second", "first"]);
	});

	it("一个钩子抛了,其余照跑,并记一行 error", async () => {
		const { handle, lines } = make();
		const ran: string[] = [];
		handle.ctx.onDispose(() => void ran.push("a"));
		handle.ctx.onDispose(() => {
			throw new Error("boom");
		});
		handle.ctx.onDispose(() => void ran.push("c"));
		await handle.dispose();
		expect(ran).toEqual(["c", "a"]);
		expect(lines).toContain("error 收摊钩子抛了:boom");
	});

	it("钩子跑的时候 signal 已经中止,原因是给的那句", async () => {
		const { handle } = make({ stopReason: "拓展 x 停用了" });
		let seen: { aborted: boolean; name?: string; message?: string } | undefined;
		handle.ctx.onDispose(() => {
			const reason = handle.ctx.signal.reason as DOMException;
			seen = { aborted: handle.ctx.signal.aborted, name: reason?.name, message: reason?.message };
		});
		expect(handle.ctx.signal.aborted).toBe(false);
		await handle.dispose();
		expect(seen).toEqual({ aborted: true, name: "AbortError", message: "拓展 x 停用了" });
	});

	it("onStopping 在 signal 中止之前被叫", async () => {
		let abortedAtCall: boolean | undefined;
		let handleRef: ReturnType<typeof make>["handle"] | undefined;
		const { handle } = make({
			onStopping: () => {
				abortedAtCall = handleRef?.ctx.signal.aborted;
			},
		});
		handleRef = handle;
		await handle.dispose();
		expect(abortedAtCall).toBe(false);
		expect(handle.ctx.signal.aborted).toBe(true);
	});

	it("onStopping 抛了不打断收尾,记一行 error", async () => {
		const { handle, lines } = make({
			onStopping: () => {
				throw new Error("宿主炸了");
			},
		});
		const ran: string[] = [];
		handle.ctx.onDispose(() => void ran.push("hook"));
		await handle.dispose();
		expect(ran).toEqual(["hook"]);
		expect(handle.ctx.signal.aborted).toBe(true);
		expect(lines.some((l) => l.startsWith("error ") && l.includes("宿主炸了"))).toBe(true);
	});

	it("总时限到了:排在后面的钩子不再跑,名册照拆", async () => {
		const { handle, lines } = make({ disposeTimeoutMs: 20 });
		const ran: string[] = [];
		let disposedEntry = 0;
		handle.track({
			dispose() {
				disposedEntry += 1;
			},
		});
		handle.ctx.onDispose(() => void ran.push("earliest"));
		handle.ctx.onDispose(() => new Promise<void>(() => {}));
		await handle.dispose();
		// 后登记的先跑:挂住的那个排在前面,最早登记的那个被时限挡在外面。
		expect(ran).toEqual([]);
		expect(disposedEntry).toBe(1);
		expect(lines).toContain("warn 收摊钩子 0.02 秒没跑完 —— 按已收摊处理,排在它后面的钩子不再跑");
	});

	it("track 交回的把手撤掉后,收尾时不再撤第二次", async () => {
		const { handle } = make();
		let count = 0;
		const tracked = handle.track({
			dispose() {
				count += 1;
			},
		});
		tracked.dispose();
		expect(count).toBe(1);
		await handle.dispose();
		expect(count).toBe(1);
	});

	it("收尾之后才 track:当场撤掉并记一行 warn,交回的把手再撤不会第二次撤", async () => {
		const { handle, lines } = make();
		await handle.dispose();
		let count = 0;
		const late = handle.track({
			dispose() {
				count += 1;
			},
		});
		expect(count).toBe(1);
		expect(lines).toContain("warn 已经卸载了,又来登记的一项当场撤掉");
		late.dispose();
		expect(count).toBe(1);
	});

	it("收尾之后才 track、那一项撤的时候抛了 → 记 error,不往外抛", async () => {
		const { handle, lines } = make();
		await handle.dispose();
		expect(() =>
			handle.track({
				dispose() {
					throw new Error("撤不掉");
				},
			}),
		).not.toThrow();
		expect(lines).toContain("error 回收注册项时抛了:撤不掉");
	});

	it("收尾时名册里没撤的注册项逐个撤掉", async () => {
		const { handle } = make();
		const gone: string[] = [];
		handle.track({ dispose: () => void gone.push("a") });
		handle.track({ dispose: () => void gone.push("b") });
		await handle.dispose();
		expect(gone.sort()).toEqual(["a", "b"]);
	});

	it("名册里一项抛了,其余照拆,并记一行 error", async () => {
		const { handle, lines } = make();
		const gone: string[] = [];
		handle.track({ dispose: () => void gone.push("a") });
		handle.track({
			dispose() {
				throw new Error("拆不掉");
			},
		});
		handle.track({ dispose: () => void gone.push("c") });
		await handle.dispose();
		expect(gone).toEqual(["a", "c"]);
		expect(lines).toContain("error 回收注册项时抛了:拆不掉");
	});

	it("收尾之后 onDispose 与 refuse 不生效,各记一行 warn", async () => {
		const { handle, lines } = make();
		await handle.dispose();
		expect(handle.disposed).toBe(true);
		let ran = false;
		handle.ctx.onDispose(() => {
			ran = true;
		});
		const refused = handle.refuse("setTimeout");
		expect(() => refused.dispose()).not.toThrow();
		await handle.dispose();
		expect(ran).toBe(false);
		expect(lines).toContain("warn 已经卸载了,onDispose 不再受理");
		expect(lines).toContain("warn 已经卸载了,setTimeout 不再受理");
	});

	it("dispose 幂等:钩子与 onStopping 只跑一次,一进门 disposed 就是 true", async () => {
		let stopping = 0;
		let hookRuns = 0;
		let disposedInside: boolean | undefined;
		let handleRef: ReturnType<typeof make>["handle"] | undefined;
		const { handle } = make({
			onStopping: () => {
				stopping += 1;
				disposedInside = handleRef?.disposed;
			},
		});
		handleRef = handle;
		handle.ctx.onDispose(() => {
			hookRuns += 1;
		});
		expect(handle.disposed).toBe(false);
		await Promise.all([handle.dispose(), handle.dispose()]);
		await handle.dispose();
		expect(stopping).toBe(1);
		expect(hookRuns).toBe(1);
		expect(disposedInside).toBe(true);
	});
});

/**
 * 问题上报(集成层):报的人是集成键、不带对象;同一个 code 只有一条;收摊时它名下的全清、不补「已恢复」。
 * 校验的规矩与来源层共用一份(`problems/problem-report.ts`),被拒的按选项记 error 或 warn。
 */
describe("createIntegrationContext · reportProblem / resolveProblem", () => {
	it("报一条:问题表里报的人是集成键、不带 about,notify 不进表", () => {
		const { handle, problems } = make();
		handle.ctx.reportProblem({ code: "auth_lost", message: "登录失效了", notify: true });
		expect(problems.list()).toEqual([
			{
				reporter: "demo",
				code: "auth_lost",
				message: "登录失效了",
				since: expect.any(String),
			},
		]);
	});

	it("报问题时盖上这个集成给人看的名字:变更里有 writtenBy,表里没有", () => {
		const { handle, problems } = make();
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		handle.ctx.reportProblem({ code: "auth_lost", message: "登录失效了" });
		expect(changes[0]).toMatchObject({ kind: "opened", writtenBy: "演示集成" });
		expect(problems.list()[0]).not.toHaveProperty("writtenBy");
	});

	it("名字在报的那一刻现取:中途换了名字,下一条变更带新的", () => {
		let name = "甲";
		const { handle, problems } = make({ label: () => name });
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		handle.ctx.reportProblem({ code: "auth_lost", message: "第一句" });
		name = "乙";
		handle.ctx.reportProblem({ code: "auth_lost", message: "第二句" });
		expect(changes.map((c) => c.writtenBy)).toEqual(["甲", "乙"]);
	});

	it("第三方硬塞 writtenBy:被上下文盖掉,表里仍是这个集成的名字", () => {
		const { handle, problems } = make();
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		handle.ctx.reportProblem({
			code: "auth_lost",
			message: "登录失效了",
			writtenBy: "冒充的",
		} as never);
		expect(changes[0]?.writtenBy).toBe("演示集成");
	});

	it("再报同一个 code 只换文案:还是一条", () => {
		const { handle, problems } = make();
		handle.ctx.reportProblem({ code: "auth_lost", message: "第一句" });
		handle.ctx.reportProblem({ code: "auth_lost", message: "第二句" });
		expect(problems.list().map((p) => p.message)).toEqual(["第二句"]);
	});

	it("notify 与 recoveryMessage 原样交给问题表:清掉时补的那句就是给的这句", () => {
		const { handle, problems } = make();
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		handle.ctx.reportProblem({
			code: "auth_lost",
			message: "登录失效了",
			notify: true,
			recoveryMessage: "登录好了",
		});
		handle.ctx.resolveProblem({ code: "auth_lost" });
		expect(changes.map((c) => [c.kind, c.notify, c.recoveryMessage])).toEqual([
			["opened", true, "登录好了"],
			["closed", true, "登录好了"],
		]);
	});

	it("resolveProblem 带 notify: false:清掉但不补已恢复", () => {
		const { handle, problems } = make();
		const changes: ProblemChange[] = [];
		handle.ctx.reportProblem({ code: "auth_lost", message: "登录失效了", notify: true });
		problems.subscribe((c) => changes.push(c));
		handle.ctx.resolveProblem({ code: "auth_lost", notify: false });
		expect(problems.list()).toEqual([]);
		expect(changes.map((c) => [c.kind, c.notify])).toEqual([["closed", false]]);
	});

	it.each([
		["code 不是 snake", { code: "Auth-Lost", message: "x" }],
		["message 是空白", { code: "auth_lost", message: "   " }],
		["recoveryMessage 是空白", { code: "auth_lost", message: "x", recoveryMessage: " " }],
	])("形状不对(%s):不进表,按选项记一行", (_name, input) => {
		const { handle, lines, problems } = make();
		handle.ctx.reportProblem(input);
		expect(problems.list()).toEqual([]);
		expect(lines.filter((l) => l.startsWith("error "))).toHaveLength(1);
	});

	it("resolveProblem 形状不对:不清,记一行", () => {
		const { handle, lines, problems } = make();
		handle.ctx.reportProblem({ code: "auth_lost", message: "x" });
		handle.ctx.resolveProblem({ code: "Bad Code" });
		expect(problems.list()).toHaveLength(1);
		expect(lines.filter((l) => l.startsWith("error "))).toHaveLength(1);
	});

	it("被拒的记成什么等级跟选项走:拓展传 warn 就是 warn,不是 error", () => {
		const { handle, lines } = make({ rejectedProblemLevel: "warn" });
		handle.ctx.reportProblem({ code: "Bad", message: "x" });
		expect(lines.filter((l) => l.startsWith("warn "))).toHaveLength(1);
		expect(lines.filter((l) => l.startsWith("error "))).toEqual([]);
	});

	it("报一条缺 message(第三方 JS 交的):被拒、不进表,onRejectedProblem 收到点名 message 的原因", () => {
		const rejections: Array<{ externalId?: string; reason: string }> = [];
		const { handle, lines, problems } = make({
			onRejectedProblem: (rejection) => rejections.push(rejection),
			rejectedProblemLevel: "warn",
		});
		handle.ctx.reportProblem({ code: "x_down" } as never);
		expect(problems.list()).toEqual([]);
		expect(lines.filter((l) => l.startsWith("warn "))).toHaveLength(1);
		expect(rejections).toEqual([{ reason: "问题「x_down」被拒：message 不是字符串" }]);
	});

	it("给了 onRejectedProblem:照旧记日志,并把给人看的原因交给它", () => {
		const rejections: Array<{ externalId?: string; reason: string }> = [];
		const { handle, lines, problems } = make({
			onRejectedProblem: (rejection) => rejections.push(rejection),
			rejectedProblemLevel: "warn",
		});
		handle.ctx.reportProblem({ code: "Bad", message: "x" });
		expect(problems.list()).toEqual([]);
		expect(lines.filter((l) => l.startsWith("warn "))).toHaveLength(1);
		expect(rejections).toEqual([{ reason: "问题「Bad」被拒：code 不是 snake 风格" }]);
	});

	it("收摊时它名下的全清、不补已恢复;别的报的人的不动", async () => {
		const { handle, problems } = make();
		problems.report({ reporter: "other", code: "x_y", message: "别人的" });
		handle.ctx.reportProblem({ code: "auth_lost", message: "登录失效了", notify: true });
		const changes: ProblemChange[] = [];
		problems.subscribe((c) => changes.push(c));
		await handle.dispose();
		expect(problems.list().map((p) => p.reporter)).toEqual(["other"]);
		expect(changes.map((c) => [c.kind, c.notify])).toEqual([["closed", false]]);
	});

	it("收摊之后再报、再清:都丢弃,各记一行,表里不会再冒出来", async () => {
		const { handle, lines, problems } = make();
		await handle.dispose();
		handle.ctx.reportProblem({ code: "auth_lost", message: "x" });
		handle.ctx.resolveProblem({ code: "auth_lost" });
		expect(problems.list()).toEqual([]);
		expect(lines.filter((l) => l.startsWith("error "))).toHaveLength(2);
	});

	it("收摊钩子跑的时候名下的问题已经清了:钩子里再报也不进表", async () => {
		const { handle, problems } = make();
		handle.ctx.reportProblem({ code: "auth_lost", message: "x" });
		let seenInHook: number | undefined;
		handle.ctx.onDispose(() => {
			handle.ctx.reportProblem({ code: "late_one", message: "收摊时才报" });
			seenInHook = problems.list().length;
		});
		await handle.dispose();
		expect(seenInHook).toBe(0);
		expect(problems.list()).toEqual([]);
	});
});

/**
 * `ctx.redact(value)`:还没存进 `secrets` 的临时凭据先登记,日志按值遮掉。一次登记一个、只增不减,直到收摊;
 * 底下的登记口是整批换的,所以工厂攒住登记过的全部、每次整批交,连续登记不会互相冲掉。值都是假值。
 */
describe("createIntegrationContext · redact", () => {
	it("登记之后,值被遮;没登记的不遮", () => {
		const { handle, redactor } = make();
		handle.ctx.redact("FAKE-TEMP-TOKEN-1");
		expect(redactor.scrub("t=FAKE-TEMP-TOKEN-1 u=FAKE-OTHER-TOKEN")).toBe(
			"t=*** u=FAKE-OTHER-TOKEN",
		);
	});

	it("连续登记几个:都遮,后一个不会把前一个冲掉;同一个登记两次也只是一个", () => {
		const { handle, redactor } = make();
		handle.ctx.redact("FAKE-TEMP-TOKEN-1");
		handle.ctx.redact("FAKE-TEMP-TOKEN-2");
		handle.ctx.redact("FAKE-TEMP-TOKEN-1");
		handle.ctx.redact("FAKE-TEMP-TOKEN-3");
		expect(redactor.scrub("FAKE-TEMP-TOKEN-1 FAKE-TEMP-TOKEN-2 FAKE-TEMP-TOKEN-3")).toBe(
			"*** *** ***",
		);
	});

	it("少于 8 个字符的不遮;空串与不是字符串的忽略,不抛", () => {
		const { handle, redactor } = make();
		handle.ctx.redact("short");
		handle.ctx.redact("");
		expect(() => handle.ctx.redact(undefined as unknown as string)).not.toThrow();
		expect(() => handle.ctx.redact(12345678 as unknown as string)).not.toThrow();
		expect(redactor.scrub("short 12345678")).toBe("short 12345678");
	});

	it("收摊之后:登记过的值撤掉,不再遮", async () => {
		const { handle, redactor } = make();
		handle.ctx.redact("FAKE-TEMP-TOKEN-1");
		await handle.dispose();
		expect(redactor.scrub("FAKE-TEMP-TOKEN-1")).toBe("FAKE-TEMP-TOKEN-1");
	});

	it("收摊钩子跑的时候登记的还遮着(撤在收摊的最后)", async () => {
		const { handle, redactor } = make();
		handle.ctx.redact("FAKE-TEMP-TOKEN-1");
		let inHook: string | undefined;
		handle.ctx.onDispose(() => {
			inHook = redactor.scrub("FAKE-TEMP-TOKEN-1");
		});
		await handle.dispose();
		expect(inHook).toBe("***");
	});

	it("收摊之后再登记:不收,记一行 warn", async () => {
		const { handle, redactor, lines } = make();
		await handle.dispose();
		handle.ctx.redact("FAKE-LATE-TOKEN-1");
		expect(redactor.scrub("FAKE-LATE-TOKEN-1")).toBe("FAKE-LATE-TOKEN-1");
		expect(lines.filter((l) => l.startsWith("warn "))).toHaveLength(1);
	});
});

/**
 * 集成上下文上的 `settings(规则)`:一个集成只有一份实现,由造上下文的人交进来(内置的由读源造,拓展有自己的)。
 * 上下文只管原样放进 `ctx`、收摊时叫它的 `dispose`。
 */
describe("createIntegrationContext · settings", () => {
	const Schema = z.object({ cron: z.string() });

	/** 一个会记「被收了几次」的读手实现:读的是 `current`,换了叫订阅者。 */
	function readerImpl() {
		let current: unknown = { cron: "a" };
		const fns = new Set<() => void>();
		let disposed = 0;
		return {
			impl: {
				settings: (schema: z.ZodType) => ({
					get: () => {
						const parsed = schema.safeParse(current);
						return parsed.success ? ok({ settings: parsed.data }) : fail("invalid", "坏了");
					},
					onChange: (fn: () => void) => {
						fns.add(fn);
						return { dispose: () => void fns.delete(fn) };
					},
				}),
				dispose: () => {
					disposed += 1;
				},
			} as never,
			set(next: unknown) {
				current = next;
				for (const fn of [...fns]) fn();
			},
			disposed: () => disposed,
		};
	}

	// 验红:`ctx.settings` 不放交进来的那一份(换成另造的),这条红。
	it("ctx.settings(规则) 就是交进来的实现:读得到它的值,它说变了才叫", () => {
		const host = readerImpl();
		const { handle } = make({ settings: host.impl });
		const reader = handle.ctx.settings(Schema);
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "a" } });
		const fn = vi.fn();
		reader.onChange(fn);
		host.set({ cron: "b" });
		expect(fn).toHaveBeenCalledTimes(1);
		expect(reader.get()).toEqual({ ok: true, settings: { cron: "b" } });
	});

	// 验红:`dispose()` 里不叫 `opts.settings.dispose()`,这条红。
	it("收摊时叫它的 dispose 一次(幂等)", async () => {
		const host = readerImpl();
		const { handle } = make({ settings: host.impl });
		await handle.dispose();
		await handle.dispose();
		expect(host.disposed()).toBe(1);
	});
});

describe("共同 timezone", () => {
	it("回调同步抛错及异步拒绝不打断其他订阅", async () => {
		const listeners = new Set<() => void>();
		const { handle, lines } = make({
			timezoneReader: {
				timezone: () => "UTC",
				onTimezoneChanged(fn) {
					listeners.add(fn);
					return { dispose: () => void listeners.delete(fn) };
				},
			},
		});
		handle.ctx.onTimezoneChanged(() => {
			throw new Error("sync timezone");
		});
		const seen = vi.fn();
		handle.ctx.onTimezoneChanged(seen);
		expect(() => {
			for (const fn of listeners) fn();
		}).not.toThrow();
		expect(seen).toHaveBeenCalledTimes(1);
		handle.ctx.onTimezoneChanged(async () => {
			throw new Error("async timezone");
		});
		for (const fn of listeners) fn();
		await Promise.resolve();
		expect(seen).toHaveBeenCalledTimes(2);
		expect(lines.join("\n")).toContain("sync timezone");
		expect(lines.join("\n")).toContain("async timezone");
		await handle.dispose();
	});
	it("开始收摊立即摘通知,不等异步钩子,旧ctx不能重新订", async () => {
		const listeners = new Set<() => void>();
		const { handle } = make({
			timezoneReader: {
				timezone: () => "UTC",
				onTimezoneChanged(fn) {
					listeners.add(fn);
					return { dispose: () => void listeners.delete(fn) };
				},
			},
		});
		const seen = vi.fn();
		handle.ctx.onTimezoneChanged(seen);
		let finish!: () => void;
		handle.ctx.onDispose(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const closing = handle.dispose();
		try {
			expect(listeners.size).toBe(0);
			handle.ctx.onTimezoneChanged(seen);
			expect(listeners.size).toBe(0);
			expect(seen).not.toHaveBeenCalled();
		} finally {
			finish();
			await closing;
		}
	});
	it("每次读当前值,订阅不补叫,手动回收后不再叫", async () => {
		let timezone = "UTC";
		const listeners = new Set<() => void>();
		const { handle } = make({
			timezoneReader: {
				timezone: () => timezone,
				onTimezoneChanged(fn) {
					listeners.add(fn);
					return { dispose: () => void listeners.delete(fn) };
				},
			},
		});
		// 先验行为,缺能力时给真实断言红,不靠缺方法抛TypeError。
		const ctx = handle.ctx as typeof handle.ctx & { timezone?: () => string };
		expect(ctx.timezone?.()).toBe("UTC");
		const seen: string[] = [];
		const claim = handle.ctx.onTimezoneChanged(() => seen.push(handle.ctx.timezone()));
		expect(seen).toEqual([]);
		timezone = "Asia/Kathmandu";
		expect(handle.ctx.timezone()).toBe("Asia/Kathmandu");
		for (const fn of listeners) fn();
		expect(seen).toEqual(["Asia/Kathmandu"]);
		claim.dispose();
		claim.dispose();
		timezone = "Asia/Shanghai";
		for (const fn of listeners) fn();
		expect(seen).toEqual(["Asia/Kathmandu"]);
		await handle.dispose();
	});
});
