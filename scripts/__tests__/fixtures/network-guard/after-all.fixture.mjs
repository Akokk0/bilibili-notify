import { afterAll, expect, it } from "vite-plus/test";

// 由 scripts/__tests__/network-guard.test.mjs 起子进程跑。收尾钩子里连外网又吞掉报错:
// 已经没有下一条测试的 afterEach 了,要靠 setup 里的 afterAll 查账把整个文件判失败。

afterAll(async () => {
	await fetch("http://bn-guard-probe.invalid/after-all").catch(() => {});
});

it("用例本身没连", () => {
	expect(1 + 1).toBe(2);
});
