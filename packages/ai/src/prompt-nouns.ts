/**
 * 提示词里没声明叫法时落的中性词,交给 contract 的 `sourceNounsOf` 当 `neutral`。
 * 给模型的话不翻(ADR-0037 决策 11):界面换了语言,提示词里还是这几个字;给人看的中性词在服务端字典 `nouns.*`。
 */
export const PROMPT_NEUTRAL_NOUNS = {
	creatorNoun: "创作者",
	postNoun: "作品",
	sources: "各平台",
} as const;
