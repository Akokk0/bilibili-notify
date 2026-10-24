/**
 * `templatesSeen`(核心设置顶层)—— 「这条我改的时候,简体默认长这样」的账本。
 *
 * 它是亮灯判定的另一半输入(判定本身见 `../../__tests__/template-defaults.test.ts`)。这里守的是
 * 它在配置层的三条不变量:
 *
 * ① **老配置缺这个字段照样能读** —— 独立端启动时 `GlobalConfigSchema.parse` 失败
 *    是直接挂掉的,新字段不带 `.default` 就是让所有老用户开不了机。
 * ② **全新安装的账本是空的** —— 新装一条文字都没存(跟随当前语言的出厂),没有「改的那一刻」可记;
 *    主人第一次改某条时才由面板记下。
 * ③ **账本在顶层、不在 `defaults` 里**(3a-38):`defaults` 里再写 `templateDefaultsSeen` 会被剥掉。
 */

import { describe, expect, it } from "vite-plus/test";
import { templateDefaultsFor } from "../../builtin-texts";
import { DEFAULT_LOCALE } from "../../i18n";
import { pendingTemplateUpdates } from "../../template-defaults";
import { GlobalConfigSchema, makeDefaultGlobalConfig } from "../globals";

const FACTORY = templateDefaultsFor(DEFAULT_LOCALE);

describe("templatesSeen", () => {
	it("老 globals.json 没有这个字段 → 自动补空账本,不是解析失败", () => {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		delete g.templatesSeen;
		const parsed = GlobalConfigSchema.safeParse(g);
		expect(parsed.success).toBe(true);
		expect(parsed.data?.templatesSeen).toEqual({});
	});

	it("全新安装:账本在顶层、是空的", () => {
		expect(makeDefaultGlobalConfig().templatesSeen).toEqual({});
	});

	it("全新安装的用户改了自己的文案但账本里还没有这条 → 不亮", () => {
		const g = makeDefaultGlobalConfig();
		const mine = { ...g.defaults.templates, liveStart: "我自己写的开播文案" };
		expect(pendingTemplateUpdates(mine, FACTORY, g.templatesSeen)).toEqual([]);
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
