/**
 * 私聊指令回给主人的「办不成」的话,集中在这里,逻辑里不写整句(之后改字、做多语言只动这一个文件)。
 *
 * 分两层:
 * - `framework`:分发器统一说的两句 —— 指令返回失败、指令抛错;
 * - 其余按指令分:各指令返回 `fail(码, 话)` 时的那句**实质**(为什么没办成、主人该怎么办),
 *   不带「XX 没办成：」的前缀 —— 前缀由分发器统一加。
 *
 * 办成了的回话(静音到几点、周报发出去了)留在各指令里,不在这儿;只有要填来源名字的几句
 * (`loginReplies`、`status`)已经集中进来。
 * 口吻是女仆风格。
 */
export const COMMAND_TEXTS = {
	framework: {
		/** 指令返回失败。`word` 是主人这次敲的那个词(别名就是别名),`message` 是失败里那句话。 */
		failed: (word: string, message: string) => `『${word}』没办成：${message}`,
		/** 指令抛错(是 bug,原因只进日志,不回给主人)。 */
		crashed: "出错了，详情在日志里",
	},
	login: {
		/** 登记表里一个带登录的来源都没有。 */
		noSources: "现在没有能登录的来源～",
		/** 敲的词不是任何一个带登录来源的键或名字;把能挑的列出来。`options` 是已拼好的「名字（键）」清单。 */
		unknownSource: (word: string, options: string) =>
			`没有叫「${word}」的来源～能登录的有：${options}`,
		/** 敲的名字被好几个来源占着(键比名字先认,所以只会撞在名字上);让主人改用键。 */
		ambiguousSource: (word: string, options: string) =>
			`有好几个来源都叫「${word}」，请改用键：${options}`,
		/** 登录系统没给出二维码、状态里也没有可转述的话。 */
		noQr: "没拿到二维码，稍后再试试～",
		/** 二维码生成了,但没发到主人这个私聊。 */
		qrNotSent: "二维码发不出去，去控制台扫吧～",
	},
	/**
	 * 办成了的回话(以下不走失败前缀)。`login` 的两句:来源不止一个又没说挑哪个(正常回答,不是失败),
	 * 与二维码发出去之后的那句叮嘱。
	 */
	loginReplies: {
		/** `lines` 是已拼好的清单(每个来源一行「- 名字（键）」),`exampleKey` 是拿第一个来源的键举的例子。 */
		pickOne: (lines: string, exampleKey: string) =>
			`有好几个来源可以登录：\n${lines}\n想扫哪一个，就在 login 后面跟上它的名字或键，比如「login ${exampleKey}」～`,
		scanned: (label: string, ttlSeconds: number) =>
			`扫这张码登录「${label}」就行，${ttlSeconds} 秒内有效，过期了再敲一次～`,
	},
	/** `status` 里每个带登录的来源那一行(冒号前:来源给人看的名字加「登录」)。 */
	status: {
		loginLabel: (label: string) => `${label}登录`,
	},
	report: {
		/** 天数越界;把区间说出来,不然主人只能猜。 */
		daysOutOfRange: (min: number, max: number) => `天数要在 ${min} 到 ${max} 之间哦～`,
		/** 上一份还在生成:这一次不跑,不重复花钱。 */
		busy: "还在跑呢，稍等一下下～",
		noTargets: "还没配推送目标呢，周报没地方发～",
	},
} as const;
