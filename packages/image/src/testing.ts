/**
 * `@bilibili-notify/image/testing` —— **只给测试用**的子路径,不是正式出口。
 *
 * 十份 `dynamic-*` 出图基准的输入是 `Post` 字面量({@link DYNAMIC_SAMPLE_POSTS}):本包的基准快照拿它出图,
 * `packages/dynamic` 的 `post-from-dynamic.test.ts` 拿 `postFromDynamic` 对 B 站原始夹具翻出来的结果与它逐项对一遍。
 * 同一份中间产物夹在两腿中间,「B 站原始数据 → 字节」整条链才都钉着 —— 而本包够不着 `packages/dynamic`,
 * 反过来 dynamic 是依赖本包的,所以夹具放这一头、从这个子路径递过去。
 *
 * 正式代码不许 import 这里(没有任何生产调用方,也不该有)。
 */

export { DYNAMIC_SAMPLE_POSTS } from "./__tests__/fixtures/post-fixtures";
