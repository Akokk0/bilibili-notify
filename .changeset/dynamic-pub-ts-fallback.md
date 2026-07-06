---
"@bilibili-notify/dynamic": patch
---

兼容 B 站动态接口返回字符串或缺失 `pub_ts` 的情况:数字字符串会按发布时间处理,缺失时尝试用 `pub_time` 兜底解析,并先过滤未订阅 UID 以避免无关动态刷屏 warn
