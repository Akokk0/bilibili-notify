/**
 * 「假装一条桥连上来」那两条场景,经开发入口 `devtools(ctx)` 的公开口。
 *
 * 缝钉在**场景 ↔ 桥自己真的端点**之间:对家是真装进替身宿主的桥(`activate` + 真 HTTP 服务器 +
 * 真 upgrade),所以会话、面板视图、adapter 的投递、喂回核心的入站,看的都是桥这一侧真的结果。
 * 场景要自己挑 token、拼出自己的地址、把连上的那条挂进「当前生效」、收摊时断掉 —— 这几件里
 * 任意一件错,症状都是「按了没反应」或者「面板上一直说连着、其实早断了」。
 */

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DevScenarioDef } from "@bilibili-notify/extension";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { devtools } from "../devtools/index.js";
import { activate } from "../index.js";
import {
	botRows,
	CONNECTION,
	devtoolsContextOf,
	hostFor,
	itemView,
	LINK_ID,
	realHttp,
	recordingHttp,
	SETTINGS,
	TARGET,
	UNREADABLE,
} from "./host-stand-in.js";

/** 假 bot 的 id —— 场景里写死的,这里用来造绑它的那条连接。 */
const FAKE_BOT_ID = "fake-bot-1";
/** R2:发信人的默认假号(编出来的,不等于假 bot 自己的号)。 */
const DEFAULT_SENDER = "800100002";

/** 绑着假 bot 的那条连接 —— 入站归属与投递的路都要它。 */
const FAKE_CONNECTION = { ...CONNECTION, settings: { link: LINK_ID, botId: FAKE_BOT_ID } };

let httpServer: HttpServer;
let port: number;
let host: ReturnType<typeof hostFor>;
let settings: typeof SETTINGS | typeof UNREADABLE;
let aborter: AbortController;
let recorder: ReturnType<typeof recordingHttp>;
let upgradePaths: string[];
let mountUrl: string | undefined;
let group: DevScenarioDef[];

function from(id: string): DevScenarioDef {
	const def = group.find((s) => s.id === id);
	if (!def) throw new Error(`没有场景 ${id}`);
	return def;
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			assertion();
			return;
		} catch (err) {
			if (Date.now() > deadline) throw err;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
}

function open(ctxMountUrl: () => string | undefined = () => mountUrl): DevScenarioDef[] {
	return devtools(devtoolsContextOf(host.ctx, ctxMountUrl)).scenarios;
}

beforeEach(async () => {
	httpServer = createServer();
	settings = SETTINGS;
	aborter = new AbortController();
	recorder = recordingHttp(realHttp());
	upgradePaths = [];
	host = hostFor(
		httpServer,
		() => [FAKE_CONNECTION],
		() => settings,
		{ http: recorder.http, signal: aborter.signal },
	);
	activate(host.ctx);
	httpServer.on("upgrade", (req) => upgradePaths.push((req.url ?? "").split("?")[0] ?? ""));
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	port = (httpServer.address() as AddressInfo).port;
	mountUrl = `http://127.0.0.1:${port}/ext/bridge`;
	group = open();
});

