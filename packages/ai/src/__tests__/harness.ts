/**
 * `packages/ai` 测试共用的脚手架。
 *
 * 收编前:那段 `ServiceContext` 假件在九个测试文件里**逐字节相同**地抄了九遍,
 * 引擎配置字面量抄了八遍,`streamOf` 五遍、`textChunk` 四遍。代价不是行数 ——
 * 是**改一次得动九处,而漏改一处不会红**:那个文件只会安静地继续测另一套配置,
 * 直到某天有人发现两个测试对同一件事给出相反的结论。
 *
 * **openai 那个假客户端刻意没收进来。** `vi.mock` 会被提到文件顶端、连 import
 * 都在它之后,配套的 `vi.hoisted` 更是在一切之前跑 —— 它拿不到任何 import 进来的
 * 东西。而且各文件要的形状本来就不同:有的只要 `chat`,responses 风味那两个还要
 * `responses`,`persona-prompt-*` 另外还蒙掉 `../tools`。那八行留在各自文件里是
 * 对的,别硬收。
 */

import type { BilibiliAPI } from "@bilibili-notify/api";
import type { ServiceContext } from "@bilibili-notify/internal";
import { CommentaryGenerator, type CommentaryGeneratorConfig } from "../commentary-generator";

/**
 * 什么都不做的 ServiceContext。
 *
 * 定时器返回一个空 `dispose`,而不是真去 `setTimeout` —— 真定时器会把测试拖到
 * 挂,而这个包的被测面(取样、重试、节流)全都只关心「登记过没有」。
 */
export function fakeServiceCtx(): ServiceContext {
	return {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		setInterval: () => ({ dispose() {} }),
		setTimeout: () => ({ dispose() {} }),
		onDispose: () => {},
	};
}

/**
 * 引擎配置的公共底,`over` 覆盖。
 *
 * 这些值是**测试的默认底**,不是产品默认值 —— 挑它们只图一件事:每一项都不触发
 * 任何可选路径(不思考、不看图、custom 方言),于是每个测试文件只需要写出**它
 * 自己要拨动的那一项**,读的人一眼就知道这条测试在乎什么。
 */
export function aiConfig(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGeneratorConfig {
	return {
		apiKey: "sk-test",
		baseURL: "https://api.test/v1",
		model: "gpt-test",
		persona: { preset: "assistant" },
		dynamicPrompt: "DYN",
		liveSummaryPrompt: "LIVE",
		enableConversation: true,
		maxHistory: 5,
		provider: "custom",
		enableThinking: false,
		thinkingLevel: "high",
		enableVision: false,
		...over,
	};
}

/** 一台按公共底装好的 generator。`api` 是空壳 —— 用得到它的测试自己传。 */
export function makeGen(over: Partial<CommentaryGeneratorConfig> = {}): CommentaryGenerator {
	return new CommentaryGenerator({
		serviceCtx: fakeServiceCtx(),
		api: {} as BilibiliAPI,
		config: aiConfig(over),
	});
}

/**
 * 把一串分片包成 SDK 那种异步可迭代 —— `create()` 开了 stream 之后返回的就是它。
 *
 * 刻意是**普通函数返回对象**而不是 `async function*`:生成器只能迭代一次,而
 * `mockResolvedValue`(不带 Once)会把同一个返回值喂给每一次调用,第二次拿到的
 * 就是一个已经耗尽的流 —— 症状是「第一条测试过、第二条空手而归」。
 */
export function streamOf(chunks: readonly unknown[]): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c;
		},
	};
}

/** chat 风味里的一片正文。 */
export const textChunk = (text: string) => ({ choices: [{ delta: { content: text } }] });
