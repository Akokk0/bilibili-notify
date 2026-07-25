/**
 * 单元测试 —— koishi sink 的投递前置判断。
 *
 * 这个文件是新开的口子:`sink.ts` 此前零覆盖(lifecycle.test.ts 把 createKoishiSink
 * 整个 mock 成 `{}`),而「指定了发送账号之后该怎么发」的最终裁决就在这里。
 *
 * 重心是**选谁发 / 发不发**,不是消息体怎么拼:
 *   - 指定的账号在线 → 就用它,哪怕同平台还有别的号排在前面
 *   - 指定的账号离线 → 不发,如实报不可达(**不**改用同平台在线的另一个号)
 *   - 指定的账号不存在 → 同样不发,并且告警要说得出「你现在有哪些号」
 *   - 没指定 → 历史行为一字不变:该平台第一个在线的
 *
 * 「离线不发」这条最难手工复现(得把一个号真的弄离线),正是值得新开这个口子的理由。
 */

import type {
	KoishiBotAdapterConfig,
	NotificationPayload,
	PushAdapter,
	PushTarget,
} from "@bilibili-notify/internal";
import type { Context, Logger } from "koishi";
import { describe, expect, it, vi } from "vite-plus/test";

/**
 * `koishi` 本体在 vitest 里没法裸 import(@koishijs/loader 会炸
 * `Class extends value #<Object>`),而 sink.ts 运行时确实要用它的 `h` 与 `Universal`
 * ——这正是这个文件此前一直没有测试的原因。打桩的写法照抄
 * subscription-loader-upnames.test.ts 里的既有做法。
 */
vi.mock("koishi", () => {
	const h = Object.assign((_type: string, ..._args: unknown[]) => ({ type: "stub" }), {
		Fragment: "fragment",
		text: (text: string) => ({ type: "text", text }),
		image: (...args: unknown[]) => ({ type: "image", args }),
	});
	return { h, Universal: { Status: { OFFLINE: 0, ONLINE: 1 } } };
});

const { createKoishiSink } = await import("../sink");

/** 与上面桩里的 Universal.Status 对齐。 */
const ONLINE = 1;
const OFFLINE = 0;

interface FakeBot {
	platform: string;
	selfId: string;
	status: number;
	sendMessage: ReturnType<typeof vi.fn>;
	sendPrivateMessage: ReturnType<typeof vi.fn>;
}

function fakeBot(platform: string, selfId: string, status = ONLINE): FakeBot {
	return {
		platform,
		selfId,
		status,
		sendMessage: vi.fn(async () => ["msg-id"]),
		sendPrivateMessage: vi.fn(async () => ["msg-id"]),
	};
}

const TEXT: NotificationPayload = { kind: "text", text: "开播啦" };

/**
 * 搭一套最小的 sink:一组假 bot + 一个指向 (platform, selfId) 的 adapter + 一个群 target。
 * 返回 sink 与收集到的告警,断言直接查这两样。
 */
function setup(bots: FakeBot[], adapterCfg: KoishiBotAdapterConfig) {
	const adapter: PushAdapter = {
		id: "adapter-1",
		name: "test",
		enabled: true,
		platform: "koishi-bot",
		config: adapterCfg,
	};
	const target: PushTarget = {
		id: "target-1",
		name: "测试群",
		adapterId: adapter.id,
		platform: "koishi-bot",
		scope: "group",
		enabled: true,
		session: { channelId: "群A" },
	};
	const warnings: string[] = [];
	const sink = createKoishiSink({
		ctx: { bots } as unknown as Context,
		resolveTarget: (id) => (id === target.id ? target : undefined),
		resolveAdapter: (id) => (id === adapter.id ? adapter : undefined),
		logger: { warn: (msg: string) => warnings.push(msg) } as unknown as Logger,
	});
	return { sink, warnings, targetId: target.id };
}

