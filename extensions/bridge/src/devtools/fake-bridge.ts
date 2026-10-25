/**
 * **假桥** —— 一个真的说桥接协议的客户端,只是后面没有机器人框架。
 *
 * 它替掉的前提是「验桥必须先写插件」:主人在拓展页建一条接入、按一下场景,那条卡就真的
 * 变绿、bot 名单与能力矩阵真的出来、推一条过去真的走到 adapter,而回执是成是败由这边说。
 * 走的是**真 socket**(桥自己的 `ws://127.0.0.1:<端口>/ext/bridge`),所以 upgrade、鉴权、
 * 握手、心跳、publishView 全是真的 —— 假的只有「后面没有 bot」这一件事。
 *
 * 网络一律走桥自己的 `ctx.http`(`websocket` / `fetch` 的 `bare` 档,不带 BN 的浏览器身份):
 * 假桥与桥同住一个包,帧的类型和协议版本直接取 `../contract.ts`,不再有手抄的那一份 ——
 * 协议真变了,这里是类型错误,不是一条悄悄漂掉的假绿。
 *
 * ⛔ **不做退避重连**(协议 §12 那条对真插件才成立):假桥跑在 BN 自己进程里,BN 没了它
 * 也没了,重连没有对象。断了就是断了,场景那头如实显示。
 */

import { fail, type HttpClient, type Result } from "@bilibili-notify/extension";
import {
	BRIDGE_PROTOCOL_VERSION,
	type BridgeBotsFrame,
	type BridgeBotWire,
	type BridgeHelloFrame,
	type BridgeInboundFrame,
	type BridgeInboundMessage,
	type BridgeKind,
	type BridgePongFrame,
	type BridgeResultFrame,
	type BridgeToServerFrame,
} from "../contract.js";

/** `ws` 的 `readyState` 里「已连上」那个值(WHATWG 的 `OPEN`)。 */
const SOCKET_OPEN = 1;

export interface FakeBridgeOptions {
	/** 桥自己的 `ctx.http` —— 假桥的 WebSocket 与取图都从这儿走。 */
	http: HttpClient;
	/** `ws://127.0.0.1:<port>/ext/<拓展 id>`。 */
	url: string;
	token: string;
	kind: BridgeKind;
	name?: string;
	version?: string;
	bots: BridgeBotWire[];
	/** 收到一条 `send` 回什么。**现读** —— 场景那头拨一下,下一条就照新的回。 */
	receipt: () => Result;
	log?: (line: string) => void;
}

export interface FakeBridge {
	/** 握完手才 resolve;连不上 / 被拒 / 半路断了都 reject,理由能直接贴到面板上。 */
	ready(): Promise<void>;
	/**
	 * 再推一份**全量**bot 名单 —— 真插件探完能力(小程序卡那格)、bot 上下线时就是这么做的。
	 * 握手那一份是「还没探」的样子,这一份才带答案。
	 */
	pushBots(bots: BridgeBotWire[]): void;
	/** `message` **原样进帧** —— 1.4 那两格链接给了就带上,没给就不出现(与老桥同形)。 */
	sendInbound(message: BridgeInboundMessage, botId?: string): void;
	/** 握过手没有 —— 场景的「当前生效」看它。 */
	connected(): boolean;
	dispose(): void;
}

/** 这条消息里有哪些要桥自己下载的图(协议 §9:那条 URL 只保证桥自己可达)。 */
function imageUrlsIn(message: unknown): string[] {
	if (typeof message !== "object" || message === null) return [];
	const m = message as Record<string, unknown>;
	if (m.kind === "image" && typeof m.url === "string") return [m.url];
	if (m.kind === "composite" && Array.isArray(m.segments)) {
		return m.segments.flatMap((s: unknown) => {
			const seg = s as Record<string, unknown>;
			return seg?.type === "image" && typeof seg.url === "string" ? [seg.url] : [];
		});
	}
	if (m.kind === "forward-images" && Array.isArray(m.images)) {
		return m.images.flatMap((i: unknown) => {
			const image = i as Record<string, unknown>;
			return typeof image?.url === "string" ? [image.url] : [];
		});
	}
	return [];
}

