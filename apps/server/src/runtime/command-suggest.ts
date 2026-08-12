/**
 * 「你是不是想敲…」—— 未知指令的近似建议。
 *
 * 一句「没有这条指令」把主人扔回去自己翻帮助,而他多半只是漏了个字母。指出最近的
 * 那条,这次手滑就地结束。
 *
 * ## 敢在这里出声,是因为已经过了鉴权门
 *
 * 建议本质上是**接口指纹**:试探者拿它当探针,几次就能把指令表摸出来。所以它只能
 * 长在 dispatcher 的 unknown 分支上 —— 那里的前提是「已确认是主人 + 带了前缀」。
 * 非主人在鉴权门就静默返回了,压根走不到这儿。
 *
 * ## 宁可闭嘴也别乱指
 *
 * 指错一条的代价比不指更大:主人会照着敲第二次,发现还是不对,才开始怀疑我们。
 * 所以预算卡得紧,拿不准就返回 `undefined`,由调用方只说那句「没有这条指令」。
 */

/**
 * 编辑距离(Levenshtein)。按**码点**切,不按 UTF-16 码元 —— 别名是主人在面板上
 * 自己填的,填个 emoji 完全可能,而按码元切会把一个字拆成两半、算出一个虚高的距离。
 */
function distance(a: readonly string[], b: readonly string[]): number {
	// 滚动一行就够:只要最终那个数,不需要回溯路径。
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(
				(prev[j] ?? 0) + 1, // 删
				(cur[j - 1] ?? 0) + 1, // 增
				(prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1), // 替
			);
		}
		prev = cur;
	}
	return prev[b.length] ?? 0;
}

/**
 * 这次比对允许错几步。
 *
 * 按**较长那侧**算,而不是给一个固定值:固定 2 的话,`?` 这种单字触发词会被任意
 * 一个字母命中(距离 1),于是主人随手敲个 `/a` 就被指去敲 `/?`。减一保证了
 * 「短词必须几乎打对」,同时给 `help` / `status` 这类长词留出调序这种双步手滑的余地。
 */
function budgetOf(typedLen: number, candidateLen: number): number {
	return Math.min(2, Math.max(typedLen, candidateLen) - 1);
}

/**
 * 从触发词里挑一个最像 `typed` 的。够远就返回 `undefined`。
 *
 * 返回的是**命中的那个触发词原样**,不折算成主名 —— 主人敲的是「静因」,回他一句
 * 「静音」他能直接照抄,回一句 `mute` 等于让他重学一遍。大小写也还原成注册时的
 * 那个:比对不敏感,印出来要跟帮助里印的一致。
 *
 * @param triggers 主名与别名混在一起,顺序即优先级。并列时取靠前的那个 ——
 *   同一次手滑跑两遍不能给出两个答案。
 */
export function suggestCommand(typed: string, triggers: readonly string[]): string | undefined {
	const key = Array.from(typed.trim().toLowerCase());
	if (key.length === 0) return undefined;

	let best: string | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const trigger of triggers) {
		const cand = Array.from(trigger.toLowerCase());
		const d = distance(key, cand);
		// 严格小于:并列时先来的赢,结果才是确定的。
		if (d <= budgetOf(key.length, cand.length) && d < bestDist) {
			best = trigger;
			bestDist = d;
		}
	}
	return best;
}
