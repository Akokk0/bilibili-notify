/**
 * `templateDefaultsSeen` —— 用户「已经知道默认长这样了」的账本。
 *
 * 它是亮灯判定的另一半输入(判定本身见 `../template-defaults.test.ts`)。这里守的是
 * 它在配置层的两条不变量:
 *
 * ① **老配置缺这个字段照样能读** —— 独立端启动时 `GlobalConfigSchema.parse` 失败
 *    是直接挂掉的,新字段不带 `.default` 就是让所有老用户开不了机。
 * ② **全新安装装完不该看见任何「有更新」** —— 他拿到的就是当前默认,没什么可更新
 *    的。账本必须在造默认配置那一刻就填满,否则新用户一进规则页满屏亮灯。
 */

import { describe, expect, it } from "vite-plus/test";
import { pendingTemplateUpdates } from "../template-defaults";
import { DEFAULT_TEMPLATES, GlobalConfigSchema, makeDefaultGlobalConfig } from "./globals";

describe("templateDefaultsSeen", () => {
	it("老 globals.json 没有这个字段 → 自动补空账本,不是解析失败", () => {
		const g = makeDefaultGlobalConfig() as unknown as {
			defaults: Record<string, unknown>;
		};
		delete g.defaults.templateDefaultsSeen;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.defaults.templateDefaultsSeen).toEqual({});
	});

	it("全新安装的用户改了自己的文案 → 不该立刻被提示「有更新」", () => {
		// 账本必须在造默认配置那一刻就填满,**理由在这条**:
		// 全新安装当下值句句等于默认,填不填账本都不亮灯(判定的第一个条件就挡住了)。
		// 可他一旦动手改文案,值就不等于默认了 —— 账本要是空的,他刚敲完自己的句子
		// 就被告知「默认文案有更新」,更新到哪去?那正是他刚替换掉的那句。
		const g = makeDefaultGlobalConfig();
		const mine = { ...g.defaults.templates, liveStart: "我自己写的开播文案" };
		expect(
			pendingTemplateUpdates(mine, DEFAULT_TEMPLATES, g.defaults.templateDefaultsSeen),
		).toEqual([]);
	});
});
