/** 只读探针:不带 refreshToken 加载(绝不触发刷新舞步),问一次身份。 */
import { makeServiceCtx, openReadonlyApi } from "./_env.ts";

const api = await openReadonlyApi(makeServiceCtx());
const myself = await api.getMyselfInfoCached();
console.log("probe:", JSON.stringify({ code: myself.code, mid: myself.data?.mid }));
process.exit(0);
