import type { DevRunResponse } from "@bilibili-notify/contract";
import {
	type DevInjection,
	type DevParamField,
	type DevParamValues,
	type DevScenarioDef,
	type DevScenarioDescriptor,
	type Failure,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import type { DevtoolsProviderRegistry } from "./providers.js";

export type { DevScenarioDef } from "@bilibili-notify/internal";

/**
 * devtools 的中央注册表(服务端这半)。
 *
 * 场景是「声明 + 三个函数」:声明(中立词汇里的 `DevScenarioDescriptor`)原样交给面板画控件;`run` 做事;
 * 状态类场景再带 `active` / `reset`,「当前生效」条与一键收摊靠它们 —— 生效与否的真相在
 * 各自的装饰器手里(一条真动作就能把假状态顶掉),注册表不另记一份,只问。
 *
 * 参数按 schema 补默认值、挡不合法的,在这一层做:每个场景各写一遍的话,漏写的那个
 * 就会拿到 `undefined` 往下传。`sub` / `target` / `connection` / `creator` 四种**不在这里补**——默认值
 * 是「第一个启用的订阅」这类要查配置的事,归场景自己;`creator` 给了的,这里按那一家的名单核一遍。
 */

export interface DevRegistry {
	list(): DevScenarioDescriptor[];
	run(id: string, params: DevParamValues): Promise<Result<DevRunResponse>>;
	active(): DevInjection[];
	/** 收摊:给 id 只收那一个,不给全收。回收完之后的生效表。 */
	reset(id?: string): Promise<Result<{ active: DevInjection[] }>>;
}

/** 场景要用的口是后建的、现取的:还没起来就当参数错回结果,别让一个 undefined 往下传。 */
export function notReady(what: string): Failure {
	return fail("invalid", `${what}还没起来`);
}

/** 把声明从 def 里剥出来 —— 函数不能过 JSON,而且面板也不该拿到。 */
function declarationOf(def: DevScenarioDef): DevScenarioDescriptor {
	const out: DevScenarioDescriptor = {
		id: def.id,
		group: def.group,
		title: def.title,
		params: def.params,
	};
	if (def.provider !== undefined) out.provider = def.provider;
	if (def.desc !== undefined) out.desc = def.desc;
	if (def.quick !== undefined) out.quick = def.quick;
	if (def.icon !== undefined) out.icon = def.icon;
	return out;
}

/** 一个字段:给的值 → 校验 / 转换;没给 → 默认值;没默认值 → 不出现在结果里。`roster` 是这一家的名单。 */
function coerce(
	field: DevParamField,
	given: string | number | undefined,
	roster: () => readonly string[],
): Result<{ value: string | number | undefined }> {
	let value: string | number | undefined;
	switch (field.kind) {
		case "sub":
		case "target":
		case "connection":
			value = given === undefined ? undefined : String(given);
			break;
		case "creator":
			value = given === undefined ? undefined : String(given);
			if (value !== undefined && !roster().includes(value)) {
				return fail("invalid", `${field.label}(${field.key})不在名单里:${value}`);
			}
			break;
		case "text":
			value = given === undefined ? field.default : String(given);
			break;
		case "enum": {
			value = given === undefined ? field.default : String(given);
			if (!field.options.some((o) => o.value === value)) {
				return fail("invalid", `${field.label}(${field.key})没有「${value}」这一档`);
			}
			break;
		}
		case "number": {
			if (given === undefined) {
				value = field.default;
				break;
			}
			const n = typeof given === "number" ? given : Number(given);
			if (!Number.isFinite(n)) return fail("invalid", `${field.label}(${field.key})要是个数`);
			if (field.min !== undefined && n < field.min) {
				return fail("invalid", `${field.label}(${field.key})最小 ${field.min}`);
			}
			if (field.max !== undefined && n > field.max) {
				return fail("invalid", `${field.label}(${field.key})最大 ${field.max}`);
			}
			value = n;
			break;
		}
	}
	return ok({ value });
}

function fillParams(
	fields: DevParamField[],
	given: DevParamValues,
	roster: () => readonly string[],
): Result<{ values: DevParamValues }> {
	const out: DevParamValues = {};
	for (const field of fields) {
		const coerced = coerce(field, given[field.key], roster);
		if (!coerced.ok) return coerced;
		if (coerced.value !== undefined) out[field.key] = coerced.value;
	}
	return ok({ values: out });
}

export interface DevRegistryOptions {
	/**
	 * 一个来源的名单(`ctx.subscriptions()` 那一份的 externalId),`creator` 参数照它核。不给 = 谁的名单都是空的,
	 * 给了 `creator` 的一律 `invalid`。
	 */
	creators?: (sourceKey: string) => readonly string[];
}

export function createDevRegistry(
	providers: Pick<DevtoolsProviderRegistry, "scenarios">,
	options: DevRegistryOptions = {},
): DevRegistry {
	const creators = options.creators ?? (() => []);
	const findDef = (id: string) => providers.scenarios().find((candidate) => candidate.id === id);
	// 声明按场景记一份:汇总那一份在认领 / 撤下之间不变,面板列场景时不必每次都重新剥。
	let listed:
		| { from: readonly DevScenarioDef[]; declarations: DevScenarioDescriptor[] }
		| undefined;

	function active(): DevInjection[] {
		const out: DevInjection[] = [];
		for (const def of providers.scenarios()) {
			const injection = def.active?.();
			if (injection) out.push(injection);
		}
		return out;
	}

	return {
		list() {
			const from = providers.scenarios();
			if (listed?.from !== from) listed = { from, declarations: from.map(declarationOf) };
			return listed.declarations;
		},
		async run(id, params) {
			const def = findDef(id);
			if (!def) return fail("not_found", `没有这个场景:${id}`);
			const filled = fillParams(def.params, params, () => creators(def.provider ?? ""));
			if (!filled.ok) return filled;
			const outcome = await def.run(filled.values);
			if (!outcome.ok) return outcome;
			const res: DevRunResponse = { active: active() };
			if (outcome.summary !== undefined) res.summary = outcome.summary;
			return ok(res);
		},
		active,
		async reset(id) {
			const current = providers.scenarios();
			if (id === undefined) {
				// 一条收摊失败不该让别的收不成 —— 但失败要报出去,所以先全跑再一起看结果。
				const results = await Promise.allSettled(current.map(async (def) => def.reset?.()));
				const failed = results.find((r) => r.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			} else {
				const def = current.find((candidate) => candidate.id === id);
				if (!def) return fail("not_found", `没有这个场景:${id}`);
				await def.reset?.();
			}
			return ok({ active: active() });
		},
	};
}
