/**
 * 直播总结的联网搜索 override —— requester 只负责把 `isWebSearchEnabled()` 的
 * 答案翻成这一次 comment() 的 `override.webSearch`,per-UP 的 aiOverride 不能丢。
 * 执行器在不在、要不要真挂工具,是生成器的事。
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { LiveSummaryRequester } from "../live-summary-requester";

const SENDERS: Array<[string, number]> = [
	["观众5", 6],
	["观众4", 5],
	["观众3", 4],
	["观众2", 3],
	["观众1", 2],
];

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
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	return { requester, comment };
}

const PARAMS = {
	sourceKey: "fake",
	topSenders: SENDERS,
	senderCount: 6,
	viewerChatCount: 21,
	sortedWords: [["晚安", 3]] as Array<[string, number]>,
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
			["fake"],
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
			["fake"],
		);
	});
});

describe("LiveSummaryRequester × 粉丝团名", () => {
	it("没有粉丝团名 → 提示词里整项不写『粉丝团名』", async () => {
		const { requester, comment } = makeRequester();
		await requester.generate({ ...PARAMS });
		expect(comment.mock.calls[0]?.[0]).not.toContain("粉丝团名");
	});

	it("有粉丝团名 → 提示词写『粉丝团名：小晨』,排在发言人数之后", async () => {
		const { requester, comment } = makeRequester();
		await requester.generate({ ...PARAMS, fanClubName: "小晨" });
		expect(comment.mock.calls[0]?.[0]).toContain("弹幕发言人数：6，粉丝团名：小晨，弹幕总数：21");
	});

	it("没有粉丝团名 → 模板里的粉丝团名渲染成空串(同今天)", () => {
		const { requester } = makeRequester();
		const out = requester.generate({ ...PARAMS, customLiveSummary: "牌{fanclub}尾" });
		expect(out?.template).toBe("牌尾");
	});
});
