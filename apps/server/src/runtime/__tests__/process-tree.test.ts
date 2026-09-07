import { describe, expect, it } from "vite-plus/test";
import {
	parseProcStatus,
	parsePsTable,
	parseWindowsProcessTable,
	subtreeRss,
} from "../process-tree.js";

/**
 * 浏览器进程子树的 RSS —— 概览页资源卡上「浏览器」那一行。
 *
 * chromium 是一棵树:一个 browser 进程 + 每个页面 / GPU / 网络各一个子进程,吃内存的
 * 大头在子进程上。只报父进程等于把最要紧的那部分漏掉。
 *
 * 三平台各有各的取数方式,共用一个「按父子链求子树和」的算法。这里钉解析与求和,
 * 起子进程那一步不在测试里跑。
 */

describe("parsePsTable(macOS / Linux 的 ps 输出)", () => {
	// `ps -axo pid=,ppid=,rss=` —— rss 单位是 KB。
	const TABLE = [
		"  1     0   12000",
		" 900     1  340000",
		"1200   900   90000",
		"1201   900  150000",
		"1300  1200   40000",
		"1500     1   20000",
	].join("\n");

	it("整表读成 pid → {ppid, rss},rss 从 KB 换成字节", () => {
		const rows = parsePsTable(TABLE);
		expect(rows.get(1200)).toEqual({ ppid: 900, rss: 90000 * 1024 });
		expect(rows.size).toBe(6);
	});

	it("表头、空行与残缺行跳过,不让整表作废", () => {
		const rows = parsePsTable(
			["  PID  PPID    RSS", "", " 900     1  340000", "garbage"].join("\n"),
		);
		expect(rows.size).toBe(1);
		expect(rows.get(900)?.rss).toBe(340000 * 1024);
	});
});

describe("subtreeRss", () => {
	const rows = parsePsTable(
		[
			"  1     0   12000",
			" 900     1  340000",
			"1200   900   90000",
			"1201   900  150000",
			"1300  1200   40000",
			"1500     1   20000",
		].join("\n"),
	);

	it("把根进程连同**所有层级**的子孙加起来", () => {
		// 900 自己 340M + 两个渲染进程 90M/150M + 孙子 40M = 620M。
		// 少算孙子那一层就漏掉了 chromium 的一大半。
		expect(subtreeRss(rows, 900)).toBe((340000 + 90000 + 150000 + 40000) * 1024);
	});

	it("兄弟树不算进来", () => {
		expect(subtreeRss(rows, 1500)).toBe(20000 * 1024);
	});

	it("进程已经不在表里(刚退掉)→ null,不是 0", () => {
		// 0 会在面板上画成「浏览器占 0MB」,那是句假话;null 才画成「—」。
		expect(subtreeRss(rows, 4242)).toBeNull();
	});

	it("父子关系成环也不会转不出来", () => {
		const cyclic = parsePsTable([" 10     11   1000", " 11     10   2000"].join("\n"));
		expect(subtreeRss(cyclic, 10)).toBe(3000 * 1024);
	});
});

describe("parseProcStatus(Linux 的 /proc/<pid>/status)", () => {
	const STATUS = [
		"Name:\tchrome",
		"State:\tS (sleeping)",
		"Tgid:\t1200",
		"Pid:\t1200",
		"PPid:\t900",
		"VmPeak:\t 2410000 kB",
		"VmRSS:\t   92160 kB",
		"Threads:\t28",
	].join("\n");

	it("PPid 与 VmRSS 一并读出;kB 换成字节", () => {
		// 刻意读 status 而不是 statm:statm 报的是**页数**,得知道页大小才换得成字节,
		// 而 ARM64 Linux 上页可以是 64K —— 按 4K 硬算会把 RSS 说大 16 倍。
		expect(parseProcStatus(STATUS)).toEqual({ ppid: 900, rss: 92160 * 1024 });
	});

	it("缺字段 / 读不出来就 null,不当 0", () => {
		expect(parseProcStatus("")).toBeNull();
		expect(parseProcStatus("Name:\tchrome\nPPid:\t900\n")).toBeNull();
		expect(parseProcStatus("Name:\tchrome\nVmRSS:\t 100 kB\n")).toBeNull();
	});
});

describe("parseWindowsProcessTable(PowerShell 的 CSV 输出)", () => {
	// Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,WorkingSetSize
	const CSV = [
		'"ProcessId","ParentProcessId","WorkingSetSize"',
		'"900","1","357564416"',
		'"1200","900","94371840"',
		'"1300","1200","41943040"',
	].join("\r\n");

	it("CSV 读成同一份 pid → {ppid, rss};WorkingSetSize 本来就是字节", () => {
		const rows = parseWindowsProcessTable(CSV);
		expect(rows.get(1200)).toEqual({ ppid: 900, rss: 94371840 });
		// 与 ps 那条路共用求和,子孙照样算得到。
		expect(subtreeRss(rows, 900)).toBe(357564416 + 94371840 + 41943040);
	});

	it("没有表头 / 空输出 → 空表,别抛", () => {
		expect(parseWindowsProcessTable("").size).toBe(0);
	});
});
