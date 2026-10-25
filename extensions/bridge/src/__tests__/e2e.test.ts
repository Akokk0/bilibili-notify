/**
 * 🔴 **一趟完整的协议往返 —— 可执行版的协议文档**(ADR-0012 决策 37)。
 *
 * 别的测试各自钉着一个零件:`server.test.ts` 只有端点、`adapter.test.ts` 塞的是假
 * `BridgeServer`、`blob.test.ts` 与 `blob-route.test.ts` 各拿着仓库的一半。**没有一条
 * 走完整条路**,而整条路上最容易断的恰恰是**两处独立构造的东西必须对得上**:
 *
 * - adapter 拿 `mountPath + "/blob" + id` 拼出一条 URL,
 * - 路由拿一个正则去认 `"/blob/<id>"`,
 * - 而地址那一头是**桥自己连进来时用的 Host**。
 *
 * 三者任意一处漂了,症状都是「消息到了但没有图」—— 平台拉图失败是静默的,日志上一个字
 * 都没有。所以这里的图**真的走一趟 HTTP**:桥收到 `send` 帧,拿帧里那条 URL 去 GET,
 * 比对字节。
 *
 * ⚠️ 宿主这一侧是**照着真宿主搭的替身**(拓展 import 不到 `apps/`,那条边不该有)。
 * 「真宿主真的这么接线」由 `apps/server/src/__tests__/bridge-e2e.test.ts` 与
 * `server-lifecycle.test.ts` 钉住,两边合起来才是完整的一根线。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Connection, ExtensionView } from "@bilibili-notify/extension";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";
import { BRIDGE_CLOSE_CODES } from "../contract.js";
import { activate } from "../index.js";
import {
	BOT_ICON,
	BOT_ID,
	botRows,
	CONNECTION,
	CONNECTION_ID,
	hostFor,
	itemView,
	LINK_ID,
	MOUNT_PREFIX,
	SETTINGS,
	TARGET,
	TOKEN,
	UNREADABLE,
} from "./host-stand-in.js";

/** 一张真图的字节 —— 内容随便,**要能逐字节比对**才证明得了取回来的就是存进去的那张。 */
const PNG = Buffer.from(
	"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
		"05fe02fea7000000004945",
	"hex",
);

type Frame = Record<string, unknown>;

/** 一个真插件:真 socket、真 `Authorization` 头、真 JSON 帧。 */
function peer(port: number, token: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}${MOUNT_PREFIX}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const frames: Frame[] = [];
	let waiter: ((frame: Frame) => void) | null = null;
	let closeCode: number | null = null;
	let closeWaiter: ((code: number) => void) | null = null;

	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString("utf8")) as Frame;
		if (waiter) {
			const resolve = waiter;
			waiter = null;
			resolve(frame);
		} else frames.push(frame);
	});
	socket.on("close", (code) => {
		closeCode = code;
		closeWaiter?.(code);
	});
	socket.on("error", () => {});

	return {
		open(): Promise<void> {
			return new Promise((resolve, reject) => {
				socket.once("open", () => resolve());
				socket.once("error", reject);
			});
		},
		send(frame: unknown): void {
			socket.send(JSON.stringify(frame));
		},
		next(): Promise<Frame> {
			const buffered = frames.shift();
			if (buffered) return Promise.resolve(buffered);
			return new Promise((resolve) => {
				waiter = resolve;
			});
		},
		/** BN 关这条 socket 时给的 close code —— 插件拿它决定要不要重连。 */
		waitClose(): Promise<number> {
			if (closeCode !== null) return Promise.resolve(closeCode);
			return new Promise((resolve) => {
				closeWaiter = resolve;
			});
		},
		dispose(): void {
			try {
				socket.terminate();
			} catch {
				// already gone
			}
		},
	};
}

