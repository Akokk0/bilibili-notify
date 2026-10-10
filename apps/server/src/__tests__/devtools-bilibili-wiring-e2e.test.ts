/**
 * 🔴 **B 站场景经登记表进来之后,入口接的 Proxy 仍是路由拿到的那一份。**
 *
 * 零件(登记表、B 站场景、`overridableApi`)各自的测试全绿,证明不了 `src/index.ts` 真把**同一个**
 * 套了壳的登录系统既交给 B 站那组场景去盖方法、又交给路由去读 —— 接线剪断哪一头,场景「跑成功了」
 * 而面板顶栏纹丝不动,没有任何别的门禁会红。所以这条起一台真 BN,从「面板按钮」一路按到
 * `GET /api/auth/status`。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevStatusDTO } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { BiliLoginStatus } from "../bilibili/api/index.js";
import { type ServerHandle, startServer } from "../index.js";

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

describe("devtools 的 B 站场景 → 真入口接的 Proxy", () => {
	let dataDir: string;
	let handle: ServerHandle;
	let base: string;

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "bn-devtools-bili-wiring-"));
		const port = await findFreePort();
		base = `http://127.0.0.1:${port}`;
		handle = await startServer({
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
		});
	});

	afterAll(async () => {
		await handle?.close("test cleanup").catch(() => {});
		await rm(dataDir, { recursive: true, force: true });
	});

	async function loginStatus(): Promise<number> {
		const res = await fetch(`${base}/api/auth/status`);
		expect(res.status).toBe(200);
		return ((await res.json()) as { status: number }).status;
	}

	it("B 站的场景在面板的表里,id 带 bilibili. 前缀,没有不带前缀的那份", async () => {
		const res = await fetch(`${base}/api/dev`);
		expect(res.status).toBe(200);
		const ids = ((await res.json()) as DevStatusDTO).scenarios.map((s) => s.id);
		expect(ids).toContain("bilibili.auth.login-state");
		expect(ids).toContain("bilibili.live.start");
		expect(ids).not.toContain("auth.login-state");
		expect(ids).not.toContain("live.start");
	});

	it("跑 bilibili.auth.login-state → 路由读到的登录状态换了;收摊回真", async () => {
		const real = await loginStatus();
		expect(real).not.toBe(BiliLoginStatus.LOGGED_IN);

		const run = await fetch(`${base}/api/dev/run/bilibili.auth.login-state`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ params: { status: "logged-in" } }),
		});
		expect(run.status).toBe(200);
		const body = (await run.json()) as { active: { scenarioId: string }[] };
		expect(body.active.map((a) => a.scenarioId)).toContain("bilibili.auth.login-state");
		expect(await loginStatus()).toBe(BiliLoginStatus.LOGGED_IN);

		const reset = await fetch(`${base}/api/dev/reset/bilibili.auth.login-state`, {
			method: "POST",
		});
		expect(reset.status).toBe(200);
		expect(await loginStatus()).toBe(real);
	});
});
