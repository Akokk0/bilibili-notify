/// <reference types="node" />
/**
 * Field 字典 conformance —— 扫 `apps/web/src/pages/` 全 .tsx,对每个
 * `<Field code="X">` / `<FieldRow code="X">` 字面量 code,断言它在 FIELD_LABELS
 * 字典里有 entry。背景:Field 组件已删除 label/hint 字面量 props,UI 文案 100%
 * 走字典 lookup;新增 Field 用法忘补字典 → 用户看到的就是 raw code(只在 dev
 * console.warn),需要静态护栏。
 *
 * 跳过:动态 code(`code={...}` 模板字符串 / 表达式)。本仓库仅 SubscriptionRulesEditor
 * `code={`templates.${templateField}`}` 一处,templateField 限定在
 * viewerChat / viewerEnter,两个 key 都在字典里;再加字段时 PR review
 * 兜底。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import { FIELD_LABELS, getFieldLabel } from "../config/field-labels.js";
import { i18n } from "../i18n";
import { listSources } from "./walk.js";

/**
 * **连测试文件一起扫**(`skipTests: false`)—— 这不是疏忽:页面测试里也写
 * `<Field code="...">`,引用了一个字典里没有的字段码同样是错,只是它错在测试里。
 */
const listTsx = (dir: string) => listSources(dir, { skipTestDirs: false });

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(TEST_DIR, "..", "pages");

/**
 * 匹配 `<Field` 或 `<FieldRow` 开标签内的字面量 `code="..."` 属性。multi-line
 * 友好(s 标志),跨行/多空白都容忍。返回 `{ file, code }[]` 便于失败时定位。
 */
function extractCodes(file: string): { file: string; code: string }[] {
	const src = readFileSync(file, "utf8");
	const out: { file: string; code: string }[] = [];
	const re = /<(?:Field|FieldRow)\b[^>]*?\bcode="([^"]+)"/gs;
	let m: RegExpExecArray | null = re.exec(src);
	while (m !== null) {
		out.push({ file, code: m[1] });
		m = re.exec(src);
	}
	return out;
}

describe("Field 字典 conformance", () => {
	const tsxFiles = listTsx(PAGES_DIR);
	const allUsages = tsxFiles.flatMap(extractCodes);

	it("扫描到至少 80 个 <Field code=...> 字面量用法(防 regex 静默丢)", () => {
		expect(allUsages.length).toBeGreaterThanOrEqual(80);
	});

	it("所有字面量 code 在 FIELD_LABELS 里都有 entry", () => {
		const missing: { file: string; code: string }[] = [];
		for (const { file, code } of allUsages) {
			if (!(code in FIELD_LABELS)) {
				missing.push({ file, code });
			}
		}
		expect(
			missing,
			`字典 apps/web/src/config/field-labels.ts 缺少以下 code 的 entry:\n${missing
				.map((x) => `  ${x.code}  (${x.file.replace(PAGES_DIR, "pages")})`)
				.join("\n")}`,
		).toEqual([]);
	});
});

it("AI body draft fields name scenes and display AI/template instead of generic on/off", () => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	const value = getFieldLabel("ai.writing.post.isOnByDefault");
	expect(value?.label).toBe("作品默认正文");
	expect(value?.formatter?.(false)).toBe("模板");
	const target = getFieldLabel(
		"ai.writing.liveSummary.byTarget.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	);
	expect(target?.label).toContain("直播总结目标例外");
	expect(target?.formatter?.(true)).toBe("AI 写");
});

it("账号排序的草稿差异有可读名称", () => {
	i18n.set({ locale: "zh-CN", voice: "plain" });
	expect(getFieldLabel("core.accounts.order")?.label).toBe("账号顺序");
});

it("缺少字段说明时只在开发环境输出当前语言的平实诊断，保留字段码", () => {
	const state = i18n.state();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		for (const [locale, message] of [
			["zh-CN", "设置字段缺少显示说明"],
			["en", "Setting field has no display description"],
			["ja", "設定項目の表示説明がありません"],
			["zh-TW", "設定欄位缺少顯示說明"],
		] as const) {
			i18n.set({ locale, voice: "maid" });
			expect(getFieldLabel("unknown.field")).toBeNull();
			expect(warn).toHaveBeenLastCalledWith(message, { code: "unknown.field" });
		}
		expect(warn).toHaveBeenCalledTimes(4);
	} finally {
		i18n.set({ locale: state.locale, voice: state.voice });
		warn.mockRestore();
	}
});

it("runtime and message field descriptions follow locale without changing field identities", () => {
	const state = i18n.state();
	const cooldown = getFieldLabel("core.linkPreview.cooldownSec");
	const prefix = getFieldLabel("core.commands.prefix");
	const heartbeat = getFieldLabel("bilibili.healthCheckMinutes");
	try {
		for (const [locale, cooldownLabel, prefixLabel, heartbeatLabel, limitText] of [
			["en", "Cooldown", "Command prefix", "Login heartbeat interval", "per minute"],
			["ja", "クールダウン", "コマンドの接頭辞", "ログイン確認間隔", "1 分あたり"],
			["zh-TW", "冷卻時間", "指令前綴", "登入心跳間隔", "每分鐘"],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			expect(cooldown?.label).toBe(cooldownLabel);
			expect(prefix?.label).toBe(prefixLabel);
			expect(heartbeat?.label).toBe(heartbeatLabel);
			expect(cooldown?.hint).toContain(limitText);
			expect(cooldown?.hint).not.toMatch(/\{value[12]\}/);
			expect(getFieldLabel("core.linkPreview.isOnByDefault")?.hint).toContain("get_mini_app_ark");
			expect(getFieldLabel("core.linkPreview.isOnByDefault")?.hint).toContain("NapCat");
			expect(getFieldLabel("core.linkPreview.cooldownSec")).toBe(cooldown);
			expect(prefix?.section).toBe("commands");
			expect(heartbeat?.section).toBe("general");
		}
	} finally {
		i18n.set({ locale: state.locale, voice: state.voice });
	}
});

it("AI field descriptions localize while provider credentials stay secret and protocol keys stay literal", () => {
	const state = i18n.state();
	try {
		for (const [locale, extraLabel, visionLabel, personaLabel] of [
			["en", "Extra request parameters", "Vision API Key", "Default personality"],
			["ja", "追加のリクエストパラメーター", "画像認識用 API Key", "既定の性格"],
			["zh-TW", "額外請求參數", "視覺 API Key", "預設性格"],
		] as const) {
			i18n.set({ locale, voice: "plain" });
			expect(getFieldLabel("ai.extraParams")?.label).toBe(extraLabel);
			expect(getFieldLabel("ai.vision.apiKey")?.label).toBe(visionLabel);
			expect(getFieldLabel("ai.activePreset")?.label).toBe(personaLabel);
			expect(getFieldLabel("ai.extraParams")?.hint).toContain("model / messages / tools");
			expect(getFieldLabel("ai.search.keys.bocha")?.hint).toContain("open.bochaai.com");
			expect(getFieldLabel("ai.vision.apiKey")?.secret).toBe(true);
			expect(getFieldLabel("ai.search.keys.bocha")?.secret).toBe(true);
			expect(getFieldLabel("ai.apiKey")?.secret).toBe(true);
		}
	} finally {
		i18n.set({ locale: state.locale, voice: state.voice });
	}
});
