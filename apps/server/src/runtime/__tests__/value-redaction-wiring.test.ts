import { fixedTimezone } from "../../__tests__/support/integration-io.js";
/**
 * **真装配里,日志出口按集成存下的值与 B 站罐子里的 cookie 打码**(接线守卫)。
 *
 * 登记册、存储宿主、日志出口、罐子各有各的单测,可证明不了它们在真装配里用的是同一份登记册:
 * 少接一处的症状是一切照常、只有日志里露出明文,门禁全绿(38-e 删掉按名字的正则之后,`SESSDATA` 就是明文)。
 * 所以这里走真的 `createAppRuntime`,再用运行时自己的存储宿主和日志器造真的 B 站上下文:
 * 一条 cookie 进罐、打一条日志,日志钩子(环形缓冲 / 归档用的那个)里看不到明文。
 * 值都是一眼看得出的假值。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { inertSettingsOf } from "../../__tests__/support/inert-settings.js";
import { inertTransitImages } from "../../__tests__/support/integration-io.js";
import { Api } from "../../bilibili/api/index.js";
import { createBiliContext } from "../../bilibili/context.js";
import { settingsSegment } from "../../bilibili/settings.js";
import { BootstrapConfigSchema } from "../../config/schema.js";
import type { LogEntry } from "../../ws/types.js";
import { type AppRuntime, createAppRuntime } from "../bootstrap.js";

let dataDir: string;
let runtime: AppRuntime;
let seen: LogEntry[];

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-value-redaction-wiring-"));
	runtime = createAppRuntime(
		BootstrapConfigSchema.parse({ dataDir, logLevel: "info" }),
		{ dataRoot: dataDir },
		{ integrationSettings: [settingsSegment] },
	);
	seen = [];
	runtime.serviceCtx.setLogHook((entry) => seen.push(entry));
});
afterEach(async () => {
	await runtime.dispose();
	await rm(dataDir, { recursive: true, force: true });
});

/** 开机时运行时自己也会打几行(生成密钥之类),按内容找,不按下标。 */
const msgs = () => seen.map((entry) => entry.msg);

describe("createAppRuntime 里的按值打码", () => {
	it("集成 secrets 里存下的值,经运行时的日志器打出来被遮;关了把手之后不再遮", async () => {
		const handle = await runtime.integrationStore.open("douyin");
		await handle.secrets.set("token", "FAKE-WIRING-SECRET-1");

		runtime.serviceCtx.logger.info("拿到了 FAKE-WIRING-SECRET-1", {
			nested: "FAKE-WIRING-SECRET-1",
		});
		expect(JSON.stringify(seen)).not.toContain("FAKE-WIRING-SECRET-1");
		expect(msgs()).toContain("拿到了 ***");

		handle.close();
		runtime.serviceCtx.logger.info("关了之后 FAKE-WIRING-SECRET-1");
		expect(msgs()).toContain("关了之后 FAKE-WIRING-SECRET-1");
	});

	it("真的 B 站上下文:一条 cookie 进罐,经运行时的日志器打出来被遮(罐子与日志出口用的是同一份登记册)", async () => {
		const biliContext = await createBiliContext({
			timezoneReader: fixedTimezone("Asia/Shanghai"),
			transitImages: inertTransitImages,
			stores: runtime.integrationStore,
			serviceCtx: runtime.serviceCtx,
			problems: runtime.problems,
			settingsOf: inertSettingsOf,
		});
		biliContext.ctx.cookies.jar.load([
			{ key: "SESSDATA", value: "FAKE-WIRING-COOKIE-1", domain: "bilibili.com", path: "/" },
			{ key: "DedeUserID", value: "123456789", domain: "bilibili.com", path: "/" },
		]);

		// 核心里不再写死 `SESSDATA=` 这个名字:带着名字打出来的 cookie 也是靠登记的值遮的。
		runtime.serviceCtx.logger.info("jar SESSDATA=FAKE-WIRING-COOKIE-1", {
			cookie: "FAKE-WIRING-COOKIE-1",
			mid: 123456789,
		});
		const row = seen.find((entry) => entry.msg.startsWith("jar "));
		expect(row?.msg).toBe("jar SESSDATA=***");
		expect(JSON.stringify(row?.args)).not.toContain("FAKE-WIRING-COOKIE-1");
		// 登录账号自己的 uid:字符串形态按子串遮,数字形态的参数按整值遮。
		expect(row?.args).toEqual([{ cookie: "***", mid: "***" }]);

		await biliContext.dispose();
		runtime.serviceCtx.logger.info("撤掉之后 FAKE-WIRING-COOKIE-1");
		expect(msgs()).toContain("撤掉之后 FAKE-WIRING-COOKIE-1");
	});

	it("续期 / 扫码拿到的新令牌:存进 secrets 之前的那一刻,经运行时的日志器打出来也被遮(不靠按名字的正则)", async () => {
		const biliContext = await createBiliContext({
			timezoneReader: fixedTimezone("Asia/Shanghai"),
			transitImages: inertTransitImages,
			stores: runtime.integrationStore,
			serviceCtx: runtime.serviceCtx,
			problems: runtime.problems,
			settingsOf: inertSettingsOf,
		});
		const api = new Api({ serviceCtx: runtime.serviceCtx, ctx: biliContext.ctx });
		// 落盘那一刻(令牌还没进 secrets)正好有一行日志带着它 —— 就是审查员说的"存盘前的空档"。
		const realCommit = biliContext.ctx.cookies.commit.bind(biliContext.ctx.cookies);
		vi.spyOn(biliContext.ctx.cookies, "commit").mockImplementation(async (ops) => {
			runtime.serviceCtx.logger.error(`存盘时出事 refresh_token=${NEW_TOKEN}`);
			return realCommit(ops);
		});

		await api.commitScannedLogin(NEW_TOKEN);

		const row = seen.find((entry) => entry.msg.startsWith("存盘时出事"));
		expect(row?.msg).toBe("存盘时出事 refresh_token=***");
		expect(JSON.stringify(seen)).not.toContain(NEW_TOKEN);
		api.stop();
		await biliContext.dispose();
	});

	// 验红:去掉 `createAppRuntime` 里按标记登记引导配置那一句,这条红。
	it("引导配置里的面板密码与口令:建运行时那一刻就登记,日志里遮;chromeEndpoint 不登记、照显", async () => {
		const withSecrets = createAppRuntime(
			BootstrapConfigSchema.parse({
				dataDir,
				logLevel: "info",
				auth: { basicAuth: { username: "FAKE-user-name", password: "FAKE-dashboard-pass" } },
				cookieEncryptionKey: "FAKE-cookie-passphrase",
				chromeEndpoint: "ws://FAKE-chrome-host:9222",
			}),
			{ dataRoot: dataDir },
			{ integrationSettings: [settingsSegment] },
		);
		try {
			const lines: LogEntry[] = [];
			withSecrets.serviceCtx.setLogHook((entry) => lines.push(entry));
			withSecrets.serviceCtx.logger.info(
				"pass=FAKE-dashboard-pass key=FAKE-cookie-passphrase user=FAKE-user-name endpoint=ws://FAKE-chrome-host:9222",
			);
			const row = lines.find((entry) => entry.msg.startsWith("pass="));
			expect(row?.msg).toBe(
				"pass=*** key=*** user=FAKE-user-name endpoint=ws://FAKE-chrome-host:9222",
			);
		} finally {
			await withSecrets.dispose();
		}
	});
});

const NEW_TOKEN = "FAKE-WIRING-NEW-REFRESH-0001";
