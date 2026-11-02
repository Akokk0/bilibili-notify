import { BUILTIN_INTEGRATION_KEYS } from "../../compose.js";
/**
 * 集成的请求那一套(`integrations/http.ts`):身份读升写、罐子自动存与闸、「集成的键 + 罐子」同一次写、恢复后的通知。
 *
 * 落盘用 `memoryKeyValueStores`(包的是真的 `createKeyValueStores`,规矩与生产同一份,只有 `persist` 换成记一笔):
 * `persists` 是每次落盘时那一袋的拷贝,所以「盘上此刻是什么」= 最后一笔(没有就是起始的那袋),
 * 「停在某一步」= `holdNext()` 把那一次落盘按住、「那一步写失败」= `failNext()`。不真杀进程。
 * 定时器用测试自己的假时钟,不碰全局。恢复那一组用真宿主(临时目录)。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_MAJOR_MIN, type CookieJar } from "@bilibili-notify/http";
import type { Disposable, Json, Logger } from "@bilibili-notify/internal";
import { createKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { memoryKeyValueStores } from "../../__tests__/support/memory-key-value-store.js";
import { readIntegrationSecretsFile } from "../../integration-store/files.js";
import {
	createIntegrationStore,
	type IntegrationStoreHandle,
} from "../../integration-store/store.js";
import { createValueRedactor } from "../../logs/value-redactor.js";
import { dataPath } from "../../runtime/roots.js";
import {
	COOKIE_SAVE_DELAY_MS,
	createIntegrationHttp,
	HTTP_COOKIES_KEY,
	HTTP_IDENTITY_KEY,
} from "../http.js";

/** 假时钟:只给 `opts.setTimeout` 用,`advance` 按到点先后依次跑。 */
function makeClock() {
	let now = 0;
	let seq = 0;
	let scheduled = 0;
	const pending = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimeout(fn: () => void, ms: number): Disposable {
			scheduled += 1;
			const id = ++seq;
			pending.set(id, { at: now + ms, fn });
			return {
				dispose() {
					pending.delete(id);
				},
			};
		},
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				let next: [number, { at: number; fn: () => void }] | undefined;
				for (const entry of pending) {
					if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at))
						next = entry;
				}
				if (!next) break;
				pending.delete(next[0]);
				now = next[1].at;
				next[1].fn();
			}
			now = target;
		},
		/** 一共排过几次定时器(含已取消、已跑完的)。 */
		get scheduled() {
			return scheduled;
		},
		get pendingCount() {
			return pending.size;
		},
	};
}

function nth<T>(list: readonly T[], index: number): T {
	const item = list[index];
	if (item === undefined) throw new Error(`第 ${index} 笔落盘不存在(一共 ${list.length} 笔)`);
	return item;
}

