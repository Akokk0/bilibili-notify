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
	versions:
		"已装的载荷版本,内含 boot-state.json 与 manifest-freshness.json;冻住的 boot.mjs 从 dataDir 推算这里",
	logs: "日志 <日>.jsonl,跨代连续;冻住的桌面壳写死了这里(「打开日志目录」)",
	generations:
		"数据代,一代一个目录 <序号>/(写到一半的叫 <序号>.partial/),选哪一代见 runtime/generations.ts",
} as const;

/**
 * 数据根(一代)下的一级项 —— 目录表,也就是代的布局(`docs/1.0/data-and-migration.md`「目录布局」)。
 * 聊天附件(⑳b)、拓展订阅头像(⑳c)、历史配图与重推原件里的图(⑳d)都已经进了图库 `images/`:`assets`、`avatars`
 * 两个过渡键删了,`history/img/` 没有了。
 */
export const DATA_ROOT_LAYOUT = {
	config: "主人填的:设置、订阅、连接、目标",
	secrets: "主密钥、口令派生盐、AI 的 apiKey、B 站 cookie",
	runtime: "程序自己记的,丢了只退化:订阅运行态、锐评草稿、直播封面的轮换游标",
	history:
		"推送历史 <日>.jsonl(文字不删)、重推原件 repush/<日>/、图与原件清到哪天的水位线 retention.json;图在图库 images/,这里只存引用",
	images: "图库:按内容存的图 <sha256>.<ext>,作品图、封面、头像、历史快照、聊天附件共用",
	stats:
		"作品 posts/、直播 live/、「在记」小账 recording/、粉丝时序 followers/(都按订阅一个 jsonl)",
	ai: "女仆对话 conversations/",
	skins: "卡片皮肤 card/<id>/、界面皮肤 dashboard/<id>/ 与 dashboard/active.json",
	library: "素材库:卡片背景 images/、字体 fonts/(连同名字清单)",
	"maid-skills": "主人的女仆技能 <name>/SKILL.md",
	extensions: "已装的拓展包、失败记账 load-state.json、市场来源 .marketplace.json",
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
