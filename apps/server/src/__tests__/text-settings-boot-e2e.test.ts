/**
 * 🔴 **入口真的把语言与口吻两项设置接到了字典 store 上(接线的守卫)。**
 *
 * `bindTextSettings` 有单元测试,证明不了 `src/index.ts` 真在配置读完之后调了它 —— 那几行剪断,
 * 类型、构建、单元测试全绿,只是语言与口吻设置从此不起作用。
 * 这里起一台真服务端(真入口、真配置仓、真字典单例),经 `PATCH /api/settings` 改,看 `i18n.state()`;
 * 再种一份写着 `locale: "ja"` 的 core.json 起机,看开机即是 ja。来源换成假的,零外连。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	PersonaCatalogResponse,
	PersonaWriteResult,
	ProblemsResponse,
	SettingsResponse,
} from "@bilibili-notify/contract";
import { makeDefaultGlobalSettings } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CORE_SETTINGS_FILE } from "../config/store.js";
import { i18n } from "../i18n/index.js";
import { type ServerHandle, startServer } from "../index.js";
import { openTestGeneration } from "./support/generation.js";

vi.mock("../bilibili/source.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../bilibili/source.js")>();
	return {
		...real,
		createBiliSource: () => ({
			descriptor: { label: "B 站", postNoun: "动态" },
			async start() {},
			async stop() {},
		}),
	};
});

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

describe("语言与口吻两项设置接在开机路径上", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-text-settings-boot-e2e-"));
		i18n.set({ locale: "zh-CN", voice: "maid" });
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		i18n.set({ locale: "zh-CN", voice: "maid" });
		await rm(dataDir, { recursive: true, force: true });
	});

	async function boot(): Promise<number> {
		const port = await findFreePort();
		handle = await startServer({
			argv: ["--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		return port;
	}

	/** 改核心设置(`/api/settings` 上挂在 `core` 下)。 */
	const patch = async (port: number, core: Record<string, unknown>) => {
		const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ core }),
		});
		expect(res.status).toBe(200);
	};

	// 验红:注释掉 `index.ts` 里 `bindTextSettings({ … })` 那几行,这条红(PATCH 之后 store 不动)。
	it("没设过 → 简中 + 女仆;PATCH 之后跟着变;发 null 回到默认", async () => {
		// 先把单例拨到别处:证明开机那一下真推了默认,而不是碰巧本来就是
		i18n.set({ locale: "en", voice: "plain" });
		const port = await boot();
		expect(i18n.state().locale).toBe("zh-CN");
		expect(i18n.state().voice).toBe("maid");

		await patch(port, { locale: "en", voice: "plain" });
		expect(i18n.state().locale).toBe("en");
		expect(i18n.state().voice).toBe("plain");

		// 英文没有女仆层,要口吻得换回有女仆层的语言才看得出
		await patch(port, { locale: "zh-CN", voice: "plain" });
		expect(i18n.state().locale).toBe("zh-CN");
		expect(i18n.state().voice).toBe("plain");

		await patch(port, { locale: null, voice: null });
		expect(i18n.state().locale).toBe("zh-CN");
		expect(i18n.state().voice).toBe("maid");
	});

	it("真实设置接口四语切换同步内置性格与持续问题，保留用户副本和模板", async () => {
		const generationDir = await openTestGeneration(dataDir);
		const file = join(generationDir, ...CORE_SETTINGS_FILE);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ ...makeDefaultGlobalSettings(), history: "Original invalid history" }),
			"utf8",
		);
		const port = await boot();
		const read = async <T>(path: string): Promise<T> => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`);
			expect(response.status).toBe(200);
			return response.json() as Promise<T>;
		};
		const before = await read<PersonaCatalogResponse>("/api/ai/personas");
		const builtin = before.entries.find((entry) => entry.id === "gentle-maid");
		if (!builtin) throw new Error("Built-in persona missing");
		const content = {
			label: "Original copy 原文",
			persona: {
				...builtin.persona,
				name: "Original persona 原文",
				traits: "Original traits 原文",
			},
			dynamicPrompt: "Original commentary rule 原文",
			liveSummaryPrompt: "Original summary rule 原文",
		};
		const created = await fetch(`http://127.0.0.1:${port}/api/ai/personas`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ op: "create", revision: before.revision, content }),
		});
		expect(created.status).toBe(200);
		const result = (await created.json()) as PersonaWriteResult;
		if (!result.ok) throw new Error(result.message);
		await patch(port, { defaults: { templates: { liveStart: "Original global template 原文" } } });
		const original = (await read<ProblemsResponse>("/api/problems")).problems.find(
			(p) => p.reporter === "core" && p.code === "settings_invalid",
		);
		if (!original) throw new Error("Invalid-settings problem missing");
		const ids = (await read<PersonaCatalogResponse>("/api/ai/personas")).entries.map(
			(entry) => entry.id,
		);
		for (const [locale, voice, label, name, reason] of [
			["en", "plain", "Gentle Maid", "Ling", "The value has an incorrect type for this setting."],
			[
				"ja",
				"maid",
				"優しいメイド",
				"アヤ",
				"ご主人様、この値の型は設定ルールに合いません。該当する欄を確認してくださいね。",
			],
			["zh-TW", "maid", "溫柔女僕", "小綾", "主人，這個值的型別不符合設定規則，請檢查這一欄喔。"],
			["zh-CN", "plain", "温柔女仆", "小绫", "值的类型不符合设置规则"],
			["zh-CN", "maid", "温柔女仆", "小绫", "主人，值的类型不符合设置规则，请检查这一格。"],
		] as const) {
			await patch(port, { locale, voice });
			expect(i18n.state()).toMatchObject({ locale, voice });
			const catalog = await read<PersonaCatalogResponse>("/api/ai/personas");
			expect(catalog.entries.map((entry) => entry.id)).toEqual(ids);
			expect(catalog.entries.find((entry) => entry.id === "gentle-maid")).toMatchObject({
				label,
				persona: { name },
			});
			expect(catalog.entries.find((entry) => entry.id === result.id)).toMatchObject(content);
			const settings = await read<SettingsResponse>("/api/settings");
			expect(settings.core.defaults.templates.liveStart).toBe("Original global template 原文");
			expect(settings.core.ai.presets.find((p) => p.id === result.id)).toMatchObject(content);
			const current = (await read<ProblemsResponse>("/api/problems")).problems.filter(
				(p) => p.reporter === "core" && p.code === "settings_invalid",
			);
			expect(current).toHaveLength(1);
			expect(current[0]?.since).toBe(original.since);
			expect(current[0]?.message).toContain(reason);
			expect(current[0]?.message).not.toContain("Original invalid history");
		}
	});

	// 验红:同上,开机那一下没推,这条红。
	it.each([
		["zh-CN", "maid"],
		["en", "plain"],
		["ja", "maid"],
		["zh-TW", "plain"],
	] as const)("core.json 保存 %s / %s → 开机即按保存值生效", async (locale, voice) => {
		const generationDir = await openTestGeneration(dataDir);
		const file = join(generationDir, ...CORE_SETTINGS_FILE);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(
			file,
			JSON.stringify({ ...makeDefaultGlobalSettings(), locale, voice }),
			"utf8",
		);
		i18n.set({
			locale: locale === "en" ? "ja" : "en",
			voice: voice === "plain" ? "maid" : "plain",
		});
		const port = await boot();
		expect(i18n.state()).toMatchObject({ locale, voice });
		const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
		expect(response.status).toBe(200);
		const settings = (await response.json()) as SettingsResponse;
		expect(settings.core).toMatchObject({ locale, voice });
	});
});
