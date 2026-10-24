/**
 * `templatesSeen`(核心设置顶层)—— 用户「已经知道默认长这样了」的账本。
 *
 * 它是亮灯判定的另一半输入(判定本身见 `../../__tests__/template-defaults.test.ts`)。这里守的是
 * 它在配置层的三条不变量:
 *
 * ① **老配置缺这个字段照样能读** —— 独立端启动时 `GlobalConfigSchema.parse` 失败
 *    是直接挂掉的,新字段不带 `.default` 就是让所有老用户开不了机。
 * ② **全新安装装完不该看见任何「有更新」** —— 他拿到的就是当前默认,没什么可更新
 *    的。账本必须在造默认配置那一刻就填满,否则新用户一进规则页满屏亮灯。
 * ③ **账本在顶层、不在 `defaults` 里**(3a-38):`defaults` 里再写 `templateDefaultsSeen` 会被剥掉。
 */

import { describe, expect, it } from "vite-plus/test";
import { templateDefaultsFor } from "../../builtin-texts";
import { DEFAULT_LOCALE } from "../../i18n";
import { allTemplateFingerprints, pendingTemplateUpdates } from "../../template-defaults";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";

const DEFAULT_TEMPLATES = templateDefaultsFor(DEFAULT_LOCALE);

describe("templatesSeen", () => {
	it("老 globals.json 没有这个字段 → 自动补空账本,不是解析失败", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.templatesSeen;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.templatesSeen).toEqual({});
	});

	it("全新安装:账本在顶层、被填满成当前默认的指纹", () => {
		expect(makeDefaultGlobalConfig().templatesSeen).toEqual(
			allTemplateFingerprints(DEFAULT_TEMPLATES),
		);
	});

	it("全新安装的用户改了自己的文案 → 不该立刻被提示「有更新」", () => {
		// 账本必须在造默认配置那一刻就填满,**理由在这条**:
		// 全新安装当下值句句等于默认,填不填账本都不亮灯(判定的第一个条件就挡住了)。
		// 可他一旦动手改文案,值就不等于默认了 —— 账本要是空的,他刚敲完自己的句子
		// 就被告知「默认文案有更新」,更新到哪去?那正是他刚替换掉的那句。
		const g = makeDefaultGlobalConfig();
		const mine = { ...g.defaults.templates, liveStart: "我自己写的开播文案" };
		expect(pendingTemplateUpdates(mine, DEFAULT_TEMPLATES, g.templatesSeen)).toEqual([]);
	});

	it("`defaults` 里写老键 templateDefaultsSeen 被剥掉、不抛,也不影响顶层账本", () => {
		const base = makeDefaultGlobalConfig();
		const g = {
			...base,
			defaults: { ...base.defaults, templateDefaultsSeen: { post: "x" } },
		};
		const parsed = GlobalConfigSchema.parse(g);
		expect("templateDefaultsSeen" in parsed.defaults).toBe(false);
		expect(parsed.templatesSeen).toEqual(base.templatesSeen);
	});
});
