/**
 * 拓展的 **WS upgrade 分发**(ADR-0012 决策 26)。
 *
 * 宿主只做一件事:**这条 upgrade 是不是 `/ext/<id>` 的**;是就把三样原料交给那个拓展,
 * 其余(握手、401/503、`maxPayload`、心跳)全归它自己 —— 那些是协议语义,翻译成宿主的
 * 词表之后,协议每加一档都要动核心发一版。
 *
 * 两条容易写错的:**不是 `/ext/*` 的一律放过**(面板那条 `/ws` 挂在同一台 server 上,
 * 抢了它就是把面板打死),以及**别改 `req.url`** —— 同一个 upgrade 事件上还挂着别的监听器。
 */

import { EventEmitter } from "node:events";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionUpgrades } from "../upgrade.js";

function fakeServer() {
	const emitter = new EventEmitter();
	return {
		server: emitter as unknown as HttpServer,
		upgrade(url: string) {
			const socket = { write: vi.fn(), destroy: vi.fn() } as unknown as Duplex;
			const req = { url, headers: {} } as IncomingMessage;
			emitter.emit("upgrade", req, socket, Buffer.alloc(0));
			return { req, socket };
		},
		listeners: () => emitter.listenerCount("upgrade"),
	};
}

describe("拓展 upgrade 分发", () => {
	it("`/ext/bridge` 打到它,原料原样交过去,路径是**剥掉前缀**的那一段", () => {
		const upgrades = createExtensionUpgrades();
		const seen: string[] = [];
		upgrades.register("bridge", (u) => seen.push(u.path));
		const host = fakeServer();
		upgrades.attach(host.server);

		const { req } = host.upgrade("/ext/bridge");
		host.upgrade("/ext/bridge/blob?x=1");
		expect(seen).toEqual(["/", "/blob"]);
		// 别的监听器还要读它 —— 不许改。
		expect(req.url).toBe("/ext/bridge");
	});

	it("前缀要**精确到一段** —— `/ext/bridgefoo` 不是它的", () => {
		const upgrades = createExtensionUpgrades();
		const handler = vi.fn();
		upgrades.register("bridge", handler);
		const host = fakeServer();
		upgrades.attach(host.server);

		const { socket } = host.upgrade("/ext/bridgefoo");
		expect(handler).not.toHaveBeenCalled();
		// 它落在 /ext/* 里但没人认领 → 明确回绝,别把连接吊死。
		expect(socket.destroy).toHaveBeenCalled();
	});

	it("**不是 `/ext/*` 的原样放过** —— 面板那条 `/ws` 挂在同一台 server 上", () => {
		const upgrades = createExtensionUpgrades();
		upgrades.register("bridge", vi.fn());
		const host = fakeServer();
		upgrades.attach(host.server);

		const { socket } = host.upgrade("/ws");
		expect(socket.destroy).not.toHaveBeenCalled();
		expect(socket.write).not.toHaveBeenCalled();
	});

	it("没人认领的 `/ext/*` → 404 并关掉", () => {
		const upgrades = createExtensionUpgrades();
		const host = fakeServer();
		upgrades.attach(host.server);

		const { socket } = host.upgrade("/ext/nobody");
		expect(vi.mocked(socket.write).mock.calls[0]?.[0]).toContain("404");
		expect(socket.destroy).toHaveBeenCalled();
	});

	it("撤下之后就没人认领了", () => {
		const upgrades = createExtensionUpgrades();
		const handler = vi.fn();
		const handle = upgrades.register("bridge", handler);
		const host = fakeServer();
		upgrades.attach(host.server);

		host.upgrade("/ext/bridge");
		expect(handler).toHaveBeenCalledTimes(1);
		handle.dispose();
		const { socket } = host.upgrade("/ext/bridge");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(socket.destroy).toHaveBeenCalled();
	});

	it("同一个 id 注册两次 → 抛(一条总入口一个主人),撤下之后可以重来", () => {
		const upgrades = createExtensionUpgrades();
		const handle = upgrades.register("bridge", vi.fn());
		expect(() => upgrades.register("bridge", vi.fn())).toThrow();
		handle.dispose();
		expect(() => upgrades.register("bridge", vi.fn())).not.toThrow();
	});

	it("换一台 server 会把上一台的监听摘掉 —— 别在旧的上面留一份", () => {
		const upgrades = createExtensionUpgrades();
		const handler = vi.fn();
		upgrades.register("bridge", handler);
		const first = fakeServer();
		const second = fakeServer();
		upgrades.attach(first.server);
		upgrades.attach(second.server);

		expect(first.listeners()).toBe(0);
		second.upgrade("/ext/bridge");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("还没 attach 就注册 → 之后 attach 上照样收得到", () => {
		const upgrades = createExtensionUpgrades();
		const handler = vi.fn();
		upgrades.register("bridge", handler);
		const host = fakeServer();
		upgrades.attach(host.server);
		host.upgrade("/ext/bridge");
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
