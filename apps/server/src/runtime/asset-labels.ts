/**
 * 资产的**显示名**该怎么清洗 —— 皮肤包的原名清单与字体图廊共用的一把尺,与
 * `font-mime.ts` / `image-mime.ts` 并列住在这里。
 *
 * 两处都在解同一个问题:盘上的名字是随机生成的 hex,主人在下拉里认不出哪个是哪个,
 * 于是把上传时那个文件名另存一份清单。而那个名字是**不可信输入** —— 上传时那一串
 * 来自浏览器,清单文件本身还可能来自外部导入的 zip 或被手改。
 *
 * 字体图廊先有的这套做法,皮肤包照抄时把它加固了一遍却没回喂;收成一份之后,加固
 * 只写在一个地方。
 *
 * **名字不进路径也不进 URL**(两处的文件名都是生成的),唯一的去处是 React 里的一段
 * 文本 —— 所以这不是注入面。它守的是这个功能存在的理由:让主人认得出哪个是哪个。
 */

/** 显示名的长度上限。下拉框里没人读得完一百多个字,而清单来自不可信的 zip。 */
const MAX_LABEL_CHARS = 120;

/**
 * 控制字符 + 双向覆盖符。
 *
 * 后者(U+202A–U+202E / U+2066–U+2069)能把 `gnp.exe` 显示成 `exe.png` —— 纯观感欺骗,
 * 伤不到系统,但这个名字存在的**全部意义**就是「让主人认得出是哪个文件」,让它骗人就
 * 等于把这个功能反过来用了。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥控制字符正是这条正则的用途
const UNSAFE_LABEL_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/**
 * 上传/包里带来的文件名 → 能安全显示的标签;剥完什么都不剩返回 null。
 *
 * 只取最后一截路径:有些浏览器(以及手工压的包)给的是整条路径。这里不是安全需要
 * —— 这个值永远不会被当路径用 —— 而是「把整条本机路径显示出来没有意义,主人要看的
 * 是 `bg.png`」。例子见 __tests__/asset-labels.test.ts。
 */
export function sanitizeAssetLabel(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const base = raw.split(/[/\\]/).pop() ?? "";
	const clean = base.replace(UNSAFE_LABEL_CHARS, "").trim();
	if (clean === "") return null;
	return clean.length > MAX_LABEL_CHARS ? clean.slice(0, MAX_LABEL_CHARS) : clean;
}

/**
 * 不可信 JSON → 原名清单。键必须是合法资产名(`isValidKey` 传 `isSkinAssetName`),
 * 值过 {@link sanitizeAssetLabel};任何一条不合格只丢那一条。
 *
 * **整份坏掉也只回空表,绝不报错** —— 名字是锦上添花,不是包的必要成分。为一份读不懂
 * 的清单拒收一整套皮肤,是拿最不重要的东西去卡最重要的路。
 */
export function parseAssetNames(
	raw: unknown,
	isValidKey: (key: string) => boolean,
): Record<string, string> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!isValidKey(key)) continue;
		const label = sanitizeAssetLabel(value);
		if (label !== null) out[key] = label;
	}
	return out;
}
