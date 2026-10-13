/**
 * B 站链接解析器失败结果的 `message`(只进日志,群里不回话)。集中放在这里,逻辑里不拼句子。
 */
export const LINK_RESOLVER_TEXTS = {
	notVideoLink: "不是 B 站视频链接",
	shortLinkUnresolved: "短链没有落到视频上",
} as const;
