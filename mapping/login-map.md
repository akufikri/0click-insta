# login — selector map

Screen map for the `login` flow: 3 steps, at least one verified against the live page.

Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.

## How to use this map

1. Read the step whose ready check is true for the screen you are on.
2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.
3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.
4. Prove the fix with the smallest possible action before running a real tool.

## Probe the live screen

```
ui_guide {"device":"<device>","flow":"login"}
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

## Step 1 — password login form

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/accounts/login/`

Ready check — true when this screen is on display:

```js
!!document.querySelector('input[name="email"], input[name="username"]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| `loginUser` | input | Mobile number, username or email | `input[name="email"]`<br>`input[name="username"]`<br>`input[aria-label*="username" i]` | React-controlled: a programmatic fill is ignored and Submit silently does nothing. Click, Control+a, then type real key events |
| `loginPass` | password | Password | `input[name="pass"]`<br>`input[name="password"]`<br>`input[type="password"]` | same rule as the username field: type, never fill |
| `loginSubmit` | button | Log in | `text:Log in`<br>`div[role="button"]`<br>`button[type="submit"]`<br>`input[type="submit"]` | input[type="submit"] exists but is zero-size and invisible — clicking it reports success and does nothing. The real button is the div[role="button"] whose text is exactly "Log in" (text match, not "Log in with Facebook") |
| — | link | Create new account | `a[href*="/accounts/emailsignup/"]` | signup entry point from the login page |
| — | link | Forgot password? | `a[href*="/accounts/password/reset/"]` | — |
## Step 2 — auth_platform reCAPTCHA wall (out-of-process frames)

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/auth_platform/recaptcha/`

Ready check — true when this screen is on display:

```js
location.pathname.startsWith('/auth_platform/recaptcha')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| — | button | reCAPTCHA checkbox | `CDP target: recaptcha/enterprise/anchor → #recaptcha-anchor` | the widget is NOT in the page DOM. It lives in separate CDP targets: fbsbx.com/captcha/recaptcha/iframe (wrapper), google.com/recaptcha/enterprise/anchor (checkbox, #recaptcha-anchor) and .../bframe (image challenge). Click it through the anchor target; src/recaptcha.ts walks a human cursor path (CSR-S corner → bowed Bézier with jitter and pauses → small overshoot → press) because Enterprise scores pointer behaviour |
| — | input | enterprise sitekey | `k= parameter of the anchor/bframe target URL` | 6L… key is readable from the frame URL, so a provider solve is possible in principle; the checkbox path needs no key at all |
| — | button | image challenge | `#rc-imageselect inside the bframe target` | only appears when the click escalates; stop and hand it to a human unless an image solver is wired |
## Step 3 — two-factor / security code

Status: **unverified — probe before trusting**

Ready check — true when this screen is on display:

```js
!!document.querySelector('input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="code" i]')
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| `loginCode` | input | Security code | `input[name="verificationCode"]`<br>`input[name="security_code"]`<br>`input[autocomplete="one-time-code"]` | — |
| `loginSubmit` | button | Confirm / Next | `text:Confirm`<br>`text:Next`<br>`button[type="submit"]` | — |

## Repair procedure

- 1. ui_guide {device, flow} — read the static map and the live controls of the current screen.
- 2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.
- 3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.
- 4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.
- 5. Prove it with the smallest action: eval_page value read-back or the real tool call.
- 6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:"live" and today's date.

