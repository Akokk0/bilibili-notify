import { describe, expect, it, vi } from "vite-plus/test";
import { createDevRegistry, DevParamError } from "../registry.js";
import { inboundScenarios } from "../scenarios/inbound.js";

/**
 * A4:私聊指令 / 群链接 —— 直接调接线层那两个入站口(`onInboundPrivate` / `onInboundGroup`),
 * 与 adapter 收到真帧后调的是同一个函数;回复走真链路(sink / 来源 adapter),开着截流就拦得住。
 */

const ADAPTERS = [
	{ id: "ad-web", name: "钩子", platform: "webhook", enabled: true },
	{ id: "ad-ob", name: "NapCat", platform: "onebot", enabled: true },
	{ id: "ad-qq", name: "官机", platform: "qq-official", enabled: false },
] as never[];

const TARGETS = [
	{
		id: "t-p",
		name: "主人",
		adapterId: "ad-ob",
		platform: "onebot",
		scope: "private",
		enabled: true,
		session: { userId: "10001" },
	},
	{
		id: "t-g",
		name: "测试群",
		adapterId: "ad-ob",
		platform: "onebot",
		scope: "group",
		enabled: true,
		session: { groupId: "88888" },
	},
	{
		id: "t-q",
		name: "官机群",
		adapterId: "ad-qq",
		platform: "qq-official",
		scope: "group",
		enabled: true,
		session: { groupOpenid: "OPENID-1" },
	},
] as never[];

function setup(
	over: {
		master?: string;
		inbound?: boolean;
		commands?: () => { prefix: string; masterUserId?: string };
	} = {},
) {
	const priv = vi.fn();
	const group = vi.fn();
	const masterUserId = "master" in over ? over.master : "10001";
	const reg = createDevRegistry(
		inboundScenarios({
			inbound: () => (over.inbound === false ? undefined : { private: priv, group }),
			commands: over.commands ?? (() => ({ prefix: "/", masterUserId })),
			adapters: () => ADAPTERS,
			targets: () => TARGETS,
		}),
	);
	return { reg, priv, group };
}

describe("inbound.command", () => {
	it("声明:事件组;text 默认留空 —— 前缀不烤进声明里", () => {
		const { reg } = setup();
		const decl = reg.list().find((d) => d.id === "inbound.command");
		// 不占快捷位:药丸上只给最常按的那几个,指令 / 链接进面板点。
		expect(decl).toMatchObject({ group: "event" });
		expect(decl?.quick).toBeUndefined();
		// 声明表在 createDevtools 那一刻就定型,而前缀在系统页上随时能改。
		expect(decl?.params.find((p) => p.key === "text")).toMatchObject({
			kind: "text",
			default: "",
		});
	});

	it("正文留空 → 用**现在**的前缀拼 help,不是建表那会儿的", async () => {
		let prefix = "/";
		const { reg, priv } = setup({ commands: () => ({ prefix, masterUserId: "master" }) });

		await reg.run("inbound.command", {});
		expect(priv.mock.calls.at(-1)?.[0]).toMatchObject({ text: "/help" });

		prefix = ".";
		await reg.run("inbound.command", {});
		expect(priv.mock.calls.at(-1)?.[0]).toMatchObject({ text: ".help" });
	});

	it("当作主人发一句私聊:userId 省略取配置里的主人", async () => {
		const { reg, priv } = setup();
		const res = await reg.run("inbound.command", { text: "/status" });
		expect(priv).toHaveBeenCalledWith({ userId: "10001", text: "/status" }, { adapterId: "ad-ob" });
		expect(res.summary).toContain("/status");
	});

	it("指定 userId 就用给的 —— 拿来验「不是主人就不理」", async () => {
		const { reg, priv } = setup();
		await reg.run("inbound.command", { userId: "20002", text: "/help" });
		expect(priv).toHaveBeenCalledWith({ userId: "20002", text: "/help" }, { adapterId: "ad-ob" });
	});

	it("没配主人又没给 userId → 拒;入站口还没接上 → 拒", async () => {
		const { reg } = setup({ master: undefined });
		await expect(reg.run("inbound.command", {})).rejects.toBeInstanceOf(DevParamError);
		const off = setup({ inbound: false });
		await expect(off.reg.run("inbound.command", {})).rejects.toBeInstanceOf(DevParamError);
	});
});

describe("inbound.link", () => {
	it("默认:第一个启用的聊天平台适配器 + 它名下第一个群目标的群地址", async () => {
		const { reg, group } = setup();
		const res = await reg.run("inbound.link", {});
		expect(group).toHaveBeenCalledWith(
			"onebot",
			expect.objectContaining({
				groupId: "88888",
				text: expect.stringContaining("bilibili.com"),
				cardLinks: [],
			}),
			{ adapterId: "ad-ob" },
		);
		expect(res.summary).toContain("88888");
	});

	it("指定适配器与群号、正文", async () => {
		const { reg, group } = setup();
		await reg.run("inbound.link", { adapter: "ad-qq", groupId: "OPENID-9", text: "BV1xx" });
		expect(group).toHaveBeenCalledWith(
			"qq-official",
			expect.objectContaining({ groupId: "OPENID-9", text: "BV1xx" }),
			{ adapterId: "ad-qq" },
		);
	});

	it("webhook 没有群 → 拒;适配器名下没群目标又没给群号 → 拒", async () => {
		const { reg } = setup();
		await expect(reg.run("inbound.link", { adapter: "ad-web" })).rejects.toBeInstanceOf(
			DevParamError,
		);
		const noGroups = createDevRegistry(
			inboundScenarios({
				inbound: () => ({ private: vi.fn(), group: vi.fn() }),
				commands: () => ({ prefix: "/" }),
				adapters: () => ADAPTERS,
				targets: () => [],
			}),
		);
		await expect(noGroups.run("inbound.link", { adapter: "ad-ob" })).rejects.toThrow(/群/);
	});
});
