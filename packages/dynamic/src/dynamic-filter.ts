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
		// 仅对前 N 字符求值,封顶最坏输入规模 —— **只对多项式回溯有用**。
		// 指数类不吃这一套:`(a{0,30}){0,30}` 配 34 个字符就够把这条同步调用钉死
		// (2026-08-25 实测跑满 30 秒),离这里的一万字远得很。也就是说,指数类全靠
		// 上面那道 checkUserRegex 挡,它漏一个,这里就是整个进程挂死的地方 ——
		// 这条调用是同步的,没有超时隔离。
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

/** 缺省的过滤配置:什么都不拦。 */
const FILTER_DEFAULTS = {
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
};

/**
 * **只看文字**的那一半(ADR-0019 决策 70):屏蔽关键词 / 屏蔽正则(`enable` 开着才判),再白名单。
 * 四个类型开关它不看 —— 它根本不知道类型。
 *
 * B 站的 {@link filterDynamic} 先判类型、再把文字交给它;拓展的作品只过它(类型开关对拓展一律不看:
 * 抖音几乎全是视频,全局开着「屏蔽视频」就会把整个号吞掉)。看的文字由调用方拼好:B 站是正文 +
 * 摘要 + 标题 + 转发原文,拓展是正文 + 视频标题。
 */
export function filterByText(
	text: string,
	config: DynamicFilterConfig,
	logger?: Logger,
): DynamicFilterResult {
	const cfg = { ...FILTER_DEFAULTS, ...config };

	if (cfg.enable) {
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

export function filterDynamic(
	dynamic: Dynamic,
	config: DynamicFilterConfig,
	logger?: Logger,
): DynamicFilterResult {
	const cfg = { ...FILTER_DEFAULTS, ...config };

	// 类型开关只对 B 站:排在文字之前(屏蔽开着才判),文字那一半与拓展共用。
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
	}

	return filterByText(getDynamicText(dynamic), config, logger);
}

/**
 * 「屏蔽后提醒」那句话(过滤配置的 `notify` 开着时发给这条订阅的目标)。B 站六种原因各一句;拓展的
 * 作品只会命中关键词与白名单两种,那两句的叫法换成平台的(`postNoun`,ADR-0019 决策 70)—— 缺省
 * 「动态」,就是 B 站的原话。
 */
export function blockedNotice(name: string, reason: Reason, postNoun = "动态"): string {
	switch (reason) {
		case Reason.BlacklistKeyword:
			return `${name}发布了一条含有屏蔽关键字的${postNoun}`;
		case Reason.BlacklistForward:
			return `${name}转发了一条动态，已屏蔽`;
		case Reason.BlacklistArticle:
			return `${name}投稿了一条专栏，已屏蔽`;
		case Reason.BlacklistDraw:
			return `${name}发布了一条图文动态，已屏蔽`;
		case Reason.BlacklistAv:
			return `${name}投稿了一条视频，已屏蔽`;
		case Reason.WhitelistUnmatched:
			return `${name}发布了一条不在白名单范围内的${postNoun}，已屏蔽`;
	}
}

export type { DynamicFilterConfig, DynamicFilterResult };
export { Reason as DynamicFilterReason };