afterEach(async () => {
	await from("connect").reset?.();
	await host.dispose();
	httpServer.closeAllConnections();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("开发入口", () => {
	it("交回 connect / inbound 两条,id 不带前缀(前缀由宿主加)", () => {
		expect(group.map((s) => s.id)).toEqual(["connect", "inbound"]);
	});

	it("每调一次新起一份闭包:一份里连上的桥,另一份看不见", async () => {
		const other = open();
		await from("connect").run({});
		expect(from("connect").active?.()).not.toBeNull();
		expect(other.find((s) => s.id === "connect")?.active?.()).toBeNull();
		expect(await other.find((s) => s.id === "inbound")?.run({ text: "x" })).toMatchObject({
			ok: false,
			code: "invalid",
		});
	});
});

describe("假装一条桥连上来", () => {
	it("拿那条接入的 token 连到桥自己的端点上,路径是它的挂载点;面板那张卡变绿,bot 带着平台图标", async () => {
		const out = await from("connect").run({});
		expect(upgradePaths).toEqual(["/ext/bridge"]);
		expect(out).toMatchObject({ ok: true, summary: expect.stringContaining("家里那台 koishi") });

		// 端点上真的多出一条握过手的会话:面板视图里是「已连接」,bot 表里有假 bot 与它的图标。
		await eventually(() =>
			expect(itemView(host.status())?.status).toEqual({ tone: "ok", text: "已连接" }),
		);
		const hello = recorder.sent.find((f) => f.type === "hello") as {
			bots: { icon?: string; platform: string; capabilities?: unknown }[];
		};
		expect(hello.bots[0]?.platform).toBe("onebot");
		expect(hello.bots[0]?.icon).toMatch(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/);
		// 握手那份还没探能力。
		expect(hello.bots[0]?.capabilities).toBeUndefined();
		expect(botRows(host.status())).toHaveLength(1);
	});

	/**
	 * 能力矩阵那三态是最难在真环境里凑齐的,所以给一档专门凑齐它。
	 *
	 * 🔴 **能力跟着握手后的第二份快照来**,不在 hello 里 —— 真插件就是这个次序。
	 */
	it("第二份名单快照带上三态能力(面板矩阵:支持 / 不支持 / 还不知道)", async () => {
		await from("connect").run({ caps: "mixed" });
		await eventually(() => {
			const cells = botRows(host.status())[0]
				?.slice(2)
				.map((cell) => (cell.kind === "tristate" ? cell.value : cell.kind));
			// atAll / inbound / forward / miniAppCard / shareCardLinks / markdown
			expect(cells).toEqual(["yes", "yes", "yes", "no", "unknown", "no"]);
		});
		expect(recorder.sent.filter((f) => f.type === "bots")).toHaveLength(1);
	});

	it("「全都支持 / 全都不支持」两档:六项恒同一个态", async () => {
		await from("connect").run({ caps: "all" });
		await eventually(() => {
			const cells = botRows(host.status())[0]
				?.slice(2)
				.map((cell) => (cell.kind === "tristate" ? cell.value : cell.kind));
			expect(cells).toEqual(Array(6).fill("yes"));
		});
		await from("connect").run({ caps: "none" });
		await eventually(() => {
			const cells = botRows(host.status())[0]
				?.slice(2)
				.map((cell) => (cell.kind === "tristate" ? cell.value : cell.kind));
			expect(cells).toEqual(Array(6).fill("no"));
		});
	});

	/** 🔴 「回执失败」是 D15 点名要留的一样:理由原样到 adapter 的投递结果。 */
	it("回执失败的理由原样到 adapter;留空就回成功", async () => {
		await from("connect").run({ fail: "群被禁言了" });
		await eventually(() =>
			expect(host.adapter().isAvailable?.(FAKE_CONNECTION, TARGET)).toBe(true),
		);
		expect(
			await host.adapter().send(FAKE_CONNECTION, TARGET, { kind: "text", text: "开播啦" }),
		).toMatchObject({
			ok: false,
			code: "unknown",
			message: "群被禁言了",
		});

		await from("connect").run({});
		await eventually(() =>
			expect(host.adapter().isAvailable?.(FAKE_CONNECTION, TARGET)).toBe(true),
		);
		expect(
			await host.adapter().send(FAKE_CONNECTION, TARGET, { kind: "text", text: "开播啦" }),
		).toMatchObject({
			ok: true,
		});
	});

	it("连上之后进「当前生效」条(id 不带前缀),收摊就断开、没了", async () => {
		await from("connect").run({});
		expect(from("connect").active?.()).toMatchObject({ scenarioId: "connect" });

		await from("connect").reset?.();
		expect(from("connect").active?.()).toBeNull();
		await eventually(() =>
			expect(itemView(host.status())?.status).toEqual({ tone: "off", text: "没连上" }),
		);
	});

	/** 🔴 T20:拓展停下(`ctx.signal` 中止)之后,假桥的连接自己断开。 */
	it("拓展的 ctx 收摊之后,假桥连接断开,active() 回 null", async () => {
		await from("connect").run({});
		expect(from("connect").active?.()).not.toBeNull();

		aborter.abort();
		await eventually(() => expect(from("connect").active?.()).toBeNull());
		await eventually(() =>
			expect(itemView(host.status())?.status).toEqual({ tone: "off", text: "没连上" }),
		);
	});

	it("自己的 HTTP 服务还没起来(mountUrl 回 undefined)→ 说清楚,别去连一个 undefined", async () => {
		mountUrl = undefined;
		await expect(from("connect").run({})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringMatching(/HTTP 服务还没起来/),
		});
		expect(upgradePaths).toEqual([]);
	});

	it("没有桥接入 → 说清楚要先去建一条,别默默连一条空的", async () => {
		settings = { links: [] };
		await expect(from("connect").run({})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringMatching(/接入/),
		});
	});

	it("设置读不懂 → 回失败,不在 devtools 里炸", async () => {
		settings = UNREADABLE;
		await expect(from("connect").run({})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringMatching(/设置/),
		});
	});

	it("接入的 token 是空的 → 明说(备份恢复回来的那条就是空的)", async () => {
		settings = { links: [{ ...SETTINGS.links[0], token: "" }] } as typeof SETTINGS;
		await expect(from("connect").run({})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringMatching(/token/),
		});
	});

	it("按名字或 id 挑得到接入;挑了没有的 → 明说", async () => {
		const [link] = SETTINGS.links;
		settings = {
			links: [{ ...link, id: "other", name: "机房那台", token: "别的 token" }, link],
		} as typeof SETTINGS;
		const out = await from("connect").run({ link: "家里那台 koishi" });
		expect(out).toMatchObject({ ok: true, summary: expect.stringContaining("家里那台 koishi") });
		await expect(from("connect").run({ link: "没有这条" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringMatching(/没有这条接入/),
		});
	});
});

