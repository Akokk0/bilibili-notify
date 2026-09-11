/**
 * **假桥** —— 一个真的说桥接协议的客户端,只是后面没有机器人框架。
 *
 * 它替掉的前提是「验桥必须先写插件」:主人在拓展页建一条接入、按一下场景,那条卡就真的
 * 变绿、bot 名单与能力矩阵真的出来、推一条过去真的走到 adapter,而回执是成是败由这边说。
 * 走的是**真 socket**(`ws://127.0.0.1:<自己的端口>/ext/bridge`),所以 upgrade、鉴权、
 * 握手、心跳、publishStatus 全是真的 —— 假的只有「后面没有 bot」这一件事。
 *
 * 🔴 **这里的帧是照着 `extensions/bridge/PROTOCOL.md` 手写的。** 桥是拓展,核心 import
 * 不到它(那条边两个方向都不该有),所以协议知识在这儿有第二份 —— 主人 2026-09-10 拍板
 * 认下这笔(ADR-0012 决策 42)。手写的东西会漂,所以配了三道:`__tests__/fake-bridge.test.ts`
 * 钉帧的形状,`__tests__/fake-bridge-protocol-version.test.ts` 钉版本号与桥的 `contract.ts`
 * 对得上(握手只看 `major`,minor 漂了没人会发现),`src/__tests__/devtools-fake-bridge-e2e.test.ts`
 * 把**真桥**装进装载根、让它俩真的说一次话 —— 协议真变了,后者会红。
 *
 * ⛔ **不做退避重连**(协议 §12 那条对真插件才成立):假桥跑在 BN 自己进程里,BN 没了它
 * 也没了,重连没有对象。断了就是断了,场景那头如实显示。
 */

import { WebSocket } from "ws";

/**
 * 协议版本。**与桥的 `contract.ts` 里那个 `BRIDGE_PROTOCOL_VERSION` 同步** ——
 * `__tests__/fake-bridge-protocol-version.test.ts` 钉着,漂了当场红。
 *
 * 光靠握手发现不了漂:判定只看 `major`,minor 停在几年前照样连得上,于是假桥会一直
 * 冒充一个老桥、而新加的那几格永远走不到。
 */
export const PROTOCOL = { major: 1, minor: 4 } as const;

/** 桥借给 BN 的一个 bot。能力表**键值都开放** —— 桥少报的按 `unknown` 算,由 BN 归一。 */
export interface FakeBridgeBot {
	botId: string;
	platform: string;
	name?: string;
	selfId?: string;
	/**
	 * 平台图标(协议 1.2)。只认 `data:image/…;base64,` 的 data URL —— 面板拿它画 bot 行
	 * 左边那枚方块,不给就退回首字母。造得出它,那条路才在真机之前走得到一次。
	 */
	icon?: string;
	capabilities?: Record<string, string>;
}

/** 一条入站消息。`scope` 只有两支 —— 频道消息由桥自己归到 `group`。 */
export type FakeBridgeInbound =
	| { scope: "private"; userId: string; text: string }
	| {
			scope: "group";
			groupId: string;
			userId: string;
			text: string;
			/**
			 * 分享卡里解出来的链接(协议 1.4,群那一支才有)。两格**都可选** —— 不给就不出现在
			 * 帧里,那正是老桥(1.3)的样子;`miniAppCardLinks` 单放一格是因为链接解析刻意不读
			 * 它(群里已经有一张能点开播放的卡了)。
			 */
			cardLinks?: string[];
			miniAppCardLinks?: string[];
	  };

export interface FakeBridgeReceipt {
	ok: boolean;
	err?: string;
}

export interface FakeBridgeOptions {
	/** `ws://127.0.0.1:<port>/ext/<拓展 id>`。 */
	url: string;
	token: string;
	kind: string;
	name?: string;
	version?: string;
	bots: FakeBridgeBot[];
	/** 收到一条 `send` 回什么。**现读** —— 场景那头拨一下,下一条就照新的回。 */
	receipt: () => FakeBridgeReceipt;
	log?: (line: string) => void;
}

