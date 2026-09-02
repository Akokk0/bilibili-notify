import { readdirSync } from "node:fs";

/**
 * 「`<versionsRoot>` 下面哪些目录是我们的」这一条判定 —— 选版、回退、撤回、清理
 * 四处都要问,所以只在这里回答一次。
 *
 * 曾经它在 `service.ts` / `select-version-for-boot.ts` / `prune-versions.ts` 各有一份
 * 逐字节相同的拷贝。这条正则已经长过一次(补预发布后缀),再长一次而漏改其中一份的话,
 * 两个方向的症状都是静音的:清理删掉了选版会挑中的目录,或者选版挑中了清理认为是垃圾
 * 的目录。
 *
 * 只依赖 `node:fs` —— `boot.mjs` 那个入口要在加载服务端之前用它,不能牵别的东西进来。
 */

/**
 * 只有长得像版本号的目录才算候选。
 *
 * `/data` 是用户挂出来的,他们真的会往里丢东西 —— 一个叫 `2026-09-01` 的手动备份
 * 按数字段会被读成主版本 **2026**,压过一切真版本,然后我们就从一个根本不是载荷
 * 的目录里启动。安装中途留下的 `.staging-*` 也一并被这条挡住。
 */
export const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 安装流程自己的临时目录:`install-payload.ts` 的 `.staging-<版本>-<uuid>` 与 `.old-<版本>-<uuid>`。 */
export const LEFTOVER_DIR_RE = /^\.(?:staging|old)-/;

/** 盘上装着的版本(目录名)。目录还不存在(从没升过级)—— 一个候选都没有,不是错误。 */
export function installedVersions(versionsRoot: string): string[] {
	try {
		return readdirSync(versionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => VERSION_DIR_RE.test(name));
	} catch {
		return [];
	}
}
