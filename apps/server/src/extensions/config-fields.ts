import type { ExtensionConfigField } from "@bilibili-notify/contract";
import { ZodObject, type ZodType } from "zod";

/**
 * 拓展交上来的两份 config 声明**对不对得上** —— 对不上就拒绝加载(ADR-0012 决策 19 / 33)。
 *
 * 两份不是冗余:字段表给人填,zod 给机器校验。合成一份要么把字段表逼成一门 DSL,要么让
 * 校验退化成只剩类型检查 —— 而真实 config 里有「加速前缀必须 https」这种跨字段规则。
 * 代价是「两份会漂」,这道对表就是那笔账的兜底:**同进程,宿主拿得到拓展的 zod**,所以
 * 漂了当场看得见,而不是等主人在面板上填完保存不上。
 *
 * 抛出来的每一条都点名到具体那一格 —— 拓展是我们自己写的,信息给足才修得快。
 */
export function assertConfigFieldsMatchSchema(
	id: string,
	schema: ZodType,
	fields: readonly ExtensionConfigField[],
): void {
	const fail = (msg: string): never => {
		throw new Error(`extension ${id}: ${msg}`);
	};

	// 第一版 config 必须是**扁平的一层键值**:面板那侧的 `set` 统一生成成
	// `config[code] = v`,前提就是这个。
	if (!(schema instanceof ZodObject)) {
		return void fail("config 的 schema 必须是一个对象(第一版 config 只支持扁平的一层键值)");
	}
	const shape = schema.shape as Record<string, ZodType>;

	const seen = new Set<string>();
	for (const field of fields) {
		if (seen.has(field.code)) {
			fail(`字段表里 "${field.code}" 摆了两栏 —— 哪一栏说了算没有答案`);
		}
		seen.add(field.code);
		if (!(field.code in shape)) {
			fail(`字段表里的 "${field.code}" 不是 config schema 的键`);
		}
	}

	for (const [key, member] of Object.entries(shape)) {
		// 收不下 `undefined` 的就是必填(可选与带默认值的都收得下)。
		const required = !member.safeParse(undefined).success;
		if (required && !seen.has(key)) {
			fail(`config schema 的必填键 "${key}" 在字段表里没有对应那一栏`);
		}
	}
}
