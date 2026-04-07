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

function safeRegexTest(pattern: string | undefined, text: string): boolean {
	if (!pattern) return false;
	try {
		return new RegExp(pattern).test(text);
	} catch (e) {
		console.warn(
			`[bilibili-notify-dynamic] 无效的正则表达式 "${pattern}": ${(e as Error).message}`,
		);
		return false;
	}
}

function testKeywordMatched(text: string, keywords: string[] | undefined): boolean {
	if (!keywords?.length) return false;
	return keywords.some((kw) => kw && text.includes(kw));
}

export function filterDynamic(dynamic: Dynamic, config: DynamicFilterConfig): DynamicFilterResult {
	const cfg = {
		enable: false,
		regex: "",
		keywords: [] as string[],
		forward: false,
		article: false,
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
		if (safeRegexTest(cfg.regex, text) || testKeywordMatched(text, cfg.keywords)) {
			return { blocked: true, reason: Reason.BlacklistKeyword };
		}
	}

	if (cfg.whitelistEnable) {
		const hasRule = !!cfg.whitelistRegex || cfg.whitelistKeywords.length > 0;
		if (
			hasRule &&
			!safeRegexTest(cfg.whitelistRegex, text) &&
			!testKeywordMatched(text, cfg.whitelistKeywords)
		) {
			return { blocked: true, reason: Reason.WhitelistUnmatched };
		}
	}

	return { blocked: false };
}

export type { DynamicFilterConfig, DynamicFilterResult };
export { Reason as DynamicFilterReason };
