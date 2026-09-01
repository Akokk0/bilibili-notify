import type { Manifest } from "./signed-manifest.js";
import { compareVersions, isPrerelease } from "./version-order.js";

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
