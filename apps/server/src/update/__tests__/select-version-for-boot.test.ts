import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { markBootSucceeded, selectVersionForBoot } from "../select-version-for-boot.js";

/**
 * 进程启动最早期决定「跑哪一份」。
 *
 * 这一层的存在理由是**自愈**:自主升级把「发了个坏版本」的爆炸半径放大到全体,
 * 服务端撤回闸只拦得住还没升的人,已经中招的那批全靠这里 —— 连续起不来就退回
 * 上一版。所以选版和「记一次启动尝试」是**配对**的:只选不记,崩溃循环永远累加
 * 不到上限,自愈就是死的。
 */
const created: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "bn-boot-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 建一个装了若干版本的 `versions/`,返回它的路径。 */
function versionsWith(root: string, ...versions: string[]): string {
	const versionsRoot = join(root, "versions");
	mkdirSync(versionsRoot, { recursive: true });
	for (const version of versions) mkdirSync(join(versionsRoot, version));
	return versionsRoot;
}

describe("selectVersionForBoot", () => {
	it("versions/ 里躺着比镜像新的载荷 → 跑载荷", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0");

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: join(root, "app"),
			versionsRoot,
			maxBootFailures: 3,
		});

		expect(selection.version).toBe("0.9.0");
		expect(selection.path).toBe(join(versionsRoot, "0.9.0"));
		expect(selection.isImageVersion).toBe(false);
	});

	it("不像版本号的目录一律不当候选 —— 一个日期命名的备份会被读成主版本 2026", () => {
		// `/data` 是用户挂出来的,他们真的会往里丢东西(手动备份、解压残留)。
		// "2026-09-01" 按数字段解析出来是 [2026],压过任何真版本 —— 然后我们就会
		// 从一个根本不是载荷的目录里启动。
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0", "2026-09-01", "backup");

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: join(root, "app"),
			versionsRoot,
			maxBootFailures: 3,
		});

		expect(selection.version).toBe("0.9.0");
	});

	it("一个版本连续起不来到上限 → 判死它,退回上一版", () => {
		// 这是自主升级唯一能救「已经中招」那批用户的东西 —— 服务端撤回闸只拦得住
		// 还没升的人,已经装上坏版本、连界面都打不开的人只能靠这里。
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.8.0", "0.9.0");
		const input = {
			imageVersion: "0.7.0",
			imagePath: join(root, "app"),
			versionsRoot,
			maxBootFailures: 3,
		};

		// 崩溃循环:每次都选中 0.9.0,每次都没能活到 markBootSucceeded。
		for (let attempt = 1; attempt <= 3; attempt++) {
			expect(selectVersionForBoot(input).version, `第 ${attempt} 次`).toBe("0.9.0");
		}

		// 第四次:0.9.0 已被判死,退回上一版。
		expect(selectVersionForBoot(input).version).toBe("0.8.0");
	});

	it("起来了就销账 —— 偶发一次起不来(宿主重启/被 OOM 杀)不该把好版本判死", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.8.0", "0.9.0");
		const input = {
			imageVersion: "0.7.0",
			imagePath: join(root, "app"),
			versionsRoot,
			maxBootFailures: 3,
		};

		selectVersionForBoot(input); // 1
		selectVersionForBoot(input); // 2
		markBootSucceeded({ versionsRoot, version: "0.9.0" }); // 清零

		selectVersionForBoot(input); // 清零后的第 1 次
		// 没销账的话,这已经是第 4 次 —— 0.9.0 早被判死,这里会拿到 0.8.0。
		expect(selectVersionForBoot(input).version).toBe("0.9.0");
	});

	it("一次都没升过 → 跑镜像自带那份", () => {
		const root = tempRoot();

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: join(root, "app"),
			// 目录压根还不存在 —— 这是绝大多数用户的常态,不是错误。
			versionsRoot: join(root, "versions"),
			maxBootFailures: 3,
		});

		expect(selection.version).toBe("0.8.0");
		expect(selection.path).toBe(join(root, "app"));
		expect(selection.isImageVersion).toBe(true);
	});

	it("用户拉了更新的镜像 → 不被 /data 里的旧载荷压住", () => {
		// 在线升级最容易长出来的反问题:「我明明 docker compose pull 了,怎么还是
		// 旧版」。镜像必须参与比较,否则一旦装过一次载荷,拉新镜像就再也不生效,
		// 而且完全没有线索指向 /data。
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0");

		const selection = selectVersionForBoot({
			imageVersion: "0.10.0",
			imagePath: join(root, "app"),
			versionsRoot,
			maxBootFailures: 3,
		});

		expect(selection.version).toBe("0.10.0");
		expect(selection.isImageVersion).toBe(true);
	});
});
