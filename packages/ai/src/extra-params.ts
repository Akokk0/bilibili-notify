/**
 * 「额外请求参数」—— 主人手写的一段 JSON,原样摊进请求体顶层。
 *
 * 这是方言适配的兜底口。我们只适配了四家,而 OpenAI 兼容生态里还有几十家;
 * 联网搜索更是分裂到没法统一(OpenRouter 用 `plugins`、硅基用 `enable_search`、
 * DeepSeek 官方压根没有),与其做一个到处失效的开关,不如把口子交出去。
 */

/**
 * 不许从这个框里覆盖的字段。它们不是「调参」,是请求的骨架 —— 被覆盖之后的
 * 症状全都表现为「女仆突然变笨/失忆」,而没有人会往一个叫「额外参数」的框上想。
 *
 * - `model` / `messages`:整段对话与模型选择,覆盖 = 请求变成另一回事
 * - `input`:responses 风味下的整段对话,与 `messages` 同罪
 * - `stream`:流式与非流式在代码里是两条分支,这里改它只会让分支与实际不符
 * - `tools` / `tool_choice`:覆盖会连带废掉看图(describe_image)与全部只读工具
 */
const BLOCKED_KEYS = ["model", "messages", "input", "stream", "tools", "tool_choice"] as const;

export interface ParsedExtraParams {
	/** 解析是否成功。**被挡掉危险键不算失败** —— 剩下的参数照常生效。 */
	ok: boolean;
	/** 可安全摊进请求体的部分;失败时为空对象。 */
	value: Record<string, unknown>;
	/** 失败原因,给日志与配置页用。 */
	error?: string;
	/** 被闸挡掉的键名。 */
	dropped?: string[];
}

/**
 * 解析主人手写的 JSON。**任何情况下都不抛** —— 一个填错的文本框不该让整条
 * 推送链路挂掉;调用方拿到 `ok:false` 时按「这次不带额外参数」继续,并把
 * `error` 记进日志。
 */
export function parseExtraParams(raw: string | undefined | null): ParsedExtraParams {
	const src = (raw ?? "").trim();
	if (!src) return { ok: true, value: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(src);
	} catch (e) {
		return {
			ok: false,
			value: {},
			error: `额外请求参数不是合法 JSON:${e instanceof Error ? e.message : String(e)}`,
		};
	}

	// `[1,2]` / `42` / `null` 都能过 JSON.parse,摊进请求体却毫无意义。
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, value: {}, error: '额外请求参数必须是一个 JSON 对象,比如 {"top_k": 40}' };
	}

	const value: Record<string, unknown> = {};
	const dropped: string[] = [];
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if ((BLOCKED_KEYS as readonly string[]).includes(k)) dropped.push(k);
		else value[k] = v;
	}
	return dropped.length > 0 ? { ok: true, value, dropped } : { ok: true, value };
}

/**
 * 把额外参数并到内建参数上。**冲突时主人赢** —— 这个口子存在的意义就是推翻
 * 我们的猜测(嫌那套 effort 映射不合胃口,直接给 `reasoning.max_tokens` 之类)。
 *
 * 两个入参都不改动:降级重试会拿同一份 extraParams 再合一次。
 */
export function mergeExtraParams(
	base: Record<string, unknown>,
	extra: Record<string, unknown>,
): Record<string, unknown> {
	return { ...base, ...extra };
}
