Image rendering turns text-only notifications into cards for content updates, live starts, and summaries. It is recommended, but optional for completing setup. When rendering is off, BN falls back to text notifications.

## Enable rendering for your deployment

**Standard Docker image:** Chromium is included. Open [Cards](/cards), enable image rendering, and send a test notification.

**Slim image** (tag `slim` or ending in `-slim`): no browser is included. Set `BN_CHROME_ENDPOINT` to a remote browser, such as a browserless companion container. Without one, BN keeps sending text.

**Non-Docker deployment:** configure a local Chrome or Chromium executable in System, or use a remote browser.

The guide's rendering check requires both an available renderer and the card-rendering switch to be enabled.
