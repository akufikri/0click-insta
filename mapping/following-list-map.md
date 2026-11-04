# following-list — selector map

Screen map for the `following-list` flow: 1 step, at least one verified against the live page.

Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.

## How to use this map

1. Read the step whose ready check is true for the screen you are on.
2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.
3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.
4. Prove the fix with the smallest possible action before running a real tool.

## Probe the live screen

```
ui_guide {"device":"<device>","flow":"following-list"}
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

## Step 1 — following dialog opened from a profile

Status: **verified live (2026-11-04)**

URL: `https://www.instagram.com/<username>/`

Note: no 'follows you' badge in 2026 web: whether someone follows back is computed as following minus followers. Fast path is Instagram's own friendship API called from the page (cookie auth): GET /api/v1/friendships/<ds_user_id>/following|followers/?count=50&max_id=… with headers x-ig-app-id=936619743392459 and x-csrftoken; 50 users per request, whole 1.6k list in seconds. The dialog crawl (virtualised rows, ~1.6s per scroll) is the fallback when the API pushes back. Unfollow is POST /api/v1/friendships/destroy/<user_id>/ with user_id in the urlencoded body

Ready check — true when this screen is on display:

```js
!!document.querySelector('div[role="dialog"]') && /following/i.test(document.querySelector('div[role="dialog"]').innerText.slice(0, 40))
```

## Controls

| selector key | kind | label a human sees | find (best first) | note |
|---|---|---|---|---|
| — | button | N following (profile counter) | `text/^[d.,KM]+ following$/ on a link, div[role=button] or span` | the counter is not an <a href> in current web: match its text, then click the node; clicking the count opens the dialog titled Following |
| — | input | Search inside the list | `div[role="dialog"] input[aria-label="Search input"]`<br>`div[role="dialog"] input[placeholder*="Search" i]` | aria-label is literally "Search input". Typing filters rows in place; unfollow_selected uses it to find one handle without crawling the whole list. Never filter while computing a set difference |
| — | button | Following (row button) | `div[role="dialog"] a[href="/<handle>/"] → nearest ancestor containing a div[role=button] whose text is Following` | click opens a small confirm dialog; the row button is what unfollow_bulk presses |
| — | button | Unfollow (confirm) | `text:Unfollow inside div[role=dialog]` | second click, same as the profile path |
| — | button | Close | `svg[aria-label="Close"]` | closes the list without touching the relationship |

## Repair procedure

- 1. ui_guide {device, flow} — read the static map and the live controls of the current screen.
- 2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.
- 3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.
- 4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.
- 5. Prove it with the smallest action: eval_page value read-back or the real tool call.
- 6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:"live" and today's date.

