import { expect, it } from "vite-plus/test";

// 由 scripts/__tests__/network-guard.test.mjs 起子进程跑。第一条把被拦的报错吞掉,查账钩子
// 仍要判它失败;第二条什么都没连,不能被上一条的账连累。

it("吞掉外网报错", async () => {
	await fetch("http://bn-guard-probe.invalid/").catch(() => {});
});

it("之后的测试不受牵连", () => {
	expect(1 + 1).toBe(2);
});
