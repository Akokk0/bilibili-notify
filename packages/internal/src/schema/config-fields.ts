import type { ZodType } from "zod";
import { LIST_ITEM_ID_KEY } from "../extension/wire";
import type { SettingsField } from "../settings-field";
import { defOf, enumValuesOf, numberBoundsOf, unwrap, type ZodDef } from "./zod-def";

/**
 * 拓展交上来的两份声明**对不对得上** —— 对不上就拒绝加载(ADR-0012 决策 19 / 33,
 * ADR-0019 决策 17)。连接配置项与设置项都走这一道。
 *
 * 设置项给人填,zod 给机器校验。官方拓展只写 zod 一份,清单里的设置项由构建从规则导出
 * (`settingsFieldsFromSchema`,经 `@bilibili-notify/extension/build`),天生对得上;手写清单的
 * (第三方、不用那道构建的)仍是两份,会漂。这道对表就是那笔账的兜底:**同进程,宿主拿得到拓展的 zod**,
 * 所以漂了当场看得见,而不是等主人在面板上填完保存不上。对的不只是键:设置项按数据类型分、
 * 与 zod 一一对应,所以**类型与默认值一起对**。构建导出完也过一遍这道,错在构建时就报。
 *
 * 🔴 **判形状不用 `instanceof`**(见 `zod-def.ts`):对象看有没有 `.shape`,类型读 `_zod.def`。
 *
 * 抛出来的每一条都点名到具体那一格 —— 拓展是我们自己写的,信息给足才修得快。
 */
export function assertConfigFieldsMatchSchema(
	id: string,
	schema: ZodType,
	fields: readonly SettingsField[],
	opts: {
		/**
		 * 连接是从候选(`listConnectionCandidates`)里**挑**出来的(ADR-0012 决策 45)—— settings 由拓展自己交,没有
		 * 一栏是人填的,所以「必填键没人填」那一半不查:那正是它的常态,不是漂了。
		 */
		picked?: boolean;
	} = {},
): void {
	const fail = (msg: string): never => {
		throw new Error(`extension ${id}: ${msg}`);
	};

	// 第一层必须是**键值对象**:面板那侧的 `set` 统一生成成 `config[key] = v`,前提就是这个。
	const shape = (schema as { shape?: unknown }).shape;
	if (typeof shape !== "object" || shape === null) {
		return void fail("config 的 schema 必须是一个对象(第一层只支持键值对象)");
	}
	assertNotStrict("config schema", defOf(schema), fail);
	checkFields("", shape as Record<string, unknown>, fields, fail, {
		picked: opts.picked === true,
		listItem: false,
	});
}

/**
 * 🔴 strict 对象(`z.strictObject` / `.strict()`)不许用:存着的那份里只要多一个旧键 —— 清单改过、
 * 旧版留下的 —— 它就**整份**解不开,设置读不了、拓展起不来(ADR-0019 决策 36);连接的 config
 * 也是存下来的,一样。zod 4 里 strict 就是 `catchall` 为 `never`。
 */
function assertNotStrict(
	what: string,
	def: ZodDef | undefined,
	fail: (msg: string) => never,
): void {
	if (defOf(def?.catchall)?.type !== "never") return;
	fail(
		`${what}是 strict 对象(z.strictObject / .strict()):存着的那份里只要多一个旧键(清单改过、旧版留下的),整份就解不开,拓展会因此起不来。改用普通的 z.object(多的键丢掉)或 z.looseObject / .passthrough()(多的键原样留着)`,
	);
}

/** 设置项的类型 → zod 那边剥完包装应该是什么。enum 不止一种写法,另由 {@link enumValuesOf} 认。 */
const ZOD_TYPE_OF: Record<Exclude<SettingsField["type"], "enum">, string> = {
	string: "string",
	number: "number",
	boolean: "boolean",
	list: "array",
};

