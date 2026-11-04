# home — selector map

Screen map for the `home` flow: 2 steps, at least one verified against the live page.

Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.

## How to use this map

1. Read the step whose ready check is true for the screen you are on.
2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.
3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.
4. Prove the fix with the smallest possible action before running a real tool.

## Probe the live screen

```
ui_guide {"device":"<device>","flow":"home"}
```

Raw DOM map (paste into `eval_page`):

```js
(() => {
  const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const around = (el) => norm(el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.innerText).slice(0, 90);
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    role: el.getAttribute('role'),
    name: el.getAttribute('name') || null,
    aria: el.getAttribute('aria-label'),
    placeholder: el.getAttribute('placeholder') || null,
    text: norm(el.innerText || el.value).slice(0, 60),
    href: el.getAttribute('href'),
    around: around(el),
    shown: shown(el),
  });
  const selector = 'input, textarea, select, button, a[href], [role="button"], [role="combobox"], [role="menuitem"], [role="tab"], [role="dialog"]';
  const controls = Array.from(document.querySelectorAll(selector)).map(describe).filter((entry) => entry.shown);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    controls: controls.slice(0, 60),
    text: norm(document.body ? document.body.innerText : '').slice(0, 1500),
  };
})()
```

## Step 1 — logged-in home feed with the left navigation rail

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/`

Ready check — true when this screen is on display:

```js
!!document.querySelector('a[href="/"] svg[aria-label="Home"], svg[aria-label="New post"], img[alt*="profile picture" i]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| `navHome` | button | Home | `a[href="/"]`<br>`svg[aria-label="Home"]` | the rail only exists while logged in; logged out the same URL redirects to the login wall |
| `navCreate` | button | New post | `a[href="/create/select/"]`<br>`svg[aria-label="New post"]` | — |
| `navNotifications` | button | Notifications | `svg[aria-label="Notifications"]`<br>`a[href="/notifications/"]` | — |
| — | link | Explore / Reels / Direct | `a[href="/explore/"]`<br>`a[href="/reels/"]`<br>`a[href="/direct/inbox/"]` | — |
| — | button | profile avatar | `img[alt$="profile picture" i]`<br>`img[alt*="profile picture" i]` | alt is "<handle>'s profile picture" — this is how status and whoami learn the handle, so never rename it away |
| — | button | More / Settings | `svg[aria-label="Settings"]`<br>`svg[aria-label="More"]` | — |
## Step 2 — welcome / suggested follows overlay

Status: **unverified — probe before trusting**

Ready check — true when this screen is on display:

```js
(document.body ? document.body.innerText : '').includes('Welcome to Instagram')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| — | button | Follow / Follow back | `text:Follow`<br>`text:Follow back` | suggestions overlay only appears on fresh accounts |
| — | button | Not now / Dismiss | `text:Not now`<br>`text:Dismiss`<br>`svg[aria-label="Close"]` | — |

## Repair procedure

- 1. ui_guide {device, flow} — read the static map and the live controls of the current screen.
- 2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.
- 3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.
- 4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.
- 5. Prove it with the smallest action: eval_page value read-back or the real tool call.
- 6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:"live" and today's date.

