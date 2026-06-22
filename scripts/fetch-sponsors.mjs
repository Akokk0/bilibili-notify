import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * fetch-sponsors —— 半自动赞助者名单。CI(.github/workflows/sponsors.yml)定时调爱发电
 * `query-sponsor` 接口,生成 `apps/web/public/sponsors.json`(仅昵称),commit 回仓库;
 * 构建时随 web 进 dist/镜像。token 只放 CI secret,运行时/镜像零密钥。
 *
 * 需要环境变量:AFDIAN_USER_ID / AFDIAN_TOKEN(均在 afdian.com/dashboard/dev 获取)。
 * 纯函数(签名/解析/分页)导出供单测;真实拉取在 main guard 内,import 不触发。
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const OUT_FILE = resolve(repoRoot, "apps/web/public/sponsors.json");
// 用 .com:afdian.net 已被墙,现行域名是 afdian.com(开放 API 路径不变)。
const API_URL = "https://afdian.com/api/open/query-sponsor";

/**
 * 爱发电签名:sign = md5(token + 'params' + {params值} + 'ts' + {ts值} + 'user_id' + {user_id值})。
 * token 仅参与签名、不传服务端。见 https://guide.afdian.com/creator/developer。
 */
export function signRequest(token, paramsStr, ts, userId) {
	return createHash("md5")
		.update(`${token}params${paramsStr}ts${ts}user_id${userId}`)
		.digest("hex");
}

/** 构造单页请求体。params 仅含 page;ts 为秒级时间戳。 */
export function buildRequestBody({ userId, token, page, ts }) {
	const paramsStr = JSON.stringify({ page });
	return {
		user_id: userId,
		params: paramsStr,
		ts,
		sign: signRequest(token, paramsStr, ts, userId),
	};
}

/**
 * 从多页 query-sponsor 响应提取去重赞助者(昵称 + 头像 URL,按 name 去重、保留首次出现
 * 顺序、过滤空白昵称)。头像缺失时 avatar 为空串,前端按空处理。
 */
export function extractSponsors(responses) {
	const sponsors = [];
	const seen = new Set();
	for (const res of responses) {
		for (const item of res?.data?.list ?? []) {
			const name = item?.user?.name?.trim();
			if (name && !seen.has(name)) {
				seen.add(name);
				sponsors.push({ name, avatar: item?.user?.avatar ?? "" });
			}
		}
	}
	return sponsors;
}

/** 按 total_page 翻完所有页;ec !== 200 抛错。fetchImpl 可注入便于测试。 */
export async function fetchAllSponsors({ userId, token, fetchImpl = fetch }) {
	const responses = [];
	let page = 1;
	let totalPage = 1;
	do {
		const ts = Math.floor(Date.now() / 1000);
		const res = await fetchImpl(API_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(buildRequestBody({ userId, token, page, ts })),
		});
		const json = await res.json();
		if (json.ec !== 200) {
			throw new Error(`afdian query-sponsor failed: ec=${json.ec} em=${json.em ?? ""}`);
		}
		responses.push(json);
		totalPage = json?.data?.total_page ?? 1;
		page += 1;
	} while (page <= totalPage);
	return responses;
}

/** 字节 + content-type → base64 data URI。 */
export function avatarToDataUri(arrayBuffer, contentType) {
	return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString("base64")}`;
}

/**
 * 下载单个头像并转成 data URI,以便头像随 sponsors.json 固化、前端不必热链爱发电 CDN
 * (避免防盗链 / CDN 变动导致裂图)。空 url / 非 2xx / 网络错误一律回退空串(前端首字母占位)。
 */
export async function fetchAvatar({ url, fetchImpl = fetch }) {
	if (!url) return "";
	try {
		const res = await fetchImpl(url);
		if (!res.ok) return "";
		const contentType = res.headers.get("content-type") || "image/jpeg";
		return avatarToDataUri(await res.arrayBuffer(), contentType);
	} catch {
		return "";
	}
}

/** 把每个赞助者的 avatar(URL)替换成本地化的 data URI;失败者 avatar 置空。串行下载,规模小。 */
export async function localizeSponsors(sponsors, fetchImpl = fetch) {
	const out = [];
	for (const s of sponsors) {
		out.push({ name: s.name, avatar: await fetchAvatar({ url: s.avatar, fetchImpl }) });
	}
	return out;
}

/**
 * 生成 sponsors.json 内容。**不写时间戳** —— 带 generatedAt 会让每次 CI 运行的产物都不同,
 * 即使赞助者没变也触发 commit(每日空提交污染 dev)。只序列化赞助者数组,内容稳定 →
 * sponsors.yml 的「有变更才 commit」才名副其实。
 */
export function buildSponsorsFile(sponsors) {
	return { sponsors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const userId = process.env.AFDIAN_USER_ID;
	const token = process.env.AFDIAN_TOKEN;
	if (!userId || !token) {
		console.error("AFDIAN_USER_ID / AFDIAN_TOKEN env required");
		process.exit(1);
	}
	const responses = await fetchAllSponsors({ userId, token });
	const sponsors = await localizeSponsors(extractSponsors(responses));
	const file = buildSponsorsFile(sponsors);
	await mkdir(dirname(OUT_FILE), { recursive: true });
	await writeFile(OUT_FILE, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	console.log(`wrote ${sponsors.length} sponsors -> ${OUT_FILE}`);
}
