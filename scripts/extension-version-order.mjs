/**
 * 版本先后。**这是 `apps/server/src/update/version-order.ts` 的手抄**:那份是 TS,而这个
 * 脚本是 CI 里直接 `node scripts/…` 跑的,进不来。两把尺子给出相反答案的那天就是把一个
 * 版本静默降回去的那天,所以 `marketplace-index.test.mjs` 里有一条用例拿客户端那把逐对
 * 比签,漂了当场红。
 *
 * @param {string} a @param {string} b
 */
export function compareEntryVersions(a, b) {
	const split = (/** @type {string} */ v) => {
		const dash = v.indexOf("-");
		return dash === -1 ? [v, ""] : [v.slice(0, dash), v.slice(dash + 1)];
	};
	const [aCore, aPre] = split(a);
	const [bCore, bPre] = split(b);

	const x = aCore.split(".");
	const y = bCore.split(".");
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (Number.parseInt(x[i] ?? "0", 10) || 0) - (Number.parseInt(y[i] ?? "0", 10) || 0);
		if (diff !== 0) return diff;
	}

	// 预发布低于同号正式版;段内数字按数值比(alpha.10 高于 alpha.9),数字低于非数字。
	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	const p = aPre.split(".");
	const q = bPre.split(".");
	for (let i = 0; i < Math.max(p.length, q.length); i++) {
		const [ai, bi] = [p[i], q[i]];
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		if (ai === bi) continue;
		const [an, bn] = [/^\d+$/.test(ai), /^\d+$/.test(bi)];
		if (an && bn) return Number(ai) - Number(bi);
		if (an !== bn) return an ? -1 : 1;
		return ai < bi ? -1 : 1;
	}
	return 0;
}
