// 服务端的字典 store(ADR-0037 决策 5、6):译文 JSON 构建时静态内联进 bundle,不在运行时读盘。
// import attributes 的写法与 routes/health.ts 读各包 package.json 一致。
import {
	createI18n,
	type Dict,
	type DictKey,
	type Locale,
	type LocaleDicts,
	mergeDict,
	type TextValues,
	translate,
} from "@bilibili-notify/internal/i18n";
import {
	bindPackageText,
	type PackageTextKey,
	withPackageDicts,
} from "@bilibili-notify/internal/texts";
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import jaMaid from "./locales/ja.maid.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import zhCNMaid from "./locales/zh-CN.maid.json" with { type: "json" };
import zhTW from "./locales/zh-TW.json" with { type: "json" };
import zhTWMaid from "./locales/zh-TW.maid.json" with { type: "json" };

/** 键的集合从简体中文那份取:键写错编译时报。 */
export type ServerTextKey = DictKey<typeof zhCN>;

// 平实四语齐全；简中、台湾繁体与日文有女仆交互覆盖，英文第一版只用平实层。
export const DICTS = {
	"zh-CN": { plain: zhCN, maid: zhCNMaid },
	"zh-TW": { plain: zhTW, maid: zhTWMaid },
	en: { plain: en },
	ja: { plain: ja, maid: jaMaid },
} satisfies Record<Locale, LocaleDicts>;

/**
 * 整台一种语言。初值简中 + 女仆:今天写死的话全是女仆口吻,语言与口吻的设置接进来是 3b-10。
 * 出字那一刻读当前那份,所以别在模块顶层调 `t` 后存成常量。
 * 包字典垫在底下(`withPackageDicts`),`t` 也取得到包里的句子。
 */
export const i18n = createI18n<ServerTextKey | PackageTextKey, Locale>({
	dicts: withPackageDicts(DICTS),
	fallback: "zh-CN",
	locale: "zh-CN",
	voice: "maid",
});

export const t = i18n.t;

// 包里的话(`packageText`)跟着服务端的语言与口吻走(ADR-0037 决策 6 下 10-28 的 🔗)
bindPackageText(i18n.t, () => i18n.state().locale);

/** 日志只用平实层；字典可预合成，当前语言在每次输出时读取。 */
const plainLogDicts = {
	"zh-CN": zhCN,
	"zh-TW": mergeDict(zhCN, zhTW),
	en: mergeDict(zhCN, en),
	ja: mergeDict(zhCN, ja),
} satisfies Record<Locale, Dict>;

export function logText(key: Extract<ServerTextKey, `log.${string}`>, values?: TextValues): string {
	const locale = i18n.state().locale;
	return translate(plainLogDicts[locale], locale, key, values);
}
