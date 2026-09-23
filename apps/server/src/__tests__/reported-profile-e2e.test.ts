/**
 * 🔴 **拓展报的资料更新,在真 BN 上落进了订阅列表**(ADR-0019 决策 7 / 49 / 62)。
 *
 * 拓展经 `handle.reportProfile` 报「这个人的名字 / 头像 / 粉丝数」,宿主核过发到 bus;后面要有人把它
 * 写进资料缓存、把头像存成文件,`GET /api/subs` 才读得到。中间任意一处漏接(bus 上没人听、bootstrap
 * 没起那个监听),拓展那头照样 resolve、订阅页永远是新建那一刻的样子,而没人报错。
 *
 * 所以装一个真的 v2 小拓展、起一台真 BN:订阅经面板那条路新建(带着解析门候选的头像),之后按拓展的
 * 动作钮报资料,全程只读面板读的那一口。bus 在这里只**旁听**(包一层真的那个,不换掉它)。
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionDTO } from "@bilibili-notify/contract";
import type { ConfigScope } from "@bilibili-notify/internal";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { avatarDataUrl } from "./support/avatar-fixtures.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/** bus 上旁听到的:资料变了的那几帧、配置变了的那几档。 */
const heard = vi.hoisted(() => ({
	profiles: [] as string[][],
	config: [] as ConfigScope[],
}));

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("subscription-profiles-changed", (ids) => {
				heard.profiles.push([...ids].sort());
			});
			bus.on("config-changed", (scope) => {
				heard.config.push(scope);
			});
			return bus;
		},
	};
});

const FIXTURE_ID = "profile-probe";
const PERSON = "douyin-person";

/** 面板那条路新建的一条。先开着报,再停用了报(决策 62:停用的也该有名字与头像)。 */
const SUB = makeExtensionSubscription({
	id: "c0000000-0000-4000-8000-000000000001",
	extensionId: FIXTURE_ID,
	externalId: PERSON,
	enabled: true,
});

