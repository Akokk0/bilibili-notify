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
import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
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
			// 入口把 `builtins.bilibili.api()`(来源造好的 `Api`)交给 `createApp`;假来源没有。
			api: () => undefined,
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

	const patch = async (port: number, body: Record<string, unknown>) => {
		const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
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

	// 验红:同上,开机那一下没推,这条红。
	it("core.json 里写着 locale: ja → 开机即是 ja", async () => {
		const generationDir = await openTestGeneration(dataDir);
		const file = join(generationDir, ...CORE_SETTINGS_FILE);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ ...makeDefaultGlobalConfig(), locale: "ja" }), "utf8");
		await boot();
		expect(i18n.state().locale).toBe("ja");
	});
});
