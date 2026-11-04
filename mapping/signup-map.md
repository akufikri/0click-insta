# signup — selector map

Screen map for the `signup` flow: 1 step, at least one verified against the live page.

Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.

## How to use this map

1. Read the step whose ready check is true for the screen you are on.
2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.
3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.
4. Prove the fix with the smallest possible action before running a real tool.

## Probe the live screen

```
ui_guide {"device":"<device>","flow":"signup"}
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

## Step 1 — Meta account form

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/accounts/emailsignup/`

Ready check — true when this screen is on display:

```js
!!document.querySelector('input[type="password"]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| — | input | Mobile number or email | `context:mobile number or email` | no name, id or aria-label: select by the text next to it and write the value with the native setter, or React ignores it. Validation is live: example.com style addresses are rejected with "Enter a correct email address" |
| — | password | Password | `context:password`<br>`input[type="password"]` | — |
| — | input | Full name | `context:full name` | — |
| — | input | Username | `input[aria-label="Username"]`<br>`context:username` | role="combobox" but it is a plain text input |
| `signupMonth` | combobox | Month | `[aria-label="Select Month"]` | — |
| `signupDay` | combobox | Day | `[aria-label="Select Day"]` | — |
| `signupYear` | combobox | Year | `[aria-label="Select Year"]` | — |
| `signupSubmit` | button | Submit | `text:Submit` | div[role="button"], not a <button> |
| — | button | I already have an account | `text:I already have an account` | — |

## Repair procedure

- 1. ui_guide {device, flow} — read the static map and the live controls of the current screen.
- 2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.
- 3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.
- 4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.
- 5. Prove it with the smallest action: eval_page value read-back or the real tool call.
- 6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:"live" and today's date.

