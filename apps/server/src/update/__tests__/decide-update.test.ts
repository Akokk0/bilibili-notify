import { describe, expect, it } from "vite-plus/test";
import { decideUpdate } from "../decide-update.js";
import type { Manifest } from "../signed-manifest.js";

/**
 * 决策只看 version / revoked / requires 三样,载荷描述与它无关 —— 但清单是**整体**
 * 必填的,所以这里补齐剩下那半边,免得每条用例都抄一遍。
 */
function manifest(fields: Partial<Manifest> & Pick<Manifest, "version">): Manifest {
	return {
		payload: {
			url: "https://github.com/o/r/releases/download/v0.0.0/p.zip",
			sha256: "a".repeat(64),
			size: 1024,
		},
		releaseUrl: "https://github.com/o/r/releases/tag/v0.0.0",
		issuedAt: 1,
		...fields,
	};
}

/**
 * 升级决策。纯函数,不碰网络、不碰磁盘 —— 「要不要升、升到哪」的全部判断都收在
 * 这里,好让每一条规则(撤回、预发布、运行时门槛)都能被单独钉住。
 */
describe("decideUpdate", () => {
	it("0.10.0 比 0.9.0 新 —— 版本必须按数字段比,不能按字符串比", () => {
		// 按字典序 "0.10.0" < "0.9.0",朴素实现会判成「已是最新」,让所有人卡在
		// 0.9.x 再也升不动,而且门禁全绿、直到发第十个小版本才爆。
		const decision = decideUpdate({
			currentVersion: "0.9.0",
			manifest: manifest({ version: "0.10.0" }),
			runtime: { nodeMajor: 24 },
		});

		expect(decision).toEqual({ kind: "update", target: "0.10.0" });
	});

	it("更新的那个版本已被撤回 → 当作没有可升的,不推给用户", () => {
		// 自主升级把「发了个坏版本」的爆炸半径从「手动升级的人」放大到全体。撤回名单
		// 是唯一能在事后拦住**还没升的人**的手段(已经中招的靠客户端自愈,不靠这里)。
		const decision = decideUpdate({
			currentVersion: "0.8.0",
			manifest: manifest({ version: "0.9.0", revoked: ["0.9.0"] }),
			runtime: { nodeMajor: 24 },
		});

		expect(decision).toEqual({ kind: "up-to-date" });
	});

	it("新版本要的 Node 比当前运行时高 → 『需要重拉镜像』,既不是可升也不是错误", () => {
		// 载荷能比镜像新,但 Node / chromium / 字体 / tini **全部来自镜像**。把一个要
		// 新 Node 的载荷塞进老镜像里就是直接跑不起来 —— 必须在这里拦下,并且明确
		// 告诉用户「这一版得重新拉镜像」,而不是崩了让他猜。
		const decision = decideUpdate({
			currentVersion: "0.8.0",
			manifest: manifest({ version: "0.9.0", requires: { nodeMajor: 26 } }),
			runtime: { nodeMajor: 24 },
		});

		expect(decision).toEqual({ kind: "needs-image-pull", target: "0.9.0" });
	});

	it("预发布版本默认不推 —— 通道提供,但默认关着", () => {
		const decision = decideUpdate({
			currentVersion: "0.8.0",
			manifest: manifest({ version: "0.9.0-alpha.1" }),
			runtime: { nodeMajor: 24 },
		});

		expect(decision).toEqual({ kind: "up-to-date" });
	});

	it("开了预发布通道,也不能把 0.9.0-alpha.1 当成比 0.9.0 新", () => {
		// semver 里预发布**低于**同号正式版。判反了就会把尝鲜用户从 0.9.0 正式版
		// 推回 alpha —— 一次静默降级,而且降完撞上的是已被前向迁移改写过的磁盘数据。
		const decision = decideUpdate({
			currentVersion: "0.9.0",
			manifest: manifest({ version: "0.9.0-alpha.1" }),
			runtime: { nodeMajor: 24 },
			allowPrerelease: true,
		});

		expect(decision).toEqual({ kind: "up-to-date" });
	});

	it("开了预发布通道就照常推 alpha", () => {
		const decision = decideUpdate({
			currentVersion: "0.8.0",
			manifest: manifest({ version: "0.9.0-alpha.1" }),
			runtime: { nodeMajor: 24 },
			allowPrerelease: true,
		});

		expect(decision).toEqual({ kind: "update", target: "0.9.0-alpha.1" });
	});

	it("alpha.10 高于 alpha.9 —— 预发布段也得按数值比", () => {
		// 本仓真发过两位数的 alpha(v0.1.0-alpha.13)。按字符串比 "alpha.10" < "alpha.9",
		// 尝鲜用户会在 alpha.9 上卡死,而且和 core 段那个坑一样:门禁全绿,发到第十个
		// 预发布版才爆。
		const decision = decideUpdate({
			currentVersion: "0.9.0-alpha.9",
			manifest: manifest({ version: "0.9.0-alpha.10" }),
			runtime: { nodeMajor: 24 },
			allowPrerelease: true,
		});

		expect(decision).toEqual({ kind: "update", target: "0.9.0-alpha.10" });
	});
});

describe("decideUpdate —— 撤回名单对**当前**版本说话", () => {
	it("正在跑的版本被撤回、清单给的是更旧的修复版 → 照样当更新目标(这是降级,也是撤回的本意)", () => {
		// 文档写的用法是「在下一份清单的 revoked 里列上坏版本号」。发出去的坏版本收不回来,
		// 但已经装上、还能正常启动的那批用户只有这一条路能被带走 —— 而修复版未必比坏版本
		// 的版本号大(常见做法是把渠道退回上一个好版本)。只比大小的话,他们看到的永远是
		// 「已是最新」。
		const decision = decideUpdate({
			currentVersion: "0.9.1",
			manifest: manifest({ version: "0.9.0", revoked: ["0.9.1"] }),
			runtime: { nodeMajor: 24 },
		});

		expect(decision).toEqual({ kind: "update", target: "0.9.0" });
	});

	it("当前版本被撤回,但清单那版也在撤回名单里 → 没有可去的地方,up-to-date", () => {
		const decision = decideUpdate({
			currentVersion: "0.9.1",
			manifest: manifest({ version: "0.9.0", revoked: ["0.9.1", "0.9.0"] }),
			runtime: { nodeMajor: 24 },
		});

		expect(decision).toEqual({ kind: "up-to-date" });
	});
});
