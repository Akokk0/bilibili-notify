/**
 * 一次 AI 调用花了多少 token —— 读法与记账。
 *
 * 只进日志,不落盘、不上面板、不换算成本。存在的理由是让主人能在日志里看见
 * 「这条点评吃了多少、缓存命中了多少」,而不必去各家控制台对账单。
 */

/**
 * 一轮请求的用量,四格。**缺的格子是 undefined,不是 0** —— 0 是「真的一个
 * 都没有」,把「没报」写成 0 会让日志凭空多出一笔「零缓存命中」,比不写更误导。
 */
export interface TokenUsage {
	input: number | undefined;
	/** 缓存命中。它**包含在** {@link input} 里,两者不能相加。 */
	cached: number | undefined;
	output: number | undefined;
	/** 思考。它**包含在** {@link output} 里。 */
	reasoning: number | undefined;
}

/** 只认非负有限数 —— 网关塞来的字符串、null、负数一律当没报。 */
function count(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 安全地往下取一层;不是对象就 undefined。厂商扩展字段不在 SDK 类型里,只能这么读。 */
function field(obj: unknown, key: string): unknown {
	return obj !== null && typeof obj === "object"
		? (obj as Record<string, unknown>)[key]
		: undefined;
}

/**
 * 把一份 usage 读成四格。两套协议的字段名互不相交,一个函数兼收:
 *
 * - chat completions:`prompt_tokens` / `completion_tokens`;缓存命中优先
 *   `prompt_tokens_details.cached_tokens`,其次顶层 `prompt_cache_hit_tokens`
 *   (DeepSeek / 硅基流动的厂商扩展),两者都有而不同时取较大者 —— 有的家
 *   标准字段恒报 0、真数只写在扩展里;思考在 `completion_tokens_details.reasoning_tokens`。
 * - Responses API:`input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`
 *   / `output_tokens_details.reasoning_tokens`。
 */
export function readTokenUsage(raw: unknown): TokenUsage {
	const stdCached = count(field(field(raw, "prompt_tokens_details"), "cached_tokens"));
	const vendorCached = count(field(raw, "prompt_cache_hit_tokens"));
	const chatCached =
		stdCached !== undefined && vendorCached !== undefined
			? Math.max(stdCached, vendorCached)
			: (stdCached ?? vendorCached);
	return {
		input: count(field(raw, "prompt_tokens")) ?? count(field(raw, "input_tokens")),
		cached: chatCached ?? count(field(field(raw, "input_tokens_details"), "cached_tokens")),
		output: count(field(raw, "completion_tokens")) ?? count(field(raw, "output_tokens")),
		reasoning:
			count(field(field(raw, "completion_tokens_details"), "reasoning_tokens")) ??
			count(field(field(raw, "output_tokens_details"), "reasoning_tokens")),
	};
}

/**
 * 把各轮加总。**任何一轮缺某一格,总数那格就是 undefined** —— 半截的和比
 * 「不知道」更误导:它看起来像个准数,其实少算了那一轮。
 */
function sumRounds(rounds: readonly TokenUsage[]): TokenUsage {
	const total = (key: keyof TokenUsage): number | undefined => {
		if (rounds.length === 0) return undefined;
		let sum = 0;
		for (const r of rounds) {
			const v = r[key];
			if (v === undefined) return undefined;
			sum += v;
		}
		return sum;
	};
	return {
		input: total("input"),
		cached: total("cached"),
		output: total("output"),
		reasoning: total("reasoning"),
	};
}

/**
 * 一次**逻辑调用**的用量日志行 —— 工具环跑了几轮就加总几轮,只出这一行。
 *
 * `unfinished`:调用中途失败 / 被取消,但之前已有几轮成功返回(那几轮的 token
 * 已经花出去了,照记,只是标一句别让人当成一次完整的回答)。
 *
 * `unit`:`rounds` 每一项算作什么。缺省「轮」(工具环);看图一批几张图并发各发
 * 一次,那不是先后的轮次,写「张」。
 */
export function formatUsageLine(
	label: string,
	model: string,
	rounds: readonly TokenUsage[],
	opts: { unfinished?: boolean; unit?: "轮" | "张" } = {},
): string {
	const t = sumRounds(rounds);
	const n = (v: number | undefined) => (v === undefined ? "未知" : String(v));
	return `[usage] ${label} · 模型=${model} · ${rounds.length} ${opts.unit ?? "轮"} · 输入 ${n(t.input)}(缓存命中 ${n(t.cached)})· 输出 ${n(t.output)}(思考 ${n(t.reasoning)})${opts.unfinished ? "· 未完成" : ""}`;
}
