/**
 * 用户可配正则的安全闸门 —— **单一权威**。
 *
 * 此前 dynamic-filter 各自手写 `looksCatastrophic`(仅匹配嵌套量词 `(X+)+`
 * 一类),schema 层(blockRegex/whitelistRegex)则完全不校验 —— 启发式分叉 +
 * 漏网。本模块把「长度上限 + 灾难性回溯启发式 + 编译校验」收敛成一处,schema
 * 保存校验与 filter 运行期判定都从这里取,杜绝两处规则漂移。
 *
 * 重要:这是**启发式**,非完备 ReDoS 静态分析(完备需 RE2/safe-regex 依赖,
 * 超出范围)。覆盖真实世界绝大多数指数级教科书构造:
 *   1. 嵌套量词:`(a+)+` `(.*)*` `(?:\w+)*` `(a+){2,}`
 *   2. 交替重叠:`(a|a)*c` `(.|.)*c` `(\w|\w)+` —— 量词作用于「替选项可重叠」的组
 * 不命中 ≠ 安全,故仍对求值输入侧封顶(调用方负责截断 subject 长度)。
 */

/** 用户正则源串的默认长度上限。短模式也能 ReDoS,长度限只是第一道粗筛。 */
export const DEFAULT_MAX_REGEX_LEN = 200;

// 1. 嵌套量词:组内含无界量词,组整体再被量词修饰。
const NESTED_QUANTIFIER = /\((?:\?[:=!][^)]*|[^)]*)[+*][^)]*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;

// 2. 交替重叠:带 `|` 的(捕获/非捕获)组紧跟无界量词,且替选项「可重叠」。
//    完备的重叠判定不可行,取保守的可控近似 —— 仅当替选项之一为 `.`/`.`-量词,
//    或两侧完全相同(`(a|a)` `(\w|\w)`)时判危。这样放过常见且安全的不相交
//    交替(`(https?|ftp)+` `(ab|cd)*`),只咬真正的指数构造。
function hasOverlappingAlternationUnderQuantifier(src: string): boolean {
	// 逐个找「( ... ) 紧跟无界量词」的组;括号可嵌套,用计数法取最外层组体。
	for (let i = 0; i < src.length; i++) {
		if (src[i] !== "(") continue;
		let depth = 1;
		let j = i + 1;
		for (; j < src.length && depth > 0; j++) {
			const ch = src[j];
			if (ch === "\\") {
				j++; // 跳过转义字符,'\(' '\|' 不计
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		if (depth !== 0) return false; // 括号不配平,交给编译校验报错
		const close = j - 1;
		const after = src.slice(close + 1);
		if (!/^\s*(?:[+*]|\{\d+(?:,\d*)?\})/.test(after)) continue; // 组后无无界量词
		let body = src.slice(i + 1, close);
		body = body.replace(/^\?[:=!]/, ""); // 去掉 (?: (?= (?! 前缀
		// 顶层 `|` 切分(忽略转义与嵌套括号内的 |)。
		const branches: string[] = [];
		let buf = "";
		let bdepth = 0;
		for (let k = 0; k < body.length; k++) {
			const ch = body[k];
			if (ch === "\\") {
				buf += ch + (body[k + 1] ?? "");
				k++;
				continue;
			}
			if (ch === "(") bdepth++;
			else if (ch === ")") bdepth--;
			if (ch === "|" && bdepth === 0) {
				branches.push(buf);
				buf = "";
			} else {
				buf += ch;
			}
		}
		branches.push(buf);
		if (branches.length < 2) continue; // 无交替
		const norm = branches.map((b) => b.trim());
		const anyDot = norm.some((b) => /^\.[+*?]?$/.test(b));
		const dupBranch = new Set(norm).size < norm.length;
		if (anyDot || dupBranch) return true;
	}
	return false;
}

/**
 * 启发式判定:`src` 是否疑似灾难性回溯(指数级 ReDoS)。命中即应拒绝执行。
 * 注意:仅是源串形态启发式,不含长度判定与编译合法性。
 */
export function isCatastrophicRegexSource(src: string): boolean {
	return NESTED_QUANTIFIER.test(src) || hasOverlappingAlternationUnderQuantifier(src);
}

export interface SafeRegexCheck {
	ok: boolean;
	/** 不安全/非法时的原因(已就绪用于日志/校验报错);ok 时为空串。 */
	reason: string;
}

/**
 * 用户正则的完整安全体检:长度上限 → 灾难性回溯启发式 → 可编译性。
 * 三关任一不过即 `ok:false` 且带可直接展示的中文 reason。纯函数,不抛。
 */
export function checkUserRegex(src: string, maxLen = DEFAULT_MAX_REGEX_LEN): SafeRegexCheck {
	if (src.length > maxLen) {
		return { ok: false, reason: `正则过长(>${maxLen} 字符),拒绝以防 ReDoS` };
	}
	if (isCatastrophicRegexSource(src)) {
		return { ok: false, reason: "正则疑似灾难性回溯(嵌套量词 / 交替重叠),拒绝执行" };
	}
	try {
		new RegExp(src);
	} catch (e) {
		return { ok: false, reason: `正则非法:${(e as Error).message}` };
	}
	return { ok: true, reason: "" };
}
