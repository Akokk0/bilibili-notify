/**
 * 按文件记账的棘轮守卫共用的对账:各文件的命中对照白名单与棘轮表。
 *
 * - 白名单按文件整份放行,写明理由。
 * - 棘轮表记每个文件的上限:多一处就红,**上限高于实数也红** —— 棘轮只许往下走,
 *   清理完的那一格当场调低,清零了整行删掉。
 * - 同一个文件不许两张表都在。
 *
 * 判据(什么算一处命中)各守卫自己写,这里只管对账。
 *
 * @param found `{ [文件]: { line, text }[] }`,没有命中的文件可以不出现
 * @param tables.what 命中叫什么,拼进提示(如「出站原语」)
 * @returns 人话描述的问题清单;空数组 = 通过
 */
export function auditRatchet(found, { allowlist, ratchet, what }) {
	const problems = [];
	for (const file of Object.keys(allowlist)) {
		if (file in ratchet) {
			problems.push(`${file}: 既在白名单又在棘轮表里 —— 两张表打架,留一张`);
		}
	}
	for (const [file, hits] of Object.entries(found)) {
		if (file in allowlist) continue;
		const limit = ratchet[file];
		if (limit === undefined) {
			for (const hit of hits) {
				problems.push(`${file}:${hit.line}: ${hit.text} —— ${what},文件不在白名单也不在棘轮表里`);
			}
		} else if (hits.length > limit) {
			problems.push(`${file}: ${what} ${hits.length} 处,超过棘轮上限 ${limit} —— 只许少不许多`);
			for (const hit of hits) problems.push(`${file}:${hit.line}: ${hit.text}`);
		} else if (hits.length < limit) {
			problems.push(
				`${file}: 实数 ${hits.length},上限还写着 ${limit} —— 把上限调低到 ${hits.length}`,
			);
		}
	}
	for (const [file, limit] of Object.entries(ratchet)) {
		if (file in found || file in allowlist) continue;
		problems.push(`${file}: 实数 0,上限还写着 ${limit} —— 把这一行从棘轮表里删掉`);
	}
	return problems;
}
