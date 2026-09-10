import { readdirSync, watch as watchDir } from "node:fs";
import { access, lstat, realpath, rm, symlink } from "node:fs/promises";
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
 * **装 / 卸当场生效**:链建好(或删掉)之后叫装载器再扫一遍盘(`rescan()`)—— 一个新出现的
 * id 从来没被 import 过,装它与「拨开关第一次启用」是同一档事实。已经装着的那些**改代码**
 * 仍要按一下「重载」:换掉已加载的代码是另一回事(决策 39)。
 */
export interface ExtensionScenariosInput {
	/** 仓里那个 `extensions/`。devtools 只在源码运行时存在,所以这条路一定在。 */
	repoDir: string;
	/** 唯一那个装载根 —— `<dataDir>/extensions/`。 */
	installRoot: string;
	/** 装载器。**现取**:拓展比 devtools 后装起来。 */
	extensions: () =>
		| {
				reload(id: string): Promise<void>;
				/** 再扫一遍装载目录 —— 装 / 卸靠它当场生效。 */
				rescan(): Promise<void>;
		  }
		| undefined;
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
			desc: "把仓里构建好的 dist 链进 <dataDir>/extensions/,当场生效。要先 vp run -F <包名> build。",
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
				// 链建完了才叫装载器去看 —— 反过来的话它扫的是装之前那一眼,什么都不会变。
				const loaded = input.extensions();
				if (!loaded) {
					// devtools 比装载器先建起来。这一次它是真要等重启,别说成「已生效」。
					return { summary: `已装 ${id} → ${dist};装载器还没起来,**重启一次**它才出现在拓展页` };
				}
				await loaded.rescan();
				return { summary: `已装上 ${id} → ${dist};拓展页上当场就有(开关还得自己拨)` };
			},
		},
		{
			id: "ext.uninstall",
			group: "ext",
			title: "卸掉一个装好的拓展",
			desc: "只删 devtools 自己链进去的那条软链,当场收摊;真目录(手放的包)不碰。",
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
				const loaded = input.extensions();
				// 收摊要走装载器:光删掉软链的话,它注册的定时器与端点还在这个进程里跑着。
				if (!loaded) return { summary: `已卸 ${id};装载器还没起来,**重启一次**它才消失` };
				await loaded.rescan();
				return { summary: `已卸 ${id};它注册的东西当场收摊,拓展页上也没了` };
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
		watchScenario(input, pick, installedAt),
	];
}

/**
 * 「改完自动重载」—— 把上面那一下也去掉。
 *
 * 盯的是**装进来那份**的目录(软链指过去的仓里 `dist`),`index.mjs` 一变就叫一次
 * {@link ext.reload} 做的那件事。配着 `vp pack -w`(30ms 一次重建)就是保存即生效。
 *
 * ⚠️ 每重载一次**漏一份旧模块**(ESM 的模块注册表删不掉,ADR-0012 决策 39)。开发版无所谓,
 * 但这就是它**默认关着、要主人自己拨开**的原因 —— 挂成常开等于让它无声地漏。
 */
function watchScenario(
	input: ExtensionScenariosInput,
	pick: DevParamField,
	installedAt: (id: string) => string,
): DevScenarioDef {
	/** 眼下盯着的那一个。同时只盯一个 —— 面板上「当前生效」也只该有一格。 */
	let live: { id: string; stop: () => void; reloads: number; failure?: string } | undefined;

	function stop(): void {
		live?.stop();
		live = undefined;
	}

	return {
		id: "ext.watch",
		group: "ext",
		title: "改完自动重载",
		icon: "refresh",
		desc: "盯着装进来那份的 index.mjs,一变就自己重载。配 `vp pack -w` 就是保存即生效。⚠️ 每重载一次漏一份旧模块(ESM 卸不掉),开发版无所谓,但别当常态开着。",
		params: [pick],
		async run(params) {
			const id = String(params.ext);
			const at = installedAt(id);
			// 盯的是**软链指过去的那个真目录** —— 盯软链本身,重建时看不到里头的变化。
			const dir = await realpath(at).catch(() => undefined);
			if (!dir) throw new DevParamError(`${id} 还没装进来 —— 先按「装一个仓里的拓展」`);

			stop();
			const state = { id, stop: () => {}, reloads: 0 } as {
				id: string;
				stop: () => void;
				reloads: number;
				failure?: string;
			};
			// 一次重建会连着来好几发事件(写文件、改名),攒一下只重载一次。
			let pending: NodeJS.Timeout | undefined;
			const watcher = watchDir(dir, (_event, name) => {
				if (name !== null && name !== EXTENSION_ENTRY_FILE) return;
				if (pending) clearTimeout(pending);
				pending = setTimeout(() => {
					void reload();
				}, 80);
			});
			state.stop = () => {
				if (pending) clearTimeout(pending);
				watcher.close();
			};

			async function reload(): Promise<void> {
				const loaded = input.extensions();
				if (!loaded) {
					state.failure = "装载器还没起来";
					return;
				}
				try {
					await loaded.reload(id);
					state.reloads += 1;
					state.failure = undefined;
				} catch (err) {
					// 🔴 失败**不掐监听**:改一行崩一次就得重新去点一遍的话,开发循环当场卡死。
					// 那句理由挂到「当前生效」条上,主人看得见。
					state.failure = (err as Error).message;
				}
			}

			live = state;
			return { summary: `盯上了 ${dir};改完自动重载(记得 vp pack -w 开着)` };
		},
		active() {
			if (!live) return null;
			const tail = live.failure ? `上次重载失败:${live.failure}` : `已重载 ${live.reloads} 次`;
			return { scenarioId: "ext.watch", label: `自动重载 → ${live.id}(${tail})` };
		},
		reset: stop,
	};
}
