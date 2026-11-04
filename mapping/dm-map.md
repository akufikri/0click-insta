# dm — selector map

Screen map for the `dm` flow: 3 steps, at least one verified against the live page.

Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.

## How to use this map

1. Read the step whose ready check is true for the screen you are on.
2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.
3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.
4. Prove the fix with the smallest possible action before running a real tool.

## Probe the live screen

```
ui_guide {"device":"<device>","flow":"dm"}
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

## Step 1 — direct inbox

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/direct/inbox/`

Ready check — true when this screen is on display:

```js
!!document.querySelector('a[href^="/direct/t/"], svg[aria-label="New message"]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| `dmNewMessage` | button | New message | `svg[aria-label="New message"]`<br>`a[href="/direct/new/"]` | — |
| `dmThread` | link | thread row | `a[href^="/direct/t/"]` | — |
## Step 2 — new message dialog

Status: **unverified — probe before trusting**

Ready check — true when this screen is on display:

```js
!!document.querySelector('div[role="dialog"]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| `dmSearch` | input | Search | `input[name="queryBox"]`<br>`input[placeholder*="Search" i]` | — |
| — | button | recipient row | `div[role="dialog"] div[role="button"]` | match the username text exactly, display names collide |
| — | button | Chat / Next | `text:Chat`<br>`text:Next` | — |
## Step 3 — thread composer

Status: **unverified — probe before trusting**

Ready check — true when this screen is on display:

```js
!!document.querySelector('textarea[placeholder*="Message" i], div[role="textbox"]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| `dmComposer` | input | Message | `textarea[placeholder*="Message" i]`<br>`div[role="textbox"][contenteditable="true"]` | — |
| — | button | Send | `text:Send` | Enter also sends |

## Repair procedure

- 1. ui_guide {device, flow} — read the static map and the live controls of the current screen.
- 2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.
- 3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.
- 4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.
- 5. Prove it with the smallest action: eval_page value read-back or the real tool call.
- 6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:"live" and today's date.

