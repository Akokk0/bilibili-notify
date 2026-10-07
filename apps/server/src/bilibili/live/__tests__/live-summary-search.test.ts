/**
 * 直播总结的联网搜索 override —— requester 只负责把 `isWebSearchEnabled()` 的
 * 答案翻成这一次 comment() 的 `override.webSearch`,per-UP 的 aiOverride 不能丢。
 * 执行器在不在、要不要真挂工具,是生成器的事。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { LiveSummaryRequester } from "../live-summary-requester";

const SENDERS = Object.fromEntries(
	Array.from({ length: 6 }, (_, i) => [`观众${i}`, i + 1]),
) as Record<string, number>;

function makeRequester(over: { webSearch?: boolean } = {}) {
	// 显式标注参数,否则 vi.fn 推出空参元组,.mock.calls[0][3] 会触发 TS2493。
	const comment = vi.fn(
		async (
			_content: string,
			_scene?: string,
			_imgs?: string[],
			_override?: Record<string, unknown>,
		) => "AI 总结",
	);
	const requester = new LiveSummaryRequester({
		commentary: { comment } as unknown as ConstructorParameters<
			typeof LiveSummaryRequester
		>[0]["commentary"],
		isAiEnabled: () => true,
		...(over.webSearch !== undefined ? { isWebSearchEnabled: () => over.webSearch === true } : {}),
		templateRenderer: { render: vi.fn() } as unknown as ConstructorParameters<
			typeof LiveSummaryRequester
		>[0]["templateRenderer"],
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	return { requester, comment };
}

const PARAMS = {
	senderRecord: SENDERS,
	sortedWords: [["晚安", 3]] as Array<[string, number]>,
	master: undefined,
	customLiveSummary: "",
};

describe("LiveSummaryRequester × webSearch", () => {
	it("isWebSearchEnabled=true → override 带 webSearch:true,per-UP 覆盖字段保留", async () => {
		const { requester, comment } = makeRequester({ webSearch: true });
		await requester.generate({ ...PARAMS, aiOverride: { model: "per-up-model" } });
		expect(comment).toHaveBeenCalledWith(
			expect.any(String),
			"liveSummary",
			undefined,
			expect.objectContaining({ webSearch: true, model: "per-up-model" }),
		);
	});

	it("没接 isWebSearchEnabled → override 原样透传(现状不变)", async () => {
		const { requester, comment } = makeRequester();
		await requester.generate({ ...PARAMS, aiOverride: { model: "per-up-model" } });
		const override = comment.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
		expect(override?.model).toBe("per-up-model");
		expect(override?.webSearch).toBeUndefined();
	});

	it("开着但这场没有 per-UP 覆盖 → 也得有 override:{webSearch:true}", async () => {
		const { requester, comment } = makeRequester({ webSearch: true });
		await requester.generate({ ...PARAMS });
		expect(comment).toHaveBeenCalledWith(
			expect.any(String),
			"liveSummary",
			undefined,
			expect.objectContaining({ webSearch: true }),
		);
	});
});
