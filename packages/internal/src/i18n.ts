/**
 * 多语言的核心(ADR-0037 决策 6):合字典、取字、一个带订阅的语言 store。
 *
 * 零依赖子路径,面板与服务端各 new 自己的 store,拓展(3b-43)也能 new 自己的。
 * 这里**不读任何 JSON、不认具体有几种语言**(`LOCALES` 只是第一版的闭集,store 只认普通 string),
 * 译文由两端各自打进包再交进来 —— 所以本文件不许引入任何值(`scripts/__tests__/internal-package.test.mjs` 钉着)。
 */

/** 第一版的四种语言(ADR-0037 决策 2),BCP 47 写法;两端的译文表 `satisfies Record<Locale, …>`。 */
export const LOCALES = ["zh-CN", "zh-TW", "en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

/** 文案口吻(ADR-0037 决策 3,命名规范词表里叫 `voice`):女仆版或平实版。设置 schema 要一张运行时的取值表。 */
export const VOICES = ["maid", "plain"] as const;
export type Voice = (typeof VOICES)[number];

/** 设置里缺语言时的规则默认(ADR-0037 决策 17:升级上来的保持简体中文)。 */
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 设置里缺口吻时的规则默认:第 4 期定之前取女仆;只写在这里、不落盘,第 4 期改默认时没动过的人自动跟上。 */
export const DEFAULT_VOICE: Voice = "maid";

/**
 * 核心设置里的 `locale` / `voice` → 交给 store 的那一份;缺的按上面两条补。
 * 服务端绑定与面板同步共用这一处,规则不各抄一份。入参写成结构类型:本文件零依赖,不认 schema。
 */
export function textSettingsOf(settings: { locale?: Locale; voice?: Voice }): {
	locale: Locale;
	voice: Voice;
} {
	return {
		locale: settings.locale ?? DEFAULT_LOCALE,
		voice: settings.voice ?? DEFAULT_VOICE,
	};
}

/** 一层译文:键 → 句子。带数量的句子拆成 `键#类别`(`#one` / `#other` …)。 */
export type Dict = Readonly<Record<string, string>>;

/** 取字时填占位符的值;`count` 同时决定挑哪个单复数类别。 */
export type TextValues = Readonly<Record<string, string | number>>;

/** 键的类型:从一份译文推,去掉 `#类别` 后缀(几条收成一个键)。 */
export type DictKey<D> = keyof D extends infer K
	? K extends `${infer Stem}#${string}`
		? Stem
		: K
	: never;

const PLURAL_SEPARATOR = "#";
const PLACEHOLDER = /\{(\w+)\}/g;
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
const DICT_KEY_SHAPE = new RegExp(
	`^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*(#(${PLURAL_CATEGORIES.join("|")}))?$`,
);
const FORBIDDEN_SEGMENTS = ["__proto__", "constructor", "prototype"];
const BRACES = /\{[^{}]*\}/g;
const WELL_FORMED_HOLE = /^\{\w+\}$/;

/** 这个键是哪一句:去掉 `#类别` 后缀。 */
export function stemOf(key: string): string {
	const at = key.indexOf(PLURAL_SEPARATOR);
	return at === -1 ? key : key.slice(0, at);
}

/**
 * 译文键的判据(ADR-0037 决策 6):`段.段…`,段是 `[A-Za-z0-9_-]+`,带数量的句子可带 `#类别`;
 * 再挡掉会碰原型链的段。守卫与宿主共用的就是这一把尺。
 */
export function isDictKey(key: string): boolean {
	return (
		DICT_KEY_SHAPE.test(key) &&
		!stemOf(key)
			.split(".")
			.some((segment) => FORBIDDEN_SEGMENTS.includes(segment))
	);
}

/** 一句译文里的占位符名,按出现顺序、不重复。 */
export function placeholdersOf(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1] as string);
	return [...names];
}

/**
 * 一句译文里写坏的占位符,按出现顺序;同一个写坏的花括号出现几次就回几次。
 * 运行时只填 `{\w+}`,其余会原样露给用户,所以守卫与宿主共用这一处判据。
 */
export function malformedPlaceholders(text: string): string[] {
	return (text.match(BRACES) ?? []).filter((hole) => !WELL_FORMED_HOLE.test(hole));
}

/**
 * 把几层叠成一份,后面的盖前面的。盖的单位是「句」:上层有某一句,下层同一句的各类别一起换掉,
 * 否则会出现上层的 `#one` 配下层的 `#other`。
 */
export function mergeDict(...layers: readonly (Dict | undefined)[]): Dict {
	// 用 Map 攒、最后 fromEntries:`Object.assign` 会触发 `__proto__` 的 setter,
	// 译文文件(JSON.parse 出来)里一个自有的 "__proto__" 键就能改掉合成结果的原型
	const merged = new Map<string, string>();
	for (const layer of layers) {
		if (layer === undefined) continue;
		const entries = Object.entries(layer);
		const stems = new Set(entries.map(([key]) => stemOf(key)));
		for (const key of [...merged.keys()]) {
			if (stems.has(stemOf(key))) merged.delete(key);
		}
		for (const [key, text] of entries) merged.set(key, text);
	}
	return Object.fromEntries(merged);
}

