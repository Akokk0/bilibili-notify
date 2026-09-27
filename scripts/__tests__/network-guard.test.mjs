import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { assertNoBlockedConnections, networkGuard } from "../network-guard.mjs";

/**
 * 测试拦外网:整个 vitest 运行里,连向非本机地址的连接一律被拦下,报错点名目标;
 * 被测代码把报错吞掉了,那条测试也照样失败。
 * 探针目标用 RFC 2606 的 `.invalid` 域名 —— 没装守卫时它只会 DNS 失败,不会真连到谁。
 */

const PROBE_HOST = "bn-guard-probe.invalid";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** fetch 的失败包在 `TypeError: fetch failed` 里,真正的原因在 cause。 */
async function failureOf(promise) {
	const err = await promise.then(
		() => {
			throw new Error("预期被拦下,结果连上了");
		},
		(e) => e,
	);
	return err.cause ?? err;
}

/** 等一个发 'error' 的东西(socket / 请求)报错。 */
function errorOf(emitter) {
	return new Promise((resolve, reject) => {
		emitter.once("error", resolve);
		emitter.once("connect", () => reject(new Error("预期被拦下,结果连上了")));
		emitter.once("response", () => reject(new Error("预期被拦下,结果连上了")));
	});
}

/** 被拦的连接都要进账本;这里核对完顺手清账,免得查账钩子把故意去连的测试判失败。 */
function expectLedger(...targets) {
	expect(
		networkGuard()
			.drain()
			.map((b) => b.target),
	).toEqual(targets);
}

describe("测试拦外网", () => {
	it("fetch 连外网被拦下,报错点名目标地址", async () => {
		const cause = await failureOf(fetch(`http://${PROBE_HOST}/`));
		expect(cause.code).toBe("BN_TEST_NETWORK_BLOCKED");
		expect(cause.message).toContain(`${PROBE_HOST}:80`);
		expectLedger(`${PROBE_HOST}:80`);
	});

	it.each([
		["net.connect(port, host)", () => net.connect(7, PROBE_HOST), `${PROBE_HOST}:7`],
		[
			"net.connect({ host, port })",
			() => net.connect({ host: PROBE_HOST, port: 7 }),
			`${PROBE_HOST}:7`,
		],
		["http.get", () => http.get(`http://${PROBE_HOST}/`), `${PROBE_HOST}:80`],
		["https.get", () => https.get(`https://${PROBE_HOST}/`), `${PROBE_HOST}:443`],
		["外网 IP", () => net.connect(7, "192.0.2.1"), "192.0.2.1:7"],
	])("%s 连外网被拦下", async (_name, open, target) => {
		const err = await errorOf(open());
		expect(err.code).toBe("BN_TEST_NETWORK_BLOCKED");
		expect(err.message).toContain(target);
		expectLedger(target);
	});

	describe("本机照常放行", () => {
		let server;
		let port;

		beforeEach(async () => {
			// 不指定 host 就监听在全部地址上,address() 报的是 `::`。
			server = http.createServer((_req, res) => res.end("ok"));
			await new Promise((resolve) => server.listen(0, resolve));
			port = server.address().port;
		});

		afterEach(() => new Promise((resolve) => server.close(resolve)));

		it.each(["127.0.0.1", "localhost", "[::1]"])("fetch http://%s", async (host) => {
			const res = await fetch(`http://${host}:${port}/`);
			expect(await res.text()).toBe("ok");
		});

		it("按 address() 报的 `::` 去连", async () => {
			const address = server.address().address;
			expect(address).toBe("::");
			const res = await fetch(`http://[${address}]:${port}/`);
			expect(await res.text()).toBe("ok");
		});

		it("net.connect(port) 缺省主机", async () => {
			const socket = net.connect(port);
			await new Promise((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			socket.destroy();
		});
	});
});

describe("吞掉报错也算失败", () => {
	it("被吞掉的连接留在账本里,带着发起处的调用栈", () => {
		net.connect(7, PROBE_HOST).on("error", () => {});
		const [entry, ...rest] = networkGuard().drain();
		expect(rest).toEqual([]);
		expect(entry.target).toBe(`${PROBE_HOST}:7`);
		expect(entry.stack).toContain("network-guard.test.mjs");
	});

	it("查账:账本是空的就放过,有账就抛错,点名目标与发起处", () => {
		expect(() => assertNoBlockedConnections([])).not.toThrow();
		const blocked = [
			{
				target: "a.invalid:443",
				stack:
					"Error\n    at guardedConnect (node:net:1:1)\n    at load (/repo/src/fetch-feed.ts:12:3)",
			},
		];
		expect(() => assertNoBlockedConnections(blocked)).toThrow(
			/a\.invalid:443[\s\S]*fetch-feed\.ts:12:3/,
		);
	});

	// 真起一次 vitest 跑夹具,钉的是「根配置 → setupFiles → 收尾查账」这整条线。
	it("接线:被测代码吞掉了被拦的报错,测试照样判失败", () => {
		const outDir = mkdtempSync(join(tmpdir(), "bn-network-guard-"));
		try {
			const outputFile = join(outDir, "report.json");
			const env = Object.fromEntries(
				Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")),
			);
			const run = spawnSync(
				"vp",
				[
					"test",
					"--config",
					"scripts/__tests__/fixtures/network-guard/vite.config.mjs",
					"--reporter",
					"json",
					"--outputFile",
					outputFile,
				],
				{ cwd: REPO_ROOT, encoding: "utf8", env },
			);
			expect(run.status, run.stderr).toBe(1);
			const report = JSON.parse(readFileSync(outputFile, "utf8"));
			const testNamed = (title) =>
				report.testResults.flatMap((f) => f.assertionResults).find((a) => a.title === title);
			const swallowed = testNamed("吞掉外网报错");
			expect(swallowed.status).toBe("failed");
			expect(swallowed.failureMessages.join("\n")).toContain(`${PROBE_HOST}:80`);
			expect(testNamed("之后的测试不受牵连").status).toBe("passed");
			const afterAllFile = report.testResults.find((f) => f.name.endsWith("after-all.fixture.mjs"));
			expect(afterAllFile.status).toBe("failed");
			expect(afterAllFile.message).toContain(`${PROBE_HOST}:80`);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 60_000);
});