/** 一张表对一个对象的成员 —— 顶层与列表的每一项是同一套规矩。 */
function checkFields(
	prefix: string,
	members: Record<string, unknown>,
	fields: readonly SettingsField[],
	fail: (msg: string) => never,
	opts: { picked: boolean; listItem: boolean },
): void {
	// zod 的 shape 是个普通对象:`in` 会顺着原型链把 `toString` 这类判成 schema 的键。只认它
	// 自己的键。
	const memberKeys: ReadonlySet<string> = new Set(Object.keys(members));
	// 列表项的 id 由 BN 生成、藏起来(ADR-0019 决策 29):清单里不声明它,zod 里却必须有 ——
	// 没有的话,BN 生成的 id 会被拓展那份 zod 当场剥掉,视图就再也挂不到这一项上。
	if (opts.listItem && !memberKeys.has(LIST_ITEM_ID_KEY)) {
		fail(`列表项 "${prefix}${LIST_ITEM_ID_KEY}" 由 BN 生成,zod 的项里要有这一格`);
	}
	const seen = new Set<string>(opts.listItem ? [LIST_ITEM_ID_KEY] : []);
	for (const field of fields) {
		const path = `${prefix}${field.key}`;
		if (seen.has(field.key)) {
			fail(`字段表里 "${path}" 摆了两栏 —— 哪一栏说了算没有答案`);
		}
		seen.add(field.key);
		if (!memberKeys.has(field.key)) {
			fail(`字段表里的 "${path}" 不是 config schema 的键`);
		}
		checkField(path, field, members[field.key], fail);
	}

	if (opts.picked) return;
	for (const [key, member] of Object.entries(members)) {
		// 有栏的那几格,必填已经由 checkField 对过。
		if (seen.has(key)) continue;
		const path = `${prefix}${key}`;
		const { def, optional } = unwrap(member);
		if (!def) fail(`"${path}" 的 schema 认不出类型 —— 拓展的 schema 要用 zod 4 写`);
		if (!optional) fail(`config schema 的必填键 "${path}" 在字段表里没有对应那一栏`);
	}
}

