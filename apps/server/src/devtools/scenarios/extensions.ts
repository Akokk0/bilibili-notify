import { readdirSync } from "node:fs";
import { access, lstat, rm, symlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import type { DevParamField } from "@bilibili-notify/contract";
import { EXTENSION_ENTRY_FILE, EXTENSION_MANIFEST_FILE } from "../../extensions/discover.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";

/**
 * 开发版怎么装拓展。
 *
 * 🔴 **装载器只有一个根**(`<dataDir>/extensions/`),仓里那个 `extensions/` 不再是根 ——
 * 于是「开发时怎么让它跑起来」这件事从**宿主的一条特例**变成了 devtools 的一个动作:
 * 把仓里构建好的 `dist` **链**进那个唯一的根。链完之后,它与主人手放的、日后从插件市场
 * 下载的**长得一模一样**:一个目录,里头是清单 + 一个自包含的 `index.mjs`。
 *
 * 软链而不是拷贝:`vp pack -w` 一改就重打包,链着的那份当场就是新的,再按一下「重载」
 * 就换掉了代码 —— 中间没有「重新拷一遍」这一步。
 *
 * ⚠️ **装 / 卸都要重启一次才生效**:装载器开机扫一遍就定了(决策 10 只把**开关**做成热的)。
 * 已经装着的那些改代码不用重启 —— 那是「重载」。
 */
export interface ExtensionScenariosInput {
	/** 仓里那个 `extensions/`。devtools 只在源码运行时存在,所以这条路一定在。 */
	repoDir: string;
	/** 唯一那个装载根 —— `<dataDir>/extensions/`。 */
	installRoot: string;
	/** 装载器。**现取**:拓展比 devtools 后装起来。 */
	extensions: () => { reload(id: string): Promise<void> } | undefined;
}

/** 仓里有哪些拓展 —— 有清单的子目录就算。开机扫一次,面板照它画下拉。 */
function repoExtensionIds(repoDir: string): string[] {
	try {
		return readdirSync(repoDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => {
				try {
					return readdirSync(join(repoDir, name)).includes(EXTENSION_MANIFEST_FILE);
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export function extensionScenarios(input: ExtensionScenariosInput): DevScenarioDef[] {
	const ids = repoExtensionIds(input.repoDir);
	// 仓里一个拓展都没有 → 这三条场景没有可选的东西,不如不出现。
	if (ids.length === 0) return [];

	const pick: DevParamField = {
		key: "ext",
		label: "拓展",
		kind: "enum",
		options: ids.map((id) => ({ value: id, label: id })),
		default: ids[0] as string,
	};
	const distOf = (id: string) => join(input.repoDir, id, "dist");
	const installedAt = (id: string) => join(input.installRoot, id);

	return [
		{
			id: "ext.install",
			group: "ext",
			title: "装一个仓里的拓展",
			desc: "把仓里构建好的 dist 链进 <dataDir>/extensions/。要先 vp run -F <包名> build;装完重启一次才看得见。",
			icon: "download",
			params: [pick],
			async run(params) {
				const id = String(params.ext);
				const dist = distOf(id);
				// 装的是**构建产物**,不是源码目录 —— 装载器只认 index.mjs(与市场下载的同形)。
				if (!(await exists(join(dist, EXTENSION_ENTRY_FILE)))) {
					throw new DevParamError(
						`${id} 还没构建:${dist} 里没有 ${EXTENSION_ENTRY_FILE}。先跑 vp run -F <它的包名> build`,
					);
				}
				const at = installedAt(id);
				const already = await lstat(at).catch(() => undefined);
				if (already?.isSymbolicLink()) {
					return { summary: `${id} 早就装着了(链到 ${dist})` };
				}
				if (already) {
					// 真目录多半是主人手放的那份包 —— devtools 不动它,不然就把人家的东西删了。
					throw new DevParamError(`${at} 已经有一个真目录了(手放的?)—— devtools 不碰它`);
				}
				await symlink(dist, at, platform() === "win32" ? "junction" : "dir");
				return { summary: `已装 ${id} → ${dist};**重启一次**它才出现在拓展页(装载不是热的)` };
			},
		},
		{
			id: "ext.uninstall",
			group: "ext",
			title: "卸掉一个装好的拓展",
			desc: "只删 devtools 自己链进去的那条软链;真目录(手放的包)不碰。",
			icon: "trash",
			params: [pick],
			async run(params) {
				const id = String(params.ext);
				const at = installedAt(id);
				const st = await lstat(at).catch(() => undefined);
				if (!st) throw new DevParamError(`${id} 没装在 ${input.installRoot} 里`);
				if (!st.isSymbolicLink()) {
					throw new DevParamError(`${at} 是个真目录,不是 devtools 链进去的 —— 要删自己动手`);
				}
				await rm(at);
				return { summary: `已卸 ${id};它要到**重启之后**才从拓展页上消失` };
			},
		},
		{
			id: "ext.reload",
			group: "ext",
			title: "重载(换掉代码)",
			desc: "收摊再按新代码跑一遍,不用重启。改完记得先让 vp pack 重新打包(-w 就自动)。",
			icon: "refresh",
			params: [pick],
			async run(params) {
				const id = String(params.ext);
				const loaded = input.extensions();
				if (!loaded) throw new DevParamError("装载器还没起来");
				// 装不起来 / 开关关着 / 没这个 id,加载器自己会说清楚是哪一种。
				await loaded.reload(id).catch((err: Error) => {
					throw new DevParamError(err.message);
				});
				return { summary: `已按新代码重跑 ${id} 的 activate` };
			},
		},
	];
}
