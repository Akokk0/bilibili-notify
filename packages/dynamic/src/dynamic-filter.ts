import { checkUserRegex, type Logger } from "@bilibili-notify/internal";
import type { Dynamic, DynamicFilterConfig, DynamicFilterResult } from "./types";
import { DynamicFilterReason as Reason } from "./types";

function collectRichText(dynamic: Dynamic, texts: string[]): void {
	const richTextNodes = dynamic.modules?.module_dynamic?.desc?.rich_text_nodes;
	if (richTextNodes?.length) {
		texts.push(richTextNodes.map((n) => n.text ?? "").join(""));
	}
	const summaryNodes = dynamic.modules?.module_dynamic?.major?.opus?.summary?.rich_text_nodes;
	if (summaryNodes?.length) {
		texts.push(summaryNodes.map((n) => n.text ?? "").join(""));
	}
	const title = dynamic.modules?.module_dynamic?.major?.opus?.title;
	if (title) texts.push(title);
	const archiveTitle = dynamic.modules?.module_dynamic?.major?.archive?.title;
	if (archiveTitle) texts.push(archiveTitle);
}

function getDynamicText(dynamic: Dynamic): string {
	const texts: string[] = [];
	collectRichText(dynamic, texts);
	if (dynamic.orig) collectRichText(dynamic.orig, texts);
	return texts.join("\n");
}

const MAX_REGEX_TEST_TEXT_LEN = 10_000;

function safeRegexTest(pattern: string | undefined, text: string, logger?: Logger): boolean {
	if (!pattern) return false;
	// ②2:统一走 @bilibili-notify/internal 的规范化闸门(长度上限 + 嵌套量词
	// **与交替重叠**两类灾难性回溯启发式 + 编译校验)。此前本地 looksCatastrophic
	// 只挡 `(X+)+`,漏 `(a|a)*c`/`(.|.)*c`(35 字符冻 ~60s)—— 单源后不再分叉。
	const check = checkUserRegex(pattern);
	if (!check.ok) {
		// logger 缺省 = silent(纯函数语义);引擎层应传入 ctx.logger 让 warn 走标准日志通道。
		logger?.warn(
			`[bilibili-notify-dynamic] 拒绝执行正则(${check.reason}):"${pattern.slice(0, 80)}"`,
		);
		return false;
	}
	try {
		// 仅对前 N 字符求值,封顶最坏输入规模(多项式回溯的输入侧上限;指数类
		// 嵌套量词∪交替重叠已在上面 checkUserRegex 拦掉)。
		const subject =
			text.length > MAX_REGEX_TEST_TEXT_LEN ? text.slice(0, MAX_REGEX_TEST_TEXT_LEN) : text;
		return new RegExp(pattern).test(subject);
	} catch (e) {
		logger?.warn(
			`[bilibili-notify-dynamic] 无效的正则表达式 "${pattern}": ${(e as Error).message}`,
		);
		return false;
	}
}

function testKeywordMatched(text: string, keywords: string[] | undefined): boolean {
	if (!keywords?.length) return false;
	return keywords.some((kw) => kw && text.includes(kw));
}

export function filterDynamic(
	dynamic: Dynamic,
	config: DynamicFilterConfig,
	logger?: Logger,
): DynamicFilterResult {
	const cfg = {
		enable: false,
		regex: "",
		keywords: [] as string[],
		forward: false,
		article: false,
		draw: false,
		av: false,
		whitelistEnable: false,
		whitelistRegex: "",
		whitelistKeywords: [] as string[],
		...config,
	};

	const text = getDynamicText(dynamic);

	if (cfg.enable) {
		if (cfg.forward && dynamic.type === "DYNAMIC_TYPE_FORWARD") {
			return { blocked: true, reason: Reason.BlacklistForward };
		}
		if (cfg.article && dynamic.type === "DYNAMIC_TYPE_ARTICLE") {
			return { blocked: true, reason: Reason.BlacklistArticle };
		}
		if (cfg.draw && dynamic.type === "DYNAMIC_TYPE_DRAW") {
			return { blocked: true, reason: Reason.BlacklistDraw };
		}
		if (cfg.av && dynamic.type === "DYNAMIC_TYPE_AV") {
			return { blocked: true, reason: Reason.BlacklistAv };
		}
		if (safeRegexTest(cfg.regex, text, logger) || testKeywordMatched(text, cfg.keywords)) {
			return { blocked: true, reason: Reason.BlacklistKeyword };
		}
	}

	if (cfg.whitelistEnable) {
		const hasRule = !!cfg.whitelistRegex || cfg.whitelistKeywords.length > 0;
		if (
			hasRule &&
			!safeRegexTest(cfg.whitelistRegex, text, logger) &&
			!testKeywordMatched(text, cfg.whitelistKeywords)
		) {
			return { blocked: true, reason: Reason.WhitelistUnmatched };
		}
	}

	return { blocked: false };
}

export type { DynamicFilterConfig, DynamicFilterResult };
export { Reason as DynamicFilterReason };
