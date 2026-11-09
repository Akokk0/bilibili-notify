This chapter covers the guide's connection, target, and test steps. If you have not chosen a route, start with the [overview comparison](/about/guide).

## Route A: QQ official bot (qq-official)

BN connects to Tencent's official Bot API without signing in to your personal QQ account or deploying an extra client. Capabilities depend on the bot tier. Lightweight bots created by QR code can currently message their creator and groups owned by that creator. Reviewed bots and enterprise accounts have broader access, subject to current official policy.

### A1 · Quick setup: connect or create by QR code

1. Open [Push targets](/targets), add a connection, and choose QQ official bot.
2. Select **Scan to connect / create** in the form (experimental), scan with mobile QQ, and create a bot on Tencent's page. If you previously created a bot this way, you can select it again to reconnect and refill its credentials. OpenClaw branding on this page is expected; it is Tencent's lightweight-bot channel.
3. The form fills in `appId` and `appSecret`. **Save the form**; the connection does not take effect until saved.
4. Select Test on the saved connection. A successful test completes the connection step.

> Lightweight bots currently need no review and can message their creator and groups owned by the creator, subject to official policy. Each QQ account can create up to five. Scan again to recover credentials by selecting an existing bot and issuing a new secret. For broader capabilities, use A2 or route B.

If you use A1, skip A2 and continue to A3.

### A2 · Standard setup: register on the developer platform

1. Register at `q.qq.com` and create a bot. Its name, description, and avatar require review.
2. Obtain `AppID` and `AppSecret` under Development → Development settings, and enter them in BN's connection form.
3. Configure the **IP allowlist** on the same page with your server's public outbound IP. You can check it on the server using `curl ifconfig.me`.
4. During testing, configure a **sandbox** on the platform with test groups or private chats (up to 20 people), and enable sandbox in BN's form. Disable it again when moving to production.

> A changed public IP can cause permission errors. Use a server with a fixed public IP, or update the platform allowlist whenever your address changes.

### A3 · Add the bot to a group and grant permissions

Both A1 and A2 require the bot to join the destination group and have the relevant permissions:

1. In mobile QQ, open Contacts → Bots, open your bot's profile, and choose Add to group. Lightweight bots can only join groups owned by their creator; other tiers follow official policy. For private messages, start a conversation from the profile.
2. In the group's bot-management settings, allow the bot to **receive all group messages** and **send proactive messages in the group**.

> BN sends proactive notifications. Without proactive-message permission, group notifications may not arrive. Restricting the messages the bot can receive may also prevent session discovery from seeing your @mention.

### A4 · Add a target and check official-route limitations

1. After the connection test succeeds, add a target: use `groupOpenid` for groups or `userOpenid` for private chats.
2. These are **not group numbers or QQ numbers**. Send a message to the bot first, mentioning it in a group or messaging it privately. Once BN receives the inbound event, the session becomes available in the target form.
3. Select Test on the target and confirm that the message arrives in QQ.

The gateway normally requests a reconnection about every 30 minutes; RECONNECT in the log is expected protocol behavior. Image messages need a publicly reachable image URL. BN handles relay of rendered images, while Markdown support still depends on public/private-domain permissions; lightweight bots do not have private-domain privileges.

## Route B: OneBot client (NapCat)

A protocol client signs in to a real QQ account and supports groups, private chats, and images. It requires another container and carries a risk of account restrictions or bans.

> Use a secondary account. Protocol clients simulate a client login, and the account may be banned.

### B1 · Deploy NapCat with Docker

Run NapCat with Docker Compose on the same server as BN:

```yaml
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      - NAPCAT_UID=1000
      - NAPCAT_GID=1000
    ports:
      - "6099:6099"   # WebUI
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/qq:/app/.config/QQ
```

1. Open `http://SERVER_IP:6099/webui`. Find the initial login token in the container log with `docker logs napcat`.
2. Scan the QR code in WebUI to sign in to QQ with a secondary account.
3. Check the [official NapCat documentation](https://github.com/NapNeko/NapCatQQ) for current images and options. Protocol clients change frequently; the example reflects the configuration when written.

> Do not expose NapCat's WebUI or WebSocket ports directly to the Internet: it holds your QQ session. Keep communication on a private or Docker network, and configure `accessToken` where needed.

### B2 · Connect BN (reverse WebSocket recommended)

OneBot has three transport options. **Reverse WebSocket is recommended**: BN listens for NapCat, which reconnects automatically after a restart.

1. In BN, add a OneBot connection, choose Reverse WS, set a listening port such as `6199`, and save.
2. In NapCat WebUI, open network settings and create a WebSocket client. Set its URL to `ws://BN_HOST:6199/`, choose **Array** as the message format, and enable it.
3. If both containers run on the same machine, attach them to one Docker network and use `ws://CONTAINER_NAME:PORT/` directly.
4. Select Test on BN's connection to complete the connection step.

Forward WS means BN connects to NapCat's WebSocket server, for example `ws://napcat:3001`. HTTP means BN sends POST requests to NapCat's HTTP service; NapCat must enable both its HTTP server and event reporting. If an access token is configured, it must match on both sides.

### B3 · Add targets and check protocol-client behavior

1. Add a target with the group number (`groupId`) or QQ number (`userId`). This route accepts those numbers directly.
2. Select Test on the target and check for the message in QQ.

Image messages can be slow because the client uploads images to QQ first, often taking more than 15 seconds. BN already allows a longer timeout for these messages. If a test suggests that NapCat is disconnected, check its sign-in status and network settings in WebUI.

## Route C: group bots or HTTP endpoints (without QQ)

Choose **Feishu bot**, **DingTalk bot**, or **WeCom bot** as the connection platform and enter its target URL. For your own service, choose **Unspecified HTTP endpoint**, which receives BN's native envelope. Supply the signing secret when required. For endpoints behind a reverse proxy or Cloudflare Access, enter the credentials under Custom headers. Select Test to verify the connection.

## Channel check

Return to [Push targets](/targets) and select Test on the target. Receiving a test message in the destination confirms that delivery works. Finally, [add a subscription](/about/guide/subs) and select the target you just created to complete setup.
