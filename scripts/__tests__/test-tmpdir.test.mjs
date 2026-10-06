import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { isProcessAlive, redirectTestTmpDir, runDirName, sweepStaleRuns } from "../test-tmpdir.mjs";

// 测试临时目录改道(scripts/test-tmpdir.mjs):一次测试运行的所有临时目录落进它自己的
// `bn-test/run-<进程号>/`,跑完整个删;被打断的运行留下的,下次开跑时按「进程还在不在」清掉。
// 这里的 base 建在当前运行自己的临时目录里(它本身就被改道过),跑完随整次运行一起消失。

let base;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "bn-tmpdir-test-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

const seed = (name) => {
	mkdirSync(join(base, name, "nested"), { recursive: true });
	writeFileSync(join(base, name, "nested", "file"), "x");
};

describe("sweepStaleRuns:只删进程已经不在的运行目录", () => {
	// 验红:把 `!isAlive(pid)` 改成恒真,「进程还在」那条红(并行跑着的另一次运行被误删)。
	it("进程不在的删掉,进程还在的原样留着", () => {
		seed(runDirName(111));
		seed(runDirName(222));
		const removed = sweepStaleRuns(base, { isAlive: (pid) => pid === 222 });
		expect(removed).toEqual([runDirName(111)]);
		expect(readdirSync(base)).toEqual([runDirName(222)]);
	});

	// 验红:把名字的判据放宽成「什么都算」,这条红。
	it("不是运行目录的东西一概不碰(别的名字、带后缀的、文件)", () => {
		seed("something-else");
		seed("run-abc");
		seed("run-123-extra");
		writeFileSync(join(base, "run-456"), "是个文件,不是目录");
		const removed = sweepStaleRuns(base, { isAlive: () => false });
		expect(removed).toEqual([]);
		expect(readdirSync(base).sort()).toEqual(
			["run-123-extra", "run-456", "run-abc", "something-else"].sort(),
		);
	});

	it("自己的进程号不删(哪怕判活的函数说它不在)", () => {
		seed(runDirName(999));
		expect(sweepStaleRuns(base, { isAlive: () => false, self: 999 })).toEqual([]);
		expect(existsSync(join(base, runDirName(999)))).toBe(true);
	});

	it("base 不存在 → 什么都不做,不抛", () => {
		expect(sweepStaleRuns(join(base, "nope"), { isAlive: () => false })).toEqual([]);
	});
});

describe("isProcessAlive", () => {
	it("自己活着;一个不可能存在的进程号不在", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		// 进程号上限远小于它(macOS 99998、Linux 默认 4194304)。
		expect(isProcessAlive(2 ** 30)).toBe(false);
	});
});

describe("redirectTestTmpDir:把这次运行的临时目录指到专属目录", () => {
	const fakeProcess = () => {
		const handlers = [];
		return { handlers, on: (event, fn) => event === "exit" && handlers.push(fn) };
	};

	// 验红:去掉对 TMPDIR 的赋值,这条红。
	it("建好 run-<进程号>、三个环境变量都指过去、记下归属", () => {
		const env = {};
		const proc = fakeProcess();
		const dir = redirectTestTmpDir({ base, pid: 4242, env, proc, isAlive: () => true });
		expect(dir).toBe(join(base, runDirName(4242)));
		expect(existsSync(dir)).toBe(true);
		expect(env.TMPDIR).toBe(dir);
		expect(env.TMP).toBe(dir);
		expect(env.TEMP).toBe(dir);
		expect(env.BN_TEST_TMP_OWNER).toBe("4242");
	});

	// 验红:去掉登记的 exit 钩子,这条红。
	it("进程退出时整个删掉自己的目录", () => {
		const env = {};
		const proc = fakeProcess();
		const dir = redirectTestTmpDir({ base, pid: 4242, env, proc, isAlive: () => true });
		writeFileSync(join(dir, "leftover"), "x");
		expect(proc.handlers).toHaveLength(1);
		proc.handlers[0]();
		expect(existsSync(dir)).toBe(false);
	});

	it("开跑前顺手清掉进程已经不在的旧运行", () => {
		seed(runDirName(111));
		seed(runDirName(222));
		redirectTestTmpDir({
			base,
			pid: 4242,
			env: {},
			proc: fakeProcess(),
			isAlive: (pid) => pid === 222,
		});
		expect(readdirSync(base).sort()).toEqual([runDirName(222), runDirName(4242)].sort());
	});

	// 验红:去掉「已经改过道就不再改」的判断,这条红(会在专属目录里再套一层)。
	it("已经改过道(环境里有归属标记)→ 不再改,回 undefined", () => {
		const env = { BN_TEST_TMP_OWNER: "1", TMPDIR: "/somewhere" };
		const proc = fakeProcess();
		expect(redirectTestTmpDir({ base, pid: 4242, env, proc, isAlive: () => true })).toBe(undefined);
		expect(env.TMPDIR).toBe("/somewhere");
		expect(readdirSync(base)).toEqual([]);
		expect(proc.handlers).toHaveLength(0);
	});
});

describe("接线:这次测试运行真的被改道了", () => {
	// 验红:把 vite.config.ts 里那一句调用删掉,这条红。
	it("os.tmpdir() 落在 bn-test/run-<进程号> 里,且那个进程还在", () => {
		const owner = Number(process.env.BN_TEST_TMP_OWNER);
		expect(Number.isInteger(owner)).toBe(true);
		expect(tmpdir().endsWith(join("bn-test", runDirName(owner)))).toBe(true);
		expect(isProcessAlive(owner)).toBe(true);
	});
});
