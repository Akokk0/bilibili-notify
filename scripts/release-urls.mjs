/**
 * 载荷包的资产名与它在 GitHub Release 上的地址 —— 只在这里写一遍。
 *
 * 这三个字符串横跨发版链的两端:发版那天由 `update-payload.yml` 打包并上传,撤回那天
 * 由 `revocation.mjs` 拿去现算 sha256、签进新清单。两端**永远不在同一天跑**,所以手抄
 * 一份的代价不是难看:改了资产名,发版照样全绿,而下一次撤回会签出一份指着 404 的清单
 * —— 客户端一路走到下载才失败,报的还是「下载失败」,没人会想到是名字对不上。
 *
 * workflow 那侧用 `node -p` 读它(那条流水线已经这么读 sha256 / size 了),
 * `release-urls.test.mjs` 顺带钉住 shell 里那几处仍与这里一致。
 */

/** @param {string} version 裸 semver,不带 v。 */
export function payloadAssetName(version) {
	return `bilibili-notify-payload-${version}.zip`;
}

/** @param {string} repo `owner/name` @param {string} version */
export function payloadUrl(repo, version) {
	return `https://github.com/${repo}/releases/download/v${version}/${payloadAssetName(version)}`;
}

/** @param {string} repo `owner/name` @param {string} version */
export function releaseUrl(repo, version) {
	return `https://github.com/${repo}/releases/tag/v${version}`;
}
