import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	clearPinnedVersion,
	markBootSucceeded,
	pinVersion,
	selectVersionForBoot,
} from "../select-version-for-boot.js";

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

	it("阈值那一次起来了 → 不能留在黑名单里,下次照样选它", () => {
		// 判死是在**选中的那一刻**记的(选中就记一次尝试,由 markBootSucceeded 销账),
		// 所以第三次选中时它已经进了 failed —— 而那一次它其实起来了。销账只清 attempts
		// 不清 failed 的话,一个好版本就从第四次开机起被永久打入冷宫、静默降级到镜像版,
		// 面板上却还说它「已就绪」。两次没确认的启动(宿主重启、OOM、启动中被 down)
		// 加上一次正常启动,就是这个形状。
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.8.0", "0.9.0");
		const input = {
			imageVersion: "0.7.0",
			imagePath: join(root, "app"),
			versionsRoot,
			maxBootFailures: 3,
		};

		selectVersionForBoot(input); // 1,没确认
		selectVersionForBoot(input); // 2,没确认
		expect(selectVersionForBoot(input).version).toBe("0.9.0"); // 3,阈值 —— 但这次起来了
		markBootSucceeded({ versionsRoot, version: "0.9.0" });

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

/**
 * 回退 = **钉住**一个版本。
 *
 * 定案是「只保留当前 + 上一版,只退一步,不给版本列表」,所以这里不是一个通用的
 * 版本选择器,而是一颗一次性的钉子:钉上之后选版不再按「取最新」走,直到我们
 * 自己拔掉它。
 */
describe("selectVersionForBoot —— 回退用的钉子", () => {
	it("钉住旧版之后就跑旧版,哪怕装着更新的载荷", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0", "0.10.0");
		pinVersion({ versionsRoot, version: "0.9.0" });

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: "/app",
			versionsRoot,
			maxBootFailures: 3,
		});

		// 不钉的话这里会选 0.10.0 —— 而 0.10.0 正是用户刚刚退出来的那一版。
		expect(selection.version).toBe("0.9.0");
		expect(selection.isImageVersion).toBe(false);
	});

	it("钉住镜像自带那版 → 跑镜像那份", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0");
		// 最常见的一次回退:只升过一次,上一版就是镜像自带的。
		pinVersion({ versionsRoot, version: "0.8.0" });

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: "/app",
			versionsRoot,
			maxBootFailures: 3,
		});

		expect(selection).toEqual({ version: "0.8.0", path: "/app", isImageVersion: true });
	});

	it("钉住的版本起不来 → 自愈压过钉子,不能钉死在一个开不了机的版本上", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0", "0.10.0");
		pinVersion({ versionsRoot, version: "0.9.0" });

		// 用户退回 0.9.0,结果 0.9.0 在他这台机器上也起不来。钉子要是压过自愈,
		// 他就再也进不去面板、也就再也拔不掉这颗钉子 —— 变成一个只能删 /data 才能
		// 脱身的死局。
		for (let i = 0; i < 3; i++)
			selectVersionForBoot({
				imageVersion: "0.8.0",
				imagePath: "/app",
				versionsRoot,
				maxBootFailures: 3,
			});

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: "/app",
			versionsRoot,
			maxBootFailures: 3,
		});
		expect(selection.version).not.toBe("0.9.0");
	});

	it("钉住的版本目录没了 → 当没钉过,别把进程卡在一个不存在的路径上", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.10.0");
		pinVersion({ versionsRoot, version: "0.9.0" });

		const selection = selectVersionForBoot({
			imageVersion: "0.8.0",
			imagePath: "/app",
			versionsRoot,
			maxBootFailures: 3,
		});

		expect(selection.version).toBe("0.10.0");
	});

	it("用户拉了更新的镜像 → 钉子作废,不然又是『我明明拉了新镜像』那个坑", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0");
		pinVersion({ versionsRoot, version: "0.9.0" });

		// 拉新镜像是一次明确的用户动作,它压过之前那次回退的意思。否则用户会
		// 拉着 0.11.0 的镜像、看着 0.9.0 的界面,而且没有任何线索。
		const selection = selectVersionForBoot({
			imageVersion: "0.11.0",
			imagePath: "/app",
			versionsRoot,
			maxBootFailures: 3,
		});

		expect(selection).toEqual({ version: "0.11.0", path: "/app", isImageVersion: true });
	});

	it("拔掉钉子就回到取最新", () => {
		const root = tempRoot();
		const versionsRoot = versionsWith(root, "0.9.0", "0.10.0");
		pinVersion({ versionsRoot, version: "0.9.0" });

		clearPinnedVersion({ versionsRoot });

		expect(
			selectVersionForBoot({
				imageVersion: "0.8.0",
				imagePath: "/app",
				versionsRoot,
				maxBootFailures: 3,
			}).version,
		).toBe("0.10.0");
	});

	it("钉子写不进去也不能拦着启动", () => {
		// 与 boot-state 其余部分同一条纪律:这份状态是启发,坏了不该让进程起不来。
		expect(() =>
			pinVersion({ versionsRoot: "/definitely/not/writable/bn", version: "0.9.0" }),
		).not.toThrow();
	});
});
