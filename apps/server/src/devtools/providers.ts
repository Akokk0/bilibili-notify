import type { DevParamField, DevScenarioDef, DevtoolsProvider } from "@bilibili-notify/internal";
import { createRegistry } from "../integrations/registry.js";

export type { DevtoolsProvider } from "@bilibili-notify/internal";

/** 核心自己那一家的提供方 id:建表时就占着,别家认领不到(它也是保留的拓展 id)。 */
const CORE_DEVTOOLS_PROVIDER = "core";

/**
 * 别家的场景能用的参数种类。`sub` / `target` / `connection` 是站内的订阅 / 目标 / 连接 id,只给核心
 * (ADR-0031 决策 2「参数按提供方收窄」);来源要挑人用 `creator`,值是自己名单里的 externalId。
 */
const PROVIDER_PARAM_KINDS: ReadonlySet<string> = new Set<DevParamField["kind"]>([
	"text",
	"number",
	"enum",
	"creator",
]);

/**
 * 登记表 `devtoolsProviders`:按提供方 id 认领,核心从这里汇总出全部场景。
 * 认领规矩(一个 id 一个主人、撤下只撤自己那一行)来自通用登记表 `createRegistry`;
 * 这里多记一份认领顺序,汇总时场景在面板里的次序才稳定。核心的场景建表时就交、以 `core` 占着、排最前;
 * 拓展在开发版启动后经 `contributes.devtools` 的开发入口认领,停用 / 卸载时撤下自己的那份。
 */
export interface DevtoolsProviderRegistry {
	/**
	 * 认领一个提供方 id;已被认领(`core` 恒被核心占着)、这一家自己的场景重复、或参数用了别家不能用的种类,
	 * 都抛,整包不进表。
	 */
	claim(providerId: string, provider: DevtoolsProvider): { dispose(): void };
	/**
	 * 汇总:每个场景的 id 与它「当前生效」条上的 `scenarioId` 都加上 `<提供方 id>.` 前缀,`provider` 填提供方 id。
	 * 认领与撤下之间交回同一份。
	 */
	scenarios(): readonly DevScenarioDef[];
}

function prefixed(providerId: string, def: DevScenarioDef): DevScenarioDef {
	const id = `${providerId}.${def.id}`;
	const { active } = def;
	return {
		...def,
		id,
		provider: providerId,
		// 「当前生效」条按 scenarioId 找场景收摊:不跟着换,面板点收摊就找不到这一条。
		active: active
			? () => {
					const injection = active.call(def);
					return injection ? { ...injection, scenarioId: id } : null;
				}
			: undefined,
	};
}

/** 一家的场景加好前缀;同一家里重名就抛,点名带前缀的 id。`kinds` 给了就只收这几种参数。 */
function prefixAll(
	providerId: string,
	defs: readonly DevScenarioDef[],
	kinds?: ReadonlySet<string>,
): DevScenarioDef[] {
	const seen = new Set<string>();
	return defs.map((def) => {
		const out = prefixed(providerId, def);
		if (seen.has(out.id)) throw new Error(`devtools 场景 id 撞了:${out.id}`);
		seen.add(out.id);
		for (const param of kinds ? def.params : []) {
			if (!kinds?.has(param.kind)) {
				throw new Error(
					`devtools 场景 ${out.id} 的参数 ${param.key} 是 ${String(param.kind)};核心以外只收 ${[...(kinds ?? [])].join(" / ")}`,
				);
			}
		}
		return out;
	});
}

export function createDevtoolsProviderRegistry(
	core: readonly DevScenarioDef[] = [],
): DevtoolsProviderRegistry {
	const table = createRegistry<DevScenarioDef[]>((id) => `devtools 提供方 id 已被认领:${id}`);
	table.claim(CORE_DEVTOOLS_PROVIDER, prefixAll(CORE_DEVTOOLS_PROVIDER, core));
	const order: string[] = [CORE_DEVTOOLS_PROVIDER];
	// 汇总的那一份:认领 / 撤下时作废,下次读时重做。面板列场景、跑场景、查生效都读它,不必每次都重新加前缀。
	let merged: readonly DevScenarioDef[] | undefined;
	return {
		claim(providerId, provider) {
			const scenarios = prefixAll(providerId, provider.scenarios, PROVIDER_PARAM_KINDS);
			const handle = table.claim(providerId, scenarios);
			order.push(providerId);
			merged = undefined;
			return {
				dispose() {
					handle.dispose();
					const at = order.indexOf(providerId);
					if (at >= 0 && table.get(providerId) === undefined) order.splice(at, 1);
					merged = undefined;
				},
			};
		},
		scenarios() {
			merged ??= order.flatMap((providerId) => table.get(providerId) ?? []);
			return merged;
		},
	};
}
