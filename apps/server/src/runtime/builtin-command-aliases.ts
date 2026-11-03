import type { Locale } from "@bilibili-notify/internal/i18n";
import { i18n } from "../i18n/index.js";

/** 固定输入协议：所有语言同时识别；展示语言不改变主人能敲的词。 */
const ALIASES = {
	help: { "zh-CN": ["帮助", "?"], "zh-TW": ["幫助", "?"], en: ["?"], ja: ["ヘルプ", "?"] },
	login: { "zh-CN": ["扫码", "登录"], "zh-TW": ["掃碼", "登入"], en: [], ja: ["ログイン"] },
	mute: { "zh-CN": ["静音", "免打扰"], "zh-TW": ["靜音", "勿擾"], en: [], ja: ["ミュート"] },
	status: { "zh-CN": ["状态"], "zh-TW": ["狀態"], en: [], ja: ["ステータス"] },
	report: { "zh-CN": ["周报"], "zh-TW": ["週報"], en: [], ja: ["レポート"] },
} as const satisfies Record<string, Record<Locale, readonly string[]>>;

type BuiltinCommandName = keyof typeof ALIASES;
export function builtinCommandAliases(name: BuiltinCommandName): readonly string[] {
	return [...new Set(Object.values(ALIASES[name]).flat())];
}
export function displayedBuiltinCommandAliases(name: BuiltinCommandName): readonly string[] {
	return ALIASES[name][i18n.state().locale];
}
