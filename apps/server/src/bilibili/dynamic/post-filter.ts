/**
 * **作品过滤**:吃平台中立的 `Post`,一份实现,所有来源(B 站、拓展)同一个(ADR-0021 决策 43、ADR-0028 决策 1)。
 *
 * - 文字:`postText(post, "plain")` —— 取段只此一份,过滤看到的与 AI、出卡是同一份字(正文、标题、视频标题、
 *   被转发的原作品里的字)。屏蔽关键词 / 屏蔽正则,再白名单,黑名单优先;
 * - 类型开关只看**最外层**:`blockReposts` ← 有 `repost`,`blockArticles` ← 有 `article`,`blockImages` ← 有图集
 *   `images`,`blockVideos` ← 有 `video`。被转发的原作品里的图集与视频归 `blockReposts` 管,不另外拦;
 * - 对所有来源生效:拓展作品不豁免类型开关(从前「抖音几乎全是视频,全局开着屏蔽视频就把整个号吞了」的豁免
 *   随 ㉑e 删掉,主人拍板,ADR-0021 决策 43)。类型开关排在文字之前。
 *
 * 规则直接吃折好的 `ContentFilters`(全局 + 按 UP 覆盖已由 `resolve` 折完):配置怎么叫,这里就怎么叫,
 * 中间没有再翻译的一层。
 */

import {
	type ContentFilters,
	checkUserRegex,
	type Logger,
	type Post,
	PostFilterReason,
	postText,
} from "@bilibili-notify/internal";

// 原因的词表住 `@bilibili-notify/internal`(历史行的 `filteredBy` 也用它);这里照旧转出,过滤的调用方不用换路。
export { PostFilterReason };

/** 过滤吃的那八格:四个类型开关 + 屏蔽 / 白名单的关键词与正则。 */
export type PostFilterRules = Pick<
	ContentFilters,
	| "blockReposts"
	| "blockArticles"
	| "blockImages"
	| "blockVideos"
	| "blockKeywords"
	| "blockRegex"
	| "allowKeywords"
	| "allowRegex"
>;

export interface PostFilterResult {
	blocked: boolean;
	reason?: PostFilterReason;
}

const MAX_REGEX_TEST_TEXT_LEN = 10_000;

function safeRegexTest(pattern: string, text: string, logger?: Logger): boolean {
	if (!pattern) return false;
	// 统一走 @bilibili-notify/internal 的规范化闸门(长度上限 + 嵌套量词
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

/** 正则数组里**每条各自判**(一条非法不连累另一条);任一命中即真。 */
function anyRegexMatched(patterns: readonly string[], text: string, logger?: Logger): boolean {
	return patterns.some((pattern) => safeRegexTest(pattern, text, logger));
}

function anyKeywordMatched(keywords: readonly string[], text: string): boolean {
	return keywords.some((keyword) => keyword && text.includes(keyword));
}

/** 最外层命中的第一个类型开关;次序 转发 → 专栏 → 图集 → 视频。 */
function blockedType(post: Post, rules: PostFilterRules): PostFilterReason | undefined {
	if (rules.blockReposts && post.repost !== undefined) return PostFilterReason.BlockedReposts;
	if (rules.blockArticles && post.article !== undefined) return PostFilterReason.BlockedArticles;
	if (rules.blockImages && (post.images?.length ?? 0) > 0) return PostFilterReason.BlockedImages;
	if (rules.blockVideos && post.video !== undefined) return PostFilterReason.BlockedVideos;
	return undefined;
}

export function filterPost(post: Post, rules: PostFilterRules, logger?: Logger): PostFilterResult {
	const type = blockedType(post, rules);
	if (type !== undefined) return { blocked: true, reason: type };

	const text = postText(post, "plain");

	if (
		anyRegexMatched(rules.blockRegex, text, logger) ||
		anyKeywordMatched(rules.blockKeywords, text)
	) {
		return { blocked: true, reason: PostFilterReason.BlockedKeyword };
	}

	// 白名单:一条规则都没有就不拦;有规则则关键词与正则任一命中才放行。
	const hasAllowRule = rules.allowKeywords.length > 0 || rules.allowRegex.length > 0;
	if (
		hasAllowRule &&
		!anyRegexMatched(rules.allowRegex, text, logger) &&
		!anyKeywordMatched(rules.allowKeywords, text)
	) {
		return { blocked: true, reason: PostFilterReason.AllowlistUnmatched };
	}

	return { blocked: false };
}
