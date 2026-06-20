---
"@bilibili-notify/storage": patch
---

FileKeyProvider 缓存密钥加载 Promise:并发 getKey() 去重为单次磁盘加载,resetKey() 同步刷新缓存,加载失败时自动清除缓存以便重试,配合服务端启动预加载密钥
