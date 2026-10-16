/**
 * **下播的附加项锚点**(`recapAnchors`):两个附加项(词云 / AI 总结)各自门控、各是下播那次推送里的一个锚点,
 * 按「词云 → 总结」排;弹幕快照同步取,两样随即各自开始做,内容是各自的约定。
 *
 * 这里只用中立的东西喂它:一个假收集器、两个假生成器、一个把调用原样记成对象的内容构造口。期望值写死成字面量。
 */

import type { ImageRef, Logger } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import type { LiveContentBuilder } from "../../content-builder";
import { type RecapDeps, type RecapOptions, recapAnchors } from "../recap-anchors";

const AVATAR = `${"c".repeat(64)}.webp` as ImageRef;

function options(over: Partial<RecapOptions> = {}): RecapOptions {
	return {
		subscriptionId: "sub-1",
		extras: { wordcloud: true, liveSummary: true },
		summaryTemplate: "总结模板",
		creator: { name: "主播", avatar: AVATAR },
		fanClubName: "小晨",
		...over,
	};
}

const content: LiveContentBuilder = {
	text: (text) => ({ kind: "text", text }),
	image: (source, mime) => ({ kind: "image", source, ...(mime === undefined ? {} : { mime }) }),
	atAll: () => ({ kind: "at-all" }),
	message: (segments) => ({ kind: "message", segments }),
};

function setup(
	opts: {
		sortedWords?: Array<[string, number]>;
		senderRecord?: Record<string, number>;
		image?: Buffer;
		/** 模板那份;不给 = 请求器回 undefined(人数不够)。 */
		summary?: string;
		/** AI 那份;不给 = 请求器没带 ai 这个键。 */
		ai?: Promise<string | undefined>;
	} = {},
) {
	const snapshot = vi.fn((_subscriptionId: string) => ({
		sortedWords: opts.sortedWords ?? [],
		senderRecord: opts.senderRecord ?? {},
		senderCount: 0,
		viewerChatCount: 0,
	}));
	const wordcloudGenerate = vi.fn(
		async (
			_words: Array<[string, number]>,
			_name: string,
			_avatar?: ImageRef,
			_skin?: string,
			_knobs?: unknown,
		) => opts.image,
	);
	const summaryGenerate = vi.fn((_params: Record<string, unknown>) =>
		opts.summary === undefined
			? undefined
			: { template: opts.summary, ...(opts.ai === undefined ? {} : { ai: opts.ai }) },
	);
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const d = {
		collector: { snapshot },
		wordcloud: { generate: wordcloudGenerate },
		summary: { generate: summaryGenerate },
		content,
		logger: logger as unknown as Logger,
	} as unknown as RecapDeps;
	return { d, snapshot, wordcloudGenerate, summaryGenerate, logger };
}

async function settled(anchors: ReturnType<typeof recapAnchors>) {
	return Promise.all(anchors.map(async (a) => [a.role, a.extra, await a.messages]));
}

