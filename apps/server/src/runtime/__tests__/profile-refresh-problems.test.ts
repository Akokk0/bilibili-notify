import { type CreatorProfileReport, fail, ok, type Subscription } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createProblemTable, type ProblemChange } from "../../problems/problem-table.js";
import { startProfileRefreshHarness } from "./profile-refresh-support.js";

const sub = (id: string, sourceKey: string, externalId: string): Subscription =>
	({ id, identity: { sourceKey, externalId }, enabled: true }) as Subscription;
const report = (name: string): CreatorProfileReport => ({ name, followers: 100 });

let close: (() => void) | undefined;
afterEach(() => {
	close?.();
	close = undefined;
});

describe("资料刷新的问题表", () => {
	it("来源回 not_found 时记在来源名下、关于这条订阅,并且不私聊", async () => {
		const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const problems = createProblemTable({ logger: logger as never });
		const changes: ProblemChange[] = [];
		problems.subscribe((change) => changes.push(change));
		const missing = vi.fn(async () => fail("not_found", "creator was deleted"));
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("sub-1", "alpha", "creator-1")],
			sources: { alpha: missing },
			problems,
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
			problems.dispose();
		};

		await p.handle.pollNow();

		const problem = expect.objectContaining({
			reporter: "alpha",
			about: { subscriptionId: "sub-1" },
			code: "creator_not_found",
			message: expect.stringMatching(/creator-1.*creator was deleted/s),
			since: expect.any(String),
		});
		expect(problems.list()).toEqual([problem]);
		expect(changes).toEqual([
			expect.objectContaining({
				kind: "opened",
				problem,
				notify: false,
			}),
		]);
	});

	it("下一轮同一条拉取成功时清掉问题", async () => {
		const problems = createProblemTable({ logger: loggerOf() });
		const results = [fail("not_found", "creator was deleted"), ok(report("Creator"))];
		const source = vi.fn(async () => results.shift() ?? ok(report("Creator")));
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("sub-1", "alpha", "creator-1")],
			sources: { alpha: source },
			problems,
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
			problems.dispose();
		};

		await p.handle.pollNow();
		expect(problems.list()).toHaveLength(1);
		await p.handle.pollNow();

		expect(problems.list()).toEqual([]);
	});

	it("订阅停用时清掉问题,但不补已恢复", async () => {
		const problems = createProblemTable({ logger: loggerOf() });
		const changes: ProblemChange[] = [];
		problems.subscribe((change) => changes.push(change));
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("sub-1", "alpha", "creator-1")],
			sources: {
				alpha: async () => fail("not_found", "creator was deleted"),
			},
			problems,
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
			problems.dispose();
		};
		await p.handle.pollNow();
		const disabled = { ...sub("sub-1", "alpha", "creator-1"), enabled: false };
		p.setSubscriptions([disabled]);

		p.bus.emit("subscription-changed", { ops: [{ kind: "update", sub: disabled }] });

		expect(problems.list()).toEqual([]);
		expect(changes.at(-1)).toEqual(expect.objectContaining({ kind: "closed", notify: false }));
	});

	it("暂时失败不记 creator_not_found", async () => {
		const problems = createProblemTable({ logger: loggerOf() });
		const p = await startProfileRefreshHarness({
			subscriptions: [sub("sub-1", "alpha", "creator-1")],
			sources: {
				alpha: async () => fail("rate_limited", "upstream blocked"),
			},
			problems,
		});
		close = () => {
			p.handle.dispose();
			p.cache.dispose();
			problems.dispose();
		};

		await p.handle.pollNow();

		expect(problems.list()).toEqual([]);
	});
});

function loggerOf() {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}