describe("桥协议往返:hello → welcome → bots → send(带图)→ 真 GET 取图 → result", () => {
	let httpServer: HttpServer;
	let port: number;
	let host: ReturnType<typeof hostFor>;
	let client: ReturnType<typeof peer> | undefined;
	/** 宿主交下来的连接名单 —— 用例可以就地把那条连接停用掉。 */
	let connections: Connection[];
	/** 桥自己的设置(接入名单)—— 用例换掉它再 `host.settingsChanged()`,就是主人存了一次。 */
	let settings: typeof SETTINGS | typeof UNREADABLE;

	beforeEach(async () => {
		httpServer = createServer();
		connections = [CONNECTION];
		settings = SETTINGS;
		host = hostFor(
			httpServer,
			() => connections,
			() => settings,
		);
		activate(host.ctx);
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		port = (httpServer.address() as AddressInfo).port;
	});

	afterEach(async () => {
		client?.dispose();
		client = undefined;
		await host.dispose();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	});

	async function handshake(): Promise<void> {
		client = peer(port, TOKEN);
		await client.open();
		client.send({
			type: "hello",
			protocol: { major: 1, minor: 0 },
			bridge: { kind: "koishi", name: "家里那台 koishi", version: "0.1.0" },
			bots: [],
		});
		expect(await client.next()).toMatchObject({
			type: "welcome",
			protocol: { major: 1 },
			// 报的是**宿主**的版本号,不是拓展自己的 —— 插件据此提示「你这版 BN 太老了」。
			server: { version: "9.9.9-test" },
			inbound: { private: true, group: "with-links" },
		});
		client.send({
			type: "bots",
			bots: [{ botId: BOT_ID, platform: "telegram", name: "小电视", icon: BOT_ICON }],
		});
		// bots 是异步到达的,adapter 要在名单里找得到这个 bot 才发得出去。
		await expectEventually(() =>
			expect(host.adapter().isAvailable?.(CONNECTION, TARGET)).toBe(true),
		);
	}

	async function expectEventually(assertion: () => void): Promise<void> {
		let last: unknown;
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline) {
			try {
				assertion();
				return;
			} catch (err) {
				last = err;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		throw last;
	}

	it("图片推送:帧里那条 URL 真的取得到,取回来的就是存进去的那张", async () => {
		await handshake();
		if (!client) throw new Error("unreachable");

		const delivered = host.adapter().send(CONNECTION, TARGET, {
			kind: "image",
			image: { buffer: PNG, mime: "image/png" },
			caption: "看图",
		});

		const frame = await client.next();
		expect(frame).toMatchObject({
			type: "send",
			botId: BOT_ID,
			platform: "telegram",
			target: { scope: "group", address: "g-42" },
			message: { kind: "image", mime: "image/png", caption: "看图" },
		});

		const url = (frame.message as { url: string }).url;
		// 🔴 地址是**这条桥自己连进来时用的那个** —— BN 猜不出别人从哪儿找得到它。
		const prefix = `http://127.0.0.1:${port}${MOUNT_PREFIX}/blob/`;
		expect(url.startsWith(prefix)).toBe(true);
		// id 本身就是凭据(128 位随机),所以它得真的是 128 位随机的样子。
		expect(url.slice(prefix.length)).toMatch(/^[0-9a-f]{32}$/);

		const got = await fetch(url);
		expect(got.status).toBe(200);
		expect(got.headers.get("content-type")).toBe("image/png");
		// 一次性的东西被谁缓存一份,取过即焚就等于没焚。
		expect(got.headers.get("cache-control")).toBe("no-store");
		expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);

		// 取过即焚:同一条 URL 再来一次就没了。
		expect((await fetch(url)).status).toBe(404);

		client.send({ type: "result", id: frame.id, ok: true });
		expect(await delivered).toMatchObject({ ok: true });
	});

	/**
	 * 面板要看的是**从配置那头看起**的名单 —— 最需要看见的恰恰是「配了但没连上」那条,
	 * 而它在会话表里根本不存在。
	 */
	/**
	 * 推送目标页「新建连接」从这里挑 bot —— 只报连着的接入驮着的;每个 bot 带着那条连接
	 * 该存的 config、经由哪条接入、已经绑成了哪条连接。
	 */
	// 验红:候选里不盖桥的图标(平台描述只用中性函数的),图标那一格就红。
	it("listConnectionCandidates:列连着的接入上的 bot;平台描述是中性的加桥的图标;settings 是 { link, botId };已绑的带 boundConnectionId;没连上是空的", async () => {
		const signal = new AbortController().signal;
		expect(await host.adapter().listConnectionCandidates?.(signal)).toEqual([]);
		await handshake();
		expect(await host.adapter().listConnectionCandidates?.(signal)).toEqual([
			{
				name: "小电视",
				platform: {
					platform: "telegram",
					label: "telegram",
					shortLabel: "telegram",
					color: "#94a3b8",
					icon: BOT_ICON,
					targetKind: "session",
					scopes: ["group", "private", "channel"],
					addressNouns: {},
				},
				settings: { link: LINK_ID, botId: BOT_ID },
				via: "家里那台 koishi",
				boundConnectionId: CONNECTION_ID,
			},
		]);
	});

	it("statusChanged:握完手喊一声,断开再喊一声 —— 面板不用切页就刷新", async () => {
		expect(host.statusChanges()).toBe(0);
		await handshake();
		const shook = host.statusChanges();
		expect(shook).toBeGreaterThanOrEqual(1);
		client?.dispose();
		const deadline = Date.now() + 2_000;
		while (host.statusChanges() <= shook && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(host.statusChanges()).toBeGreaterThan(shook);
		expect(itemView(host.status())?.status).toEqual({ tone: "off", text: "没连上" });
	});

	/**
	 * 🔴 **bot 名单是会再变的**:插件探完能力会重发一份带答案的快照,bot 上下线也会。
	 * 只在握手那一下喊 `statusChanged()` 的话,面板上那张能力矩阵永远停在握手那一份 ——
	 * 探测结果要等主人切一次页才看得见,而这正是「面板说不支持、其实支持」的来路。
	 */
	it("bots 快照又来一份 → 再喊一声 statusChanged,能力矩阵跟着换", async () => {
		await handshake();
		const before = host.statusChanges();
		client?.send({
			type: "bots",
			bots: [
				{
					botId: BOT_ID,
					platform: "telegram",
					icon: BOT_ICON,
					capabilities: { miniAppCard: "supported" },
				},
			],
		});
		await expectEventually(() => expect(host.statusChanges()).toBeGreaterThan(before));
		// 表头:方块、名字,然后六项能力 —— 「小程序卡」是第四项,落在第 6 格。
		expect(botRows(host.status())[0]?.[5]).toEqual({ kind: "tristate", value: "yes" });
	});

	// ---- 入站归属 ------------------------------------------------------------

	it("桥驮上来的消息归那条绑好的连接,喂回核心时带着两坐标", async () => {
		await handshake();
		client?.send({
			type: "inbound",
			botId: BOT_ID,
			platform: "telegram",
			message: { scope: "private", userId: "u1", text: "/status" },
		});
		await expectEventually(() => expect(host.inbound()).toHaveLength(1));
		// 桥只报是哪条连接收到的 —— 平台不由桥自报,宿主按连接补。
		expect(host.inbound()[0]).toMatchObject({
			route: "private",
			msg: { address: "u1" },
			meta: { connectionId: CONNECTION_ID },
		});
		expect(host.inbound()[0]?.meta).toEqual({ connectionId: CONNECTION_ID });
	});

	/**
	 * 🔴 **停用的连接不收入站**。只看「绑没绑成连接」的话,停用只拦得住**出**的那一半:
	 * 指令照跑、链接照解析、图照渲染,一路走到要发回去那一步才失败。主人把一条连接停用
	 * 的意思是「这个 bot 现在跟 BN 没关系」,而不是「它说的话照听、只是不回」。
	 */
	it("绑的那条连接停用了 → 驮上来的消息**一条都不收**", async () => {
		await handshake();
		connections = [{ ...CONNECTION, enabled: false }];
		client?.send({
			type: "inbound",
			botId: BOT_ID,
			platform: "telegram",
			message: { scope: "private", userId: "u1", text: "/status" },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(host.inbound()).toEqual([]);
	});

	// ---- 吊销 ----------------------------------------------------------------

	/**
	 * 🔴 **重新生成 token 也得踢掉握手窗口里那条**。它拿旧 token 过了 upgrade、还没发 hello,
	 * 所以不在会话表里:只从会话看起的对账看不见它,上一轮快照随后被刷成新 token —— 它接着
	 * 发 hello 就成了一条正式会话,之后每次对账都是「token 没变」,再也没人踢它。
	 *
	 * hello **紧跟着**发:插件那头这时还不知道自己已经被关了,帧正在路上。所以光看 close code
	 * 不够,还得看它有没有借着那一帧溜进会话表(面板上那张卡是不是「已连接」)。
	 * close code 要的是 4005 而不是 4004:握手超时也会关它,那样绿是假绿。
	 */
	it("握手窗口里重新生成了 token → 那条以 4005 被关,拿不到 welcome,也成不了会话", async () => {
		client = peer(port, TOKEN);
		await client.open();
		const [link] = SETTINGS.links;
		if (!link) throw new Error("unreachable");
		settings = { links: [{ ...link, token: "重新生成的-token" }] };
		host.settingsChanged();
		client.send({
			type: "hello",
			protocol: { major: 1, minor: 0 },
			bridge: { kind: "koishi", name: "家里那台 koishi", version: "0.1.0" },
			bots: [{ botId: BOT_ID, platform: "telegram" }],
		});
		// 先到的是哪一个:welcome 帧(溜进来了)还是 close(被踢了)。
		const first = await Promise.race([
			client.next().then((frame) => ({ frame })),
			client.waitClose().then((code) => ({ code })),
		]);
		expect(first).toEqual({ code: BRIDGE_CLOSE_CODES.revoked });
		// close 到了插件这头时,它在那之前发出的 hello BN 早就收过了(同一条 TCP,先后不乱)。
		expect(itemView(host.status())?.status).toEqual({ tone: "off", text: "没连上" });
		expect(host.adapter().isAvailable?.(CONNECTION, TARGET)).toBe(false);
	});

	/**
	 * 🔴 设置读坏的那一下(`get()` 回 `invalid`),名单**不清空**:清空的话新来的插件收 401,
	 * 按协议永久不再重连(ADR-0019 决策 36)。桥拿上一份好的名单,等装载器把它收掉。
	 */
	it("设置读坏的那一下,token 握手照收(不回 401),名单还是上一份好的", async () => {
		await handshake();
		settings = UNREADABLE;
		host.settingsChanged();

		const second = peer(port, TOKEN);
		try {
			await second.open();
			second.send({
				type: "hello",
				protocol: { major: 1, minor: 0 },
				bridge: { kind: "koishi", name: "家里那台 koishi", version: "0.1.0" },
				bots: [],
			});
			expect(await second.next()).toMatchObject({ type: "welcome" });
		} finally {
			second.dispose();
		}
	});

	it("publishView:握过手之后,面板拿得到这条接入的样子与 bot 表(ADR-0019 决策 20)", async () => {
		await handshake();
		const view = itemView(host.status());
		expect(view?.status).toEqual({ tone: "ok", text: "已连接" });
		expect(view?.pill).toBe("koishi");
		expect(JSON.stringify(view?.subtitle)).toContain("家里那台 koishi v0.1.0");
		expect(JSON.stringify(view?.subtitle)).toContain("来自 127.0.0.1");
		// 插件随 bot 报了图标就用插件的 —— 图进视图顶层的字典,格子按键引用(决策 39)。
		const icon = botRows(host.status())[0]?.[0];
		expect(icon).toMatchObject({ kind: "icon", fallback: "te" });
		const key = icon?.kind === "icon" ? icon.image : undefined;
		expect(key && (host.status() as ExtensionView).images?.[key]).toBe(BOT_ICON);
	});
});
