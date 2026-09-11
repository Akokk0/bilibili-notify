/**
 * 「假装一条桥连上来」那两条场景。
 *
 * 缝钉在**场景 ↔ 真 socket** 之间:场景要自己从接入里挑出 token、拼出 BN 自己的地址、
 * 把连上的那条挂进「当前生效」、一键收摊时断掉。这几件里任意一件错,症状都是「按了没反应」
 * 或者「面板上一直说连着、其实早断了」。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type WebSocket, WebSocketServer } from "ws";
import { bridgeScenarios } from "../scenarios/bridge.js";

const LINK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN = "panel-token";

let httpServer: HttpServer;
let wss: WebSocketServer;
let port: number;
let frames: Record<string, unknown>[];
let paths: string[];
let sockets: WebSocket[];
/** 桥的设置(接入名单住这儿),形状归桥自己 —— 场景按键名读。 */
let settings: unknown;

const LINK = {
	id: LINK_ID,
	name: "家里那台 koishi",
	bridgeKind: "koishi",
	token: TOKEN,
	enabled: true,
};

/** `master: null` = 系统页没配主人。**别用 `undefined`** —— 显式传它会触发默认参数。 */
function scenarios(
	master: { platform: string; address: string } | null = { platform: "bridge", address: "10086" },
) {
	return bridgeScenarios({
		settings: () => settings,
		address: () => `127.0.0.1:${port}`,
		commands: () => ({ prefix: "/", master: master ?? undefined }),
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
	settings = { links: [LINK] };
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

	/**
	 * 能力矩阵那三态是最难在真环境里凑齐的,所以给一档专门凑齐它。
	 *
	 * 🔴 **能力跟着握手后的第二份快照来**,不在 hello 里 —— 真插件就是这个次序(先报名单,
	 * 探完小程序卡那格再重推一份带答案的)。这条顺带钉住了那一跳:握手那份是「还不知道」。
	 */
	it("能力表随第二份名单快照报上来(握手那份还没探);三态齐全 / 全支持 / 全不支持", async () => {
		await from("bridge.connect").run({ caps: "mixed" });
		const hello = await nextFrame("hello");
		expect((hello.bots as { capabilities?: unknown }[])[0]?.capabilities).toBeUndefined();

		const snapshot = await nextFrame("bots");
		const caps =
			(snapshot.bots as { capabilities: Record<string, string> }[])[0]?.capabilities ?? {};
		expect(new Set(Object.values(caps))).toEqual(new Set(["supported", "unsupported", "unknown"]));
	});

	/** 面板拿它画 bot 行左边那枚方块 —— 不给的话那条路在真机之前一次都走不到。 */
	it("bot 带着平台图标报上来,而且是 data URL(BN 不收 http 地址)", async () => {
		await from("bridge.connect").run({});
		const hello = await nextFrame("hello");
		const icon = (hello.bots as { icon?: string }[])[0]?.icon ?? "";
		expect(icon).toMatch(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/);
	});

	it("没有桥接入 → 说清楚要先去建一条,别默默连一条空的", async () => {
		settings = undefined;
		await expect(from("bridge.connect").run({})).rejects.toThrow(/接入/);
	});

	it("设置的形状不对 → 当一条都没有,不在 devtools 里炸", async () => {
		settings = { links: "nope" };
		await expect(from("bridge.connect").run({})).rejects.toThrow(/接入/);
	});

	it("接入的 token 是空的 → 明说(备份恢复回来的那条就是空的)", async () => {
		settings = { links: [{ ...LINK, token: "" }] };
		await expect(from("bridge.connect").run({})).rejects.toThrow(/token/);
	});

	it("按名字或 id 挑得到接入;挑了没有的 → 明说", async () => {
		settings = { links: [{ ...LINK, id: "other", name: "机房那台" }, LINK] };
		const out = await from("bridge.connect").run({ link: "家里那台 koishi" });
		expect(out.summary).toContain("家里那台 koishi");
		await expect(from("bridge.connect").run({ link: "没有这条" })).rejects.toThrow(/没有这条接入/);
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

	/**
	 * 🔴 **默认发信人不许正好是那个假 bot 自己**。没配主人时群消息得自己编一个号,而它
	 * 从前编的恰好等于假 bot 的 `selfId` —— 于是链接解析那道「机器人自己贴的链接不解析」
	 * 的闸把整条消息静默吃掉,场景报「已驮上去」、面板上什么都不发生,而**没有任何一行日志**。
	 */
	it("群消息:没配主人时编的发信人**不是假 bot 自己**,而且摘要里说清是谁", async () => {
		group = scenarios(null);
		await from("bridge.connect").run({});
		const hello = await nextFrame("hello");
		const selfId = (hello.bots as { selfId?: string }[])[0]?.selfId;
		expect(selfId).toBeTruthy();

		const out = await from("bridge.inbound").run({ scope: "group", from: "g-42" });
		const inbound = await nextFrame("inbound");
		const userId = (inbound.message as { userId: string }).userId;
		expect(userId).not.toBe(selfId);
		expect(out.summary).toContain(userId);
	});

	it("还没假装连上就驮 → 说清楚先按上面那条", () => {
		// 同步抛 —— 注册表那头 `await def.run(...)`,对面板来说与 reject 一样。
		expect(() => from("bridge.inbound").run({ text: "帮助" })).toThrow(/没连/);
	});
});