/** 让已排上的微任务与落盘走完。 */
async function settle() {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

function silentLogger() {
	const errors: string[] = [];
	const warns: string[] = [];
	const logger: Logger = {
		info: () => {},
		warn: (m) => warns.push(m),
		error: (m) => errors.push(m),
		debug: () => {},
	};
	return { logger, errors, warns };
}

/** 盘上存的 `http.cookies`:`{ 键: 值 }`。 */
function cookieValues(entries: ReadonlyMap<string, Json>): Record<string, string> {
	const raw = entries.get(HTTP_COOKIES_KEY);
	if (typeof raw !== "string") return {};
	return Object.fromEntries(
		(JSON.parse(raw) as Array<{ key: string; value: string }>).map((c) => [c.key, c.value]),
	);
}

const SOURCE = "https://api.bilibili.com/x";

function setCookie(jar: CookieJar, key: string, value: string) {
	jar.setFromSetCookie(`${key}=${value}; Domain=bilibili.com; Path=/`, SOURCE);
}

/** 起始的一对 `(C0, T0)`:`serialize()` 吐回来的就是这个样子。 */
const C0 = JSON.stringify([
	{
		key: "SESSDATA",
		value: "c0",
		expires: "Infinity",
		domain: "bilibili.com",
		path: "/",
		secure: false,
		httpOnly: false,
	},
]);

function world(opts: { secrets?: Record<string, Json>; state?: Record<string, Json> } = {}) {
	const secrets = memoryKeyValueStores("secrets", opts.secrets);
	const state = memoryKeyValueStores("state", opts.state);
	const replacedHooks: Array<() => void | Promise<void>> = [];
	/** 假把手的 `redact` 登记到这一份册子里,归属 `bilibili`(与真把手"归属就是把手的集成"同一个形状)。 */
	const redactor = createValueRedactor();
	const handle: IntegrationStoreHandle = {
		state: state.store,
		secrets: secrets.store,
		hostState: state.stores.host,
		hostSecrets: secrets.stores.host,
		commitSecrets: secrets.stores.commit,
		redact: (kind, values) => redactor.replace("bilibili", kind, values),
		onSecretsReplaced(fn): Disposable {
			replacedHooks.push(fn);
			return { dispose() {} };
		},
		close() {},
	};
	return {
		handle,
		redactor,
		/** 模拟恢复备份:先把袋子里的 `http.cookies` 换成这段,再叫登记过的「密钥被换了」。 */
		async restoreCookies(cookiesJson: string) {
			await secrets.stores.host.set(HTTP_COOKIES_KEY, cookiesJson);
			for (const fn of [...replacedHooks]) await fn();
		},
		secrets,
		state,
		/** 盘上 `secrets` 此刻的整袋:最后一笔落盘,没有就是起始的。 */
		secretsDisk: () => secrets.persists.at(-1) ?? new Map(Object.entries(opts.secrets ?? {})),
		stateDisk: () => state.persists.at(-1) ?? new Map(Object.entries(opts.state ?? {})),
	};
}

async function build(w: ReturnType<typeof world>, extra: { saveDelayMs?: number } = {}) {
	const clock = makeClock();
	const log = silentLogger();
	const http = await createIntegrationHttp({
		stores: w.handle,
		logger: log.logger,
		setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
		...extra,
	});
	return { http, clock, redactor: w.redactor, ...log };
}

const PAIR0: Record<string, Json> = { [HTTP_COOKIES_KEY]: C0, refreshToken: "T0" };

describe("1. 开机装罐不触发存盘", () => {
	it("存着的那段 serialize() 不会原样吐回来(expires 不是 ISO、域名带前导点):装罐不回写", async () => {
		const reformatted = JSON.stringify([
			{
				key: "SESSDATA",
				value: "c0",
				expires: "Wed, 01 Jan 2099 00:00:00 GMT",
				domain: ".bilibili.com",
				path: "/",
			},
		]);
		const w = world({ secrets: { [HTTP_COOKIES_KEY]: reformatted } });
		const { http, clock } = await build(w);
		expect(http.cookies.jar.getValue("SESSDATA")).toBe("c0");
		// 前提:重新序列化出来确实与存着的不一样 —— 不然内容去重会替 `loading` 标志把这条撑绿。
		expect(JSON.stringify(http.cookies.jar.serialize())).not.toBe(reformatted);
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		expect(clock.scheduled).toBe(0);

		// 对照:真的变一下,到点就写了。
		setCookie(http.cookies.jar, "bili_jct", "x");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("存着的不是数组 / 不是合法 JSON:记 error、按空罐起", async () => {
		for (const bad of ["{}", "not json"]) {
			const w = world({ secrets: { [HTTP_COOKIES_KEY]: bad } });
			const { http, errors, clock } = await build(w);
			expect(http.cookies.jar.getValue("SESSDATA")).toBeUndefined();
			expect(errors.join("\n")).toContain("按空罐起");
			clock.advance(60_000);
			await settle();
			expect(w.secrets.persists).toHaveLength(0);
		}
	});

	it("存着的数组里有坏元素([null]):建得起来、罐子是空的、记一条 error", async () => {
		for (const bad of ["[null]", [null] as Json]) {
			const w = world({ secrets: { [HTTP_COOKIES_KEY]: bad } });
			const { http, errors, clock } = await build(w);
			expect(http.cookies.jar.serialize()).toEqual([]);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("按空罐起");
			clock.advance(60_000);
			await settle();
			expect(w.secrets.persists).toHaveLength(0);
		}
	});
});

describe("2. 攒多久", () => {
	it("罐子变了 2 秒内不写,到点写一次", async () => {
		const w = world();
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(COOKIE_SAVE_DELAY_MS - 1);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		clock.advance(1);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
		expect(cookieValues(w.secretsDisk())).toEqual({ a: "1" });
	});

	it("连着三次变化只写一次;不顺延:第 2 秒必写,且带上后来的变化", async () => {
		const w = world();
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(1000);
		setCookie(http.cookies.jar, "b", "2");
		clock.advance(900);
		setCookie(http.cookies.jar, "c", "3");
		clock.advance(99);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		clock.advance(1); // 第一笔变化后整 2000ms
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
		expect(cookieValues(w.secretsDisk())).toEqual({ a: "1", b: "2", c: "3" });
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("saveDelayMs 可调", async () => {
		const w = world();
		const { http, clock } = await build(w, { saveDelayMs: 50 });
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(50);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it('空罐写成删 http.cookies,不存 "[]"', async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		http.cookies.jar.clear();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
		expect(w.secretsDisk().has(HTTP_COOKIES_KEY)).toBe(false);
		expect(w.secretsDisk().get("refreshToken")).toBe("T0");
	});
});

describe("3. 闸", () => {
	it("闸没放:到点不写;放了以后再攒一下才写", async () => {
		const w = world();
		const { http, clock } = await build(w);
		const gate = http.cookies.hold();
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		gate.dispose();
		clock.advance(COOKIE_SAVE_DELAY_MS - 1);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		clock.advance(1);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
		expect(cookieValues(w.secretsDisk())).toEqual({ a: "1" });
	});

	it("闸是在定时器已经排上之后才拿的:到点什么都不做,放闸后才写", async () => {
		const w = world();
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "a", "1"); // 定时器排上
		const gate = http.cookies.hold();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		gate.dispose();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("两道闸放一道不写,全放了才恢复;同一道闸重复放不多减", async () => {
		const w = world();
		const { http, clock } = await build(w);
		const first = http.cookies.hold();
		const second = http.cookies.hold();
		setCookie(http.cookies.jar, "a", "1");
		first.dispose();
		first.dispose(); // 幂等:不能把 holds 减成 0
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		second.dispose();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("放闸时罐子没有变:不起定时器", async () => {
		const w = world();
		const { http, clock } = await build(w);
		http.cookies.hold().dispose();
		expect(clock.scheduled).toBe(0);
	});
});

describe("4. commit:同一次写", () => {
	it("一次落盘里同时有新罐子与 ops(第一笔落盘就两个键都是新值);有闸也写;写完清掉攒着的那一下", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		const gate = http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		const result = await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		expect(result).toEqual({ ok: true });
		expect(w.secrets.persists).toHaveLength(1);
		// 钉「同一次」:第一笔落盘那一刻两个键就同时是新的。
		const first = nth(w.secrets.persists, 0);
		expect(cookieValues(first)).toEqual({ SESSDATA: "c1" });
		expect(first.get("refreshToken")).toBe("T1");
		// 攒着的那一下已清:放闸、推进时间都不再写。
		gate.dispose();
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("没有闸、定时器已排上时 commit:恰好落盘一次", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("ops 里可以删键,罐子空了一起删(登出)", async () => {
		const w = world({ secrets: PAIR0 });
		const { http } = await build(w);
		http.cookies.jar.clear();
		await http.cookies.commit([{ kind: "delete", key: "refreshToken" }]);
		expect(w.secrets.persists).toHaveLength(1);
		expect([...w.secretsDisk().keys()]).toEqual([]);
	});

	it("不动闸:commit 之后闸还在", async () => {
		const w = world();
		const { http, clock } = await build(w);
		http.cookies.hold();
		await http.cookies.commit([{ kind: "set", key: "k", value: 1 }]);
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(1); // 只有 commit 那一笔
	});
});

describe("5. commit 的 ops 带 http. 键", () => {
	it("回 invalid、盘上不变;之后罐子的变化照常能存", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		const result = await http.cookies.commit([
			{ kind: "set", key: "refreshToken", value: "T1" },
			{ kind: "set", key: HTTP_COOKIES_KEY, value: "x" },
		]);
		expect(result).toMatchObject({ ok: false, code: "invalid" });
		expect(w.secrets.persists).toHaveLength(0);
		expect(w.secretsDisk().get("refreshToken")).toBe("T0");
		// 罐子的变化没丢:放一下闸(dirty 还在)就会存。
		http.cookies.hold().dispose();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
		expect(cookieValues(w.secretsDisk())).toEqual({ SESSDATA: "c1" });
	});
});

describe("6. 存失败", () => {
	it("自动存失败:记 error、dirty 留着;下一次变化再试", async () => {
		const w = world();
		const { http, clock, errors } = await build(w);
		w.secrets.failNext();
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(0);
		expect(errors.join("\n")).toContain("测试里让这次落盘失败");
		// dirty 还在:没有新变化,只是放一下闸,也会存上。
		http.cookies.hold().dispose();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
		expect(cookieValues(w.secretsDisk())).toEqual({ a: "1" });
	});

	it("自动存失败后来了新变化:下一次到点带着全部内容写上", async () => {
		const w = world();
		const { http, clock } = await build(w);
		w.secrets.failNext();
		setCookie(http.cookies.jar, "a", "1");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		setCookie(http.cookies.jar, "b", "2");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(cookieValues(w.secretsDisk())).toEqual({ a: "1", b: "2" });
	});

	it("commit 失败:结果原样回给调用方,盘上不变,dirty 置回", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		w.secrets.failNext();
		const result = await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		expect(result).toMatchObject({ ok: false, code: "unavailable" });
		expect(w.secretsDisk().get("refreshToken")).toBe("T0");
		expect(cookieValues(w.secretsDisk())).toEqual({ SESSDATA: "c0" });
		http.cookies.hold().dispose();
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(cookieValues(w.secretsDisk())).toEqual({ SESSDATA: "c1" });
	});
});

describe("7. dispose", () => {
	it("没闸有脏:写一次最后的", async () => {
		const w = world();
		const { http } = await build(w);
		setCookie(http.cookies.jar, "a", "1");
		await http.dispose();
		expect(w.secrets.persists).toHaveLength(1);
		expect(cookieValues(w.secretsDisk())).toEqual({ a: "1" });
		await http.dispose(); // 幂等
		expect(w.secrets.persists).toHaveLength(1);
	});

	it("有闸:不写;之后放闸、罐子再变、commit 都不再写,也不再排定时器", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		const gate = http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		await http.dispose();
		expect(w.secrets.persists).toHaveLength(0);
		const scheduledAtDispose = clock.scheduled;
		gate.dispose();
		setCookie(http.cookies.jar, "SESSDATA", "c2");
		clock.advance(60_000);
		await settle();
		// 摘了订阅:罐子再变连定时器都不排。
		expect(clock.scheduled).toBe(scheduledAtDispose);
		expect(w.secrets.persists).toHaveLength(0);
		const late = await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T9" }]);
		expect(late).toMatchObject({ ok: false, code: "unavailable" });
		expect(w.secrets.persists).toHaveLength(0);
		expect(w.secretsDisk().get("refreshToken")).toBe("T0");
	});

	it("攒着的那一下被清掉,dispose 之后不会又冒出一次写", async () => {
		const w = world();
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "a", "1");
		await http.dispose();
		expect(clock.pendingCount).toBe(0);
		clock.advance(60_000);
		await settle();
		expect(w.secrets.persists).toHaveLength(1);
	});
});

describe("8. 恢复备份整袋换掉之后(真宿主)", () => {
	let dataRoot: string;
	beforeEach(async () => {
		dataRoot = await mkdtemp(join(tmpdir(), "bn-integration-http-"));
	});
	afterEach(async () => {
		await rm(dataRoot, { recursive: true, force: true });
	});

	async function realWorld() {
		const log = silentLogger();
		const keyProvider = createKeyProvider({
			keyPath: dataPath(dataRoot, "secrets", "master.key"),
			saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
			logger: log.logger,
		});
		const redactor = createValueRedactor();
		const store = createIntegrationStore({
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			dataRoot,
			keyProvider,
			logger: log.logger,
			redactor,
		});
		const handle = await store.open("bilibili");
		const clock = makeClock();
		const http = await createIntegrationHttp({
			stores: handle,
			logger: log.logger,
			setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
		});
		const secretsBytes = async () =>
			(await readFile(join(dataRoot, "secrets", "bilibili", "secrets.enc"))).toString("base64");
		const secretsEntries = async () => {
			const read = await readIntegrationSecretsFile({
				reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
				dataRoot,
				key: "bilibili",
				logger: log.logger,
				keyProvider,
			});
			if (read.kind !== "ok") throw new Error(`读不出:${read.kind}`);
			return read.entries;
		};
		return { store, handle, clock, http, secretsBytes, secretsEntries, ...log };
	}

	const restoredCookies = JSON.stringify([
		{
			key: "SESSDATA",
			value: "restored",
			expires: "Wed, 01 Jan 2099 00:00:00 GMT",
			domain: ".bilibili.com",
			path: "/",
		},
	]);

	it("罐子换成备份里的、不触发存盘;onRestored 的回调在罐子换好之后才被叫", async () => {
		const w = await realWorld();
		setCookie(w.http.cookies.jar, "SESSDATA", "before");
		await w.http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T0" }]);
		const bytesBefore = await w.secretsBytes();
		const scheduledBefore = w.clock.scheduled;

		const seen: Array<string | undefined> = [];
		w.http.cookies.onRestored(() => {
			seen.push(w.http.cookies.jar.getValue("SESSDATA"));
		});
		const restored = await w.store.restoreSecrets("bilibili", {
			[HTTP_COOKIES_KEY]: restoredCookies,
			refreshToken: "T-restored",
		});
		expect(restored).toEqual({ ok: true });
		expect(seen).toEqual(["restored"]);
		expect(w.http.cookies.jar.getValue("SESSDATA")).toBe("restored");

		// restoreSecrets 自己写了一次盘;之后罐子这头不该再写。
		const bytesAfterRestore = await w.secretsBytes();
		expect(bytesAfterRestore).not.toBe(bytesBefore);
		w.clock.advance(60_000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await w.secretsBytes()).toBe(bytesAfterRestore);
		expect(w.clock.scheduled).toBe(scheduledBefore);
		expect((await w.secretsEntries()).get("refreshToken")).toBe("T-restored");

		// 对照:恢复之后罐子真变了,照常存。
		setCookie(w.http.cookies.jar, "bili_jct", "j");
		w.clock.advance(COOKIE_SAVE_DELAY_MS);
		await vi.waitFor(async () => {
			expect(await w.secretsBytes()).not.toBe(bytesAfterRestore);
		});
		expect(cookieValues(await w.secretsEntries())).toEqual({ SESSDATA: "restored", bili_jct: "j" });
	});

	it("备份里没有 http.cookies:罐子清空,不触发存盘", async () => {
		const w = await realWorld();
		setCookie(w.http.cookies.jar, "SESSDATA", "before");
		await w.http.cookies.commit();
		await w.store.restoreSecrets("bilibili", { refreshToken: "T" });
		expect(w.http.cookies.jar.getValue("SESSDATA")).toBeUndefined();
		const bytes = await w.secretsBytes();
		w.clock.advance(60_000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await w.secretsBytes()).toBe(bytes);
	});

	it("onRestored 的回调抛了:记 error,后面的照叫", async () => {
		const w = await realWorld();
		const seen: string[] = [];
		w.http.cookies.onRestored(() => {
			throw new Error("boom");
		});
		w.http.cookies.onRestored(() => {
			seen.push("second");
		});
		await w.store.restoreSecrets("bilibili", { refreshToken: "T" });
		expect(seen).toEqual(["second"]);
		expect(w.errors.join("\n")).toContain("boom");
	});

	it("dispose 之后不再听「被换了」:罐子不动", async () => {
		const w = await realWorld();
		await w.http.dispose();
		await w.store.restoreSecrets("bilibili", { [HTTP_COOKIES_KEY]: restoredCookies });
		expect(w.http.cookies.jar.getValue("SESSDATA")).toBeUndefined();
	});

	it("真宿主上 commit:secrets.enc 解开后两个键同时是新值", async () => {
		const w = await realWorld();
		setCookie(w.http.cookies.jar, "SESSDATA", "c1");
		expect(
			await w.http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]),
		).toEqual({ ok: true });
		const entries = await w.secretsEntries();
		expect(cookieValues(entries)).toEqual({ SESSDATA: "c1" });
		expect(entries.get("refreshToken")).toBe("T1");
	});
});

describe("8b. 排队次序", () => {
	it("罐子的内容在轮到那一次写的那一刻才取,不是入队时的快照", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		// 第一笔 commit 的落盘按住:它在写道里占着位置。
		const release = w.secrets.holdNext();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		const slow = http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		await settle();
		// 罐子再变,到点自动存排在 commit 后面。
		setCookie(http.cookies.jar, "extra", "e1");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		// 排上之后、轮到之前,罐子又变了一次。
		setCookie(http.cookies.jar, "later", "l1");
		release();
		await slow;
		await settle();
		expect(w.secrets.persists).toHaveLength(2);
		// 第二笔带的是它轮到那一刻罐子里的东西(含 later),不是入队时的。
		expect(cookieValues(nth(w.secrets.persists, 1))).toEqual({
			SESSDATA: "c1",
			extra: "e1",
			later: "l1",
		});
		// 第一笔是 commit 那一刻的罐子。
		expect(cookieValues(nth(w.secrets.persists, 0))).toEqual({ SESSDATA: "c1" });
		expect(nth(w.secrets.persists, 0).get("refreshToken")).toBe("T1");
	});
});

describe("9. 身份", () => {
	const inRange = {
		userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR_MIN + 2}.0.0.0 Safari/537.36`,
		secChUa: '"Not;A=Brand";v="99", "Google Chrome";v="138", "Chromium";v="138"',
		secChUaMobile: "?0",
		secChUaPlatform: '"Linux"',
	};
	const tooOld = {
		...inRange,
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36",
	};

	function majorOf(identity: { userAgent: string }): number {
		return Number(/Chrome\/(\d+)\./.exec(identity.userAgent)?.[1]);
	}

	it("没有:生成并写进 http.identity", async () => {
		const w = world();
		const { http } = await build(w);
		expect(majorOf(http.identity)).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
		expect(w.state.persists).toHaveLength(1);
		expect(w.stateDisk().get(HTTP_IDENTITY_KEY)).toEqual({ ...http.identity });
	});

	it("有、在区间里:原样、不写", async () => {
		const w = world({ state: { [HTTP_IDENTITY_KEY]: inRange } });
		const { http } = await build(w);
		expect(http.identity).toEqual(inRange);
		expect(w.state.persists).toHaveLength(0);
	});

	it("低于下限:换新并写回", async () => {
		const w = world({ state: { [HTTP_IDENTITY_KEY]: tooOld } });
		const { http } = await build(w);
		expect(http.identity.userAgent).not.toBe(tooOld.userAgent);
		expect(majorOf(http.identity)).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
		expect(w.stateDisk().get(HTTP_IDENTITY_KEY)).toEqual({ ...http.identity });
	});

	it("存的形状坏了(缺格 / 不是对象 / 格不是字符串):生成", async () => {
		for (const bad of [{ userAgent: "x" }, "oops", [], { ...inRange, secChUa: 1 }]) {
			const w = world({ state: { [HTTP_IDENTITY_KEY]: bad as Json } });
			const { http } = await build(w);
			expect(majorOf(http.identity)).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
			expect(w.stateDisk().get(HTTP_IDENTITY_KEY)).toEqual({ ...http.identity });
		}
	});

	it("重启后身份不变:第二次开机读到第一次写的", async () => {
		const first = world();
		const a = await build(first);
		const second = world({ state: Object.fromEntries(first.stateDisk()) });
		const b = await build(second);
		expect(b.http.identity).toEqual(a.http.identity);
		expect(second.state.persists).toHaveLength(0);
	});

	it("写不进:记 warn、照用内存里这份", async () => {
		const w = world();
		w.state.failNext();
		const { http, warns } = await build(w);
		expect(majorOf(http.identity)).toBeGreaterThanOrEqual(CHROME_MAJOR_MIN);
		expect(warns.join("\n")).toContain("浏览器身份");
	});

	it("集成给的默认头拿到身份再给", async () => {
		const w = world({ state: { [HTTP_IDENTITY_KEY]: inRange } });
		const seen: string[] = [];
		const log = silentLogger();
		await createIntegrationHttp({
			stores: w.handle,
			logger: log.logger,
			headers: (identity) => {
				seen.push(identity.userAgent);
				return { "x-test": "1" };
			},
			setTimeout: (fn, ms) => makeClock().setTimeout(fn, ms),
		});
		expect(seen).toEqual([inRange.userAgent]);
	});
});

/**
 * 罐子里的每条 cookie 值,一到罐子里就登记进打码登记册(不等存盘):罐子要攒 2 秒才存,拿着闸更久,
 * 这段窗口里日志不能露出明文。值都是假值。
 */
describe("罐子的值登记要打码", () => {
	const jarOf = (value: string, key = "SESSDATA") =>
		JSON.stringify([{ key, value, expires: "Infinity", domain: "bilibili.com", path: "/" }]);

	it("开机装罐:存着的值当场登记(不触发存盘)", async () => {
		const w = world({ secrets: { [HTTP_COOKIES_KEY]: jarOf("FAKE-BOOT-COOKIE-1") } });
		const { redactor, clock } = await build(w);
		expect(redactor.scrub("v=FAKE-BOOT-COOKIE-1")).toBe("v=***");
		expect(clock.scheduled).toBe(0);
	});

	it("收到一条 Set-Cookie:存盘之前(假时钟没到点)值已经被遮", async () => {
		const w = world();
		const { http, redactor, clock } = await build(w);
		setCookie(http.cookies.jar, "SESSDATA", "FAKE-FRESH-COOKIE-1");
		expect(w.secrets.persists).toHaveLength(0);
		expect(redactor.scrub("v=FAKE-FRESH-COOKIE-1")).toBe("v=***");
		clock.advance(COOKIE_SAVE_DELAY_MS - 1);
		expect(w.secrets.persists).toHaveLength(0);
	});

	it("拿着闸的时候收到的也遮", async () => {
		const w = world();
		const { http, redactor } = await build(w);
		const gate = http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "FAKE-HELD-COOKIE-1");
		expect(redactor.scrub("FAKE-HELD-COOKIE-1")).toBe("***");
		gate.dispose();
	});

	it("值换了:新的遮,旧的不再遮;少于 8 个字符的不遮", async () => {
		const w = world();
		const { http, redactor } = await build(w);
		setCookie(http.cookies.jar, "SESSDATA", "FAKE-OLD-COOKIE-1");
		setCookie(http.cookies.jar, "SESSDATA", "FAKE-NEW-COOKIE-2");
		setCookie(http.cookies.jar, "short", "abc1234");
		expect(redactor.scrub("FAKE-OLD-COOKIE-1 FAKE-NEW-COOKIE-2 abc1234")).toBe(
			"FAKE-OLD-COOKIE-1 *** abc1234",
		);
	});

	it("登出(整罐清空):值不再遮", async () => {
		const w = world({ secrets: { [HTTP_COOKIES_KEY]: jarOf("FAKE-LOGOUT-COOKIE") } });
		const { http, redactor } = await build(w);
		http.cookies.jar.clear();
		expect(redactor.scrub("FAKE-LOGOUT-COOKIE")).toBe("FAKE-LOGOUT-COOKIE");
	});

	it("恢复备份整罐换:换进来的值登记,换走的不再遮", async () => {
		const w = world({ secrets: { [HTTP_COOKIES_KEY]: jarOf("FAKE-BEFORE-RESTORE") } });
		const { redactor } = await build(w);
		await w.restoreCookies(jarOf("FAKE-AFTER-RESTORE"));
		expect(redactor.scrub("FAKE-BEFORE-RESTORE FAKE-AFTER-RESTORE")).toBe(
			"FAKE-BEFORE-RESTORE ***",
		);
	});

	it("值是百分号编码的:原样与解码后的两种写法都遮", async () => {
		const w = world({ secrets: { [HTTP_COOKIES_KEY]: jarOf("FAKE%2CCOMMA%2CVALUE", "enc") } });
		const { redactor } = await build(w);
		expect(redactor.scrub("a FAKE%2CCOMMA%2CVALUE b FAKE,COMMA,VALUE c")).toBe("a *** b *** c");
	});

	it("集成停下(dispose):罐子的值撤掉", async () => {
		const w = world({ secrets: { [HTTP_COOKIES_KEY]: jarOf("FAKE-DISPOSE-COOKIE") } });
		const { http, redactor } = await build(w);
		await http.dispose();
		expect(redactor.scrub("FAKE-DISPOSE-COOKIE")).toBe("FAKE-DISPOSE-COOKIE");
	});
});

describe("崩溃时刻表(§E.4):每一种停下的时刻盘上是什么", () => {
	/** 盘上的一对 `(C, T)`。 */
	function pairOf(entries: ReadonlyMap<string, Json>) {
		return { c: cookieValues(entries).SESSDATA, t: entries.get("refreshToken") };
	}

	it("平时零散的 Set-Cookie 到了、2 秒没到就崩:盘上还是上一次存的", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		setCookie(http.cookies.jar, "scatter", "1");
		clock.advance(COOKIE_SAVE_DELAY_MS - 1);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		expect(w.secrets.persists).toHaveLength(0);
	});

	it("自动存那一次写写到一半(落盘按住):盘上是旧的整份;放开后是新的整份", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		const release = w.secrets.holdNext();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		release();
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c1", t: "T0" });
	});

	it("续期:刷新 POST 回来了、确认之前(闸挡着):C1 不落盘,一直是 (C0, T0)", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		setCookie(http.cookies.jar, "bili_jct", "j1");
		clock.advance(10 * 60_000);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		expect(w.secrets.persists).toHaveLength(0);
	});

	it("续期:确认回来了、提交那次写落盘之前(落盘按住):(C0, T0);落盘后 (C1, T1),没有第三种", async () => {
		const w = world({ secrets: PAIR0 });
		const { http } = await build(w);
		http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		const release = w.secrets.holdNext();
		const committing = http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		release();
		await committing;
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c1", t: "T1" });
		// 每一笔落盘的整袋里,罐子与令牌要么都是旧的、要么都是新的。
		for (const entries of w.secrets.persists) {
			const pair = pairOf(entries);
			expect(`${pair.c}/${pair.t}`).toMatch(/^(c0\/T0|c1\/T1)$/);
		}
	});

	it("续期:提交的写失败之后(闸留着)一直跑着:盘上 (C0, T0),罐子再变也不落盘", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		w.secrets.failNext();
		const result = await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		expect(result.ok).toBe(false);
		setCookie(http.cookies.jar, "other", "o");
		clock.advance(10 * 60_000);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		expect(w.secrets.persists).toHaveLength(0);
	});

	it("续期:提交成功才放闸;放闸之后零散变化照常自动存", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		const gate = http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T1" }]);
		gate.dispose();
		setCookie(http.cookies.jar, "scatter", "1");
		clock.advance(COOKIE_SAVE_DELAY_MS);
		await settle();
		expect(w.secrets.persists).toHaveLength(2);
		expect(cookieValues(w.secretsDisk())).toEqual({ SESSDATA: "c1", scatter: "1" });
		expect(w.secretsDisk().get("refreshToken")).toBe("T1");
	});

	it("会话终态(清了罐、闸留着)之后崩:盘上上一对原样", async () => {
		const w = world({ secrets: PAIR0 });
		const { http, clock } = await build(w);
		http.cookies.hold(); // terminateSession 先拿闸、留着不放
		http.cookies.jar.clear();
		clock.advance(10 * 60_000);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		expect(w.secrets.persists).toHaveLength(0);
	});

	it("扫码成功:登录回应到了、提交之前(闸挡着):盘上是扫码前的状态", async () => {
		const w = world();
		const { http, clock } = await build(w);
		http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "fresh");
		clock.advance(10 * 60_000);
		await settle();
		expect(w.secretsDisk().size).toBe(0);
	});

	it("扫码成功:提交的写失败:盘上同上,这次进程里罐子是登录着的", async () => {
		const w = world();
		const { http } = await build(w);
		http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "fresh");
		w.secrets.failNext();
		const result = await http.cookies.commit([{ kind: "set", key: "refreshToken", value: "T" }]);
		expect(result.ok).toBe(false);
		expect(w.secretsDisk().size).toBe(0);
		expect(http.cookies.jar.getValue("SESSDATA")).toBe("fresh");
	});

	it("登出:清了罐、提交之前:登出前的一对;提交之后两个键都没了", async () => {
		const w = world({ secrets: { ...PAIR0, other: "kept" } });
		const { http } = await build(w);
		http.cookies.hold();
		http.cookies.jar.clear();
		const release = w.secrets.holdNext();
		const committing = http.cookies.commit([{ kind: "delete", key: "refreshToken" }]);
		await settle();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		release();
		await committing;
		expect(w.secretsDisk().has(HTTP_COOKIES_KEY)).toBe(false);
		expect(w.secretsDisk().has("refreshToken")).toBe(false);
		expect(w.secretsDisk().get("other")).toBe("kept"); // 别的键原样
	});

	it("优雅关停:链正跑在刷新与确认之间(闸还在):不做最后一次存,盘上 (C0, T0)", async () => {
		const w = world({ secrets: PAIR0 });
		const { http } = await build(w);
		http.cookies.hold();
		setCookie(http.cookies.jar, "SESSDATA", "c1");
		await http.dispose();
		expect(pairOf(w.secretsDisk())).toEqual({ c: "c0", t: "T0" });
		expect(w.secrets.persists).toHaveLength(0);
	});

	it("优雅关停:有零散变化没存、没有闸:dispose 里存了最后一次", async () => {
		const w = world({ secrets: PAIR0 });
		const { http } = await build(w);
		setCookie(http.cookies.jar, "scatter", "1");
		await http.dispose();
		expect(cookieValues(w.secretsDisk())).toEqual({ SESSDATA: "c0", scatter: "1" });
		expect(w.secretsDisk().get("refreshToken")).toBe("T0");
	});

	it("身份:生成了、写 state 之前崩(落盘按住):盘上没有身份", async () => {
		const w = world();
		w.state.holdNext(); // 永不放:就是「写之前崩」
		const building = build(w);
		await settle();
		expect(w.stateDisk().has(HTTP_IDENTITY_KEY)).toBe(false);
		expect(w.state.persists).toHaveLength(0);
		// 不等 building:进程已经"死"了。
		void building;
	});
});
