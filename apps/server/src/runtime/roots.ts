import { t as serverText } from "../i18n/index.js";
/**
 * 配置里的 `dataDir` 在代码里拆成两个根(ADR-0022 决策 1):
 *
 * - **宿主根**(`hostRoot`):`dataDir` 本身。放不分代的东西:冻住的外壳认的宿主件,和装各代的那一层。
 * - **数据根**(`dataRoot`):其余一切,是宿主根下选中的那一代 `generations/<序号>/`(选法见
 *   `runtime/generations.ts`)。0.x 留在宿主根上的文件是第 0 代,只作迁移的输入(`migration/`)。
 *
 * 在两个根下拼路径一律经 `hostPath` / `dataPath`:第一段只能是下面两张表里的键,新开一个一级
 * 目录就得先在表里登记 —— 迁移靠这张表知道要搬什么,漏登的目录换代时会被丢在旧代里。
 * 守卫 13 后半(`__tests__/data-roots.test.ts`)钉住没人绕过这两个函数自己拼。
 *
 * ⚠️ 这个文件在 boot 的模块图里(`update/versions-root.ts` 用它),只许 import `node:` 内置模块。
 */

import { join } from "node:path";

/**
 * 宿主根下的一级项,都不分代:`versions` 与 `logs` 是冻住的外壳认的地方,位置与格式都不许改;
 * `generations` 是装各代的那一层本身。
 */
export const HOST_ROOT_LAYOUT = {
	get versions() {
		return serverText("service.runtime.roots.text.1");
	},
	get logs() {
		return serverText("service.runtime.roots.text.2");
	},
	get generations() {
		return serverText("service.runtime.roots.text.3");
	},
} as const;

/**
 * 数据根(一代)下的一级项 —— 目录表,也就是代的布局(`docs/1.0/data-and-migration.md`「目录布局」)。
 * 聊天附件(⑳b)、拓展订阅头像(⑳c)、历史配图与重推原件里的图(⑳d)都已经进了图库 `images/`:`assets`、`avatars`
 * 两个过渡键删了,`history/img/` 没有了。
 */
export const DATA_ROOT_LAYOUT = {
	get config() {
		return serverText("service.runtime.roots.text.4");
	},
	get secrets() {
		return serverText("service.runtime.roots.text.5");
	},
	get runtime() {
		return serverText("service.runtime.roots.text.6");
	},
	get history() {
		return serverText("service.runtime.roots.text.7");
	},
	get images() {
		return serverText("service.runtime.roots.text.8");
	},
	get stats() {
		return serverText("service.runtime.roots.text.9");
	},
	get uptime() {
		return serverText("service.runtime.roots.text.10");
	},
	get ai() {
		return serverText("service.runtime.roots.text.11");
	},
	get skins() {
		return serverText("service.runtime.roots.text.12");
	},
	get library() {
		return serverText("service.runtime.roots.text.13");
	},
	get "maid-skills"() {
		return serverText("service.runtime.roots.text.14");
	},
	get extensions() {
		return serverText("service.runtime.roots.text.15");
	},
} as const;

export type HostRootKey = keyof typeof HOST_ROOT_LAYOUT;
export type DataRootKey = keyof typeof DATA_ROOT_LAYOUT;

/** 宿主根下的路径。第一段只能是 `HOST_ROOT_LAYOUT` 里的键。 */
export function hostPath(hostRoot: string, key: HostRootKey, ...rest: string[]): string {
	return join(hostRoot, key, ...rest);
}

/** 数据根(一代)下的路径。第一段只能是 `DATA_ROOT_LAYOUT` 里的键。 */
export function dataPath(dataRoot: string, key: DataRootKey, ...rest: string[]): string {
	return join(dataRoot, key, ...rest);
}
