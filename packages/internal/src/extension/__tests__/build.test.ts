/**
 * 构建那一步:源码清单 + 入口导出的两份规则 → 包里那份清单(规则只写一份,设置项由规则导出)。
 *
 * 期望值手写成清单里的样子,不照着实现再算一遍。
 */

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { manifestWithSettingsFields } from "../build";

const SOURCE = {
	id: "demo",
	name: "示例",
	description: "构建测试用的清单",
	version: "0.0.1",
	apiVersion: 3,
	contributes: { push: { label: "示例平台", shortLabel: "示", color: "#123456" } },
};

describe("设置项写进清单", () => {
	it("settingsSchema 导出成 settings.fields,connectionSettingsSchema 导出成 contributes.push.settingsFields", () => {
		const manifest = manifestWithSettingsFields(SOURCE, {
			settingsSchema: z.object({ name: z.string().min(1).meta({ label: "名字" }) }),
			connectionSettingsSchema: z.object({
				atAll: z.boolean().default(false).meta({ label: "支持 @全体" }),
			}),
		});
		expect(manifest).toEqual({
			...SOURCE,
			settings: { fields: [{ key: "name", type: "string", label: "名字", required: true }] },
			contributes: {
				push: {
					...SOURCE.contributes.push,
					settingsFields: [{ key: "atAll", type: "boolean", label: "支持 @全体", default: false }],
				},
			},
		});
	});

	it("一栏都不出的不写:连接里全是拓展交的键(桥),清单里就没有 settingsFields", () => {
		const manifest = manifestWithSettingsFields(SOURCE, {
			connectionSettingsSchema: z.object({ link: z.string().min(1), botId: z.string().min(1) }),
		});
		expect(manifest).toEqual(SOURCE);
	});

	it("两份都没导出的拓展,清单原样", () => {
		expect(manifestWithSettingsFields(SOURCE, {})).toEqual(SOURCE);
	});
});

describe("构建失败", () => {
	it("源码清单里还手写着设置项:两份并存就又会漂", () => {
		const settings = { fields: [{ key: "name", type: "string", label: "名字" }] };
		expect(() => manifestWithSettingsFields({ ...SOURCE, settings }, {})).toThrow(
			/settings\.fields/,
		);
		const push = { ...SOURCE.contributes.push, settingsFields: [] };
		expect(() => manifestWithSettingsFields({ ...SOURCE, contributes: { push } }, {})).toThrow(
			/contributes\.push\.settingsFields/,
		);
	});

	it("导出了连接设置的规则,清单却没开推送那口", () => {
		const { contributes: _, ...noPush } = SOURCE;
		expect(() =>
			manifestWithSettingsFields(noPush, {
				connectionSettingsSchema: z.object({
					atAll: z.boolean().default(false).meta({ label: "开" }),
				}),
			}),
		).toThrow(/contributes\.push/);
	});

	it("自己的设置里有必填的键没写 label:面板上没那一栏,存不进去 —— 加载时的对表在构建时就过一遍", () => {
		expect(() =>
			manifestWithSettingsFields(SOURCE, {
				settingsSchema: z.object({ secretKey: z.string().min(1) }),
			}),
		).toThrow(/demo.*secretKey/);
	});

	it("导出来的清单过不了清单格式(选项图标不是图片),照宿主读清单的那一套点名", () => {
		expect(() =>
			manifestWithSettingsFields(SOURCE, {
				settingsSchema: z.object({
					kind: z
						.enum(["a"])
						.meta({ label: "种类", options: { a: { label: "甲", icon: "not-an-image" } } }),
				}),
			}),
		).toThrow(/settings\.fields\.0\.options\.0\.icon/);
	});
});
