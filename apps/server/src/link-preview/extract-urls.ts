/**
 * 从聊天文本里挑「像网址的东西」—— 链接预览的第一道,平台中立。
 *
 * 只管形状:域名(点分的几段、末段是字母)加可选的端口与路径,带不带 `https://` 都认(群里常有人贴
 * `bilibili.com/video/BV…` 这种裸写法)。认不认、属于哪个平台由在册的链接解析器的 `matches` 说了算,
 * 所以这里宁可多挑:挑多的只是多问几个解析器一句「认不认」,不会发请求。
 *
 * 路径只收 ASCII 的网址安全字符,中文、全角标点、空白都是边界 —— 「链接，真好看」里的逗号和后面的字不进去;
 * 末尾紧贴的半角标点(句号、右括号……)也剥掉。
 */

const URL_CANDIDATE_RE =
	/(?<![A-Za-z0-9.@-])(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#][A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?/g;

/** 网址末尾不算进去的半角标点。 */
const TRAILING_PUNCT_RE = /[.,;:!?)\]'"]+$/;

/** 文本里的网址候选,按出现顺序,同一条原文只交一次。 */
export function extractUrls(text: string): string[] {
	if (!text) return [];
	const seen = new Set<string>();
	const found: string[] = [];
	for (const m of text.matchAll(URL_CANDIDATE_RE)) {
		const url = m[0].replace(TRAILING_PUNCT_RE, "");
		if (url === "" || seen.has(url)) continue;
		seen.add(url);
		found.push(url);
	}
	return found;
}
