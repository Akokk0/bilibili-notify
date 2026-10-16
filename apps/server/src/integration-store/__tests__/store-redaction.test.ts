/**
 * 集成存储宿主给日志打码登记册喂值:`secrets` 里每一段字符串(递归走 JSON)、不管它是怎么进来的
 * (开把手时读进来的、写进去的、恢复备份整袋换进来的),都登记;换走的旧值不再遮;把手关了清掉。
 * 用真的存储宿主与临时数据根。值都是一眼看得出的假值。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@bilibili-notify/internal";
import { createKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { dataPath } from "../../runtime/roots.js";
import { createIntegrationStore } from "../store.js";

let dataRoot: string;

const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function setup() {
	const keyProvider = createKeyProvider({
		keyPath: dataPath(dataRoot, "secrets", "master.key"),
		saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
		logger,
	});
	const redactor = createValueRedactor();
	const store = createIntegrationStore({ dataRoot, keyProvider, logger, redactor });
	return { store, redactor };
}

beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), "bn-store-redaction-"));
});
afterEach(async () => {
	await rm(dataRoot, { recursive: true, force: true });
});

describe("集成存储宿主 · 登记要打码的值", () => {
	it("secrets.set 之后,值(含嵌套里的字符串)被遮;state 里的不遮", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		await handle.secrets.set("token", "FAKE-TOKEN-AAAA");
		await handle.secrets.set("nested", { list: [{ key: "FAKE-NESTED-BBBB" }], n: 12345678 });
		await handle.state.set("note", "FAKE-STATE-CCCC");
		expect(redactor.scrub("FAKE-TOKEN-AAAA FAKE-NESTED-BBBB FAKE-STATE-CCCC 12345678")).toBe(
			"*** *** FAKE-STATE-CCCC 12345678",
		);
	});

	it("batch 一次写几个、宿主那一面(http. 键)写的字符串也登记", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("bilibili");
		await handle.secrets.batch([
			{ kind: "set", key: "a", value: "FAKE-BATCH-AAAA" },
			{ kind: "set", key: "b", value: "FAKE-BATCH-BBBB" },
		]);
		await handle.hostSecrets.set("http.other", "FAKE-HOST-CCCCC");
		expect(redactor.scrub("FAKE-BATCH-AAAA FAKE-BATCH-BBBB FAKE-HOST-CCCCC")).toBe("*** *** ***");
	});

	it("开把手时盘上已有的值:重开一份把手,读进来的当场登记", async () => {
		const first = setup();
		const handle = await first.store.open("douyin");
		await handle.secrets.set("token", "FAKE-ON-DISK-AAAA");
		handle.close();

		const second = setup();
		expect(second.redactor.scrub("FAKE-ON-DISK-AAAA")).toBe("FAKE-ON-DISK-AAAA");
		await second.store.open("douyin");
		expect(second.redactor.scrub("FAKE-ON-DISK-AAAA")).toBe("***");
	});

	it("少于 8 个字符的值不遮", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		await handle.secrets.set("short", "abc1234");
		expect(redactor.scrub("abc1234")).toBe("abc1234");
	});

	it("覆盖写:旧值不再遮,新值遮;删掉键:值不再遮", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		await handle.secrets.set("token", "FAKE-OLD-VALUE-1");
		await handle.secrets.set("token", "FAKE-NEW-VALUE-2");
		expect(redactor.scrub("FAKE-OLD-VALUE-1 FAKE-NEW-VALUE-2")).toBe("FAKE-OLD-VALUE-1 ***");
		await handle.secrets.delete("token");
		expect(redactor.scrub("FAKE-NEW-VALUE-2")).toBe("FAKE-NEW-VALUE-2");
	});

	it("写失败(超限额)的值不登记:没存进去的不算在册", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		const tooBig = "FAKE-TOO-BIG-".padEnd(300 * 1024, "x");
		const result = await handle.secrets.set("big", tooBig);
		expect(result.ok).toBe(false);
		expect(redactor.scrub("FAKE-TOO-BIG-")).toBe("FAKE-TOO-BIG-");
	});

	it("恢复备份整袋换:换进来的登记,换走的旧值不再遮", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		await handle.secrets.set("token", "FAKE-BEFORE-RESTORE");
		const restored = await store.restoreSecrets("douyin", { token: "FAKE-AFTER-RESTORE" });
		expect(restored.ok).toBe(true);
		expect(redactor.scrub("FAKE-BEFORE-RESTORE FAKE-AFTER-RESTORE")).toBe(
			"FAKE-BEFORE-RESTORE ***",
		);
	});

	it("把手关了:这个集成的值撤掉;关之前已排上的写落完也不再登记", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		await handle.secrets.set("token", "FAKE-CLOSING-AAAA");
		const late = handle.secrets.set("late", "FAKE-LATE-WRITE-1");
		handle.close();
		await late;
		expect(redactor.scrub("FAKE-CLOSING-AAAA FAKE-LATE-WRITE-1")).toBe(
			"FAKE-CLOSING-AAAA FAKE-LATE-WRITE-1",
		);
	});

	it("handle.redact:按种类整批登记在这个把手的集成名下;同一种整批换,别的种类与 secrets 的不受影响", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		await handle.secrets.set("token", "FAKE-SECRETS-AAAA");
		handle.redact("cookies", ["FAKE-COOKIE-AAAA", "FAKE-COOKIE-BBBB"]);
		handle.redact("redact", ["FAKE-OTHER-AAAAA"]);
		expect(
			redactor.scrub("FAKE-SECRETS-AAAA FAKE-COOKIE-AAAA FAKE-COOKIE-BBBB FAKE-OTHER-AAAAA"),
		).toBe("*** *** *** ***");
		handle.redact("cookies", ["FAKE-COOKIE-CCCC"]);
		expect(
			redactor.scrub("FAKE-SECRETS-AAAA FAKE-COOKIE-AAAA FAKE-COOKIE-CCCC FAKE-OTHER-AAAAA"),
		).toBe("*** FAKE-COOKIE-AAAA *** ***");
		handle.redact("cookies", []);
		expect(redactor.scrub("FAKE-COOKIE-CCCC")).toBe("FAKE-COOKIE-CCCC");
	});

	it("handle.redact:归属就是把手的集成 —— 关一个把手撤它所有种类的值,不动别的集成", async () => {
		const { store, redactor } = setup();
		const a = await store.open("douyin");
		const b = await store.open("kuaishou");
		a.redact("cookies", ["FAKE-A-COOKIE-1111"]);
		a.redact("redact", ["FAKE-A-OTHER-22222"]);
		b.redact("cookies", ["FAKE-B-COOKIE-3333"]);
		a.close();
		expect(redactor.scrub("FAKE-A-COOKIE-1111 FAKE-A-OTHER-22222 FAKE-B-COOKIE-3333")).toBe(
			"FAKE-A-COOKIE-1111 FAKE-A-OTHER-22222 ***",
		);
	});

	it("handle.redact:把手关了之后再登记的不收", async () => {
		const { store, redactor } = setup();
		const handle = await store.open("douyin");
		handle.close();
		handle.redact("cookies", ["FAKE-LATE-COOKIE-1"]);
		expect(redactor.scrub("FAKE-LATE-COOKIE-1")).toBe("FAKE-LATE-COOKIE-1");
	});

	it("两个集成各登记各的;一个关了不撤另一个的", async () => {
		const { store, redactor } = setup();
		const a = await store.open("douyin");
		const b = await store.open("kuaishou");
		await a.secrets.set("t", "FAKE-OWNER-A-AAAA");
		await b.secrets.set("t", "FAKE-OWNER-B-BBBB");
		a.close();
		expect(redactor.scrub("FAKE-OWNER-A-AAAA FAKE-OWNER-B-BBBB")).toBe("FAKE-OWNER-A-AAAA ***");
	});
});
