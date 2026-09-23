/**
 * 🔴 **订阅源的五种上报,在真 BN 上是接着的**(ADR-0019 决策 7 / 57 / 62)。
 *
 * 拓展经 `handle.report*` 报「那个人怎么了」,宿主核过形状、按 `(这个拓展, 外部 id)` 找出它名下所有
 * 指向这个人的订阅,发到 bus 上的 `subscription-reported` —— 后面出卡、存资料、首页在播都从那里接。
 * 中间要过三处:ctx 的分发(对订阅、按开关筛)、装载器递过去的回调、`index.ts` 把回调接到 bus 上。
 * 任意一处漏接,拓展那头照样 resolve、类型与单元测试全绿,症状是作品一条都推不出去、而没人报错。
 *
 * 所以装一个真的 v2 小拓展进装载根、起一台真 BN:面板按它的动作钮,动作里真调五个方法;bus 在这里
 * 只**旁听**(包一层真的那个,不换掉它)。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubscriptionReportDelivery } from "@bilibili-notify/internal";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { type StandaloneServerHandle, startStandaloneServer } from "../index.js";
import { makeExtensionSubscription } from "./support/extension-subscription.js";

/** bus 上收到的每一条 `subscription-reported`。 */
const heard = vi.hoisted(() => [] as SubscriptionReportDelivery[]);

vi.mock("../runtime/message-bus.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../runtime/message-bus.js")>();
	return {
		...real,
		createNodeMessageBus: () => {
			const bus = real.createNodeMessageBus();
			bus.on("subscription-reported", (delivery) => {
				heard.push(delivery);
			});
			return bus;
		},
	};
});

const FIXTURE_ID = "report-probe";
/** 别的拓展名下、指向同一个外部 id 的一条 —— 身份是 `(拓展, 外部 id)`,它不该被分到。 */
const OTHER_ID = "other-source";
const SHARED = "douyin-shared";

/** 同一个人的两条开着的订阅(比如推给两组群)。 */
const ON_A = makeExtensionSubscription({
	id: "b0000000-0000-4000-8000-000000000001",
	extensionId: FIXTURE_ID,
	externalId: SHARED,
	enabled: true,
});
const ON_B = makeExtensionSubscription({
	id: "b0000000-0000-4000-8000-000000000002",
	extensionId: FIXTURE_ID,
	externalId: SHARED,
	enabled: true,
});
/** 同一个人、停用的那条。 */
const OFF = makeExtensionSubscription({
	id: "b0000000-0000-4000-8000-000000000003",
	extensionId: FIXTURE_ID,
	externalId: SHARED,
	enabled: false,
});
const FOREIGN = makeExtensionSubscription({
	id: "b0000000-0000-4000-8000-000000000004",
	extensionId: OTHER_ID,
	externalId: SHARED,
	enabled: true,
});

/**
 * 清单只声明了作品与开播:下播没声明(报了要被拒),直播状态因为声明了开播而收。每个动作真调一次
 * `handle.report*`,把它的 Promise 原样交回 —— 拒掉的原因就是面板那头收到的原话。
 */
