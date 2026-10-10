import { createRegistry } from "../integrations/registry.js";
import type { DevScenarioDef } from "./registry.js";

/**
 * 一家集成交给 devtools 的那一包场景。B 站是第一个实现者(`bilibili/devtools/`),拓展的
 * `contributes.devtools` 随 3b 接进来。
 *
 * 场景里写**不带前缀**的 id:来源前缀由汇总那一处统一加(`providers.scenarios()`),
 * 各家不用知道自己叫什么、也冒充不了别家(ADR-0031 决策 2)。
 */
export interface DevtoolsProvider {
	scenarios: DevScenarioDef[];
}

/**
 * 登记表 `devtoolsProviders`:按来源 id 认领,核心从这里汇总出全部场景。
 * 认领规矩(一个 id 一个主人、撤下只撤自己那一行)来自通用登记表 `createRegistry`;
 * 这里多记一份认领顺序,汇总时场景在面板里的次序才稳定。
 */
export interface DevtoolsProviderRegistry {
	/** 认领一个来源 id;已被认领、或这一家自己的场景 id 撞了,都抛。 */
	claim(sourceId: string, provider: DevtoolsProvider): { dispose(): void };
	/** 汇总:每个场景的 id 与它「当前生效」条上的 `scenarioId` 都加上 `<来源 id>.` 前缀。 */
	scenarios(): DevScenarioDef[];
}

function prefixed(sourceId: string, def: DevScenarioDef): DevScenarioDef {
	const id = `${sourceId}.${def.id}`;
	const { active } = def;
	return {
		...def,
		id,
		// 「当前生效」条按 scenarioId 找场景收摊:不跟着换,面板点收摊就找不到这一条。
		active: active
			? () => {
					const injection = active.call(def);
					return injection ? { ...injection, scenarioId: id } : null;
				}
			: undefined,
	};
}

export function createDevtoolsProviderRegistry(): DevtoolsProviderRegistry {
	const table = createRegistry<DevtoolsProvider>((id) => `devtools 来源 id 已被认领:${id}`);
	const order: string[] = [];
	return {
		claim(sourceId, provider) {
			const seen = new Set<string>();
			for (const def of provider.scenarios) {
				if (seen.has(def.id)) throw new Error(`devtools 场景 id 撞了:${sourceId}.${def.id}`);
				seen.add(def.id);
			}
			const handle = table.claim(sourceId, provider);
			order.push(sourceId);
			return {
				dispose() {
					handle.dispose();
					const at = order.indexOf(sourceId);
					if (at >= 0 && table.get(sourceId) === undefined) order.splice(at, 1);
				},
			};
		},
		scenarios() {
			return order.flatMap((sourceId) =>
				(table.get(sourceId)?.scenarios ?? []).map((def) => prefixed(sourceId, def)),
			);
		},
	};
}
