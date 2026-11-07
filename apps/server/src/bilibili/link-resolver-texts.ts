import { t as serverText } from "./i18n.js";
/**
 * B 站链接解析器失败结果的 `message`(只进日志,群里不回话)。集中放在这里,逻辑里不拼句子。
 */
export const LINK_RESOLVER_TEXTS = {
	get notVideoLink() {
		return serverText("bilibili.link-resolver-texts.text.1");
	},
	get shortLinkUnresolved() {
		return serverText("bilibili.link-resolver-texts.text.2");
	},
} as const;