describe("koishi sink — 指定了发送账号", () => {
	it("指定的号在线 → 就用它,不管它排第几", async () => {
		const first = fakeBot("onebot", "111");
		const wanted = fakeBot("onebot", "222");
		const { sink, targetId } = setup([first, wanted], { botPlatform: "onebot", selfId: "222" });

		const res = await sink.send(targetId, TEXT);
		expect(res.ok).toBe(true);
		expect(wanted.sendMessage).toHaveBeenCalledTimes(1);
		expect(first.sendMessage).not.toHaveBeenCalled();
	});

	it("指定的号离线 → 不发,报不可达,绝不改用同平台在线的另一个号", async () => {
		// 这是主人拍板的语义。发错号比没发出去更难收场:群里看到的是个可能根本不该
		// 在场的机器人,@全体的权限也未必一样。
		const wanted = fakeBot("onebot", "111", OFFLINE);
		const sibling = fakeBot("onebot", "222", ONLINE);
		const { sink, targetId } = setup([wanted, sibling], { botPlatform: "onebot", selfId: "111" });

		const res = await sink.send(targetId, TEXT);
		expect(res.ok).toBe(false);
		expect(res.err).toContain("111");
		expect(sibling.sendMessage).not.toHaveBeenCalled();
		expect(wanted.sendMessage).not.toHaveBeenCalled();
	});

	it("指定的号不存在(填错一位数)→ 不发,且告警列得出当前可用的号", async () => {
		const a = fakeBot("onebot", "111");
		const b = fakeBot("onebot", "222");
		const { sink, warnings, targetId } = setup([a, b], {
			botPlatform: "onebot",
			selfId: "1111",
		});

		const res = await sink.send(targetId, TEXT);
		expect(res.ok).toBe(false);
		expect(a.sendMessage).not.toHaveBeenCalled();
		expect(b.sendMessage).not.toHaveBeenCalled();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("1111"); // 填错的那个
		expect(warnings[0]).toContain("222"); // 实际可用的
	});

	it("指定的号不存在 → isAvailable 如实报不可用", () => {
		const { sink, targetId } = setup([fakeBot("onebot", "111")], {
			botPlatform: "onebot",
			selfId: "1111",
		});
		expect(sink.isAvailable(targetId)).toBe(false);
	});
});

describe("koishi sink — 没指定发送账号(历史行为)", () => {
	it("用该平台第一个**在线**的号 —— 首个离线时顺延,不误判不可达", async () => {
		const offlineFirst = fakeBot("onebot", "111", OFFLINE);
		const onlineSecond = fakeBot("onebot", "222", ONLINE);
		const { sink, targetId } = setup([offlineFirst, onlineSecond], { botPlatform: "onebot" });

		const res = await sink.send(targetId, TEXT);
		expect(res.ok).toBe(true);
		expect(onlineSecond.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("多个同平台在线也照旧静默挑第一个 —— 这条是刻意保留的,别顺手加告警", async () => {
		// 主人明确要求不为这种情况加告警(单机器人部署占绝大多数,不值得每次都吵)。
		// 写成测试是怕日后有人「顺手补全」,那会让一屋子正常用户天天看见一条黄字。
		const first = fakeBot("onebot", "111");
		const second = fakeBot("onebot", "222");
		const { sink, warnings, targetId } = setup([first, second], { botPlatform: "onebot" });

		const res = await sink.send(targetId, TEXT);
		expect(res.ok).toBe(true);
		expect(first.sendMessage).toHaveBeenCalledTimes(1);
		expect(warnings).toEqual([]);
	});

	it("平台填错但只有一个在线平台 → 仍然回退投递 + 告警(master 不可达那条老修复)", async () => {
		// 没指定账号时回退必须原样保留:普通订阅与 master 永远走这条路。
		const bot = fakeBot("onebot", "10086");
		const { sink, warnings, targetId } = setup([bot], { botPlatform: "qq" });

		const res = await sink.send(targetId, TEXT);
		expect(res.ok).toBe(true);
		expect(bot.sendMessage).toHaveBeenCalledTimes(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("onebot");
	});
});