/** 收到的原始帧 → 一个对象;不是 JSON、或不是对象就当没收到。 */
function parseFrame(raw: unknown): Record<string, unknown> | undefined {
	try {
		const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
		const frame: unknown = JSON.parse(text);
		return typeof frame === "object" && frame !== null
			? (frame as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function createFakeBridge(opts: FakeBridgeOptions): FakeBridge {
	const log = opts.log ?? (() => {});
	let shook = false;
	let settle: { resolve(): void; reject(err: Error): void } | undefined;
	const ready = new Promise<void>((resolve, reject) => {
		settle = { resolve, reject };
	});
	// 没人 await 的 rejection 会变成 unhandled;场景那头是 await 的,但 dispose 早于握手时
	// 这条 promise 也会被拒。
	ready.catch(() => {});

	function rejectReady(err: Error): void {
		settle?.reject(err);
		settle = undefined;
	}

	const made = opts.http.websocket(opts.url, {
		headers: { Authorization: `Bearer ${opts.token}` },
		bare: true,
	});
	if (!made.ok) {
		rejectReady(new Error(`连不上:${made.message}`));
		return {
			ready: () => ready,
			connected: () => false,
			pushBots() {
				throw new Error("假桥还没连上,这份名单没推上去");
			},
			sendInbound() {
				throw new Error("假桥还没连上,这条没驮上去");
			},
			dispose() {},
		};
	}
	const socket = made.socket;
	socket.binaryType = "nodebuffer";

	function send(frame: BridgeToServerFrame): boolean {
		if (socket.readyState !== SOCKET_OPEN) return false;
		socket.send(JSON.stringify(frame));
		return true;
	}

	/**
	 * 真插件在这儿要做的:按 `botId` 找到 bot、把消息译成那个平台的形状、发出去、回执。
	 * 假桥把中间那段换成一行日志 —— **回执照回**,BN 那头等着它决定这条推送算成还是算败。
	 */
	async function deliver(frame: Record<string, unknown>): Promise<void> {
		const id = String(frame.id ?? "");
		const reply = (receipt: Result): void => {
			send({ type: "result", id, ...receipt } as BridgeResultFrame);
		};
		for (const url of imageUrlsIn(frame.message)) {
			// 图要自己下载(协议 §9)。取不到就如实回失败 —— 静默发一条没有图的消息
			// 才是最难查的那种坏,而这一步顺带把取图口真的走了一遍。
			const problem = await fetchImage(url);
			if (problem) {
				log(problem);
				reply(fail("unavailable", problem));
				return;
			}
		}
		const receipt = opts.receipt();
		log(
			`收到一条给 ${String(frame.botId)} 的消息 —— ${receipt.ok ? "回成功" : `回失败:${receipt.message}`}`,
		);
		reply(receipt);
	}

	async function fetchImage(url: string): Promise<string | undefined> {
		const got = await opts.http.fetch(url, { bare: true });
		if (!got.ok) return `取图失败(${got.message}):${url}`;
		if (!got.isSuccess) return `取图失败(HTTP ${got.status}):${url}`;
		log(`取到图 ${got.body.byteLength} 字节`);
		return undefined;
	}

	socket.on("open", () => {
		const hello: BridgeHelloFrame = {
			type: "hello",
			protocol: BRIDGE_PROTOCOL_VERSION,
			bridge: { kind: opts.kind, name: opts.name, version: opts.version },
			bots: opts.bots,
		};
		send(hello);
	});

	socket.on("message", (raw) => {
		const frame = parseFrame(raw);
		if (!frame) return;
		switch (frame.type) {
			case "welcome":
				shook = true;
				log(`握上手了:BN v${String((frame.server as { version?: string })?.version ?? "?")}`);
				settle?.resolve();
				settle = undefined;
				break;
			case "ping": {
				// 1.3:带 id 的是面板在探活,原样回 —— 假桥也得让「测试」量出个真数。
				const pong: BridgePongFrame =
					typeof frame.id === "string" ? { type: "pong", id: frame.id } : { type: "pong" };
				send(pong);
				break;
			}
			case "send":
				// 取图是异步的,但**回执一定发得出去**(下载失败也回),所以没人等这条 promise
				// 也不会漏掉一条投递。
				void deliver(frame);
				break;
			case "error":
				log(`BN 报了个错:${String(frame.message)}`);
				break;
			// 不认识的一律忽略 —— 协议里写死的演进纪律,断在这里等于每加一种帧就打死老桥。
		}
	});

	socket.on("unexpected-response", (...args) => {
		// upgrade 被拒。状态码就是最有用的那句话:401 token 不对,404 桥没在跑,503 接入停用了。
		const res = args[1] as { statusCode?: number } | undefined;
		rejectReady(new Error(`BN 不给开这条连接:HTTP ${res?.statusCode ?? 0}`));
		socket.close();
	});
	socket.on("error", (...args) => rejectReady(new Error(`连不上:${(args[0] as Error).message}`)));
	socket.on("close", (...args) => {
		shook = false;
		rejectReady(new Error(`还没握上手就断了(${String(args[0])})`));
		log(`断了(${String(args[0])})`);
	});

	return {
		ready: () => ready,
		connected: () => shook,
		pushBots(bots) {
			// 名单是全量快照,整份换掉。没握上手就推 = 那份名单谁也没收到,别假装成功。
			const frame: BridgeBotsFrame = { type: "bots", bots };
			if (!shook || !send(frame)) throw new Error("假桥还没连上,这份名单没推上去");
		},
		sendInbound(message, botId) {
			const bot = botId === undefined ? opts.bots[0] : opts.bots.find((b) => b.botId === botId);
			if (!bot) throw new Error(`名单里没有 ${botId ?? "任何 bot"}`);
			const frame: BridgeInboundFrame = {
				type: "inbound",
				botId: bot.botId,
				platform: bot.platform,
				message,
			};
			// 不排队不补发(协议:推一条三小时前的东西比不推更糟),所以既不假装成功也不攒着。
			if (!shook || !send(frame)) throw new Error("假桥还没连上,这条没驮上去");
		},
		dispose() {
			try {
				socket.close();
			} catch {
				// 已经没了
			}
		},
	};
}
