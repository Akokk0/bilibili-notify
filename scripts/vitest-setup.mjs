import { afterAll, afterEach } from "vite-plus/test";
import { assertNoErrorBodyViolations, errorBodyGuard } from "./error-body-guard.mjs";
import { assertNoBlockedConnections, networkGuard } from "./network-guard.mjs";

// 根 vite.config 的 test.setupFiles:每个测试文件跑之前先装上记账式守卫,每条测试收尾查一次账
// (beforeAll 与模块顶层发起的,记在第一条测试头上);afterAll 兜住最后一条测试之后才发起的 ——
// 文件自己的 afterAll、迟到的后台任务。
//   - 测试拦外网(network-guard.mjs):连非本机地址的连接、查外网名字的 DNS。
//   - 错误体(error-body-guard.mjs):服务端代码回的非 2xx 体必须是 { code, message }。
// 各家的账先全部交出来、再逐家查:一家抛了不能让另一家的账留到下一条测试头上。
const guards = [
	[networkGuard(), assertNoBlockedConnections],
	[errorBodyGuard(), assertNoErrorBodyViolations],
];

function audit() {
	const ledgers = guards.map(([guard, assertClean]) => [guard.drain(), assertClean]);
	const failures = [];
	for (const [entries, assertClean] of ledgers) {
		try {
			assertClean(entries);
		} catch (err) {
			failures.push(err);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new Error(failures.map((e) => e.message).join("\n\n"));
}

afterEach(audit);
afterAll(audit);
