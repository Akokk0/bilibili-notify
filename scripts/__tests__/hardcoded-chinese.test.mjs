import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { auditRatchet } from "../ratchet-audit.mjs";
import { findNodes, listSources, parseSource, srcRootsUnder, ts } from "../source-scan.mjs";

/**
 * 写死的中文棘轮:服务端、面板与各包的源码里,带汉字的字符串节点只许少、不许多
 * (ADR-0037 决策 16 第四个小点;docs/1.0/architecture.md 第二层静态扫描「写死的中文」那一行)。
 * 给人看的话进字典(服务端 `t`、面板 `useT()`、各包与 contract 的 `packageText`),不再写死在源码里;这道守卫让「还剩多少处」看得见、只往下走,
 * 管到第 4 期结束。
 *
 * - 范围:`apps/server/src`、`apps/web/src`、`apps/contract/src`、`packages/<包>/src`,不含测试、`.d.ts`。
 *   拓展(`extensions/`,由各自的 `locales/` 管,决策 14)与桌面壳(`apps/desktop/src`,启动壳,没有字典可进)不扫。
 * - 判据看语法树(注释天生不是节点):**一个带汉字(`\p{Script=Han}`)的字符串节点算一处**。节点有四种:
 *   字符串字面量(含类型位置的、对象的字符串键、JSX 属性值)、不带插值的反引号串、带插值的模板
 *   (头和各段里任何一段带汉字,整个模板算**一处**,里面嵌的字符串另算)、JSX 文字。判 `node.text`(转义已解开),
 *   不判源码原文。
 * - 日志调用的参数(深一层也算在内)不算(决策 13,日志不翻):方法是 `trace` / `debug` / `info` / `warn` / `error` /
 *   `fatal` / `log`,接收者最后一段叫 `log` / `logger` / `console`(`this.logger`、`ctx.logger`、`opts.logger?.warn`);
 *   另加裸函数 `log(...)` / `warn(...)`。
 * - 整目录不扫:三个开发版调试面板(`devtools/`),只在开发版源码上跑,构建时换成空桩或摇掉。
 * - 白名单(整个文件放行):整份都是「永远不翻」的中文 —— 给模型的话(提示词、工具回给模型的话,决策 11)与词云停用词表。
 *   提示词和给人看的字混在一个文件里的,照常记棘轮(行内注释写明),到不了 0。
 * - 棘轮按文件记上限(对账见 `scripts/ratchet-audit.mjs`):多一处就红,上限高于实数也红,清零了整行删。
 *   **涨了一律红,调格前问主人**(包与 contract 也一样)。
 *
 * 抓不到的(靠审查与别的守卫):
 * - 先赋给变量再交给日志的(`const m = "坏了"; logger.warn(m);`):字符串在日志调用外面,照算(钉住现状,漏排)。
 * - 名字碰巧叫 `log` / `warn` 却不是日志的函数(目前没看到):会被漏排。
 * - `new Error("…")`、问题上报、`fail(code, "…")` 里的话:会进私聊、问题表或失败 `message`,是给人看的字,照算。
 * - 正则字面量里的中文(`/^(帮助|help)$/`):是认输入用的(决策 9),不是字符串节点。
 * - 中文标识符(`const 直播 = 1`):不是字符串节点。
 * - 只有中文标点或假名的串(`"，"`、`"です"`):不带汉字,不算。
 * - 拓展与桌面壳里的中文(上面说了,不扫);`locales/*.json` 里的话(JSON 没有语法树,第 4 期的中文叫法棘轮开张时一起扫)。
 * - 字符串拼出来的中文(`"直" + "播"`):每一段各算各的;`String.fromCharCode` 之类拼出的抓不到。
 *
 * 判据写成纯函数 + 样例:一条永远判 OK 的规则跟没有一样。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 整个目录放行(仓库相对、带结尾斜杠),写明理由。 */
export const EXCLUDED_DIRS = {
	"apps/server/src/devtools/": "开发版专属的调试面板(服务端),构建时换成空桩",
	"apps/server/src/bilibili/devtools/":
		"开发版专属的调试面板(B 站引擎的造状态与造事件),构建时换成空桩",
	"apps/web/src/devtools/": "开发版专属的调试面板(面板),构建时摇掉",
};

