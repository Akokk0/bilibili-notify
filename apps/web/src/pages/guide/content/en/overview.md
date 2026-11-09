Welcome to bilibili-notify (BN). This guide takes you from a fresh setup to your first notification. Sign in to each source, then configure connections, targets, a test delivery, and subscriptions. If no source supports sign-in, start with connections. The Guide on the left checks progress and advances automatically; you are done when every step turns green.

1. **Sign in to source accounts** — Open System → Accounts and sign in to each source that supports it, so BN can read its subscription content.
2. **Configure a push connection** — Connect BN to your QQ bot, Feishu, DingTalk, WeCom, or another service, then select Test to check the connection.
3. **Add a push target** — Choose which group or person receives the messages.
4. **Send a test notification** — Select Test on the target. Receiving the message confirms that the channel works.
5. **Add your first subscription** — On Subscriptions, choose a source, search for a creator, and subscribe.

Why subscribe last? The subscription form asks you to select push targets. Setting up delivery first lets you complete the subscription in one go.

## QQ connection options: choosing a route

BN offers two ways to connect to QQ, with different capabilities and setup requirements:

| Requirement | qq-official (official bot) | onebot (NapCat and other protocol clients) |
| --- | --- | --- |
| **Group notifications** | Depends on the bot tier. A lightweight bot created by QR code can message its creator and groups owned by its creator. Reviewed bots and enterprise accounts have broader access, subject to official policy. | Group and private chats; flexible group membership. |
| **Extra deployment** | None. BN connects directly to Tencent's official API. | A separate protocol-client container, such as NapCat or Lagrange. |
| **Account restrictions or bans** | Uses the official API without signing in to your personal QQ account. | The client signs in to a QQ account. Restrictions or bans are possible; use a secondary account. |
| **Message formats** | Text, images, and rendered cards. Markdown formatting is exclusive to this route, but restricted by bot type; private-domain privileges are unavailable to lightweight or public-domain bots. No merged forwarding or @all. | Text and images; multiple images use merged forwarding. Supports @all members, but not Markdown formatting. |

For lightweight personal use, try qq-official's QR connection/creation flow. For frequent group notifications, merged forwarding, or @all, use onebot with NapCat. Both walkthroughs are in [Push channels](/about/guide/push).

Not using QQ? Feishu, DingTalk, and WeCom each have a group-bot connection type. Your own service can use **Unspecified HTTP endpoint**, which receives BN's native envelope. See the push-channel chapter.

For Telegram, Discord, or KOOK, install **Bot framework bridge** from Extensions and reuse bots already configured in Koishi or AstrBot.
