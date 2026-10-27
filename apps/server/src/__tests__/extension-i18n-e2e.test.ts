/**
 * 🔴 **拓展的译文从构建产物一路到面板那两口**(ADR-0037 决策 14):把假源的**构建产物**
 * (`dist/` 里带着 `locales/`)装进装载根、起一台真 BN,切语言,再读面板读的两处 ——
 * 拓展列表那一行的名字(清单字段的盖)与 `/api/ext/fake-source/status` 的视图文字(`ctx.i18n.t`)。
 *
 * 钉的是「构建忘了拷 `locales/`」这种只在装上之后才露的事:单元测试全绿,拓展页却永远是原字。
 * 期望的文字来自 `extensions/fake-source/locales/` 里那两份译文,不从实现里抄。
 *
 * 切语言走真接线:`PATCH /api/settings { locale }` 写核心设置,入口经 `bind-settings` 把它接到服务端
 * 的字典 store,装载器读的就是那一个。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionPanelView, ExtensionsResponse } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import { installRepoExtensionInto } from "./support/install-repo-extension.js";

const FAKE = "fake-source";

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

describe("拓展的译文 e2e:切语言,拓展页的名字与视图文字跟着换", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;
	let port: number;

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

	async function fakeName(): Promise<string | undefined> {
		const body = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		return body.extensions.find((e) => e.id === FAKE)?.name;
	}

	/** 面板那条路切语言:写核心设置的 `locale` 一格。 */
	async function setLocale(locale: "zh-CN" | "en" | "ja"): Promise<void> {
		const res = await api("/api/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ core: { locale } }),
		});
		expect(res.status, await res.clone().text()).toBe(200);
	}

	async function viewOf(): Promise<ExtensionPanelView> {
		const res = await api(`/api/ext/${FAKE}/status`);
		expect(res.status).toBe(200);
		return (await res.json()) as ExtensionPanelView;
	}

	/** 提示那块的字(富文本原样序列化,拿来做包含判断)。 */
	async function noticeText(): Promise<string> {
		const view = await viewOf();
		for (const entry of view.page ?? []) {
			if ("block" in entry && entry.block.type === "notice")
				return JSON.stringify(entry.block.text);
		}
		throw new Error("视图里没有提示那一块");
	}

	async function summaryText(): Promise<string> {
		return JSON.stringify((await viewOf()).summary?.text);
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-extension-i18n-e2e-"));
		await installRepoExtensionInto(dataDir, FAKE, "@bilibili-notify/extension-fake-source");
		port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		const toggled = await api("/api/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ core: { extensions: { [FAKE]: { enabled: true } } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		// 拨完紧接着列一次拓展,那一口会先把热装落实掉。
		const listed = (await (await api("/api/ext")).json()) as ExtensionsResponse;
		expect(listed.extensions.find((e) => e.id === FAKE)?.state).toBe("running");
	});

	afterAll(async () => {
		await setLocale("zh-CN").catch(() => {});
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("简中:名字是 zh-CN 译文里的,视图是简中那句", async () => {
		await setLocale("zh-CN");
		expect(await fakeName()).toBe("假源(开发用)");
		expect(await summaryText()).toContain("0 条订阅");
		expect(await noticeText()).toContain("开发用的假源");
	});

	it("切到英文:名字与视图文字都是 en 译文里的(摘要按单复数挑)", async () => {
		await setLocale("en");
		expect(await fakeName()).toBe("Fake source (dev)");
		expect(await summaryText()).toContain("0 subscriptions");
		expect(await noticeText()).toContain("A development-only fake source");
	});

	it("切回简中:两处都回中文", async () => {
		await setLocale("zh-CN");
		expect(await fakeName()).toBe("假源(开发用)");
		expect(await summaryText()).toContain("0 条订阅");
		expect(await noticeText()).toContain("开发用的假源");
	});

	it("日文没有这个拓展的译文:落到简中那份(回落链 本语言 → 简中 → 英文)", async () => {
		await setLocale("ja");
		expect(await fakeName()).toBe("假源(开发用)");
		expect(await summaryText()).toContain("0 条订阅");
	});
});