/** 白名单:整个文件放行,写明理由。 */
export const ALLOWLIST = {
	"apps/server/src/bilibili/ai-tool-texts.ts":
		"B 站女仆工具回给模型的话:同提示词,不翻(决策 11,主人定)",
	"apps/server/src/bilibili/weekly-report-skill.ts":
		"B 站版周报技能:给模型的提示词,不翻(决策 11,主人定)",
	"apps/server/src/maid-skills/builtin.ts":
		"内置女仆技能:给模型的提示词(说明同时显示在面板上),不翻(决策 11,主人定)",
	"apps/server/src/live/recap/stop-words.ts": "词云的中文停用词表:整份是数据,不是给人看的话",
	"apps/server/src/ai/creator-reader-texts.ts":
		"创作者阅读工具回给模型的话:同提示词,不翻(决策 11,主人定)",
	"packages/ai/src/prompt-nouns.ts": "提示词里的中性叫法:同提示词,不翻(决策 11,主人定)",
	"packages/ai/src/tool-texts.ts": "AI 工具回给模型的话:同提示词,不翻(决策 11,主人定)",
};

/** 报错后面带的那句:越界怎么办。 */
export const ADVICE =
	"若是新写的给人看的话:服务端写进 `apps/server/src/i18n/locales/zh-CN.json` 经 `t(...)` 取,面板写进 `apps/web/src/i18n/locales/zh-CN.json` 经 `useT()` 取,各包与 contract 写进 `packages/internal/src/texts/locales/zh-CN.json`(键用包名开头)经 `packageText(...)` 取;若是给模型的提示词、或这道守卫的判据打不准:去问主人,由主人定是加上限还是改判据,不要自己加,也不要起别的形状躲;数降了就当场把这一格调低,清零了整行删";

/**
 * 棘轮表:文件 → 命中的上限(开张时的现数:365 个文件 5601 处)。只许往下调。行内注释只如实写这一格是什么。
 */
