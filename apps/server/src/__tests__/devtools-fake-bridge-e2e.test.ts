/**
 * 🔴 **devtools 那条假桥,对上真桥。**
 *
 * 假桥说的帧是**手写的第二份**(核心 import 不到拓展,ADR-0012 决策 42),而手写的东西会漂:
 * 桥那边改一个字段名、升一次协议 major,假桥仍旧编译得过、单元测试仍旧全绿 —— 症状是
 * 主人按下场景之后卡片不变绿,而**没有任何门禁会红**。
 *
 * 所以这一条把**真桥的构建产物**装进装载根、起一台真 BN,让 devtools 那条场景连一次:
 * 从「面板按钮」一路到「拓展 `publishStatus` 里真的多了一条会话」。这中间任意一环
 * (token 怎么读、地址怎么拼、帧长什么样、协议版本认不认)错了,这条就红。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { installBridgeInto } from "./support/install-bridge.js";

const CONNECTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = "devtools-fake-bridge-token";

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

describe("devtools 的假桥 → 真桥", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-fake-bridge-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { bridge: { enabled: true } };
		await installBridgeInto(dataDir);
		await writeFile(globalsPath, JSON.stringify(globals));
		await writeFile(
			join(dataDir, "state", "connections.json"),
			JSON.stringify([
				{
					id: CONNECTION_ID,
					name: "家里那台 koishi",
					enabled: true,
					kind: "extension",
					extensionId: "bridge",
					config: { token: TOKEN, bridgeKind: "koishi" },
				},
			]),
		);
	});

	afterAll(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	function boot(at: number): Promise<StandaloneServerHandle> {
		return startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(at),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
	}

	beforeEach(async () => {
		port = await findFreePort();
		handle = await boot(port);
	});

	afterEach(async () => {
		await handle?.close("test cleanup").catch(() => {});
		handle = undefined;
	});

	async function runScenario(id: string, params: Record<string, unknown> = {}): Promise<Response> {
		return fetch(`http://127.0.0.1:${port}/api/dev/run/${id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ params }),
		});
	}

	async function status(): Promise<Record<string, unknown>> {
		const res = await fetch(`http://127.0.0.1:${port}/api/ext/bridge/status`);
		expect(res.status).toBe(200);
		return (await res.json()) as Record<string, unknown>;
	}

	it("按一下场景 → 真桥那头真的多了一条握过手的会话,bot 名单与能力表都在", async () => {
		// 按之前:配着一条接入,但没人连 —— 拓展页上那张卡是灰的。
		expect(status()).resolves.toMatchObject({ sessions: [{ connected: false }] });

		const res = await runScenario("bridge.connect", { platform: "telegram", caps: "mixed" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { summary?: string; active: { scenarioId: string }[] };
		expect(body.summary).toContain("家里那台 koishi");
		expect(body.active.map((a) => a.scenarioId)).toContain("bridge.connect");

		const after = (await status()) as {
			sessions: {
				connected: boolean;
				kind?: string;
				bots: { platform: string; capabilities: Record<string, string> }[];
			}[];
		};
		const session = after.sessions[0];
		expect(session?.connected).toBe(true);
		expect(session?.kind).toBe("koishi");
		expect(session?.bots).toHaveLength(1);
		expect(session?.bots[0]?.platform).toBe("telegram");
		// 🔴 三态齐全:桥把没报的补成 unknown,面板据此分「不支持」与「还不知道」。
		expect(new Set(Object.values(session?.bots[0]?.capabilities ?? {}))).toEqual(
			new Set(["supported", "unsupported", "unknown"]),
		);
	});

	it("一键收摊 → 那条会话当场没了(假状态只由 devtools 收摊)", async () => {
		await runScenario("bridge.connect");
		expect(await status()).toMatchObject({ sessions: [{ connected: true }] });

		const res = await fetch(`http://127.0.0.1:${port}/api/dev/reset`, { method: "POST" });
		expect(res.status).toBe(200);

		// 断开是异步到达的(socket 关闭 → 端点摘表)。
		const deadline = Date.now() + 1_000;
		let sessions: { connected: boolean }[] = [];
		while (Date.now() < deadline) {
			sessions = ((await status()) as { sessions: { connected: boolean }[] }).sessions;
			if (!sessions[0]?.connected) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(sessions[0]?.connected).toBe(false);
	});

	/** 桥驮上来的私聊 —— 真入站链路,核心那条「私聊指令」场景够不着桥。 */
	it("驮一条私聊上去,真桥收得下(不是 400 也不是断连)", async () => {
		await runScenario("bridge.connect");
		const res = await runScenario("bridge.inbound", { from: "10086", text: "/help" });
		expect(res.status).toBe(200);
		// 驮完之后连接还在 —— 帧畸形的话桥会以 4003 把它踢掉。
		expect(await status()).toMatchObject({ sessions: [{ connected: true }] });
	});
});
