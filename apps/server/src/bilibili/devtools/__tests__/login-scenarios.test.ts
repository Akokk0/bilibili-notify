import type { AuthState } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { type BiliDevtoolsDeps, createBiliDevtools } from "../index.js";
import { fakeAuth } from "./support/fake-auth.js";
import { biliRegistry } from "./support/registry.js";

const NOT_READY = "B 站来源还没起来，先等它起来再试";

function setup(options?: { login?: boolean; state?: AuthState }) {
	const state = options?.state ?? { status: "logged-in", loggedInAt: "2026-10-25T00:00:00.000Z" };
	const auth = fakeAuth(state, { name: "真的" });
	const login = {
		healthCheckNow: vi.fn(async () => true),
		handleAuthLost: vi.fn(async () => {}),
		reportAccountInfo: vi.fn(async () => {}),
	};
	const deps = {
		bus: {
			emit: vi.fn(),
			on: vi.fn(() => ({ dispose() {} })),
		},
		subs: () => [],
		dynamic: () => undefined,
		liveRooms: () => undefined,
		profileAvatars: () => undefined,
		login: () => (options?.login === false ? undefined : login),
		auth: () => auth,
	} as unknown as BiliDevtoolsDeps;
	return {
		login,
		registry: biliRegistry(createBiliDevtools(deps).provider.scenarios),
	};
}

describe("B 站登录失效与重新确认登录", () => {
	it("已登录时按「登录失效」把当前会话判失效一次", async () => {
		const { login, registry } = setup();

		await registry.run("bilibili.auth.lost", {});

		expect(login.handleAuthLost).toHaveBeenCalledOnce();
	});

	it("没登录时按「登录失效」不碰登录系统,并说清没有可判失效的会话", async () => {
		const { login, registry } = setup({ state: { status: "logged-out" } });

		await expect(registry.run("bilibili.auth.lost", {})).resolves.toMatchObject({
			summary: "现在没登录着，没有可判失效的会话",
		});

		expect(login.handleAuthLost).not.toHaveBeenCalled();
	});

	it("按「重新确认登录」拿罐里现成的 cookie 再探一次,摘要写探完后的状态", async () => {
		let state: AuthState = { status: "expired", message: "账号登录已失效，请重新扫码登录" };
		const auth = fakeAuth(state, null);
		const login = {
			healthCheckNow: vi.fn(async () => true),
			handleAuthLost: vi.fn(async () => {}),
			reportAccountInfo: vi.fn(async () => {
				state = { status: "logged-in", loggedInAt: "2026-10-25T01:00:00.000Z" };
			}),
		};
		const deps = {
			bus: { emit: vi.fn(), on: vi.fn(() => ({ dispose() {} })) },
			subs: () => [],
			dynamic: () => undefined,
			liveRooms: () => undefined,
			profileAvatars: () => undefined,
			login: () => login,
			auth: () => ({ ...auth, state: () => state }),
		} as unknown as BiliDevtoolsDeps;
		const registry = biliRegistry(createBiliDevtools(deps).provider.scenarios);

		await expect(registry.run("bilibili.auth.recheck", {})).resolves.toMatchObject({
			summary: "重新确认登录：已登录。",
		});

		expect(login.reportAccountInfo).toHaveBeenCalledOnce();
	});

	it("来源还没起来时两个场景都回同一句提示,不抛", async () => {
		const { registry } = setup({ login: false });

		await expect(registry.run("bilibili.auth.lost", {})).resolves.toMatchObject({
			summary: NOT_READY,
		});
		await expect(registry.run("bilibili.auth.recheck", {})).resolves.toMatchObject({
			summary: NOT_READY,
		});
	});

	it("场景说明写清真实副作用、问题表与私聊、cookie 罐不动和恢复办法", () => {
		const { registry } = setup();
		const descOf = (id: string) => registry.list().find((candidate) => candidate.id === id)?.desc;
		const lost = descOf("bilibili.auth.lost");
		expect(lost).toContain("动态检测会停、直播监听会拆");
		expect(lost).toContain("会进问题表，主人会收到私聊，恢复时会补一句「已恢复」");
		expect(lost).toContain("cookie 罐不动");
		expect(lost).toContain("看完记得按「重新确认登录」");
		const recheck = descOf("bilibili.auth.recheck");
		expect(recheck).toContain("还有效就回到已登录");
		expect(recheck).toContain("已经失效的话就判成登录失效");
		expect(recheck).toContain("主人会收到私聊");
		expect(recheck).toContain("cookie 罐不动");
	});
});