export const RATCHET = {
	"apps/contract/src/maid-skill.ts": 5,
	"apps/contract/src/skin.ts": 33,
	"apps/server/src/ai/conversation-store.ts": 1,
	"apps/server/src/ai/tool-label-texts.ts": 10,
	"apps/server/src/assets/asset-store.ts": 5,
	"apps/server/src/auth/dashboard-auth.ts": 1,
	"apps/server/src/auth/desktop-token.ts": 1,
	"apps/server/src/backup/assemble.ts": 3,
	"apps/server/src/backup/crypto.ts": 1,
	"apps/server/src/backup/rejected-error.ts": 1,
	"apps/server/src/bilibili/api/api-client.ts": 1,
	"apps/server/src/bilibili/api/api.ts": 12,
	"apps/server/src/bilibili/api/wbi.ts": 1,
	"apps/server/src/bilibili/auth/index.ts": 1,
	"apps/server/src/bilibili/auth/login-flow.ts": 3,
	"apps/server/src/bilibili/auth/login-state.ts": 9,
	"apps/server/src/bilibili/context.ts": 1,
	"apps/server/src/bilibili/dynamic/dynamic-poller.ts": 7,
	"apps/server/src/bilibili/dynamic/post-from-dynamic.ts": 18,
	"apps/server/src/bilibili/health-texts.ts": 3,
	"apps/server/src/bilibili/images.ts": 2,
	"apps/server/src/bilibili/link-resolver-texts.ts": 2,
	"apps/server/src/bilibili/live/protocol/client.ts": 2,
	"apps/server/src/bilibili/live/session/room-helpers.ts": 6,
	"apps/server/src/bilibili/live/session/room-session.ts": 10,
	"apps/server/src/bilibili/problem-layers.ts": 8,
	"apps/server/src/bilibili/settings.ts": 2,
	"apps/server/src/bilibili/source.ts": 7,
	"apps/server/src/bilibili/video-card.ts": 1,
	"apps/server/src/boot.ts": 1,
	"apps/server/src/card-skins/ai-css.ts": 36, // 含给模型的提示词(决策 11 不翻)
	"apps/server/src/card-skins/chat-tools.ts": 103, // 含给模型的提示词(决策 11 不翻)
	"apps/server/src/card-skins/css-sanitizer.ts": 1,
	"apps/server/src/card-skins/html-sanitizer.ts": 22,
	"apps/server/src/card-skins/package.ts": 13,
	"apps/server/src/card-skins/preview-html.ts": 2,
	"apps/server/src/card-skins/store.ts": 28,
	"apps/server/src/config/loader.ts": 7,
	"apps/server/src/config/settings-problems.ts": 51,
	"apps/server/src/config/validation-error.ts": 8,
	"apps/server/src/extensions/install.ts": 15,
	"apps/server/src/extensions/loader.ts": 13,
	"apps/server/src/extensions/marketplace.ts": 20,
	"apps/server/src/extensions/mount.ts": 2,
	"apps/server/src/extensions/settings-io.ts": 17,
	"apps/server/src/extensions/view-check.ts": 39,
	"apps/server/src/history/repush-runner.ts": 2,
	"apps/server/src/history/repush-store.ts": 2,
	"apps/server/src/history/repush.ts": 6,
	"apps/server/src/history/store.ts": 7,
	"apps/server/src/images/image-fetcher.ts": 7,
	"apps/server/src/images/image-referrers.ts": 9,
	"apps/server/src/images/image-store.ts": 3,
	"apps/server/src/images/image-writes.ts": 4,
	"apps/server/src/index.ts": 10,
	"apps/server/src/integration-store/files.ts": 3,
	"apps/server/src/integration-store/key-value-store.ts": 15,
	"apps/server/src/integration-store/store.ts": 9,
	"apps/server/src/integrations/context.ts": 4,
	"apps/server/src/integrations/http.ts": 2,
	"apps/server/src/integrations/settings-reader.ts": 1,
	"apps/server/src/live/live-push.ts": 12,
	"apps/server/src/live/live-sessions.ts": 4,
	"apps/server/src/live/live-text.ts": 1,
	"apps/server/src/live/recap/live-summary-requester.ts": 7,
	"apps/server/src/maid-skills/chat-tool.ts": 5,
	"apps/server/src/maid-skills/parse.ts": 6,
	"apps/server/src/maid-skills/store.ts": 12,
	"apps/server/src/migration/ai.ts": 1,
	"apps/server/src/migration/bili-login.ts": 6,
	"apps/server/src/migration/connections.ts": 2,
	"apps/server/src/migration/files.ts": 4,
	"apps/server/src/migration/followers.ts": 1,
	"apps/server/src/migration/history-images.ts": 2,
	"apps/server/src/migration/history.ts": 2,
	"apps/server/src/migration/keyed-records.ts": 1,
	"apps/server/src/migration/live-placeholders.ts": 3,
	"apps/server/src/migration/membership-moves.ts": 1,
	"apps/server/src/migration/recording.ts": 2,
	"apps/server/src/migration/roast-drafts.ts": 2,
	"apps/server/src/migration/stats.ts": 2,
	"apps/server/src/migration/subscriptions.ts": 1,
	"apps/server/src/migration/templates.ts": 10,
	"apps/server/src/migration/zero-platforms.ts": 14,
	"apps/server/src/migration/zero-vocabulary.ts": 8,
	"apps/server/src/platforms/qq-bind.ts": 15,
	"apps/server/src/platforms/upstream-message.ts": 1,
	"apps/server/src/posts/deliver-post.ts": 2,
	"apps/server/src/posts/post-text.ts": 4,
	"apps/server/src/push/adapter-context.ts": 7,
	"apps/server/src/push/connection-settings.ts": 2,
	"apps/server/src/push/dispatch.ts": 1,
	"apps/server/src/push/target-dispatcher.ts": 1,
	"apps/server/src/routes/ai-skills.ts": 1,
	"apps/server/src/routes/ai.ts": 18,
	"apps/server/src/routes/cards-skins.ts": 23,
	"apps/server/src/routes/command-alias-guard.ts": 2,
	"apps/server/src/routes/connections.ts": 8,
	"apps/server/src/routes/dashboard-skins.ts": 20,
	"apps/server/src/routes/history.ts": 8,
	"apps/server/src/routes/images.ts": 1,
	"apps/server/src/routes/masked-cells.ts": 2,
	"apps/server/src/routes/request-body.ts": 2,
	"apps/server/src/routes/respond-failure.ts": 8,
	"apps/server/src/routes/roast-approval-guard.ts": 6,
	"apps/server/src/routes/session.ts": 5,
	"apps/server/src/routes/stats.ts": 4,
	"apps/server/src/routes/system-logs.ts": 6,
	"apps/server/src/routes/system-update.ts": 2,
	"apps/server/src/routes/system.ts": 15,
	"apps/server/src/routes/targets.ts": 9,
	"apps/server/src/routes/test-result.ts": 3,
	"apps/server/src/routes/upload-limit.ts": 1,
	"apps/server/src/runtime/card-assets.ts": 2,
	"apps/server/src/runtime/command-dispatcher.ts": 3,
	"apps/server/src/runtime/command-help.ts": 6,
	"apps/server/src/runtime/command-params.ts": 18,
	"apps/server/src/runtime/font-assets.ts": 2,
	"apps/server/src/runtime/generations.ts": 2,
	"apps/server/src/runtime/login-command.ts": 5,
	"apps/server/src/runtime/mute-command.ts": 3,
	"apps/server/src/runtime/report-command.ts": 7,
	"apps/server/src/runtime/resource-monitor.ts": 1,
	"apps/server/src/runtime/roast-command.ts": 6,
	"apps/server/src/runtime/roots.ts": 15,
	"apps/server/src/runtime/status-command.ts": 13,
	"apps/server/src/runtime/storage-usage.ts": 8,
	"apps/server/src/runtime/subscription-avatar.ts": 1,
	"apps/server/src/skins/ai-create.ts": 2,
	"apps/server/src/skins/ai-edit.ts": 15, // 含给模型的提示词(决策 11 不翻)
	"apps/server/src/skins/chat-tool.ts": 17,
	"apps/server/src/skins/package.ts": 9,
	"apps/server/src/skins/schema.ts": 32,
	"apps/server/src/skins/scoped-css.ts": 33,
	"apps/server/src/skins/skin-store.ts": 4,
	"apps/server/src/skins/store.ts": 17,
	"apps/server/src/stats/roast-deliver.ts": 6,
	"apps/server/src/stats/roast.ts": 39, // 含给模型的提示词(决策 11 不翻)
	"apps/server/src/subscriptions/source-context.ts": 2,
	"apps/server/src/util/failure-text.ts": 4,
	"apps/server/src/ws/server.ts": 2,
	"apps/server/src/zip-junk.ts": 3,
	"apps/web/src/components/AuthGate.tsx": 1,
	"apps/web/src/components/LoginDialog.tsx": 9,
	"apps/web/src/components/ai-chat/card-skin-preview.tsx": 9,
	"apps/web/src/components/ai-chat/composer.tsx": 18,
	"apps/web/src/components/ai-chat/index.tsx": 23,
	"apps/web/src/components/ai-chat/markdown.tsx": 1,
	"apps/web/src/components/ai-chat/messages.tsx": 13,
	"apps/web/src/components/ai-chat/persona.ts": 2,
	"apps/web/src/components/ai-chat/search-control.tsx": 4,
	"apps/web/src/components/ai-chat/sidebar.tsx": 14,
	"apps/web/src/components/ai-chat/thinking-control.tsx": 4,
	"apps/web/src/components/ai-chat/thinking-level-setting.tsx": 6,
	"apps/web/src/components/alert-shell.tsx": 2,
	"apps/web/src/components/browser-source-settings.tsx": 24,
	"apps/web/src/components/chrome-autodetect.tsx": 15,
	"apps/web/src/components/commands-settings.tsx": 12,
	"apps/web/src/components/draft-island.tsx": 12,
	"apps/web/src/components/drag-handle.tsx": 3,
	"apps/web/src/components/error-boundary.tsx": 6,
	"apps/web/src/components/forms.tsx": 10,
	"apps/web/src/components/header.tsx": 33,
	"apps/web/src/components/inherit-note.tsx": 1,
	"apps/web/src/components/link-preview-settings.tsx": 38,
	"apps/web/src/components/onboarding/derive.ts": 1,
	"apps/web/src/components/onboarding/reopen-section.tsx": 4,
	"apps/web/src/components/onboarding/tour-companion.tsx": 29,
	"apps/web/src/components/onboarding/tour-script.ts": 21,
	"apps/web/src/components/override-box.tsx": 3,
	"apps/web/src/components/qq-address-pickers.tsx": 19,
	"apps/web/src/components/qq-qr-bind.tsx": 16,
	"apps/web/src/components/scope-tabs.tsx": 10,
	"apps/web/src/components/shell-states.tsx": 7,
	"apps/web/src/components/skin-preview-bar.tsx": 5,
	"apps/web/src/components/system-resource-card.tsx": 23,
	"apps/web/src/components/target-chip-picker.tsx": 1,
	"apps/web/src/components/toast-shell.tsx": 3,
	"apps/web/src/components/untrusted-markdown.tsx": 2,
	"apps/web/src/components/update/mirror-picker.tsx": 12,
	"apps/web/src/components/update/restart.ts": 6,
	"apps/web/src/components/update/status.ts": 14,
	"apps/web/src/components/update/update-section.tsx": 46,
	"apps/web/src/config/auth-status.ts": 6,
	"apps/web/src/config/field-labels.ts": 212,
	"apps/web/src/config/nav.ts": 12,
	"apps/web/src/config/push-features.ts": 20,
	"apps/web/src/hooks/useUpdateCheckOnOpen.ts": 1,
	"apps/web/src/hooks/useUpdateTransitionNotice.ts": 4,
	"apps/web/src/pages/About.tsx": 30,
	"apps/web/src/pages/CardSkinEditor.tsx": 15,
	"apps/web/src/pages/Dashboard.tsx": 75,
	"apps/web/src/pages/ExtensionDetail.tsx": 20,
	"apps/web/src/pages/History.tsx": 50,
	"apps/web/src/pages/Logs.tsx": 16,
	"apps/web/src/pages/Rules.tsx": 12,
	"apps/web/src/pages/Stats.tsx": 77,
	"apps/web/src/pages/System.tsx": 52,
	"apps/web/src/pages/Targets.tsx": 184,
	"apps/web/src/pages/ai/MaidSkills.tsx": 28,
	"apps/web/src/pages/ai/TestPanel.tsx": 7,
	"apps/web/src/pages/ai/model-ops.ts": 4,
	"apps/web/src/pages/backup/BackupExportDialog.tsx": 15,
	"apps/web/src/pages/backup/BackupImportDialog.tsx": 16,
	"apps/web/src/pages/backup/BackupSection.tsx": 20,
	"apps/web/src/pages/backup/backup-file.ts": 1,
	"apps/web/src/pages/backup/dialog-bits.tsx": 1,
	"apps/web/src/pages/backup/summary.ts": 12,
	"apps/web/src/pages/cards/CardSkinKnobs.tsx": 16,
	"apps/web/src/pages/cards/CardSkinSection.tsx": 32,
	"apps/web/src/pages/cards/CssAiSlot.tsx": 16,
	"apps/web/src/pages/cards/CssEditor.tsx": 19,
	"apps/web/src/pages/cards/SkinCanvas.tsx": 24,
	"apps/web/src/pages/cards/SkinInspector.tsx": 134,
	"apps/web/src/pages/cards/SkinPreviewPane.tsx": 22,
	"apps/web/src/pages/cards/card-skin-ai.ts": 3,
	"apps/web/src/pages/cards/cell-debug.ts": 3,
	"apps/web/src/pages/cards/css-value-shapes.ts": 137,
	"apps/web/src/pages/cards/preview-error.ts": 4,
	"apps/web/src/pages/cards/skin-draft-ops.ts": 31,
	"apps/web/src/pages/extensions/declarative/blocks.tsx": 5,
	"apps/web/src/pages/extensions/declarative/extension-page.tsx": 6,
	"apps/web/src/pages/extensions/declarative/list-items.ts": 14,
	"apps/web/src/pages/extensions/declarative/list-new-item.tsx": 15,
	"apps/web/src/pages/extensions/declarative/list-section.tsx": 34,
	"apps/web/src/pages/extensions/declarative/parts.tsx": 6,
	"apps/web/src/pages/extensions/declarative/settings-form.tsx": 21,
	"apps/web/src/pages/extensions/docs-panel.tsx": 5,
	"apps/web/src/pages/extensions/install-outcome.tsx": 6,
	"apps/web/src/pages/extensions/marketplace-section.tsx": 26,
	"apps/web/src/pages/extensions/marketplace-sources-dialog.tsx": 12,
	"apps/web/src/pages/extensions/report-discrepancies.tsx": 7,
	"apps/web/src/pages/extensions/shared.tsx": 1,
	"apps/web/src/pages/extensions/staged-code-note.tsx": 14,
	"apps/web/src/pages/extensions/state-meta.ts": 8,
	"apps/web/src/pages/guide/guide-panel.tsx": 6,
	"apps/web/src/pages/rules/MessageLayoutEditor.tsx": 14,
	"apps/web/src/pages/rules/PerUpEditor.tsx": 63,
	"apps/web/src/pages/rules/message-layout-utils.ts": 4,
	"apps/web/src/pages/rules/sections.tsx": 108,
	"apps/web/src/pages/skins/SkinEditor.tsx": 120,
	"apps/web/src/pages/skins/SkinSection.tsx": 29,
	"apps/web/src/pages/skins/skin-edit.ts": 38,
	"apps/web/src/pages/stats/RoastCard.tsx": 15,
	"apps/web/src/pages/stats/RoastPushBox.tsx": 8,
	"apps/web/src/pages/stats/RoastRunNowBox.tsx": 33,
	"apps/web/src/pages/stats/RoastScheduleBox.tsx": 5,
	"apps/web/src/pages/stats/RoastScheduleFields.tsx": 17,
	"apps/web/src/pages/stats/RoastShell.tsx": 4,
	"apps/web/src/pages/stats/SoloRoastCard.tsx": 10,
	"apps/web/src/pages/stats/SoloRoastScheduleBox.tsx": 5,
	"apps/web/src/pages/stats/chart-utils.ts": 5,
	"apps/web/src/pages/stats/charts.tsx": 11,
	"apps/web/src/pages/stats/columns.ts": 8,
	"apps/web/src/pages/stats/csv.ts": 12,
	"apps/web/src/pages/stats/radar.ts": 10,
	"apps/web/src/pages/stats/ranges.ts": 3,
	"apps/web/src/pages/up/TagEditDialog.tsx": 8,
	"apps/web/src/pages/up/UpCard.tsx": 8,
	"apps/web/src/pages/up/UpCardMenu.tsx": 6,
	"apps/web/src/pages/up/UpDialog.tsx": 61,
	"apps/web/src/services/aiChat.ts": 7,
	"apps/web/src/services/api.ts": 4,
	"apps/web/src/services/cardSkinAi.ts": 2,
	"apps/web/src/services/session.ts": 3,
	"apps/web/src/services/stats.ts": 2,
	"apps/web/src/types/connection-fields.ts": 37,
	"apps/web/src/types/domain.ts": 11,
	"apps/web/src/utils/formatDiffValue.ts": 6,
	"apps/web/src/utils/groupDiffs.ts": 18,
	"packages/ai/src/commentary-generator.ts": 50, // 含给模型的提示词(决策 11 不翻)
	"packages/ai/src/extra-params.ts": 2,
	"packages/ai/src/persona-presets.ts": 11,
	"packages/ai/src/provider-probe.ts": 15,
	"packages/ai/src/tool-label-texts.ts": 8,
	"packages/ai/src/tools.ts": 50, // 含给模型的话(决策 11 不翻),与给人看的话混放
	"packages/ai/src/usage.ts": 6,
	"packages/ai/src/vision.ts": 8,
	"packages/ai/src/web-search.ts": 7,
	"packages/http/src/http-client.ts": 17,
	"packages/http/src/public-address.ts": 2,
	"packages/http/src/websocket.ts": 1,
	"packages/image/src/blocks/live.tsx": 11,
	"packages/image/src/blocks/membership.tsx": 1,
	"packages/image/src/blocks/post.tsx": 1,
	"packages/image/src/blocks/roast.tsx": 11,
	"packages/image/src/blocks/superchat.tsx": 1,
	"packages/image/src/blocks/wordcloud.tsx": 2,
	"packages/image/src/format.ts": 1,
	"packages/image/src/icons.tsx": 10,
	"packages/image/src/image-renderer.ts": 25,
	"packages/image/src/live-view.ts": 4,
	"packages/image/src/preview/sample-cards.ts": 38,
	"packages/image/src/render.ts": 1,
	"packages/image/src/rich-text.tsx": 2,
	"packages/image/src/skin/knob-assets.ts": 2,
	"packages/image/src/templates/post-content.tsx": 2,
	"packages/internal/src/ai.ts": 6,
	"packages/internal/src/bilibili-guard.ts": 7,
	"packages/internal/src/card-skin.ts": 185,
	"packages/internal/src/extension/build.ts": 5,
	"packages/internal/src/features.ts": 4,
	"packages/internal/src/format.ts": 14,
	"packages/internal/src/platform-registry.ts": 17,
	"packages/internal/src/schema/card-skin.ts": 48,
	"packages/internal/src/schema/config-fields.ts": 27,
	"packages/internal/src/schema/extension-manifest.ts": 33,
	"packages/internal/src/schema/extension-marketplace.ts": 9,
	"packages/internal/src/schema/extension-subscription.ts": 2,
	"packages/internal/src/schema/extension-view.ts": 7,
	"packages/internal/src/schema/history.ts": 1,
	"packages/internal/src/schema/settings-fields-from-schema.ts": 12,
	"packages/internal/src/schema/subscriptions.ts": 5,
	"packages/internal/src/schema/targets.ts": 1,
	"packages/internal/src/util/regex-safety.ts": 3,
	"packages/internal/src/util/serial-queue.ts": 1,
	"packages/storage/src/append-jsonl.ts": 2,
	"packages/storage/src/replace-directory.ts": 3,
	"packages/ui/src/atoms.tsx": 2,
	"packages/ui/src/dialog.tsx": 3,
	"packages/ui/src/dock.tsx": 5,
	"packages/ui/src/form-controls.tsx": 7,
	"packages/ui/src/notice.tsx": 1,
	"packages/ui/src/secret-cell.tsx": 2,
	"packages/ui/src/section-nav.tsx": 3,
	"packages/ui/src/tri-state.tsx": 3,
};