/** 三张不同的「png」:宿主只认开头的魔数,后面几个字节让它们内容不同。 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (...tail: number[]) => Buffer.from([...PNG_MAGIC, ...tail]);
const SEED_PNG = png(0, 0, 0, 1);
const REPORTED_PNG = png(1, 2, 3, 4);
const NEXT_PNG = png(5, 6, 7, 8);

const FIXTURE_CODE = `
const png = (...tail) => new Uint8Array([${PNG_MAGIC.join(", ")}, ...tail]);
const PERSON = ${JSON.stringify(PERSON)};
export function activate(ctx) {
	const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
	ctx.onAction("profile.full", () =>
		handle.reportProfile(PERSON, { name: "报来的名字", fans: 4321, avatar: png(1, 2, 3, 4) }),
	);
	ctx.onAction("profile.sameAvatar", () => handle.reportProfile(PERSON, { avatar: png(1, 2, 3, 4) }));
	ctx.onAction("profile.nameOnly", () => handle.reportProfile(PERSON, { name: "只改了名字" }));
	ctx.onAction("profile.nextAvatar", () => handle.reportProfile(PERSON, { avatar: png(5, 6, 7, 8) }));
}
`;

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") {
				probe.close(() => reject(new Error("failed to allocate test port")));
				return;
			}
			const { port } = address;
			probe.close(() => resolve(port));
		});
	});
}

describe("资料更新 e2e:拓展报的名字 / 粉丝 / 头像落进了订阅列表", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

	async function press(action: string): Promise<void> {
		const res = await api(`/api/ext/${FIXTURE_ID}/actions/${action}`, { method: "POST" });
		expect(res.status, await res.clone().text()).toBe(200);
	}

	/** 面板那条路新建:带着解析门候选的名字、粉丝与头像(决策 49 的「新建时用选中那个候选预填」)。 */
	async function create(): Promise<void> {
		const res = await api("/api/subs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...SUB,
				cachedProfile: { name: "候选的名字", fans: 7, avatar: avatarDataUrl("png", SEED_PNG) },
			}),
		});
		expect(res.status, await res.clone().text()).toBe(200);
	}

	const avatarFile = () => join(dataDir, "avatars", `${SUB.id}.png`);

	/** 这一条的资料。 */
	async function profile() {
		const res = await api("/api/subs");
		const list = (await res.json()) as SubscriptionDTO[];
		return list.find((s) => s.id === SUB.id)?.cachedProfile;
	}

	/** 等这一次报的资料落进去(`lastRefreshedAt` 换过)。 */
	function refreshedAfter(before: Awaited<ReturnType<typeof profile>>) {
		return vi.waitFor(async () => {
			const now = await profile();
			expect(now?.lastRefreshedAt).not.toBe(before?.lastRefreshedAt);
			return now;
		});
	}

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-reported-profile-e2e-"));
		const extDir = join(dataDir, "extensions", FIXTURE_ID);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: FIXTURE_ID,
				name: "资料探针",
				description: "按一下动作钮报一次资料",
				version: "0.1.0",
				apiVersion: 2,
				actions: ["profile.full", "profile.sameAvatar", "profile.nameOnly", "profile.nextAvatar"],
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["post"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);

		port = await findFreePort();
		handle = await startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
		// 面板那条路拨开关:拨完紧接着列一次拓展,那一口会先把热装落实掉。
		const toggled = await api("/api/globals", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ extensions: { [FIXTURE_ID]: { enabled: true } } }),
		});
		expect(toggled.status, await toggled.clone().text()).toBe(200);
		await api("/api/ext");
		await create();
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		heard.profiles.length = 0;
		heard.config.length = 0;
	});

	it("报一次:换上报来的名字 / 粉丝,头像换了张、地址的 ?v= 跟着变", async () => {
		const before = await profile();
		expect(before?.name).toBe("候选的名字");
		expect(before?.avatar).toMatch(new RegExp(`^/api/subs/${SUB.id}/avatar\\?v=`));

		await press("profile.full");
		const after = await refreshedAfter(before);

		expect(after?.name).toBe("报来的名字");
		expect(after?.fans).toBe(4321);
		expect(after?.avatar).toMatch(new RegExp(`^/api/subs/${SUB.id}/avatar\\?v=[0-9a-f]+$`));
		expect(after?.avatar).not.toBe(before?.avatar);
		const img = await api(after?.avatar ?? "");
		expect(img.status).toBe(200);
		expect(Buffer.from(await img.arrayBuffer()).equals(REPORTED_PNG)).toBe(true);
		// 面板被告知去重取订阅列表;没发 config-changed "subscriptions"(那会重建路由、惊动引擎与拓展)。
		await vi.waitFor(() => expect(heard.profiles).toEqual([[SUB.id]]));
		expect(heard.config).not.toContain("subscriptions");
	});

	it("同一张头像再报一次:地址不变,文件不重写;看得见的都没变,不打扰面板", async () => {
		const before = await profile();
		const inode = (await stat(avatarFile())).ino;

		await press("profile.sameAvatar");
		const after = await refreshedAfter(before);

		expect(after?.avatar).toBe(before?.avatar);
		expect((await stat(avatarFile())).ino).toBe(inode);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(heard.profiles).toEqual([]);
	});

	it("停用了、只报名字:照样更新,粉丝与头像不动", async () => {
		const off = await api(`/api/subs/${SUB.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		});
		expect(off.status, await off.clone().text()).toBe(200);
		const before = await profile();

		await press("profile.nameOnly");
		const after = await refreshedAfter(before);

		expect(after?.name).toBe("只改了名字");
		expect(after?.fans).toBe(4321);
		expect(after?.avatar).toBe(before?.avatar);
	});

	it("换一张头像:覆盖,地址的 ?v= 变了,取回来的是新的那张", async () => {
		const before = await profile();

		await press("profile.nextAvatar");
		const after = await refreshedAfter(before);

		expect(after?.avatar).not.toBe(before?.avatar);
		const img = await api(after?.avatar ?? "");
		expect(Buffer.from(await img.arrayBuffer()).equals(NEXT_PNG)).toBe(true);
	});
});
