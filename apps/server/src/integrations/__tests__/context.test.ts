/**
 * 集成上下文 —— 「名册 + 收尾钩子 + 时限 + 停后拒收」这套生命周期。
 *
 * 只经 `createIntegrationContext` 这个工厂测对外行为:拓展上下文、平台适配器、B 站都建在它上面。
 */

import type { Logger } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { memoryStores } from "../../__tests__/support/memory-key-value-store.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
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
	const handle = createIntegrationContext({
		logger,
		stopReason: "它停用了",
		...memoryStores(),
		problems,
		reporter: "demo",
		rejectedProblemLevel: "error",
		...extra,
	});
	return { handle, lines, problems };
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
