/**
 * 🔴 **B 站场景经登记表进来之后,入口接的 Proxy 仍是路由拿到的那一份。**
 *
 * 零件(登记表、B 站场景、`overridableApi`)各自的测试全绿,证明不了 `compose.ts` 真把 B 站 devtools 建的开发壳钩子
 * 递给了来源,让**同一个**套了壳的登录口既被 B 站那组场景盖方法、又被来源挂上让路由去读 —— 接线剪断哪一头,场景「跑成功了」
 * 而面板顶栏纹丝不动,没有任何别的门禁会红。所以这条起一台真 BN,从「面板按钮」一路按到
 * `GET /api/sources/bilibili/auth`,断言落在 `state.status` 上。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevStatusDTO } from "@bilibili-notify/contract";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
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

	async function loginStatus(): Promise<string> {
		const res = await fetch(`${base}/api/sources/bilibili/auth`);
		expect(res.status).toBe(200);
		return ((await res.json()) as { state: { status: string } }).state.status;
	}

	// 验红:`bilibili/source.ts` 里 `Source.auth` 不挂登录口(`auth: shellAuth` 去掉),这条红 —— 回的是 400 unsupported,
	// 而各零件的测试一条都不红。
	it("真入口起来之后,GET /api/sources/bilibili/auth 回 200 与一个合法的状态", async () => {
		const res = await fetch(`${base}/api/sources/bilibili/auth`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { state: { status: string } };
		expect([
			"logged-out",
			"confirming",
			"awaiting-scan",
			"logged-in",
			"expired",
			"error",
		]).toContain(body.state.status);
	});

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
		expect(real).not.toBe("logged-in");

		const run = await fetch(`${base}/api/dev/run/bilibili.auth.login-state`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ params: { status: "logged-in" } }),
		});
		expect(run.status).toBe(200);
		const body = (await run.json()) as { active: { scenarioId: string }[] };
		expect(body.active.map((a) => a.scenarioId)).toContain("bilibili.auth.login-state");
		expect(await loginStatus()).toBe("logged-in");

		const reset = await fetch(`${base}/api/dev/reset/bilibili.auth.login-state`, {
			method: "POST",
		});
		expect(reset.status).toBe(200);
		expect(await loginStatus()).toBe(real);
	});
});