describe("桥驮一条消息上来", () => {
	async function connected(): Promise<void> {
		await from("connect").run({});
		await eventually(() =>
			expect(host.adapter().isAvailable?.(FAKE_CONNECTION, TARGET)).toBe(true),
		);
	}

	/** R2:发信人是编出来的假号,默认就用它 —— 私聊也一样(T19)。 */
	it("私聊:不给发信人 → 用默认假号;正文留空取 /help", async () => {
		await connected();
		const out = await from("inbound").run({});
		await eventually(() => expect(host.inbound()).toHaveLength(1));
		expect(host.inbound()[0]).toMatchObject({
			route: "private",
			msg: { address: DEFAULT_SENDER, text: "/help" },
			meta: { connectionId: FAKE_CONNECTION.id },
		});
		expect(out).toMatchObject({ ok: true, summary: expect.stringContaining(DEFAULT_SENDER) });
	});

	it("私聊:发信人改成主人的号、正文自己写 → 原样驮上去", async () => {
		await connected();
		await from("inbound").run({ from: "10086", text: "帮助" });
		await eventually(() => expect(host.inbound()).toHaveLength(1));
		expect(host.inbound()[0]).toMatchObject({
			route: "private",
			msg: { address: "10086", text: "帮助" },
		});
	});

	it("群消息:群号与发信人各自一格,各有默认假号;正文留空取带链接的那条", async () => {
		await connected();
		await from("inbound").run({ scope: "group", group: "g-42", text: "看看 https://b23.tv/x" });
		await eventually(() => expect(host.inbound()).toHaveLength(1));
		expect(host.inbound()[0]).toMatchObject({
			route: "group",
			msg: { address: "g-42", senderId: DEFAULT_SENDER, text: "看看 https://b23.tv/x" },
		});

		await from("inbound").run({ scope: "group", from: "10086" });
		await eventually(() => expect(host.inbound()).toHaveLength(2));
		const second = host.inbound()[1]?.msg as { address: string; senderId: string; text: string };
		expect(second.senderId).toBe("10086");
		expect(second.address).not.toBe("");
		expect(second.text).toContain("https://www.bilibili.com/video/");
	});

	/**
	 * 🔴 **默认发信人不许正好是那个假 bot 自己**。从前就栽过:撞上 `selfId`,链接解析那道
	 * 「机器人自己贴的链接不解析」的闸会把整条消息静默吃掉,场景报「已驮上去」、什么都不发生。
	 */
	it("群消息:默认发信人**不是假 bot 自己**,而且摘要里说清是谁", async () => {
		await connected();
		const out = await from("inbound").run({ scope: "group" });
		await eventually(() => expect(host.inbound()).toHaveLength(1));
		const msg = host.inbound()[0]?.msg as { senderId: string; selfId?: string };
		expect(msg.selfId).toBeTruthy();
		expect(msg.senderId).not.toBe(msg.selfId);
		expect(out).toMatchObject({ ok: true, summary: expect.stringContaining(msg.senderId) });
	});

	it("场景说明写清:发信人默认是编的号,要以主人身份试指令就改成主人的号;群里别填 bot 自己的号", () => {
		const desc = from("inbound").desc ?? "";
		expect(desc).toMatch(/编/);
		expect(desc).toMatch(/主人/);
		expect(desc).toMatch(/bot 自己/);
	});

	it("还没假装连上就驮 → 说清楚先按上面那条", () => {
		// 同步回失败结果 —— 注册表无须靠异常猜「还没连上」。
		expect(from("inbound").run({ text: "帮助" })).toMatchObject({
			ok: false,
			code: "invalid",
			message: expect.stringMatching(/没连/),
		});
	});
});
