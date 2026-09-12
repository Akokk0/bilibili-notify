/**
 * 「这个 href 能不能真的落成一个可点的链接」—— 渲染**不受信** Markdown 的那把尺子。
 *
 * 独立成一个模块,是因为它的两个用处分处两条包边界:AI 聊天(`components/ai-chat/
 * markdown.tsx`)与拓展文档(`components/untrusted-markdown.tsx`)。前者运行时就引着
 * `react-markdown`,后者**刻意不引**(那一坨约 153KB,静态可达就进初始包,站里所有
 * `lazy()` 一起作废;`__tests__/markdown-chunk.test.ts` 从入口爬图钉着)。放在聊天那个
 * 文件里,后者一 import 就把库捎进来了。
 */

/**
 * 放行的协议。其余(`javascript:` / `data:` / `vbscript:` / `mailto:` …)一律掐掉。
 *
 * 白名单而不是黑名单:黑名单要穷举所有能跑脚本的协议,漏一个就是个洞。这里连
 * `mailto:` 也不给 —— 这两个场景下它几乎不会出现,而每多一个放行项都是一条要单独
 * 想清楚的路。
 */
const SAFE_PROTOCOLS = ["http:", "https:"];

/**
 * 只让安全协议落成可点的 href。
 *
 * 拿 `URL` 真解析而不是用正则筛前缀:`java\nscript:` 这类带控制字符 / 大小写混写 /
 * 百分号编码的花样能绕过朴素的字符串判断,而浏览器照样认。解析不出来的相对地址
 * 原样放行(它跳不出本站)。
 */
export function safeHref(href: string | undefined): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, "https://placeholder.invalid/");
	} catch {
		return undefined; // 连解析都失败 → 不给它 href
	}
	if (!SAFE_PROTOCOLS.includes(url.protocol)) return undefined;
	return href;
}