const FIXTURE_CODE = `
const T = Date.UTC(2026, 8, 23, 12);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const LIVE = { url: "https://live.douyin.com/1", startedAt: T, title: "直播" };
export function activate(ctx) {
	const handle = ctx.registerSubscriptionSource({ lookup: () => [] });
	ctx.onAction("report.post", () =>
		handle.reportPost(${JSON.stringify(SHARED)}, {
			id: "p1",
			url: "https://www.douyin.com/video/p1",
			publishedAt: T,
			text: "新作品",
			images: [PNG, SVG],
		}),
	);
	ctx.onAction("report.liveStart", () => handle.reportLiveStart(${JSON.stringify(SHARED)}, LIVE));
	ctx.onAction("report.liveEnd", () => handle.reportLiveEnd(${JSON.stringify(SHARED)}, LIVE));
	ctx.onAction("report.liveStatus", () =>
		handle.reportLiveStatus(${JSON.stringify(SHARED)}, { live: true, viewers: 3 }),
	);
	ctx.onAction("report.profile", () =>
		handle.reportProfile(${JSON.stringify(SHARED)}, { name: "新名字", fans: 10 }),
	);
	ctx.onAction("report.forget", () => {
		// 不接这个 Promise(拓展作者常这么写):BN 拒掉它,也不许变成 unhandledRejection。
		handle.reportLiveEnd(${JSON.stringify(SHARED)}, LIVE);
	});
	ctx.onAction("report.stranger", () =>
		handle.reportPost("not-mine", { id: "p2", url: "https://www.douyin.com/video/p2", publishedAt: T }),
	);
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

describe("订阅源上报 e2e:拓展报的,经 ctx 与 index.ts 的接线到了 bus 上", () => {
	let dataDir: string;
	let handle: StandaloneServerHandle | undefined;
	let port: number;

	function boot(at: number): Promise<StandaloneServerHandle> {
		return startStandaloneServer({
			argv: [
				"--host",
				"127.0.0.1",
				"--port",
				String(at),
				"--data-dir",
				dataDir,
				"--log-level",
				"silent",
			],
			env: { BN_CONFIG_DISABLED: "1", BN_ALLOW_NO_AUTH: "1" },
			shutdownTimeoutMs: 1_000,
		});
	}

	/** 同 `subscription-source-e2e`:先空启动一趟拿到完整的 globals,再摆拓展、开开关、写订阅。 */
	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-sub-report-e2e-"));
		const seed = await boot(await findFreePort());
		await seed.close("seed");

		const globalsPath = join(dataDir, "state", "globals.json");
		const globals = JSON.parse(await readFile(globalsPath, "utf8")) as Record<string, unknown>;
		globals.extensions = { [FIXTURE_ID]: { enabled: true } };
		await writeFile(globalsPath, JSON.stringify(globals));

		const extDir = join(dataDir, "extensions", FIXTURE_ID);
		await mkdir(extDir, { recursive: true });
		await writeFile(
			join(extDir, "extension.json"),
			JSON.stringify({
				id: FIXTURE_ID,
				name: "上报探针",
				description: "按一下动作钮报一条",
				version: "0.1.0",
				apiVersion: 2,
				actions: [
					"report.post",
					"report.liveStart",
					"report.liveEnd",
					"report.liveStatus",
					"report.profile",
					"report.forget",
					"report.stranger",
				],
				contributes: {
					subscription: {
						display: { label: "探针", shortLabel: "探", color: "#3366ff" },
						events: ["post", "liveStart"],
					},
				},
			}),
		);
		await writeFile(join(extDir, "index.mjs"), FIXTURE_CODE);

		await writeFile(
			join(dataDir, "state", "extension-subscriptions.json"),
			JSON.stringify([ON_A, ON_B, OFF, FOREIGN]),
		);

		port = await findFreePort();
		handle = await boot(port);
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		heard.length = 0;
	});

	/** 面板按一下那个动作钮:回状态码与原话。 */
	async function press(action: string): Promise<{ status: number; err?: string }> {
		const res = await fetch(`http://127.0.0.1:${port}/api/ext/${FIXTURE_ID}/actions/${action}`, {
			method: "POST",
		});
		const body = (await res.json()) as { ok: boolean; err?: string };
		return { status: res.status, err: body.err };
	}

	const ids = (delivery: SubscriptionReportDelivery | undefined) =>
		[...(delivery?.subscriptionIds ?? [])].sort();

	it("作品:同一个人的两条开着的订阅都收到,停用的与别的拓展那条收不到;解不开的那张图丢了", async () => {
		expect(await press("report.post")).toEqual({ status: 200 });
		expect(heard).toHaveLength(1);
		const [delivery] = heard;
		expect(delivery?.extensionId).toBe(FIXTURE_ID);
		expect(delivery?.externalId).toBe(SHARED);
		expect(ids(delivery)).toEqual([ON_A.id, ON_B.id]);
		expect(delivery?.report.kind).toBe("post");
		if (delivery?.report.kind !== "post") return;
		expect(delivery.report.value.text).toBe("新作品");
		// 报了两张:PNG 收下、SVG 丢掉 —— 丢一张不连坐整条。
		expect(delivery.report.value.images).toHaveLength(1);
		expect(delivery.report.value.images?.[0]).toBeInstanceOf(Uint8Array);
	});

	it("开播:声明过,照样只发开着的那两条", async () => {
		expect(await press("report.liveStart")).toEqual({ status: 200 });
		expect(heard.map((d) => d.report.kind)).toEqual(["liveStart"]);
		expect(ids(heard[0])).toEqual([ON_A.id, ON_B.id]);
	});

	it("直播状态:清单声明了开播就收;停用的不进(它也不进首页在播)", async () => {
		expect(await press("report.liveStatus")).toEqual({ status: 200 });
		expect(heard.map((d) => d.report)).toEqual([
			{ kind: "liveStatus", value: { live: true, viewers: 3 } },
		]);
		expect(ids(heard[0])).toEqual([ON_A.id, ON_B.id]);
	});

	it("资料更新:停用的那条也收到(它照样该有名字),别的拓展那条仍收不到", async () => {
		expect(await press("report.profile")).toEqual({ status: 200 });
		expect(heard.map((d) => d.report)).toEqual([
			{ kind: "profile", value: { name: "新名字", fans: 10 } },
		]);
		expect(ids(heard[0])).toEqual([ON_A.id, ON_B.id, OFF.id]);
	});

	it("清单没声明的种类(下播):整条拒,拓展拿到的错带着原因;bus 上什么都没有", async () => {
		const { status, err } = await press("report.liveEnd");
		expect(status).toBe(500);
		expect(err).toContain("liveEnd");
		expect(err).toContain("没声明");
		expect(heard).toEqual([]);
	});

	it("拓展不接 report* 的 Promise、BN 又拒了它:不变成 unhandledRejection(独立端会因此关掉整个进程)", async () => {
		expect(await press("report.forget")).toEqual({ status: 200 });
		// 给那个 reject 一拍落定 —— 没人接的话,vitest 在这里报 Unhandled Rejection、整个文件红。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(heard).toEqual([]);
		expect(await press("report.profile")).toEqual({ status: 200 });
	});

	it("不在自己名下的外部 id:正常 resolve,不发", async () => {
		expect(await press("report.stranger")).toEqual({ status: 200 });
		expect(heard).toEqual([]);
	});
});
