import type {
	DevInjection,
	DevParamField,
	DevParamValues,
	DevRunResponse,
	DevScenario,
} from "@bilibili-notify/contract";

/**
 * devtools 的中央注册表(服务端这半)。
 *
 * 场景是「声明 + 三个函数」:声明(契约里的 `DevScenario`)原样交给面板画控件;`run` 做事;
 * 状态类场景再带 `active` / `reset`,「当前生效」条与一键收摊靠它们 —— 生效与否的真相在
 * 各自的装饰器手里(一条真动作就能把假状态顶掉),注册表不另记一份,只问。
 *
 * 参数按 schema 补默认值、挡不合法的,在这一层做:每个场景各写一遍的话,漏写的那个
 * 就会拿到 `undefined` 往下传。`sub` / `target` / `adapter` 三种**不在这里补**——默认值
 * 是「第一个启用的订阅」这类要查配置的事,归场景自己。
 */
export interface DevRunOutcome {
	summary?: string;
}

export interface DevScenarioDef extends DevScenario {
	run(params: DevParamValues): Promise<DevRunOutcome> | DevRunOutcome;
	/** 状态类场景:现在生效着的那条注入,没有就 null。事件类不写。 */
	active?(): DevInjection | null;
	/**
	 * 状态类场景:收摊。可以是异步的 —— 有的收摊要写盘(静音),写失败得能一路冒到路由,
	 * 而不是变成一个没人接的 promise 把进程带走。
	 */
	reset?(): void | Promise<void>;
}

export interface DevRegistry {
	list(): DevScenario[];
	run(id: string, params: DevParamValues): Promise<DevRunResponse>;
	active(): DevInjection[];
	/** 收摊:给 id 只收那一个,不给全收。回收完之后的生效表。 */
	reset(id?: string): Promise<DevInjection[]>;
}

export class DevScenarioNotFound extends Error {
	constructor(id: string) {
		super(`没有这个场景:${id}`);
		this.name = "DevScenarioNotFound";
	}
}

export class DevParamError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DevParamError";
	}
}

/** 把声明从 def 里剥出来 —— 函数不能过 JSON,而且面板也不该拿到。 */
function declarationOf(def: DevScenarioDef): DevScenario {
	const out: DevScenario = { id: def.id, group: def.group, title: def.title, params: def.params };
	if (def.desc !== undefined) out.desc = def.desc;
	if (def.quick !== undefined) out.quick = def.quick;
	if (def.icon !== undefined) out.icon = def.icon;
	return out;
}

/** 一个字段:给的值 → 校验 / 转换;没给 → 默认值;没默认值 → 不出现在结果里。 */
function coerce(
	field: DevParamField,
	given: string | number | undefined,
): string | number | undefined {
	switch (field.kind) {
		case "sub":
		case "target":
		case "adapter":
			return given === undefined ? undefined : String(given);
		case "text":
			return given === undefined ? field.default : String(given);
		case "enum": {
			const value = given === undefined ? field.default : String(given);
			if (!field.options.some((o) => o.value === value)) {
				throw new DevParamError(`${field.label}(${field.key})没有「${value}」这一档`);
			}
			return value;
		}
		case "number": {
			if (given === undefined) return field.default;
			const n = typeof given === "number" ? given : Number(given);
			if (!Number.isFinite(n)) throw new DevParamError(`${field.label}(${field.key})要是个数`);
			if (field.min !== undefined && n < field.min) {
				throw new DevParamError(`${field.label}(${field.key})最小 ${field.min}`);
			}
			if (field.max !== undefined && n > field.max) {
				throw new DevParamError(`${field.label}(${field.key})最大 ${field.max}`);
			}
			return n;
		}
	}
}

function fillParams(fields: DevParamField[], given: DevParamValues): DevParamValues {
	const out: DevParamValues = {};
	for (const field of fields) {
		const value = coerce(field, given[field.key]);
		if (value !== undefined) out[field.key] = value;
	}
	return out;
}

export function createDevRegistry(defs: readonly DevScenarioDef[]): DevRegistry {
	const byId = new Map<string, DevScenarioDef>();
	for (const def of defs) {
		if (byId.has(def.id)) throw new Error(`devtools 场景 id 撞了:${def.id}`);
		byId.set(def.id, def);
	}
	const declarations = [...byId.values()].map(declarationOf);

	function must(id: string): DevScenarioDef {
		const def = byId.get(id);
		if (!def) throw new DevScenarioNotFound(id);
		return def;
	}

	function active(): DevInjection[] {
		const out: DevInjection[] = [];
		for (const def of byId.values()) {
			const injection = def.active?.();
			if (injection) out.push(injection);
		}
		return out;
	}

	return {
		// 声明是静态的(参数表、默认值都在建表时定型),建一次就够 —— 每次 GET 都重新剥一遍
		// 二十多个对象,只是在给轮询多做无用功。
		list: () => declarations,
		async run(id, params) {
			const def = must(id);
			const outcome = await def.run(fillParams(def.params, params));
			const res: DevRunResponse = { active: active() };
			if (outcome.summary !== undefined) res.summary = outcome.summary;
			return res;
		},
		active,
		async reset(id) {
			if (id === undefined) {
				// 一条收摊失败不该让别的收不成 —— 但失败要报出去,所以先全跑再一起看结果。
				const results = await Promise.allSettled(
					[...byId.values()].map(async (def) => def.reset?.()),
				);
				const failed = results.find((r) => r.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			} else {
				await must(id).reset?.();
			}
			return active();
		},
	};
}
