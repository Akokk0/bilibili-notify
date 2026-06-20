---
"koishi-plugin-bilibili-notify": minor
---

koishi 端新增 cookieEncryptionKey 配置项:设置后用它经 scrypt 派生 AES-256 密钥,对 secrets(B 站 cookie / AI apiKey)做真正的静态加密(密钥本身不落盘),对齐 standalone 端的 BN_COOKIE_KEY;留空仍回退到原本与密文同目录的随机密钥(仅混淆)。此前 koishi 端无设置密钥的入口,只能走弱加密
