/**
 * 版本先后。升级决策(`decide-update`)与启动选版(`select-version-for-boot`)
 * 共用这一把尺子。
 */
/** semver 的预发布记号:主版本号后面挂了 `-` 的都算(`0.9.0-alpha.1`)。 */
export function isPrerelease(version: string): boolean {
	return version.includes("-");
}

/** `0.9.0-alpha.1` → `["0.9.0", "alpha.1"]`;没有预发布段时后者为空串。 */
function splitVersion(version: string): [core: string, prerelease: string] {
	const dash = version.indexOf("-");
	return dash === -1 ? [version, ""] : [version.slice(0, dash), version.slice(dash + 1)];
}

function compareNumericSegments(a: string, b: string): number {
	const [x, y] = [a.split("."), b.split(".")];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (Number.parseInt(x[i] ?? "0", 10) || 0) - (Number.parseInt(y[i] ?? "0", 10) || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * 预发布段按点分标识符逐个比:两边都是数字就按**数值**比(`alpha.10` 高于
 * `alpha.9` —— 按字符串比会判反,而我们真的发过两位数的 alpha),数字低于非数字,
 * 其余按字典序;前缀全等时短的那个低。
 */
function comparePrerelease(a: string, b: string): number {
	const [x, y] = [a.split("."), b.split(".")];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const [ai, bi] = [x[i], y[i]];
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

/**
 * 版本比较。两个坑都在这里:
 *
 * 1. **core 段按数字比,不能按字符串比** —— 字典序下 `0.10.0` < `0.9.0`,发到第十个
 *    小版本时所有人静静卡死在 0.9.x。
 * 2. **预发布低于同号正式版** —— 判反了会把尝鲜用户从 `0.9.0` 推回 `0.9.0-alpha.1`,
 *    一次静默降级,而磁盘数据已经被前向迁移改写过了。
 *
 * 抽成共用件是因为**升级决策和启动选版必须用同一把尺子** —— 两份会各自漂移的
 * 比较器,迟早在某个版本号上给出相反的答案。正确性由两边的用例覆盖,不单独给它
 * 写测试(那只会把测试绑死在实现上)。
 */
export function compareVersions(a: string, b: string): number {
	const [aCore, aPre] = splitVersion(a);
	const [bCore, bPre] = splitVersion(b);

	const coreDiff = compareNumericSegments(aCore, bCore);
	if (coreDiff !== 0) return coreDiff;

	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	return comparePrerelease(aPre, bPre);
}