const HAN = /\p{Script=Han}/u;
const LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "log"]);
const LOG_RECEIVERS = new Set(["log", "logger", "console"]);
const LOG_BARE_FUNCTIONS = new Set(["log", "warn"]);

/** 接收者表达式的最后一段名字:`logger`、`this.logger`、`ctx.logger` 都是 `logger`。 */
function receiverName(expression) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return undefined;
}

/** 这个调用是不是日志调用(含可选链 `logger?.warn(…)`)。 */
export function isLogCall(node) {
	if (!ts.isCallExpression(node)) return false;
	const callee = node.expression;
	if (ts.isIdentifier(callee)) return LOG_BARE_FUNCTIONS.has(callee.text);
	if (!ts.isPropertyAccessExpression(callee)) return false;
	return LOG_METHODS.has(callee.name.text) && LOG_RECEIVERS.has(receiverName(callee.expression));
}

/** 这个节点是不是某个日志调用的参数(深一层也算:条件表达式、模板、嵌套调用里的)。 */
function insideLogCall(node) {
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (isLogCall(parent) && parent.arguments.includes(child)) return true;
	}
	return false;
}

/** 这个节点是不是带汉字的字符串节点(四种)。 */
function isChineseText(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return HAN.test(node.text);
	}
	if (ts.isTemplateExpression(node)) {
		return HAN.test(node.head.text) || node.templateSpans.some((s) => HAN.test(s.literal.text));
	}
	return ts.isJsxText(node) && HAN.test(node.text);
}

