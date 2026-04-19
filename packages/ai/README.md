# koishi-plugin-bilibili-notify-ai

[![npm](https://img.shields.io/npm/v/koishi-plugin-bilibili-notify-ai?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bilibili-notify-ai)

`koishi-plugin-bilibili-notify` 的 AI 增强插件，提供动态点评、直播总结和多轮对话能力，支持任何 OpenAI 兼容接口。

> [!NOTE]
> 需要先安装并配置 `koishi-plugin-bilibili-notify` 核心插件

## 功能

- **动态点评**：UP 主发布新动态时，自动生成 AI 点评（需在 dynamic 插件中启用）
- **直播总结**：直播结束后，根据弹幕词云生成 AI 总结（需在 live 插件中启用）
- **多轮对话**：`bili chat` 指令与 AI 对话，支持会话历史记忆和自动压缩
- **工具调用**：对话中可查询订阅列表、UP 主信息、动态、视频、直播状态，以及添加/取消订阅
- **多模态**：支持图片输入，动态点评和对话时可理解图片内容（需模型支持视觉能力）
- **人格预设**：内置助理、女仆、傲娇、弹幕解说员、犀利评论家等预设，支持完全自定义

## 安装

在 Koishi 插件市场中搜索 `bilibili-notify-ai` 并安装。

## 配置

| 配置项 | 说明 |
|---|---|
| `apiKey` | OpenAI 兼容 API 密钥 |
| `baseURL` | API 地址，默认 SiliconFlow（`https://api.siliconflow.cn/v1`） |
| `model` | 模型名称，默认 `Qwen/Qwen3-8B` |
| `persona` | 人格配置，支持预设选择和自定义 |
| `enableConversation` | 开启多轮对话历史记忆 |
| `enableThinking` | 开启模型思考模式（Qwen3 等） |
| `enableSearch` | 开启模型联网搜索（SiliconFlow 等） |
| `enableVision` | 开启多模态图片理解 |

## 指令

| 指令 | 说明 |
|---|---|
| `bili ai [内容]` | 单次测试，验证 AI 配置是否正确 |
| `bili chat [消息]` | 多轮对话，支持查询订阅、管理 UP 主 |
| `bili chat -c` | 清除当前对话历史 |

## License

MIT
