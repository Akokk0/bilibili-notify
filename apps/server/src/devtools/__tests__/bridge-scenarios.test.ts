/**
 * 「假装一条桥连上来」那两条场景。
 *
 * 缝钉在**场景 ↔ 真 socket** 之间:场景要自己从接入里挑出 token、拼出 BN 自己的地址、
 * 把连上的那条挂进「当前生效」、一键收摊时断掉。这几件里任意一件错,症状都是「按了没反应」
 * 或者「面板上一直说连着、其实早断了」。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Connection } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type WebSocket, WebSocketServer } from "ws";
import { bridgeScenarios } from "../scenarios/bridge.js";

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "panel-token";

let httpServer: HttpServer;
let wss: WebSocketServer;
let port: number;
let frames: Record<string, unknown>[];
let paths: string[];
let sockets: WebSocket[];
let connections: Connection[];

const BRIDGE_CONNECTION: Connection = {
	id: CONNECTION_ID,
	name: "家里那台 koishi",
	enabled: true,
	kind: "extension",
	extensionId: "bridge",
	config: { token: TOKEN, bridgeKind: "koishi" },
};

const ONEBOT_CONNECTION = {
	id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	name: "家里那台 QQ",
	enabled: true,
	kind: "direct",
	platform: "onebot",
	connector: "ws",
	config: {},
} as unknown as Connection;

function scenarios() {
	return bridgeScenarios({
		connections: () => connections,
		address: () => `127.0.0.1:${port}`,
		commands: () => ({ prefix: "/", master: { platform: "bridge", address: "10086" } }),
	});
}

/** 那两条场景共用一份活口,所以整组只建一次、按 id 取。 */
let group: ReturnType<typeof scenarios>;
function from(id: string) {
	const def = group.find((s) => s.id === id);
	if (!def) throw new Error(`没有场景 ${id}`);
	return def;
}

function nextFrame(type: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			const hit = frames.find((f) => f.type === type);
			if (hit) return resolve(hit);
			if (Date.now() > deadline) return reject(new Error(`没等到 ${type} 帧`));
			setTimeout(tick, 5);
		};
		tick();
	});
}

beforeEach(async () => {
	frames = [];
	paths = [];
	sockets = [];
	connections = [BRIDGE_CONNECTION];
	httpServer = createServer();
	wss = new WebSocketServer({ noServer: true });
	httpServer.on("upgrade", (req, socket, head) => {
		paths.push((req.url ?? "").split("?")[0] ?? "");
		wss.handleUpgrade(req, socket, head, (ws) => {
			sockets.push(ws);
			ws.on("message", (raw: Buffer) => {
				const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
				frames.push(frame);
				if (frame.type === "hello") {
					ws.send(
						JSON.stringify({
							type: "welcome",
							protocol: { major: 1, minor: 1 },
							server: { version: "9.9.9-test" },
							inbound: { private: true, group: "with-links" },
						}),
					);
				}
			});
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	port = (httpServer.address() as AddressInfo).port;
	group = scenarios();
});

afterEach(async () => {
	await from("bridge.connect").reset?.();
	for (const socket of sockets) socket.terminate();
	wss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("假装一条桥连上来", () => {
	it("拿那条接入的 token 连到 BN 自己身上,路径是那个拓展的挂载点", async () => {
		const out = await from("bridge.connect").run({});
		expect(paths).toEqual(["/ext/bridge"]);
		expect(await nextFrame("hello")).toMatchObject({
			bridge: { kind: "koishi" },
			bots: [{ platform: "onebot" }],
		});
		expect(out.summary).toContain("家里那台 koishi");
	});

	it("连上之后进「当前生效」条,收摊就没了", async () => {
		await from("bridge.connect").run({});
		expect(from("bridge.connect").active?.()).toMatchObject({ scenarioId: "bridge.connect" });

		await from("bridge.connect").reset?.();
		expect(from("bridge.connect").active?.()).toBeNull();
	});

	/** 能力矩阵那三态是最难在真环境里凑齐的,所以给一档专门凑齐它。 */
	it("能力表按档报:三态齐全 / 全支持 / 全不支持", async () => {
		await from("bridge.connect").run({ caps: "mixed" });
		const hello = await nextFrame("hello");
		const caps = (hello.bots as { capabilities: Record<string, string> }[])[0]?.capabilities ?? {};
		expect(new Set(Object.values(caps))).toEqual(new Set(["supported", "unsupported", "unknown"]));
	});

	it("没有桥接入 → 说清楚要先去建一条,别默默连一条空的", async () => {
		connections = [ONEBOT_CONNECTION];
		await expect(from("bridge.connect").run({})).rejects.toThrow(/接入/);
	});

	it("接入的 token 是空的 → 明说(备份恢复回来的那条就是空的)", async () => {
		connections = [{ ...BRIDGE_CONNECTION, config: { token: "", bridgeKind: "koishi" } }];
		await expect(from("bridge.connect").run({})).rejects.toThrow(/token/);
	});

	it("挑了一条不是拓展的连接 → 明说它不是桥", async () => {
		connections = [BRIDGE_CONNECTION, ONEBOT_CONNECTION];
		await expect(from("bridge.connect").run({ connection: ONEBOT_CONNECTION.id })).rejects.toThrow(
			/不是/,
		);
	});
});

describe("桥驮一条消息上来", () => {
	it("私聊:发信人省略 = 配置里的主人,所以会被当真", async () => {
		await from("bridge.connect").run({});
		await from("bridge.inbound").run({ text: "帮助" });
		expect(await nextFrame("inbound")).toMatchObject({
			message: { scope: "private", userId: "10086", text: "帮助" },
		});
	});

	it("群消息:群号自己给", async () => {
		await from("bridge.connect").run({});
		await from("bridge.inbound").run({
			scope: "group",
			from: "g-42",
			text: "看看 https://b23.tv/x",
		});
		expect(await nextFrame("inbound")).toMatchObject({
			message: { scope: "group", groupId: "g-42", userId: "10086" },
		});
	});

	it("还没假装连上就驮 → 说清楚先按上面那条", () => {
		// 同步抛 —— 注册表那头 `await def.run(...)`,对面板来说与 reject 一样。
		expect(() => from("bridge.inbound").run({ text: "帮助" })).toThrow(/没连/);
	});
});
