/**
 * 直播总结请求器:模板那份恒备好(同步),AI 那份只在门开着且有 commentary 时才有,
 * 是不会拒绝的约定(失败 / 空串都兑现成 undefined)。
 *
 * 验红:把 `live-summary-requester.ts` 退回「AI 成功就不渲染模板」→ 「门开」「挂着」两条红;
 * 让 AI 失败时约定拒绝 → 「comment 抛错」那条红。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { LIVE_SUMMARY_MIN_SENDERS, LiveSummaryRequester } from "../live-summary-requester";

const SENDERS = Object.fromEntries(
	Array.from({ length: 6 }, (_, i) => [`观众${i}`, i + 1]),
) as Record<string, number>;

const PARAMS = {
	senderRecord: SENDERS,
	sortedWords: [["晚安", 3]] as Array<[string, number]>,
	fanClubName: "小晨",
	customLiveSummary: "共{dmc}人，{un1}发了{dc1}条，{fanclub}",
};

function setup(
	over: {
		comment?: (...args: unknown[]) => Promise<string>;
		enabled?: boolean;
		commentary?: boolean;
	} = {},
) {
	const comment = vi.fn(over.comment ?? (async () => "AI 总结"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const requester = new LiveSummaryRequester({
		commentary:
			over.commentary === false
				? null
				: ({ comment } as unknown as ConstructorParameters<
						typeof LiveSummaryRequester
					>[0]["commentary"]),
		isAiEnabled: () => over.enabled !== false,
		logger,
	});
	return { requester, comment, logger };
}

describe("LiveSummaryRequester.generate", () => {
	it("发言人数不足:回 undefined,不问 AI", () => {
		const { requester, comment } = setup();
		const few = Object.fromEntries(
			Array.from({ length: LIVE_SUMMARY_MIN_SENDERS - 1 }, (_, i) => [`观众${i}`, 1]),
		);
		expect(requester.generate({ ...PARAMS, senderRecord: few })).toBeUndefined();
		expect(comment).not.toHaveBeenCalled();
	});

	it("门开、commentary 在:模板那份已按模板渲染,AI 那份兑现成 comment 的回答,只问一次", async () => {
		const { requester, comment } = setup();
		const made = requester.generate(PARAMS);
		expect(made?.template).toBe("共6人，观众5发了6条，小晨");
		expect(await made?.ai).toBe("AI 总结");
		expect(comment).toHaveBeenCalledTimes(1);
		expect(comment.mock.calls[0]?.[1]).toBe("liveSummary");
	});

	it("门关:只有模板那份,没有 ai 这个键,没问 AI", () => {
		const { requester, comment } = setup({ enabled: false });
		const made = requester.generate(PARAMS);
		expect(made?.template).toBe("共6人，观众5发了6条，小晨");
		expect(made && "ai" in made).toBe(false);
		expect(comment).not.toHaveBeenCalled();
	});

	it("没有 commentary:只有模板那份,没有 ai 这个键", () => {
		const { requester } = setup({ commentary: false });
		const made = requester.generate(PARAMS);
		expect(made?.template).toBe("共6人，观众5发了6条，小晨");
		expect(made && "ai" in made).toBe(false);
	});

	it("comment 抛错:AI 那份兑现成 undefined(不拒绝),记一条 error,模板照常", async () => {
		const { requester, logger } = setup({
			comment: async () => {
				throw new Error("服务商挂了");
			},
		});
		const made = requester.generate(PARAMS);
		expect(made?.template).toBe("共6人，观众5发了6条，小晨");
		await expect(made?.ai).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(String(logger.error.mock.calls[0]?.[0])).toContain("服务商挂了");
	});

	it("comment 回空串:AI 那份兑现成 undefined(当没有 AI 版)", async () => {
		const { requester } = setup({ comment: async () => "" });
		await expect(requester.generate(PARAMS)?.ai).resolves.toBeUndefined();
	});

	it("comment 挂着不兑现:模板那份此刻已经拿得到", () => {
		const { requester } = setup({ comment: () => new Promise<string>(() => {}) });
		const made = requester.generate(PARAMS);
		expect(made?.template).toBe("共6人，观众5发了6条，小晨");
		expect(made?.ai).toBeInstanceOf(Promise);
	});
});