function checkField(
	path: string,
	field: SettingsField,
	member: unknown,
	fail: (msg: string) => never,
): void {
	const { def, fill, optional } = unwrap(member);
	// 认不出就拒,而不是悄悄跳过这一格 —— 跳过的话,这一格的两份声明就再没人对了。
	if (!def) return void fail(`"${path}" 的 schema 认不出类型 —— 拓展的 schema 要用 zod 4 写`);
	const accepted = field.type === "enum" ? enumValuesOf(def) : undefined;
	if (field.type === "enum" ? !accepted : def.type !== ZOD_TYPE_OF[field.type]) {
		const hint =
			field.type === "enum" && def.type === "union"
				? " —— enum 只认每一支都是字面量(或 z.enum)的 union"
				: "";
		fail(`"${path}" 声明的是 ${field.type},zod 里却是 ${def.type}${hint}`);
	}

	// 🔴 必填也要对上。BN 保存设置前按**清单**校验,没写 `required` 也没给 `default` 的格照清单是
	// 「可以不填」;zod 却收不下 `undefined` —— 缺了这一格的设置照样存得进去,拓展读的时候解不开,
	// **整份**设置按没设过算(桥就是全部接入一起失效)。有默认值的两边已由下面对表钉住。
	const zodRequired = !optional;
	const declaredDefault = "default" in field ? field.default : undefined;
	if (zodRequired && field.required !== true && declaredDefault === undefined) {
		const fix =
			field.type === "list"
				? `要么写 "required": true,要么给 zod 那边一个默认值(比如 .default([]))`
				: `要么写 "required": true,要么两边都给同一个 default`;
		fail(
			`"${path}" 在 zod 里是必填(收不下 undefined),设置项里却没写 "required": true 也没给 default —— 按清单保存时缺了它照样放行,拓展自己的 zod 却解不开(设置会整份当没设过)。${fix}`,
		);
	}

	if (field.type === "list") {
		// 列表自己的默认值(通常是空数组)不算漂移:设置项里没有给列表写默认值那一格。
		const item = unwrap(def.element).def;
		if (item?.type !== "object" || !item.shape) {
			return void fail(`"${path}" 是列表,zod 那边每一项得是个对象`);
		}
		assertNotStrict(`"${path}" 的每一项`, item, fail);
		checkFields(`${path}.`, item.shape, field.fields, fail, {
			picked: false,
			listItem: true,
		});
		return;
	}

	if (field.type === "number") {
		// 🔴 面板照设置项的 min / max 拦,拓展照自己的 zod 收。zod 多一道,面板放行的值拓展一读就整份
		// 失败(设置读不了、拓展起不来);设置项多一道,面板拦下的是拓展本来收的值。
		const zod = numberBoundsOf(def);
		const sides = [
			["下限", field.min, zod.min, ["≥", ">"]],
			["上限", field.max, zod.max, ["≤", "<"]],
		] as const;
		for (const [which, declared, bound, [closed, open]] of sides) {
			if (
				declared === undefined ? bound === undefined : bound?.inclusive && bound.value === declared
			) {
				continue;
			}
			const zodSide = bound ? `${bound.inclusive ? closed : open} ${bound.value}` : "没写";
			fail(
				`"${path}" 的${which}两边不一样:设置项是 ${declared === undefined ? "没写" : `${closed} ${declared}`},zod 是 ${zodSide} —— 面板照设置项拦、拓展照 zod 收,放行的值拓展可能读不了。设置项的 min / max 含端点,对应 zod 的 .min() / .max()(即 .gte() / .lte())`,
			);
		}
	}

	if (field.type === "enum" && accepted) {
		// 面板存的永远是字符串:zod 收的是数字 1 的话,选项写 "1" 也永远存不对。
		const odd = accepted.find((value) => typeof value !== "string");
		if (odd !== undefined) {
			fail(`"${path}" 的 zod 取值里有不是字符串的 ${JSON.stringify(odd)} —— 面板存的永远是字符串`);
		}
		// 面板能选出 zod 不收的值(或者反过来有一种永远选不到),都是漂了。
		const declared = field.options.map((option) => option.value).sort();
		const values = [...new Set(accepted as string[])].sort();
		if (declared.join("\n") !== values.join("\n")) {
			fail(`"${path}" 的选项 [${declared.join(", ")}] 与 zod 的取值 [${values.join(", ")}] 对不上`);
		}
	}

	// 面板显示的默认值就是设置项里写的那个;与 zod 实际补上的不一样,主人看到的就是假话。
	let defaultValue: unknown;
	if (fill) {
		try {
			defaultValue = fill.read();
		} catch (err) {
			fail(
				`"${path}" 的 .${fill.from}() 在缺了这一格时算不出补什么(${err instanceof Error ? err.message : String(err)}) —— 对表要拿它与设置项的 default 比,改成直接给值的 .catch(值) 或 .default(值)`,
			);
		}
	}
	// 补出来是 undefined 的(`.catch(() => undefined)` 这类)等于没补。
	const hasDefault = defaultValue !== undefined;
	const from = fill?.from === "catch" ? "(.catch 补的)" : "";
	if (field.default !== undefined && !hasDefault) {
		fail(`"${path}" 在设置项里写了默认值 ${JSON.stringify(field.default)},zod 里却没有`);
	}
	if (field.default === undefined && hasDefault) {
		fail(
			`"${path}" 在 zod 里有默认值 ${JSON.stringify(defaultValue)}${from},设置项里没写 —— 面板显示的会和实际用的不一样`,
		);
	}
	if (field.default !== undefined && hasDefault && !Object.is(field.default, defaultValue)) {
		fail(
			`"${path}" 的默认值两边不一样:设置项写的是 ${JSON.stringify(field.default)},zod 是 ${JSON.stringify(defaultValue)}${from}`,
		);
	}
}
