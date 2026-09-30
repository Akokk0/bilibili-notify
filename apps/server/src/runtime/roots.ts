/**
 * 配置里的 `dataDir` 在代码里拆成两个根(ADR-0022 决策 1):
 *
 * - **宿主根**(`hostRoot`):`dataDir` 本身。放不分代、格式冻结的宿主件 —— 冻住的外壳认它们的位置。
 * - **数据根**(`dataRoot`):其余一切。1.0 起是宿主根下选中的那一代;0.x 的布局(第 0 代)
 *   就是宿主根本身,所以数据代落地之前两个根是同一个目录。
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
 * 数据根下的一级项 —— 目录表。现在登记的是 0.x 的布局(第 0 代),也就是数据代迁移要读的
 * 输入清单;数据代落地时换成代的布局(`docs/1.0/data-and-migration.md`「目录布局」)。
 */
export const DATA_ROOT_LAYOUT = {
	state: "设置、两份订阅、连接、目标,和程序自己记的小状态(订阅运行态、锐评草稿)",
	secrets: "主密钥、口令派生盐、AI 的 apiKey、B 站 cookie",
	history: "推送历史 <日>.jsonl、历史图 img/、重推原件 repush/<日>/",
	stats: "作品 dyn/、直播 live/、seen/(按订阅一个 jsonl)与水位线 since",
	fans: "粉丝时序,按订阅一个 jsonl",
	assets: "卡片背景 card-bg/、聊天附件 chat/、字体 font/",
	avatars: "拓展订阅的头像,按订阅 id",
	skins: "界面皮肤 <id>/ 与 active.json",
	"card-skins": "卡片皮肤 <id>/",
	"maid-skills": "主人的女仆技能 <name>/SKILL.md",
	ai: "女仆对话 chat/",
	extensions: "已装的拓展包、失败记账 load-state.json、市场来源 .marketplace.json",
	"card-bg-cursors.json": "直播封面的轮换游标",
} as const;

/**
 * 代里的一级项 —— 代的布局(`docs/1.0/data-and-migration.md`「目录布局」)。迁移器照它把第 0 代搬进
 * 新的一代;接线那一步(⑥b2)它替换上面的 `DATA_ROOT_LAYOUT`。第 2 期以前格式不动,所以还有三处
 * 过渡:它们要等图库(`images/`)落地才能并过去。
 */
export const GENERATION_LAYOUT = {
	config: "主人填的:设置、订阅、连接、目标",
	secrets: "主密钥、口令派生盐、AI 的 apiKey、B 站 cookie",
	runtime: "程序自己记的,丢了只退化:订阅运行态、锐评草稿、直播封面的轮换游标",
	history: "推送历史 <日>.jsonl、重推原件 repush/<日>/;历史图 img/ 是过渡,第 2 期并进图库",
	stats: "作品 dyn/、直播 live/、seen/、粉丝时序 followers/(按订阅一个 jsonl)与水位线 since",
	ai: "女仆对话 conversations/",
	skins: "卡片皮肤 card/<id>/、界面皮肤 panel/<id>/ 与 panel/active.json",
	library: "素材库:卡片背景 images/、字体 fonts/(连同名字清单)",
	"maid-skills": "主人的女仆技能 <name>/SKILL.md",
	extensions: "已装的拓展包、失败记账 load-state.json、市场来源 .marketplace.json",
	avatars: "过渡,第 2 期并进图库:拓展订阅的头像,按订阅 id",
	assets: "过渡,第 2 期并进图库:聊天附件 chat/",
} as const;

export type HostRootKey = keyof typeof HOST_ROOT_LAYOUT;
export type DataRootKey = keyof typeof DATA_ROOT_LAYOUT;
export type GenerationKey = keyof typeof GENERATION_LAYOUT;

/** 宿主根下的路径。第一段只能是 `HOST_ROOT_LAYOUT` 里的键。 */
export function hostPath(hostRoot: string, key: HostRootKey, ...rest: string[]): string {
	return join(hostRoot, key, ...rest);
}

/** 数据根下的路径。第一段只能是 `DATA_ROOT_LAYOUT` 里的键。 */
export function dataPath(dataRoot: string, key: DataRootKey, ...rest: string[]): string {
	return join(dataRoot, key, ...rest);
}

/** 某一代里的路径。第一段只能是 `GENERATION_LAYOUT` 里的键。 */
export function generationPath(
	generationDir: string,
	key: GenerationKey,
	...rest: string[]
): string {
	return join(generationDir, key, ...rest);
}