/** 只认字典自己的键:顺着原型链会把缺键 `constructor` 取成函数。 */
function ownText(dict: Dict, key: string): string | undefined {
	return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

const pluralRulesByLocale = new Map<string, Intl.PluralRules | null>();

function pluralCategory(locale: string, count: number): string {
	let rules = pluralRulesByLocale.get(locale);
	if (rules === undefined) {
		try {
			rules = new Intl.PluralRules(locale);
		} catch {
			// 语言码不合法(拓展自己报的):不挑类别,落 #other
			rules = null;
		}
		pluralRulesByLocale.set(locale, rules);
	}
	return rules === null ? "other" : rules.select(count);
}

/**
 * 按键取字、按 `count` 挑单复数类别、填 `{名字}`。纯函数,不读任何 store。
 * 缺键回键本身(露出来好查);没给值的占位符原样留着。
 */
export function translate(
	dict: Dict,
	locale: string,
	key: string,
	values: TextValues = {},
): string {
	let text = ownText(dict, key);
	if (typeof values.count === "number") {
		const category = pluralCategory(locale, values.count);
		text =
			ownText(dict, `${key}${PLURAL_SEPARATOR}${category}`) ??
			ownText(dict, `${key}${PLURAL_SEPARATOR}other`) ??
			text;
	}
	if (text === undefined) return key;
	return text.replace(PLACEHOLDER, (hole, name: string) =>
		// 只认 values 自己的键:`in` 会顺着原型链,把 {constructor} 填成函数源码
		Object.hasOwn(values, name) ? String(values[name]) : hole,
	);
}

/** 一种语言的几层:平实版必有,女仆层可选(没有 = 这种语言不出口吻)。 */
export interface LocaleDicts {
	plain: Dict;
	maid?: Dict;
}

export interface I18nOptions<L extends string> {
	dicts: Readonly<Record<L, LocaleDicts>>;
	/** 缺句打底的语言(BN 两端是 zh-CN;拓展可以不给)。 */
	fallback?: L;
	locale: L;
	voice: Voice;
}

/** 某一刻合好的那一份;两次 `set` 之间引用不变(`useSyncExternalStore` 要求)。 */
export interface I18nState<K extends string, L extends string> {
	locale: L;
	/** 实际生效的口吻:要女仆而这种语言没有女仆层时是 `plain`。 */
	voice: Voice;
	dict: Dict;
	/** 绑死这一份的取字函数。 */
	t(key: K, values?: TextValues): string;
}

export interface I18n<K extends string, L extends string> {
	/** 出字那一刻读当前那份;两端导出的 `t` 就是它。 */
	t(key: K, values?: TextValues): string;
	/** 换语言或口吻:当场合好一份新的,再通知订阅者;没变就什么也不做。 */
	set(change: { locale?: L; voice?: Voice }): void;
	state(): I18nState<K, L>;
	/** 给 `useSyncExternalStore` 用:回一个退订函数。 */
	subscribe(listener: () => void): () => void;
}

/**
 * 一个语言 store。核心不建单例。
 * 合成在 `set` 时做一次(打底语言 → 本语言 → 女仆层),之后 `t` 只按键读,不在取字时回落。
 */
export function createI18n<K extends string = string, L extends string = string>(
	options: I18nOptions<L>,
): I18n<K, L> {
	const { dicts, fallback } = options;
	const listeners = new Set<() => void>();

	const build = (locale: L, wanted: Voice): I18nState<K, L> => {
		// 类型说每种语言都有,但 set 收的是运行时的值(拓展的译文文件可能不全):缺的当成空层
		const layersOf = (l: L): Partial<LocaleDicts> =>
			(dicts as Partial<Record<L, LocaleDicts>>)[l] ?? {};
		const maid = wanted === "maid" ? layersOf(locale).maid : undefined;
		const dict = mergeDict(
			fallback === undefined ? undefined : layersOf(fallback).plain,
			layersOf(locale).plain,
			maid,
		);
		return {
			locale,
			voice: maid === undefined ? "plain" : "maid",
			dict,
			t: (key, values) => translate(dict, locale, key, values),
		};
	};

	let current = build(options.locale, options.voice);
	let wantedVoice = options.voice;

	return {
		t: (key, values) => current.t(key, values),
		set(change) {
			const locale = change.locale ?? current.locale;
			const voice = change.voice ?? wantedVoice;
			if (locale === current.locale && voice === wantedVoice) return;
			wantedVoice = voice;
			current = build(locale, voice);
			for (const listener of [...listeners]) listener();
		},
		state: () => current,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
