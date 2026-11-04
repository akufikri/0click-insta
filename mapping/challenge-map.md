# challenge — selector map

Screen map for the `challenge` flow: 2 steps, at least one verified against the live page.

Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.

## How to use this map

1. Read the step whose ready check is true for the screen you are on.
2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.
3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.
4. Prove the fix with the smallest possible action before running a real tool.

## Probe the live screen

```
ui_guide {"device":"<device>","flow":"challenge"}
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

## Step 1 — Cloudflare / captcha wall

Status: **verified live (2026-11-04)**

Ready check — true when this screen is on display:

```js
!/^https?:\/\/www\.instagram\.com\/$/.test(location.href) || /just a moment|verify you are human|confirm it'?s you/i.test(document.body ? document.body.innerText : '')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| — | input | captcha response field | `textarea[name="g-recaptcha-response"]`<br>`textarea[name="h-captcha-response"]`<br>`input[name="cf-turnstile-response"]` | token injection target for challenge_solve |
| — | button | Turnstile checkbox | `iframe[src*=turnstile]`<br>`iframe[src*=challenges.cloudflare.com]` | — |
| — | button | Continue / Try again | `text:Continue`<br>`text:Try again` | — |
## Step 2 — Instagram checkpoint (confirm identity, code, selfie)

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/challenge/`

Note: with a healthy session this route answers a generic 'Reload page' shell; real checkpoints (code entry, selfie) only render under a flagged session

Ready check — true when this screen is on display:

```js
location.pathname.includes('/challenge') || /confirm it'?s you|help us confirm|we detected unusual activity/i.test(document.body ? document.body.innerText : '')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| — | input | security code | `input[name="security_code"]`<br>`input[aria-label*="code" i]`<br>`input[type="text"]` | — |
| — | button | Next / Continue / Confirm | `text:Next`<br>`text:Continue`<br>`text:Confirm` | — |
| — | button | Send code again / Resend | `text:Send code again`<br>`text:Resend` | — |
| — | button | Try another way | `text:Try another way` | — |
| — | button | selfie / video check | `text:Take a video selfie`<br>`text:Take a selfie` | human only; no automation path and none should be invented |

## Repair procedure

- 1. ui_guide {device, flow} — read the static map and the live controls of the current screen.
- 2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.
- 3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.
- 4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.
- 5. Prove it with the smallest action: eval_page value read-back or the real tool call.
- 6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:"live" and today's date.

