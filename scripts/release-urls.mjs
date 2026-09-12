/**
 * 发布物的资产名与它们在 GitHub Release 上的地址 —— 只在这里写一遍。
 *
 * 两组:本体的**升级载荷**(下面第一段),和一个**拓展包**(第二段)。
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

// ---------------- 拓展包 -------------------------------------------------------
//
// 同一个理由,只是链更短:打包(`pack-extension.mjs`)、写索引条目
// (`marketplace-entry.mjs`)、上传(`extension-release.yml`)三处说的必须是同一个名字。
// 索引里那条 URL 一旦指错,客户端要一路走到下载才失败,报的还是「下载失败」。

/** @param {string} id @param {string} version */
export function extensionAssetName(id, version) {
	return `${id}-${version}.zip`;
}

/**
 * 那个**不可变** release 的 tag。`extension/<id>@<version>` —— 斜杠与 `@` 都在里头,
 * 所以拼进 URL 时必须整段转义(见下面两条),而 `gh release create` 要的是没转义的原样。
 *
 * ⚠️ **别把它跟 URL 面那个 `ext` 拉平**(ADR-0012 决策 38:对外路径一律 `/ext/<id>`)。
 * 那是面板与桥拨的地址,天天出现在配置里,短一点是对的;这个是 GitHub 发布页上给**素不
 * 相识的人**看的一行字,和 `v0.11.0` 并排列着 —— 那儿写全称才看得懂这是个拓展。
 *
 * @param {string} id @param {string} version
 */
export function extensionTag(id, version) {
	return `extension/${id}@${version}`;
}

/** @param {string} repo `owner/name` @param {string} id @param {string} version */
export function extensionPackageUrl(repo, id, version) {
	const tag = encodeURIComponent(extensionTag(id, version));
	return `https://github.com/${repo}/releases/download/${tag}/${extensionAssetName(id, version)}`;
}

/** @param {string} repo `owner/name` @param {string} id @param {string} version */
export function extensionReleaseUrl(repo, id, version) {
	return `https://github.com/${repo}/releases/tag/${encodeURIComponent(extensionTag(id, version))}`;
}
