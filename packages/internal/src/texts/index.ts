/**
 * 包字典(ADR-0037 决策 6 下 10-28 的 🔗,4-56):各包与 contract 给人看的话都住这一份,两端共用。
 *
 * 零依赖子路径 `@bilibili-notify/internal/texts`:译文住 `locales/` 的几份 JSON(打包时内联),
 * 形状同两端那套(每种语言一份平实版,中文另有女仆层)。键的第一段是包名(`internal.*`、`ai.*` …),
 * 两端字典的键不许用这些名字开头(`scripts/__tests__/i18n-dicts.test.mjs` 钉着)。
 *
 * - 包里出字:`packageText(键, 值)`,**出字那一刻**调(决策 1)。zod 的报错写成
 *   `{ error: () => packageText(…) }`,校验那一刻才取。
 * - 两端在建 store 的文件里调一次 `bindPackageText(i18n.t, () => i18n.state().locale)`,把自己的取字口和当前语言交进来:包里的话从此跟着
 *   那一端的语言与口吻走。没交过的(单测、打进拓展包里的那份)按简体中文取,和今天写死的字一样。
 *
 * 包日志使用 `<包名>.log.*`，不写女仆层覆盖；字典守卫据 ADR-0039 保证其平实口吻。
 *
 * 核心不建 store(`createI18n` 那条规矩):这里只存一个交进来的函数。
 * 不许引入 zod 或 schema;值级 import 只有同样零依赖的 `i18n.ts` 与 JSON。
 */

import {
	DEFAULT_LOCALE,
	DEFAULT_VOICE,
	type DictKey,
	LOCALES,
	type Locale,
	type LocaleDicts,
	mergeDict,
	type TextValues,
	translate,
} from "../i18n";
import type { Disposable } from "../platform";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zhCN from "./locales/zh-CN.json";
import zhCNMaid from "./locales/zh-CN.maid.json";
import zhTW from "./locales/zh-TW.json";

/**
 * 包字典的键:从简体中文那份推,写错编译时报。经 `PACKAGE_DICTS` 取而不直接写 `typeof zhCN`:
 * 导出的类型直接引 JSON,产物的类型声明就得带上 TypeScript 给 JSON 生成的 `export =`,
 * 打包类型的插件每次构建都报一条「CommonJS dts」警告。
 */
export type PackageTextKey = DictKey<(typeof PACKAGE_DICTS)["zh-CN"]["plain"]>;

/** 四种语言的包字典。繁体、英文、日文在第 5 期逐片补齐,缺的句子拿简体中文打底。 */
export const PACKAGE_DICTS = {
	"zh-CN": { plain: zhCN, maid: zhCNMaid },
	"zh-TW": { plain: zhTW },
	en: { plain: en },
	ja: { plain: ja },
} satisfies Record<Locale, LocaleDicts>;

/**
 * 两端建 store 之前,字典先过它:每种语言的平实版与女仆层各把包字典垫在底下,
 * 两端的 `t` 因此也取得到包里的句子(面板组件可以直接 `useT()` 取,切语言照样重画)。
 * 本端与包都没写女仆层的语言照旧没有女仆层。`packages` 只给测试换一份。
 */
export function withPackageDicts(
	dicts: Readonly<Record<Locale, LocaleDicts>>,
	packages: Readonly<Record<Locale, LocaleDicts>> = PACKAGE_DICTS,
): Record<Locale, LocaleDicts> {
	const layered = (locale: Locale): LocaleDicts => {
		const own = dicts[locale];
		const shared = packages[locale];
		const plain = mergeDict(shared.plain, own.plain);
		if (own.maid === undefined && shared.maid === undefined) return { plain };
		return { plain, maid: mergeDict(shared.maid, own.maid) };
	};
	return Object.fromEntries(LOCALES.map((locale) => [locale, layered(locale)])) as Record<
		Locale,
		LocaleDicts
	>;
}

/** 交进来的取字口:两端 store 的 `t`。 */
export type PackageTranslator = (key: PackageTextKey, values?: TextValues) => string;

/** 没交过取字口时用的那一份:规则默认的语言与口吻。 */
const UNBOUND_LAYERS: LocaleDicts = PACKAGE_DICTS[DEFAULT_LOCALE];
const UNBOUND_DICT = mergeDict(
	UNBOUND_LAYERS.plain,
	DEFAULT_VOICE === "maid" ? UNBOUND_LAYERS.maid : undefined,
);

let bound: { translator: PackageTranslator; locale: () => Locale } | undefined;

/**
 * 两端把自己的取字口交进来。回的把手撤掉这一次交的,回到交之前的那个口(测试里临时换一个也能还原);
 * 语言读取口供数字/金额格式现取，旧的只绑取字函数调用按规则默认语言；撤过再撤不出错。
 */
export function bindPackageText(
	translator: PackageTranslator,
	locale: () => Locale = () => DEFAULT_LOCALE,
): Disposable {
	const previous = bound;
	const current = { translator, locale };
	bound = current;
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			if (bound === current) bound = previous;
		},
	};
}

/** 包里取字:出字那一刻调,别在模块顶层取好存起来。缺键回键本身。 */
export function packageText(key: PackageTextKey, values?: TextValues): string {
	return bound !== undefined
		? bound.translator(key, values)
		: translate(UNBOUND_DICT, DEFAULT_LOCALE, key, values);
}

/** 包内数字等非句子格式的当前语言；两端与取字口一起交进来，出字时现取。 */
export function packageLocale(): Locale {
	return bound?.locale() ?? DEFAULT_LOCALE;
}
