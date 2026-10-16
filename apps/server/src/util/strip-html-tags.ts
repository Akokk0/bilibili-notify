/** B 站搜索结果会用 `<em class="keyword">…</em>` 包住命中的关键词;名字里不要这层标签。 */
export function stripHtmlTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}
