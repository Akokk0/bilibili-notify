import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { installPayload } from "../install-payload.js";

/**
 * 升级包落盘。**唯一的一条保证:要么 `versions/<ver>/` 完整出现,要么现场一个
 * 字节没动。**
 *
 * 这里刻意用真实临时目录而不是 mock fs —— 原子 rename、目录已存在、路径穿越
 * 这几件事的语义全在真实文件系统上,mock 出来的等于没测。
 */
const created: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "bn-update-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeZip(files: Record<string, string>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([n, c]) => [n, strToU8(c)])));
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("installPayload", () => {
	it("versionsRoot 是相对路径也装得上 —— 越界判定得先把根算成绝对路径", () => {
		// 配置里 dataDir 默认是 `./data`,用户手写 yaml 也常写相对路径。越界判定拿
		// 绝对路径去跟相对根比前缀,会把**每一个**条目都判成越界 —— 好包永远装不上,
		// 而且报出来的 unsafe-entry 像是供应链告警。
		const absolute = tempRoot();
		const versionsRoot = relative(process.cwd(), absolute);
		const zip = makeZip({ "index.mjs": "console.log('payload')" });

		const result = installPayload({
			zip,
			expectedSha256: sha256(zip),
			version: "0.9.0",
			versionsRoot,
		});

		expect(result.ok, result.ok ? "" : `reason=${result.reason}`).toBe(true);
		expect(existsSync(join(absolute, "0.9.0", "index.mjs"))).toBe(true);
	});

	it("sha256 对不上 → 拒绝,而且 versions/ 下一个字节都不多", () => {
		const versionsRoot = tempRoot();

		const result = installPayload({
			zip: makeZip({ "index.mjs": "console.log('payload')" }),
			expectedSha256: sha256(strToU8("完全是别的东西")),
			version: "0.9.0",
			versionsRoot,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("checksum-mismatch");
		// 校验必须发生在**落盘之前**。先解压再校验的话,失败那一刻磁盘上已经躺着
		// 半个树了,而下一次启动选版会把它当成一个可用版本。
		expect(readdirSync(versionsRoot)).toEqual([]);
	});

	it("一切正常 → versions/<ver>/ 完整出现,内容与包一致(含嵌套目录)", () => {
		const versionsRoot = tempRoot();
		const zip = makeZip({
			"index.mjs": "console.log('payload')",
			"web-dist/index.html": "<!doctype html>",
		});

		const result = installPayload({
			zip,
			expectedSha256: sha256(zip),
			version: "0.9.0",
			versionsRoot,
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(result.alreadyInstalled).toBe(false);
		expect(readdirSync(versionsRoot)).toEqual(["0.9.0"]);
		expect(readFileSync(join(result.path, "index.mjs"), "utf8")).toBe("console.log('payload')");
		expect(readFileSync(join(result.path, "web-dist", "index.html"), "utf8")).toBe(
			"<!doctype html>",
		);
	});

	it("zip 里有逃出目标目录的条目 → 整包拒绝,不是跳过那一条", () => {
		// 我们解的是**要被执行的代码**。一个 `../` 条目就能把文件写到版本目录外面 ——
		// 覆盖掉隔壁版本、甚至镜像自带那份。所以发现一条就整包不要:一个会往外写的
		// 包,剩下那些条目也不值得信。
		const root = tempRoot();
		const versionsRoot = join(root, "versions");
		mkdirSync(versionsRoot);
		const zip = makeZip({
			"index.mjs": "console.log('ok')",
			"../../escaped.mjs": "console.log('pwned')",
		});

		const result = installPayload({
			zip,
			expectedSha256: sha256(zip),
			version: "0.9.0",
			versionsRoot,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("unsafe-entry");
		expect(readdirSync(versionsRoot)).toEqual([]);
		expect(existsSync(join(root, "escaped.mjs"))).toBe(false);
	});

	it("这个版本已经装过 → 不碰磁盘,报『已存在』让上层去切指针", () => {
		// 两条真实路径会走到这里:① 装完了但没来得及切指针就挂了;② 用户回退到上一版
		// 之后又想升回来(而我们保留当前+上一版,那个目录根本没删)。
		// 两种情况下那个目录都是**完整**的 —— 它只可能通过原子 rename 出现 ——
		// 所以正确的动作是什么都不做,而不是重下 25MB 再装一遍。
		const versionsRoot = tempRoot();
		const first = makeZip({ "index.mjs": "第一次装的" });
		installPayload({
			zip: first,
			expectedSha256: sha256(first),
			version: "0.9.0",
			versionsRoot,
		});

		const second = makeZip({ "index.mjs": "不该覆盖掉上面那份" });
		const result = installPayload({
			zip: second,
			expectedSha256: sha256(second),
			version: "0.9.0",
			versionsRoot,
		});

		if (!result.ok) throw new Error(`expected ok, got reason=${result.reason}`);
		expect(result.alreadyInstalled).toBe(true);
		expect(readFileSync(join(result.path, "index.mjs"), "utf8")).toBe("第一次装的");
		// 没有残留的 staging 目录
		expect(readdirSync(versionsRoot)).toEqual(["0.9.0"]);
	});

	it("解压写到一半炸了 → staging 清干净,不留半个树,也不抛", () => {
		// 「app」先作为文件写下去,紧接着「app/index.mjs」又要拿它当目录 —— 必然
		// ENOTDIR,而且是在**已经写了几个文件之后**才炸。这是「半个树」唯一真正
		// 可能出现的时机。
		const versionsRoot = tempRoot();
		const zip = makeZip({ app: "我是文件", "app/index.mjs": "我要拿上面那个当目录" });

		const result = installPayload({
			zip,
			expectedSha256: sha256(zip),
			version: "0.9.0",
			versionsRoot,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("extract-failed");
		// 目标目录没出现,**staging 也没留下** —— 否则下次安装会撞上一堆孤儿目录。
		expect(readdirSync(versionsRoot)).toEqual([]);
	});

	it("下下来的根本不是个 ZIP → 拒绝,不抛", () => {
		// sha256 对得上只证明「字节是清单说的那一份」,**不证明那份字节是个能解开的包**
		// —— 我们自己发错东西的时候就长这样。
		const versionsRoot = tempRoot();
		const notAZip = strToU8("这不是压缩包,只是一串字");

		const result = installPayload({
			zip: notAZip,
			expectedSha256: sha256(notAZip),
			version: "0.9.0",
			versionsRoot,
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe("extract-failed");
		expect(readdirSync(versionsRoot)).toEqual([]);
	});
});
