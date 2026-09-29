// 服务端目录里的 __tests__ 支撑文件:它造的假回应算测试自己的。
export function fakeUpstream500() {
	return new Response("upstream down", { status: 500 });
}