/** 一份源码里写死的中文:`{ line, text }[]`,按出现顺序。 */
export function chineseTextHits(source) {
	return findNodes(source, (node) => isChineseText(node) && !insideLogCall(node)).map(
		({ line, text }) => ({ line, text }),
	);
}

const sample = (text, file = "sample.ts") => chineseTextHits(parseSource(file, text));
const count = (text, file) => sample(text, file).length;
/** 样例里的模板插值写成 `@{`,免得 Biome 把字符串里的 `${` 当成写错的模板。 */
const tpl = (text) => text.replaceAll("@{", "${");

describe("写死的中文的判据:算", () => {
	it("字符串字面量:双引号、单引号、不带插值的反引号、转义写法", () => {
		expect(count('const s = "直播中";')).toBe(1);
		expect(count("const s = '直播中';")).toBe(1);
		expect(count("const s = `直播中`;")).toBe(1);
		expect(count('const s = "\\u76f4\\u64ad";')).toBe(1);
	});

	it("带插值的模板:头或任何一段带汉字算一处,里面嵌的字符串另算", () => {
		expect(count(tpl("const s = `@{n}位观众`;"))).toBe(1);
		expect(count(tpl("const s = `@{n}位@{m}人`;"))).toBe(1);
		expect(count(tpl('const s = `开头@{x ? "是" : "否"}结尾`;'))).toBe(3);
		expect(count(tpl("const s = `abc@{n}`;"))).toBe(0);
	});

	it("JSX 文字与 JSX 属性", () => {
		expect(count("const e = <p>还没有订阅</p>;", "sample.tsx")).toBe(1);
		expect(count('const e = <B title="关闭" />;', "sample.tsx")).toBe(1);
	});

	it("类型位置的字符串、对象的字符串键、取字时传的参数值", () => {
		expect(count('type S = "直播中" | "未开播";')).toBe(2);
		expect(count('const o = { "帮助": 1 };')).toBe(1);
		expect(count('t("cmd.x", { label: "直播" });')).toBe(1);
	});

	it("new Error 里的话照算(会进失败 message)", () => {
		expect(count('throw new Error("没找到");')).toBe(1);
	});

	it("不是日志的同名方法:接收者最后一段不是 log / logger / console", () => {
		expect(count('res.error("失败");')).toBe(1);
		expect(count('browser.info("中文");')).toBe(1);
		expect(count('catalog.warn("中文");')).toBe(1);
		expect(count('logs.push("中文");')).toBe(1);
	});

	it("先赋给变量再交给日志的:字符串在日志外面,照算(漏排,钉住现状)", () => {
		expect(count('const m = "坏了"; logger.warn(m);')).toBe(1);
	});

	it("命中带行号与那一段源码的第一行", () => {
		expect(sample('\nconst k = "直播";')).toEqual([{ line: 2, text: '"直播"' }]);
		expect(sample("const k = `第一行\n第二行`;")).toEqual([{ line: 1, text: "`第一行" }]);
	});
});

