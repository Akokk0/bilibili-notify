/**
 * 包内资产的**原名清单**:`assets/<生成名>` → 主人上传时那个文件叫什么。
 *
 * 盘上的名字是随机生成的,主人在下拉里只看得到一串 hex —— 卡片字体图廊踩过同一件事
 * (「列表里只剩一串 hex 主人根本认不出哪个是哪个」),解法也照抄它:名字另存一份清单,
 * 而**目录才是真相** —— 清单丢了照样列得出资产(名字回落成生成名),清单里多出盘上
 * 没有的记录则一概不算。
 *
 * **为什么不干脆拿原名当文件名**(主人问过,2026-08-20 定案):那个名字会流进三个 sink
 * —— 磁盘路径、URL 路径(`skinAssetUrl` 是原样拼的)、以及拼进受信任 `<style>` 的
 * `url("…")`。现在这三处的安全性**由构造保证**:名字不是不可信输入。换成原名就退成
 * 「靠一条正则守着三个 sink」,而皮肤包是能从外部导入的 zip —— 那条正则从此是对第三方
 * 包的边界,漏一个引号就是往受信任样式表里注任意 CSS。
 *
 * 走这条路,原名唯一的去处是 React 里的一段文本(自动转义),三个 sink 一个都不碰。
 */

/** 清单在包内的位置。住在 `assets/` 里,而 `.json` 不在资产白名单上,故永远不会被当成一份资产列出或 serve。 */
export const ASSET_NAMES_FILE = "assets/index.json";

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
 * —— 这个值永远不会被当路径用 —— 而是「显示 `C:\Users\akokko\Desktop\bg.png` 没有
 * 意义,主人要看的是 `bg.png`」。
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