export interface FakeBridge {
	/** 握完手才 resolve;连不上 / 被拒 / 半路断了都 reject,理由能直接贴到面板上。 */
	ready(): Promise<void>;
	/**
	 * 再推一份**全量**bot 名单 —— 真插件探完能力(小程序卡那格)、bot 上下线时就是这么做的。
	 * 握手那一份是「还没探」的样子,这一份才带答案。
	 */
	pushBots(bots: FakeBridgeBot[]): void;
	/** `message` **原样进帧** —— 1.4 那两格链接给了就带上,没给就不出现(与老桥同形)。 */
	sendInbound(message: FakeBridgeInbound, botId?: string): void;
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

export function createFakeBridge(opts: FakeBridgeOptions): FakeBridge {
	const log = opts.log ?? (() => {});
	const socket = new WebSocket(opts.url, { headers: { Authorization: `Bearer ${opts.token}` } });
	let shook = false;
	let settle: { resolve(): void; reject(err: Error): void } | undefined;
	const ready = new Promise<void>((resolve, reject) => {
		settle = { resolve, reject };
	});
	// 没人 await 的 rejection 会变成 unhandled;场景那头是 await 的,但 dispose 早于握手时
	// 这条 promise 也会被拒。
	ready.catch(() => {});

	function fail(err: Error): void {
		settle?.reject(err);
		settle = undefined;
	}

	function send(frame: Record<string, unknown>): boolean {
		if (socket.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(frame));
		return true;
	}

	/**
	 * 真插件在这儿要做的:按 `botId` 找到 bot、把消息译成那个平台的形状、发出去、回执。
	 * 假桥把中间那段换成一行日志 —— **回执照回**,BN 那头等着它决定这条推送算成还是算败。
	 */
	async function deliver(frame: Record<string, unknown>): Promise<void> {
		const id = String(frame.id ?? "");
		for (const url of imageUrlsIn(frame.message)) {
			// 图要自己下载(协议 §9)。取不到就如实回失败 —— 静默发一条没有图的消息
			// 才是最难查的那种坏,而这一步顺带把取图口真的走了一遍。
			const err = await fetchImage(url);
			if (err) {
				log(err);
				send({ type: "result", id, ok: false, err });
				return;
			}
		}
		const receipt = opts.receipt();
		log(
			`收到一条给 ${String(frame.botId)} 的消息 —— ${receipt.ok ? "回成功" : `回失败:${receipt.err ?? ""}`}`,
		);
		send(
			receipt.ok
				? { type: "result", id, ok: true }
				: { type: "result", id, ok: false, err: receipt.err ?? "假桥说不行" },
		);
	}

	async function fetchImage(url: string): Promise<string | undefined> {
		try {
			const res = await fetch(url);
			if (!res.ok) return `取图失败(HTTP ${res.status}):${url}`;
			log(`取到图 ${(await res.arrayBuffer()).byteLength} 字节`);
			return undefined;
		} catch (err) {
			return `取图失败(${(err as Error).message}):${url}`;
		}
	}

	socket.on("open", () => {
		send({
			type: "hello",
			protocol: { ...PROTOCOL },
			bridge: { kind: opts.kind, name: opts.name, version: opts.version },
			bots: opts.bots,
		});
	});

	socket.on("message", (raw: Buffer) => {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
		} catch {
			return;
		}
		switch (frame.type) {
			case "welcome":
				shook = true;
				log(`握上手了:BN v${String((frame.server as { version?: string })?.version ?? "?")}`);
				settle?.resolve();
				settle = undefined;
				break;
			case "ping":
				// 1.3:带 id 的是面板在探活,原样回 —— 假桥也得让「测试」量出个真数。
				send(typeof frame.id === "string" ? { type: "pong", id: frame.id } : { type: "pong" });
				break;
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

	socket.on("unexpected-response", (_req, res) => {
		// upgrade 被拒。状态码就是最有用的那句话:401 token 不对,404 桥没在跑,503 接入停用了。
		fail(new Error(`BN 不给开这条连接:HTTP ${res.statusCode ?? 0}`));
		socket.terminate();
	});
	socket.on("error", (err: Error) => fail(new Error(`连不上:${err.message}`)));
	socket.on("close", (code: number) => {
		shook = false;
		fail(new Error(`还没握上手就断了(${code})`));
		log(`断了(${code})`);
	});

	return {
		ready: () => ready,
		connected: () => shook,
		pushBots(bots) {
			// 名单是全量快照,整份换掉。没握上手就推 = 那份名单谁也没收到,别假装成功。
			if (!shook || !send({ type: "bots", bots })) {
				throw new Error("假桥还没连上,这份名单没推上去");
			}
		},
		sendInbound(message, botId) {
			const bot = botId === undefined ? opts.bots[0] : opts.bots.find((b) => b.botId === botId);
			if (!bot) throw new Error(`名单里没有 ${botId ?? "任何 bot"}`);
			if (!shook || !send({ type: "inbound", botId: bot.botId, platform: bot.platform, message })) {
				// 不排队不补发(协议:推一条三小时前的东西比不推更糟),所以既不假装成功也不攒着。
				throw new Error("假桥还没连上,这条没驮上去");
			}
		},
		dispose() {
			try {
				socket.terminate();
			} catch {
				// 已经没了
			}
		},
	};
}