describe("写死的中文的判据:不算", () => {
	it("注释:行注释、块注释、JSDoc、JSX 注释(写成代码样子的)", () => {
		expect(count('// const s = "中文";')).toBe(0);
		expect(count('/* const s = "中文"; */ const a = 1;')).toBe(0);
		expect(count('/** 说明 `"中文"` */\nexport const a = 1;')).toBe(0);
		expect(count("const e = <p>{/* 中文 */}</p>;", "sample.tsx")).toBe(0);
		expect(count('const e = <p>{/* <b title="中文" /> */}</p>;', "sample.tsx")).toBe(0);
	});

	it("正则字面量:认输入用的(决策 9)", () => {
		expect(count("const re = /^(帮助|help)$/;")).toBe(0);
	});

	it("不带汉字的串:中文标点、假名、纯英文", () => {
		expect(count('const a = "，"; const b = "……"; const c = "です"; const d = "plain";')).toBe(0);
	});

	it("日志调用的参数,深一层也算在内", () => {
		expect(count('logger.warn("中文");')).toBe(0);
		expect(count(tpl('this.logger.info(`…@{"中文"}…`);'))).toBe(0);
		expect(count('ctx.logger.error(x ? "甲" : "乙");')).toBe(0);
		expect(count('opts.logger?.warn("中文");')).toBe(0);
		expect(count('logger?.warn("中文");')).toBe(0);
		expect(count('console.error("中文");')).toBe(0);
		expect(count('console.log("中文");')).toBe(0);
		expect(count('log("中文");')).toBe(0);
		expect(count('warn("中文");')).toBe(0);
		expect(count('logger.warn(format({ msg: "中文" }));')).toBe(0);
	});

	it("日志调用旁边的不是日志参数,照算", () => {
		expect(count('logger.warn("x"); const s = "中文";')).toBe(1);
	});

	it("中文标识符不是字符串节点(抓不到,钉住现状)", () => {
		expect(count("const 直播 = 1;")).toBe(0);
	});
});

