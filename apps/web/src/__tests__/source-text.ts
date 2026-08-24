/**
 * 静态守卫读源码时的文本处理。与 `walk.ts` 是一对:那边管「扫哪些文件」,
 * 这边管「读进来之后先怎么收拾」。
 *
 * 收编前有**三份**,而且**不是同一个东西** —— 这才是收编的理由。前两份
 * (`input-hook-coverage` / `library-reuse-conformance`)逐字节相同,第三份
 * (`skin-hook-coverage`)是个正则版,而正则版会**误吞真代码**:
 *
 * ```
 * // 说明 /* 这不是块注释开头
 * const a = "font-mono";
 * ```
 *
 * 正则版先跑 `/\/\*[\s\S]*?\*\//` —— 它从第一行那个 `/*` 一路匹配到底下某个 `*&#47;`,
 * 把中间的真代码一起抹白。于是那道守卫会**安静地漏扫**这一段:不报错、不失败,
 * 只是从此看不见这几行里的违规。三份并排放着,谁也不会想到它们行为不同。
 */

/**
 * 把注释整段抹成等长空白 —— **保住行号**,同时不让注释里引述的示例代码算数。
 *
 * 守卫的注释里常常写着「以前是这么写的」并原样贴出违规写法(那正是它要拦的东西),
 * 不抹掉的话每道守卫都会被自己的说明文字绊倒。
 *
 * 逐字符扫而不是用正则:顺序走下来,`//` 先出现就先吃掉整行,`/*` 不会反过来跨行
 * 吞掉它后面的代码。
 *
 * **也必须整段扫,不能逐行处理**(收编前 `library-reuse-conformance` 里记着这条,
 * 是变异测试抓出来的):逐行的话 JSDoc 的收尾行会被「以星号开头」那类规则先抹掉,
 * 于是块注释的开头再也找不到自己的结尾,一路向前吃到下一个收尾符,把中间的真代码
 * 整段吞掉 —— 守卫就此安静地漏检。
 *
 * **已知射程**:不认字符串字面量。裸写的 `//` 一律当行注释,唯一的例外是紧挨在
 * 冒号后面的那种 —— 那是 `https://`,站里的真实写法(`<a href="…" className="…">`
 * 整行会被抹白,守卫从此看不见这一行的 class)。别的形态的字符串里若真出现 `//`,
 * 这里仍会看走眼;认全字符串要连转义与模板串一起处理,而目前没有哪道守卫需要它。
 */
export function blankComments(src: string): string {
	const out: string[] = [];
	for (let i = 0; i < src.length; ) {
		if (src.startsWith("/*", i)) {
			const end = src.indexOf("*/", i);
			const stop = end === -1 ? src.length : end + 2;
			out.push(src.slice(i, stop).replace(/[^\n]/g, " "));
			i = stop;
		} else if (src.startsWith("//", i) && src[i - 1] !== ":") {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			out.push(" ".repeat(stop - i));
			i = stop;
		} else {
			out.push(src[i] as string);
			i += 1;
		}
	}
	return out.join("");
}
