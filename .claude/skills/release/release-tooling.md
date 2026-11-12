# 发版：SDK与拓展创建器

SDK与`create-bn-ext`通过`tooling-release.yml`在GitHub Actions手动发行，版本各自来自源码清单；本体`@bilibili-notify/bn`另随主程序tag发行。版本与实际发行须有主人授权，当前决定与验收状态见[第6期计划](../../../docs/1.0/phase-6-plan.md)。

1. 核对两份源码版本和创建器的默认SDK版本，先构建真实tgz并完成全量门禁。完成条件：清单是主人确定的版本，归档通过实际仓外消费及发行测试；`0.0.0-dev`不可发行。
2. 核对远端`dev`是否含待发代码、默认分支是否已登记工作流。推送范围有额外变化时先做精确清单，给主人核对。完成条件：Actions能在`dev`选择手动入口，源码与待发提交一致。
3. 在Actions选择`bilibili-notify — extension tools (npm)`、分支`dev`，选包并保持`dry_run=true`。完成条件：共享全量gate、构建、实际tgz校验和审阅产物上传全部成功。
4. 按[账号准备](../../../docs/agents/build-release.md#sdk与创建器npm工具)选择模式，以 `dry_run=false` 手动触发。首发用 `bootstrap-token` 暂存。下载暂存包与本次 Actions 原始归档核对后，请主人在 npm 的 **Staged Packages** 网页先批准 SDK，再批准创建器。批准后重跑原 `publish` 作业，直到 `awaitingApproval` 为 false，公共 registry 的渠道与归档摘要均匹配。后续已绑定的包使用 `trusted` 直接发布。
5. 从真实registry运行创建器，验证默认SDK/工具版本、工程安装和`vp run verify`。完成条件：公开入口可用，工程无需本地归档覆盖即可通过；本机夹具与dry-run不能代替上架结论。

部分成功时优先重跑失败的publish作业，复用原Actions归档。同号同内容会复用；内容冲突需新版本。包上传后才推进`alpha`或`latest`，较旧候选不倒退渠道。更新进度时分别写清SDK、创建器和本体状态。