/** 范围:服务端、面板、contract 与 `packages/<包>/src`,仓库相对路径。桌面壳不扫。 */
function scopeRoots() {
	return srcRootsUnder(["apps", "packages"], { except: ["apps/desktop/src"] });
}

/** 范围里所有叫 `devtools` 的目录,仓库相对、带结尾斜杠。 */
function devtoolsDirsInScope() {
	const found = [];
	const walk = (rel) => {
		for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "node_modules") continue;
			const child = `${rel}/${entry.name}`;
			if (entry.name === "devtools") found.push(`${child}/`);
			walk(child);
		}
	};
	for (const root of scopeRoots()) walk(root);
	return found.sort();
}

/** 真去扫仓库:文件 → 命中。排除目录里的与没有命中的文件不出现。 */
export function scanRepo() {
	const found = {};
	for (const file of listSources(scopeRoots())) {
		if (Object.keys(EXCLUDED_DIRS).some((dir) => file.startsWith(dir))) continue;
		const hits = chineseTextHits(parseSource(file));
		if (hits.length > 0) found[file] = hits;
	}
	return found;
}

/**
 * 🔴 **真去扫仓里的代码。** 上面的样例证明判据没写错;这一条证明表外没有人又把话写死回源码里。
 */
describe("源码里写死的中文只降不涨", () => {
	it("范围认得对:服务端、面板、contract 与各包都在,桌面壳、拓展不在", () => {
		const roots = scopeRoots();
		for (const expected of [
			"apps/server/src",
			"apps/web/src",
			"apps/contract/src",
			"packages/internal/src",
			"packages/ui/src",
			"packages/image/src",
			"packages/ai/src",
		]) {
			expect(roots).toContain(expected);
		}
		expect(roots).not.toContain("apps/desktop/src");
		expect(roots.some((root) => root.startsWith("extensions/"))).toBe(false);
	});

	it("排除的目录和白名单的文件真的存在", () => {
		for (const dir of Object.keys(EXCLUDED_DIRS)) {
			expect(existsSync(join(REPO_ROOT, dir)), dir).toBe(true);
		}
		for (const file of Object.keys(ALLOWLIST)) {
			expect(existsSync(join(REPO_ROOT, file)), file).toBe(true);
		}
	});

	it("范围里每个叫 devtools 的目录都在排除表里", () => {
		expect(devtoolsDirsInScope()).toEqual(Object.keys(EXCLUDED_DIRS).sort());
	});

	// 重生成棘轮表用(只打印,不写文件):BN_PRINT_CHINESE_RATCHET=1 vp test scripts/__tests__/hardcoded-chinese.test.mjs
	it.skipIf(!process.env.BN_PRINT_CHINESE_RATCHET)("打印逐文件的实数,可直接贴进 RATCHET", () => {
		const found = scanRepo();
		const files = Object.keys(found)
			.filter((file) => !(file in ALLOWLIST))
			.sort();
		const lines = files.map((file) => `\t${JSON.stringify(file)}: ${found[file].length},`);
		const total = files.reduce((sum, file) => sum + found[file].length, 0);
		console.log(
			`RATCHET-BEGIN\n${lines.join("\n")}\nRATCHET-END files=${files.length} nodes=${total}`,
		);
	});

	it("表外没有写死的中文,棘轮表里的文件不多于上限、也不少于上限", () => {
		expect(
			auditRatchet(scanRepo(), {
				allowlist: ALLOWLIST,
				ratchet: RATCHET,
				what: "写死的中文",
				advice: ADVICE,
			}),
		).toEqual([]);
	});
});
