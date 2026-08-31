import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * tauri.conf.json 的 before* 命令必须写死本仓那份 vp,不能写裸 `vp`。
 *
 * 裸名字会被 tauri 自己劫持:它解析 `beforeDevCommand` 时按目录逐级向上收集
 * `node_modules/.bin`,而本仓是**嵌在另一个项目里的**
 * (`bilibili-notify-dev/external/bilibili-notify`),外层那份 yarn 装的
 * vite-plus 0.2.1 排在本仓前面就被选中 —— 2026-08-31 实测祖先链:
 *   node <外层>/node_modules/.bin/vp run front:dev
 *
 * 症状是 `dev:desktop` 打出 `VITE+ v0.2.1`。**极难查**:脚本内 `which -a vp` 和
 * `vp --version` 都老老实实报 0.3.0(本仓 .bin 排第一),看着完全无辜 —— 中招的是
 * 「谁在跑这个脚本」,不是脚本里解析到谁。而且删 node_modules 重装治不了
 * (本仓根就摆着 0.3.0,任何经过仓库根的查找都会先撞到它),我在这上面误诊过两轮。
 * 影响面:0.2.1 只当任务运行器,真正编译的仍是本仓 0.3.0 的 core,所以**门禁全绿、
 * 产物也正常**,只有横幅和 `vp run` 那层的行为是旧的 —— 没有任何别的东西会报警。
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(here);
const conf = JSON.parse(readFileSync(join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));

describe("tauri before* 命令", () => {
	const entries = [
		["beforeDevCommand", conf.build?.beforeDevCommand],
		["beforeBuildCommand", conf.build?.beforeBuildCommand],
	];

	for (const [key, command] of entries) {
		it(`${key} 不用裸 vp(会被外层项目的旧 vp 劫持)`, () => {
			expect(command).toBeTypeOf("string");
			expect(command).not.toMatch(/^\s*vpx?r?\s/);
		});

		/**
		 * 这条是 2026-08-31 v0.8.0 发版当场用一次 Windows 构建失败换来的。
		 *
		 * 上一版把第一个词写成了 `../../node_modules/.bin/vp`,macOS 上好好的
		 * —— 但 tauri 在 Windows 上是拿 `cmd /C` 跑 before* 命令的,cmd **不能把
		 * 正斜杠相对路径当命令名执行**,原地回一句
		 * `'..' is not recognized as an internal or external command`;
		 * 何况 `.bin/vp` 是 shell 脚本,Windows 上要走的是同目录的 `vp.cmd`。
		 *
		 * 所以第一个词必须是**能在 PATH 上找到的裸命令名**(`node`),真正的路径
		 * 降级成它的参数 —— 参数位置上 Node 两个平台都认正斜杠。
		 * 本地在 macOS 上验这个文件是验不出来的,只有这条断言拦得住。
		 */
		it(`${key} 的第一个词是 PATH 上的裸命令 —— Windows 的 cmd 执行不了相对路径`, () => {
			const bin = command.split(/\s+/)[0];
			expect(bin).not.toMatch(/[/\\]/);
		});

		it(`${key} 经 node 跑本仓那份 vp,而且那个文件真的在`, () => {
			// tauri 实测以 apps/desktop 为 cwd 跑 before* 命令,相对路径按它解析。
			const [bin, script] = command.split(/\s+/);
			expect(bin).toBe("node");
			// .bin/ 里的是 shim(Windows 上是 vp.cmd),这里要的是真身那个 JS。
			expect(script).toBe("../../node_modules/vite-plus/bin/vp");
			expect(existsSync(resolve(desktopRoot, script))).toBe(true);
		});
	}
});
