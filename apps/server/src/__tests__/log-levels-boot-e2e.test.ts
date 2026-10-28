/**
 * 🔴 **入口真的把日志等级表接到了上下文上(接线的守卫)。**
 *
 * `bindLogLevels`、`createNodeServiceContext` 各有单元测试,证明不了 `src/index.ts` 真在配置读完之后调了
 * `bindLogLevels(...)` —— 那一句剪断,类型、构建、单元测试全绿,只是等级设置从此不起作用。
 * 这里起一台真服务端(真入口、真配置仓、真 `createNodeServiceContext`),经 `PATCH /api/settings` 改日志等级表,
 * 看各标签的日志器真实的放行:`bilibili` 调到 error,B 站的 warn 不出、核心的 info 照出;`onebot` 调到 debug,只有它的 debug 出。
 * 零外连(`--log-level` 之外的开关与别的 e2e 一致;来源换成假的)。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type ServerHandle, startServer } from "../index.js";
import type { NodeServiceContext } from "../runtime/service-context.js";
import type { LogEntry } from "../ws/types.js";
import { openTestGeneration } from "./support/generation.js";

/** 测试里装进去的拓展的 id(带命名空间,第三方的写法)与它把自己的 ctx.logger 留在全局上的那个名字。 */
const EXTENSION_ID = "acme.logprobe";
const PROBE_KEY = "__bnLogLevelsProbeLogger";

const captured = vi.hoisted(() => ({ ctx: undefined as unknown }));

vi.mock("../runtime/service-context.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/service-context.js")>();
	return {
		...real,
		createNodeServiceContext: (opts: Parameters<typeof real.createNodeServiceContext>[0]) => {
			const ctx = real.createNodeServiceContext(opts);
			captured.ctx = ctx;
			return ctx;
		},
	};
});

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

describe("日志等级表接在开机路径上", () => {
	let dataDir: string;
	let handle: ServerHandle | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-log-levels-boot-e2e-"));
		captured.ctx = undefined;
	});

	afterEach(async () => {
		delete (globalThis as Record<string, unknown>)[PROBE_KEY];
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	// 验红:删掉 `index.ts` 里 `bindLogLevels({ … })` 那一句,这条红(设置改了日志器的等级不动)。
	it("改 logging.levels:bilibili 调到 error 只压 B 站的 warn;onebot 调到 debug 只放出它的 debug;清掉之后回到总等级", async () => {
		const port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"info",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		const ctx = captured.ctx as NodeServiceContext;
		const seen: LogEntry[] = [];
		ctx.setLogHook((entry) => seen.push(entry));
		const bili = ctx.forSubsystem("dynamic", "bilibili").logger;
		const onebot = ctx.forSubsystem("onebot", "onebot").logger;
		const emit = () => {
			seen.length = 0;
			bili.warn("bili-warn");
			ctx.logger.info("core-info");
			onebot.debug("onebot-debug");
			onebot.info("onebot-info");
			return seen.map((e) => e.msg);
		};
		const patch = async (levels: Record<string, string | null>) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ core: { logging: { levels } } }),
			});
			expect(res.status).toBe(200);
		};

		expect(emit()).toEqual(["bili-warn", "core-info", "onebot-info"]);

		await patch({ bilibili: "error" });
		expect(emit()).toEqual(["core-info", "onebot-info"]);

		await patch({ onebot: "debug" });
		expect(emit()).toEqual(["core-info", "onebot-debug", "onebot-info"]);

		await patch({ bilibili: null, onebot: null });
		expect(emit()).toEqual(["bili-warn", "core-info", "onebot-info"]);
	});

	// 验红:`index.ts` 里递给装载器的 `loggerOf` 改成别的(比如 `() => runtime.serviceCtx.logger`),这条红
	// (拓展拿到的是核心那一格,调它自己那一格不起作用)。
	it("某个拓展 id 设成 debug:拓展自己的 debug 才出,核心与 B 站的 debug 仍压着;清掉之后回到总等级", async () => {
		const generationDir = await openTestGeneration(dataDir);
		const extensionDir = join(generationDir, "extensions", EXTENSION_ID);
		await mkdir(extensionDir, { recursive: true });
		await writeFile(
			join(extensionDir, "extension.json"),
			JSON.stringify({
				id: EXTENSION_ID,
				name: "日志探针",
				description: "测试用",
				version: "1.0.0",
				apiVersion: 3,
				contributes: { push: { label: "测试", shortLabel: "测", color: "#000000" } },
			}),
		);
		// 把拓展拿到的 ctx.logger 留在全局上,好在测试里往里写。
		await writeFile(
			join(extensionDir, "index.mjs"),
			`export function activate(ctx) { globalThis.${PROBE_KEY} = ctx.logger; }`,
		);

		const port = await findFreePort();
		handle = await startServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"info",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
		});
		/** 改核心设置(`/api/settings` 上挂在 `core` 下)。 */
		const patch = async (core: Record<string, unknown>) => {
			const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ core }),
			});
			expect(res.status).toBe(200);
		};
		// 拓展默认关着:开了它,装载器才会 activate。
		await patch({ extensions: { [EXTENSION_ID]: { enabled: true } } });
		const probe = await vi.waitFor(() => {
			const found = (globalThis as Record<string, unknown>)[PROBE_KEY] as Logger | undefined;
			if (!found) throw new Error("拓展还没起来");
			return found;
		});

		const ctx = captured.ctx as NodeServiceContext;
		const seen: LogEntry[] = [];
		ctx.setLogHook((entry) => seen.push(entry));
		const bili = ctx.forSubsystem("dynamic", "bilibili").logger;
		const emit = () => {
			seen.length = 0;
			probe.debug("ext-debug");
			ctx.logger.debug("core-debug");
			bili.debug("bili-debug");
			probe.info("ext-info");
			return seen.map((e) => `${e.name}:${e.msg}`);
		};

		expect(emit()).toEqual([`${EXTENSION_ID}:ext-info`]);

		await patch({ logging: { levels: { [EXTENSION_ID]: "debug" } } });
		expect(emit()).toEqual([`${EXTENSION_ID}:ext-debug`, `${EXTENSION_ID}:ext-info`]);

		await patch({ logging: { levels: { [EXTENSION_ID]: null } } });
		expect(emit()).toEqual([`${EXTENSION_ID}:ext-info`]);
	});
});
