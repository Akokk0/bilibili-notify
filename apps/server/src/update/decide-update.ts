import type { Manifest } from "./signed-manifest.js";

export interface DecideUpdateInput {
	/** 当前**实际生效**的版本 —— 注意不是镜像里那份,是启动选版真正加载的那份。 */
	currentVersion: string;
	manifest: Manifest;
	/** 当前**镜像/安装包**提供的运行时。载荷换得动,这个换不动。 */
	runtime: RuntimeCapabilities;
	/** 预发布通道。**提供,但默认关着** —— 不写就是关。 */
	allowPrerelease?: boolean;
}

export interface RuntimeCapabilities {
	nodeMajor: number;
}

export type UpdateDecision =
	| { kind: "update"; target: string }
	| { kind: "up-to-date" }
	/** 有更新的版本,但当前镜像/安装包供不起它 —— 得让用户去重拉镜像。 */
	| { kind: "needs-image-pull"; target: string };

/** semver 的预发布记号:主版本号后面挂了 `-` 的都算(`0.9.0-alpha.1`)。 */
function isPrerelease(version: string): boolean {
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
 * 这些是 {@link decideUpdate} 的内部细节,不单独对外暴露:正确性由上面那些决策用例
 * 覆盖,单独给它写测试只会把测试绑死在实现上。
 */
function compareVersions(a: string, b: string): number {
	const [aCore, aPre] = splitVersion(a);
	const [bCore, bPre] = splitVersion(b);

	const coreDiff = compareNumericSegments(aCore, bCore);
	if (coreDiff !== 0) return coreDiff;

	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	return comparePrerelease(aPre, bPre);
}

export function decideUpdate({
	currentVersion,
	manifest,
	runtime,
	allowPrerelease = false,
}: DecideUpdateInput): UpdateDecision {
	const isNewer = compareVersions(manifest.version, currentVersion) > 0;
	const isRevoked = (manifest.revoked ?? []).includes(manifest.version);
	const isGatedPrerelease = isPrerelease(manifest.version) && !allowPrerelease;
	if (!isNewer || isRevoked || isGatedPrerelease) return { kind: "up-to-date" };

	const requiredNode = manifest.requires?.nodeMajor;
	if (requiredNode !== undefined && runtime.nodeMajor < requiredNode) {
		return { kind: "needs-image-pull", target: manifest.version };
	}

	return { kind: "update", target: manifest.version };
}