describe("recapAnchors", () => {
	it("两样都关着:回空数组,没碰收集器与生成器", () => {
		const t = setup();
		const anchors = recapAnchors(
			options({ extras: { wordcloud: false, liveSummary: false } }),
			t.d,
		);
		expect(anchors).toEqual([]);
		expect(t.snapshot).not.toHaveBeenCalled();
		expect(t.wordcloudGenerate).not.toHaveBeenCalled();
		expect(t.summaryGenerate).not.toHaveBeenCalled();
	});

	it("只开词云:只有词云那一个锚点,不问 AI", async () => {
		const t = setup({ image: Buffer.from("img") });
		const anchors = recapAnchors(options({ extras: { wordcloud: true, liveSummary: false } }), t.d);
		expect(await settled(anchors)).toEqual([
			["extra", "wordcloud", [{ kind: "image", source: Buffer.from("img"), mime: "image/jpeg" }]],
		]);
		expect(t.summaryGenerate).not.toHaveBeenCalled();
	});

	it("只开总结:只有总结那一个锚点,词云不算", async () => {
		const t = setup({ summary: "只有总结" });
		const anchors = recapAnchors(options({ extras: { wordcloud: false, liveSummary: true } }), t.d);
		expect(await settled(anchors)).toEqual([
			["extra", "liveSummary", [{ kind: "text", text: "只有总结" }]],
		]);
		expect(t.wordcloudGenerate).not.toHaveBeenCalled();
	});

	it("两样都开:先词云后总结,各带各的键", async () => {
		const t = setup({ image: Buffer.from("img"), summary: "总结文本" });
		expect(await settled(recapAnchors(options(), t.d))).toEqual([
			["extra", "wordcloud", [{ kind: "image", source: Buffer.from("img"), mime: "image/jpeg" }]],
			["extra", "liveSummary", [{ kind: "text", text: "总结文本" }]],
		]);
	});

	it("快照按订阅 id 同步取,两样随即各自开始做(返回之前就已被叫到)", () => {
		const t = setup({ image: Buffer.from("img"), summary: "总结" });
		const anchors = recapAnchors(options(), t.d);
		expect(t.snapshot).toHaveBeenCalledTimes(1);
		expect(t.snapshot).toHaveBeenCalledWith("sub-1");
		expect(t.wordcloudGenerate).toHaveBeenCalledTimes(1);
		expect(t.summaryGenerate).toHaveBeenCalledTimes(1);
		expect(anchors.every((a) => a.messages instanceof Promise)).toBe(true);
	});

	it("订阅额外的停用词:从交给两个生成器的热词里滤掉(逗号分隔、去空白)", async () => {
		const t = setup({
			sortedWords: [
				["刷屏", 10],
				["精彩", 5],
				["哈哈", 3],
			],
		});
		await settled(recapAnchors(options({ wordcloudStopWords: "刷屏, 哈哈" }), t.d));
		expect(t.wordcloudGenerate.mock.calls[0]?.[0]).toEqual([["精彩", 5]]);
		expect(t.summaryGenerate.mock.calls[0]?.[0].sortedWords).toEqual([["精彩", 5]]);
	});

	it("没有额外停用词:热词原样透传", async () => {
		const t = setup({
			sortedWords: [
				["精彩", 5],
				["哈哈", 3],
			],
		});
		await settled(recapAnchors(options(), t.d));
		expect(t.wordcloudGenerate.mock.calls[0]?.[0]).toEqual([
			["精彩", 5],
			["哈哈", 3],
		]);
	});

	it("词云没做出来(生成器回空):那个锚点的 messages 是 undefined;总结同理", async () => {
		const t = setup();
		expect(await settled(recapAnchors(options(), t.d))).toEqual([
			["extra", "wordcloud", undefined],
			["extra", "liveSummary", undefined],
		]);
	});

	it("做的时候出错:那个锚点的约定被拒绝,另一个不受牵连", async () => {
		const t = setup({ summary: "总结" });
		t.wordcloudGenerate.mockRejectedValue(new Error("词云画不出来"));
		const [wordcloud, summary] = recapAnchors(options(), t.d);
		await expect(wordcloud?.messages).rejects.toThrow("词云画不出来");
		expect(await summary?.messages).toEqual([{ kind: "text", text: "总结" }]);
	});

	it("总结有 AI 那份:messages 是模板那串,aiMessages 是 AI 那串;词云锚点永远没有这一格", async () => {
		const t = setup({
			image: Buffer.from("img"),
			summary: "模板总结",
			ai: Promise.resolve("AI 总结"),
		});
		const [wordcloud, summary] = recapAnchors(options(), t.d);
		expect(wordcloud && "aiMessages" in wordcloud).toBe(false);
		expect(await summary?.messages).toEqual([{ kind: "text", text: "模板总结" }]);
		expect(await summary?.aiMessages).toEqual([{ kind: "text", text: "AI 总结" }]);
	});

	it("总结没有 AI 那份:锚点上没有 aiMessages 这个键", async () => {
		const t = setup({ summary: "模板总结" });
		const [, summary] = recapAnchors(options(), t.d);
		expect(summary && "aiMessages" in summary).toBe(false);
		expect(await summary?.messages).toEqual([{ kind: "text", text: "模板总结" }]);
	});

	it("AI 那份兑现成 undefined:aiMessages 兑现成 undefined,模板那串不受影响", async () => {
		const t = setup({ summary: "模板总结", ai: Promise.resolve(undefined) });
		const [, summary] = recapAnchors(options(), t.d);
		expect(await summary?.aiMessages).toBeUndefined();
		expect(await summary?.messages).toEqual([{ kind: "text", text: "模板总结" }]);
	});

	it("请求器同步抛错:总结的 messages 被拒绝,没有 aiMessages,词云不受牵连", async () => {
		const t = setup({ image: Buffer.from("img") });
		t.summaryGenerate.mockImplementation(() => {
			throw new Error("模板渲染炸了");
		});
		const [wordcloud, summary] = recapAnchors(options(), t.d);
		await expect(summary?.messages).rejects.toThrow("模板渲染炸了");
		expect(summary && "aiMessages" in summary).toBe(false);
		expect(await wordcloud?.messages).toEqual([
			{ kind: "image", source: Buffer.from("img"), mime: "image/jpeg" },
		]);
	});

	it("交给总结生成器的入参:发言记录、热词、粉丝团名字、模板与 AI 覆盖", async () => {
		const t = setup({
			sortedWords: [["精彩", 5]],
			senderRecord: { 观众甲: 3 },
			summary: "总结",
		});
		await settled(
			recapAnchors(
				options({
					extras: { wordcloud: false, liveSummary: true },
					aiOverride: { model: "per-up-model" },
				}),
				t.d,
			),
		);
		expect(t.summaryGenerate.mock.calls[0]?.[0]).toStrictEqual({
			senderRecord: { 观众甲: 3 },
			sortedWords: [["精彩", 5]],
			fanClubName: "小晨",
			customLiveSummary: "总结模板",
			aiOverride: { model: "per-up-model" },
		});
	});

	it("交给词云生成器的:热词、主播名、头像与皮肤两格", async () => {
		const t = setup({ sortedWords: [["精彩", 5]], image: Buffer.from("img") });
		const knobs = { "k6eee-cafed00d": { accent: "#aaaaaa" } };
		await settled(
			recapAnchors(
				options({
					extras: { wordcloud: true, liveSummary: false },
					cardSkin: "k6eee-cafed00d",
					cardSkinKnobs: knobs,
				}),
				t.d,
			),
		);
		expect(t.wordcloudGenerate.mock.calls[0]).toEqual([
			[["精彩", 5]],
			"主播",
			AVATAR,
			"k6eee-cafed00d",
			knobs,
		]);
	});

	it("开始做的时候记一条 debug 日志", () => {
		const t = setup();
		recapAnchors(options(), t.d);
		expect(t.logger.debug).toHaveBeenCalledTimes(1);
		expect(String(t.logger.debug.mock.calls[0]?.[0])).toContain("wordcloud=true summary=true");
	});
});
