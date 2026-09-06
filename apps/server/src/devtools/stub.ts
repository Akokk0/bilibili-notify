import type { CreateDevtoolsInput, Devtools } from "./index.js";

/**
 * 构建产物里的 devtools —— 也就是没有。
 *
 * `apps/server/vite.config.ts` 在**任何**构建(lib 与 bundle 都算)里把 `./devtools/index.js`
 * 解析到这个文件,于是整套 devtools 从产物里连根消失:不是「挂着但门关着」,是根本没有
 * 这段代码。devtools 只在 tsx 直跑源码时存在,那时这个桩不参与。
 *
 * 签名照抄真的那份,index.ts 那边一行不用改;类型从 `./index.js` 拿的是 `import type`,
 * 擦掉之后不会把真模块牵进来。
 */
export function createDevtools(_input: CreateDevtoolsInput): Devtools | null {
	return null;
}
