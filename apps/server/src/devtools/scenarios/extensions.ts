import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DevParamField, fail, ok } from "@bilibili-notify/internal";
import type { DevelopmentExtensions } from "../development-extensions.js";
import type { DevScenarioDef } from "../registry.js";

export interface ExtensionScenariosOptions {
	repoDir: string;
	development: Pick<DevelopmentExtensions, "list" | "mount" | "unmount" | "reload" | "setWatching">;
}

/** 场景与拓展页共用源码装载，不再维护另一套链接、监听或构建流程。 */
export function extensionScenarios(input: ExtensionScenariosOptions): DevScenarioDef[] {
	let ids: string[];
	try {
		ids = readdirSync(input.repoDir, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && existsSync(join(input.repoDir, entry.name, "extension.json")),
			)
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
	if (!ids.length) return [];
	const pick: DevParamField = {
		key: "ext",
		label: "拓展",
		kind: "enum",
		options: ids.map((id) => ({ value: id, label: id })),
		default: ids[0] as string,
	};
	const watched = new Set<string>();
	return [
		{
			id: "ext.install",
			group: "ext",
			title: "挂载仓里的拓展源码",
			icon: "download",
			desc: "直接读取src/index.ts，由BN运行与监听，无需构建或另起拓展进程。",
			params: [pick],
			async run(params) {
				const id = String(params.ext);
				if (!ids.includes(id)) return fail("invalid", "仓里没有这个拓展工程");
				if (input.development.list().some((mount) => mount.id === id))
					return ok({ summary: `${id}已挂载源码` });
				const result = await input.development.mount(join(input.repoDir, id), true);
				return result.ok
					? ok({ summary: `已挂载${id}源码；启用后由BN运行，保存自动更新` })
					: result;
			},
		},
		{
			id: "ext.uninstall",
			group: "ext",
			title: "解除源码挂载",
			icon: "trash",
			desc: "收掉BN中的实例和监听，只移除受管理的链接，保留源码。",
			params: [pick],
			async run(params) {
				const id = String(params.ext);
				const result = await input.development.unmount(id);
				if (!result.ok) return result;
				watched.delete(id);
				return ok({ summary: `已解除${id}，源码保持原样` });
			},
		},
		{
			id: "ext.reload",
			group: "ext",
			title: "重新加载源码",
			icon: "refresh",
			desc: "先校验源码及依赖，通过后由BN收尾旧实例并加载新版。",
			params: [pick],
			async run(params) {
				const id = String(params.ext);
				const result = await input.development.reload(id);
				return result.ok ? ok({ summary: `已重新读取${id}源码` }) : result;
			},
		},
		{
			id: "ext.watch",
			group: "ext",
			title: "源码自动更新",
			icon: "refresh",
			desc: "由BN监听源码和子依赖；失败保留当前实例，修正后继续更新。",
			params: [pick],
			run(params) {
				const id = String(params.ext);
				const result = input.development.setWatching(id, true);
				if (!result.ok) return result;
				watched.add(id);
				return ok({ summary: `已开启${id}源码监听` });
			},
			active() {
				const active = input.development
					.list()
					.filter((mount) => watched.has(mount.id) && mount.watching);
				return active.length
					? {
							scenarioId: "ext.watch",
							label: active
								.map((mount) => `${mount.id}：${mount.error ?? `已更新${mount.reloads}次`}`)
								.join("；"),
						}
					: null;
			},
			reset() {
				for (const id of watched) input.development.setWatching(id, false);
				watched.clear();
			},
		},
	];
}
