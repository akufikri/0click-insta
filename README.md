```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│    ___         _  _        _      ___              _           │
│   / _ \   ___ | |(_)  ___ | | __ |_ _| _ __   ___ | |_  __ _   │
│  | | | | / __|| || | / __|| |/ /  | | | '_ \ / __|| __|/ _` |  │
│  | |_| || (__ | || || (__ |   <   | | | | | |\__ \| |_| (_| |  │
│   \___/  \___||_||_| \___||_|\_\ |___||_| |_||___/ \__|\__,_|  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

# 0click-insta

Instagram MCP server that drives the browser you already have open in a terminal pane. One device = one Instagram account = one terminal-browser daemon, one cookie jar, one profile directory. Accounts stay logged in, run side by side, never share state.

[![MCP](https://img.shields.io/badge/MCP-stdio-111)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-26%2B-339933)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-16%20passing-brightgreen)](#verification)

MCP server that drives Instagram **through the browser you already have in a terminal pane**. One device = one Instagram account = one terminal-browser daemon + its own cookie jar + its own profile directory. Accounts stay logged in, live side by side, and never share state.

Nothing is automated with a hidden headless Chromium: the pane is the browser, the MCP drives it over CDP with `agent-browser`, and every action is what a person at the pane would see.

## How it fits together

```
MCP client (omp, Claude, anything stdio)
      │  tools/call
      ▼
src/server.ts ── run(): live check → challenge gate → rate gate → pace → flow
      │
      ├── src/ig.ts        Instagram flows (post, edit, delete, follow, like, comment, save, dm, story, feed, profile, notifications)
      ├── src/igapi.ts     friendship API fast path: list followers/following, unfollow, 50 per request
      ├── src/agent.ts     locator → agent-browser argv, eval/click/fill/upload
      ├── src/selectors.ts every piece of DOM knowledge, in one file
      ├── src/tb.ts        the only place that spawns binaries
      │      ├── terminal-browser ls registry (sqlite) → key + cdpPort
      │      ├── agent-browser --session 0click-<device> --cdp <port> <command> [args]
      │      └── tern split (opens the pane when the MCP runs inside Tern)
      ├── src/device.ts    device registry + the five env vars that isolate a device
      ├── src/challenge.ts Cloudflare / captcha / checkpoint detection
      ├── src/captcha.ts   2captcha + anti-captcha solving and token injection
      ├── src/stealth.ts   CDP anti-detection profile (webdriver, UA, plugins, WebGL, locale)
      ├── src/rate.ts      per-device hourly limits
      └── src/human.ts     pacing between UI actions
```

## Requirements

- Node 26+ (runs TypeScript directly, no build step)
- `terminal-browser` (tested 0.11.1) with the `agent-browser` it ships
- A terminal that terminal-browser can render in: Tern, kitty, Ghostty, WezTerm, tmux, VS Code
- One pane per device. The MCP never fakes a TTY: it either splits a Tern pane itself or prints the command for you.

## Start

```bash
cd ~/dev/projects/0click-instagram
npm install
npm test          # 11 self-checks, no account needed
npm run typecheck
# live DOM checks against a started device (upload/fill/click/press on fixtures)
IG_TEST_DEVICE=<device> npm run test:flows
node src/server.ts   # stdio MCP server
```

Then, from an MCP client:

1. `device_create {"id":"main"}` — creates `~/.0click/instagram/devices/main/` (meta, appdata, state, data, run, agent).
2. `device_start {"device":"main"}` — opens the pane (Tern split) and applies the stealth profile. If it answers `needsManualStart`, run the returned command inside a terminal pane.
3. Log in by hand in the pane (2FA included), then `status` until `loggedIn: true` and `handle` is filled. Or `login {"device":"main","username":"<your username>","password":"<your password>","code":"<2fa code>"}`.
4. Drive it: `post`, `edit_post`, `delete_post`, `follow`, `unfollow`, `like`, `unlike`, `comment`, `save`, `unsave`, `profile`, `feed`, `dm_list`, `dm_send`, `story_view`, `story_upload`, `notifications`.

## Tools

| Tool | Params | What it does |
|---|---|---|
| `device_list` | — | devices with live key, cdp port, handle |
| `device_create` | `id`, `url?`, `socksPort?` | new isolated device + the pane command |
| `device_delete` | `id`, `confirm` | stop the browser, then wipe the device dir |
| `device_start` | `device` | pane + stealth profile, reuses a live browser |
| `device_stop` | `device` | close that device's browser, keep its cookies and pane |
| `pane_command` | `device` | the exact shell line for a pane |
| `login` | `device`, `username?`, `password?`, `code?` | wait for manual login, or fill credentials |
| `logout` | `device` | clears the cookie jar |
| `status` | `device` | running / loggedIn / handle / url / challenge |
| `post` | `device`, `media[]`, `caption?`, `kind` | photo, carousel (2-10), reel |
| `edit_post` | `device`, `target`, `caption` | rewrite a caption |
| `delete_post` | `device`, `target` | delete own post |
| `follow` / `unfollow` | `device`, `username` | idempotent |
| `following_list` | `device`, `username?`, `search?`, `maxScrolls?` | who this account follows: scroll the dialog to the end, or filter with its search box |
| `followers_list` | `device`, `username?`, `search?`, `maxScrolls?` | who follows this account, same crawl/filter |
| `unfollow_selected` | `device`, `usernames[]`, `confirm?` | unfollow exactly these handles through the following dialog; dry run unless `confirm:true` |
| `unfollow_bulk` | `device`, `confirm?`, `limit?`, `maxScrolls?` | unfollow only accounts that do **not** follow back (following minus followers); dry run unless `confirm:true` |
| `like` / `unlike` | `device`, `target` | idempotent, reads aria state first |
| `comment` | `device`, `target`, `text` | comment on a post |
| `save` / `unsave` | `device`, `target` | bookmark toggle |
| `profile` | `device`, `username` | bio, counts, 12 recent posts |
| `feed` | `device`, `limit?` | post links from home feed |
| `dm_list` | `device`, `limit?` | inbox threads |
| `dm_send` | `device`, `username`, `text` | new message |
| `story_view` | `device`, `username` | open a story |
| `story_upload` | `device`, `media[]` | story when desktop exposes it, else `Unsupported` |
| `notifications` | `device`, `limit?` | notifications panel lines |
| `register` | `device`, `contact`, `password`, `fullName`, `username`, `birthday`, `submit?` | Meta web signup; `submit:false` fills only and never creates an account |
| `register_verify` | `device`, `code` | finish the signup with the emailed/texted code |
| `ui_guide` | `device?`, `flow?` | selector map per screen plus the live controls on the device page |
| `inspect_screens` | `device`, `flows?`, `navigate?` | walk every mapped screen, report dead selectors (reusable across accounts) |
| `captcha_state` / `captcha_click` | `device` | reCAPTCHA Enterprise state from the out-of-process frames, and the human-shaped cursor click |
| `eval_page` | `device`, `expr`, `url?` | run JS in the page (selector repair) |
| `page_reload` | `device` | reload |
| `challenge_status` | `device` | Cloudflare / captcha / checkpoint report + sitekey |
| `challenge_solve` | `device`, `waitMs?`, `provider?` | wait out the wall or solve via provider |
| `stealth_apply` | `device` | reinstall the anti-detection profile |
| `proxy_set` | `device`, `socksPort` | egress through a local SOCKS proxy |
| `challenge_probe_text` | `device` | raw page text for debugging |

Every reply is one JSON object. Failures are `{"ok":false,"error":"<code>","message":"<reason>"}` with `screenshot` attached for UI-shaped failures.

Error codes: `DeviceNotRunning`, `NotLoggedIn`, `RateLimited`, `SelectorMissing`, `BadCredentials`, `BadTarget`, `Unsupported`, `TbTimeout`, `TbNonJson`, `TbFailed`, `ConfirmRequired`, `InvalidDeviceId`, `DeviceExists`, `ChallengeRequired`, `CaptchaUnsolvable`, `PaneNotStarted`.

## Anti-bot layer

Four independent layers, all on by default:

1. **Challenge gate** — before any action the page is probed for Cloudflare interstitials, Turnstile, reCAPTCHA, hCaptcha, Arkose, Instagram checkpoints and Instagram action limits. A wall becomes `ChallengeRequired` with a hint instead of a confusing selector error. `challenge_solve` waits for clearance (short-lived JS challenges and Turnstile resolve themselves once the pane renders them).
2. **Stealth profile** — over raw CDP, held open for the browser's lifetime: `navigator.webdriver` removed, UA stripped of `Electron/<version>` and `terminal-browser/<version>`, plugin and language arrays, WebGL vendor, permission-query patch, `en-US` locale, timezone, `Accept-Language`, realistic `outerWidth/Height`. Scripts are installed with `addScriptToEvaluateOnNewDocument` so they run before page code.
3. **Captcha provider** — `IG_CAPTCHA_PROVIDER=2captcha|anticaptcha` + `IG_CAPTCHA_KEY` solves reCAPTCHA/hCaptcha/Turnstile off-site and injects the token into the page. Arkose needs a human; the tool says so instead of pretending.
4. **Egress + pace** — `proxy_set` (or `device_create {socksPort}`) routes a device's Chromium through a local SOCKS proxy, so a blocked device can move network without losing its session; every action is preceded by 800-2500 ms of human pacing, and per-device hourly limits stop the account from being burned by a loop.

Cookies (`cf_clearance`, `sessionid`, `csrftoken`) live in the device's own Electron profile, so clearance survives restarts and never crosses accounts.

## Isolation

Each device sets, for both the pane and every MCP call:

```
XDG_STATE_HOME=<device>/state        # pixel bridge, logs
XDG_DATA_HOME=<device>/data          # terminal-browser registry (key, cdp port)
XDG_RUNTIME_DIR=<device>/run         # daemon socket + instance sockets
TERMINAL_BROWSER_APPDATA=<device>/appdata   # Electron userData: cookies, storage
AGENT_BROWSER_SOCKET_DIR=<device>/agent     # agent-browser session sockets
```

Two devices therefore run two daemons, two browser processes, two cookie jars, and can be logged into different accounts at the same time.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `IG_PROFILE_ROOT` | `~/.0click/instagram` | device root |
| `IG_LOGIN_WAIT_MS` | `300000` | manual login wait |
| `IG_PACE_MIN_MS` / `IG_PACE_MAX_MS` | `800` / `2500` | pacing window |
| `IG_LIMIT_FOLLOW`, `IG_LIMIT_UNFOLLOW`, `IG_LIMIT_LIKE`, `IG_LIMIT_COMMENT`, `IG_LIMIT_POST`, `IG_LIMIT_DM`, `IG_LIMIT_STORY`, `IG_LIMIT_READ`, `IG_LIMIT_LOGIN` | 20/20/60/10/5/20/10/240/10 | hourly limits per action |
| `IG_CHALLENGE_WAIT_MS` | `180000` | how long `challenge_solve` waits |
| `IG_CAPTCHA_PROVIDER` / `IG_CAPTCHA_KEY` | — | `2captcha` or `anticaptcha` |
| `IG_CAPTCHA_WAIT_MS` | `180000` | provider polling budget |
| `IG_TZ` | `Asia/Kuala_Lumpur` | timezone override |
| `AGENT_BROWSER_BIN` | the one shipped with terminal-browser | override the driver binary |
| `TERMINAL_BROWSER_BIN` | `terminal-browser` | pane command binary |

## Inspector — re-map any account

The maps describe screens; the inspector tells you, for the account you are logged into right now, which of those descriptions is still true.

```bash
npm run inspect -- --device main                 # every mapped screen
npm run inspect -- --device main --flows home,dm
npm run inspect -- --device main --username other_handle
```

It walks each screen (substituting `<username>` from the device's saved handle), waits for the guide's ready check, then probes every selector key that screen depends on. Output goes to `mapping/inspect/<timestamp>-<device>.md`; exit code `2` means something is dead.

Three statuses per key:

| status | meaning | what to do |
|---|---|---|
| `ok` | a candidate resolved on the live page | nothing |
| `latent` | the guide marks it `when: "after-click"` — it only exists after another control is used (menu items, unfollow confirm) | audit it by hand, or drive the click first |
| `dead` | nothing matched and nothing should have been hidden | add the new candidate to `src/selectors.ts`, best first |

The same sweep is one MCP call — `inspect_screens {"device":"main"}` — so a fresh account, a second device, or an Instagram deploy that renames things is re-mapped without re-deriving anything: run it, read the dead rows, edit candidates, run again.

Only a screenshot-free JSON summary is returned by the tool; the CLI writes the full markdown with live control tables (tag, aria-label, placeholder, text, href) per screen.

## Repairing selectors — `mapping/`

Every screen this server touches has a generated map in `mapping/`: `home-map.md`, `login-map.md`, `signup-map.md`, `signup-code-map.md`, `challenge-map.md`, `create-post-map.md`, `edit-caption-map.md`, `post-modal-map.md`, `profile-map.md`, `feed-map.md`, `dm-map.md`, `notifications-map.md`, `story-map.md`. Each file carries the URL, a ready check that decides "am I on this screen", a probe expression, a control table (label → selector candidates → note), and the repair procedure. `mapping/README.md` is the index.

Coverage is enforced, not promised: `TOOL_COVERAGE` in `src/guidelines.ts` names the screens each tool drives, and `npm test` parses `src/server.ts` — a new tool without a mapping entry fails the suite, and so does a flow no tool uses or a selector key that does not exist in `src/selectors.ts`.

Maps are generated from `src/guidelines.ts`:

```bash
npm run maps          # rewrite mapping/*
npm test              # fails if mapping/ and the guide disagree
```

So the AI does not re-derive selectors: it calls `ui_guide {"device":"main","flow":"login"}` (static map + a live control dump of the current page), edits the candidate list in `src/selectors.ts` keeping the key name, and reruns the smallest action to prove it. `verified: "live"` in a map means it was checked against the real page on the date shown; anything else is a guess to be probed.

Selector candidates live in `src/selectors.ts` and are tried in order, so a DOM change is a one-line edit there — no flow code touched.

## Verification

```
npx tsc --noEmit          # exit 0, strict, no build step
npm test                  # 16/16: env isolation, registry, rate limits, cookies, locators,
                          #        challenge classes, captcha sitekeys, UA, cursor path, mapping drift
npm run maps              # regenerate mapping/* from src/guidelines.ts
npm run inspect -- --device main   # crawl every mapped screen, report dead selectors
IG_TEST_DEVICE=main npm run test:flows   # 10 live DOM checks (upload/fill/click/press) on fixtures
```

Measured on a logged-in device (2026-11-04):

| what | result |
|---|---|
| browser pane, stealth profile | `navigator.webdriver = null`, UA `Chrome/152` with `Electron`/`terminal-browser` stripped |
| reCAPTCHA Enterprise wall | cleared by a cursor path inside the out-of-process anchor frame |
| friendship list (friendship API, 50/page) | 1,498-1,533 following in ~60s vs ~150s by scrolling (and the scroll stops early) |
| unfollow through the dialog | 2.85s per handle after collapsing search + click + confirm into one page evaluation |
| legacy `POST /api/v1/friendships/destroy/<id>/` | dead: HTTP 200 with `content-type: text/html`, nothing unfollowed |
| guarded bulk unfollow | candidates verified with `followed_by` per account before acting, so accounts that follow back are never touched |

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

```
Copyright 2026 Fikri Nurhakim (akufikri)
```

Why Apache-2.0 and not MIT: it keeps every copyright and attribution notice intact when someone redistributes this, adds an explicit patent grant (and kills that grant if they sue over patents), and withholds trademark rights over the project name — while still allowing commercial and closed-source use. If you would rather forbid running a modified copy as a hosted service, AGPL-3.0 is the drop-in alternative: replace `LICENSE` with the AGPL text and set `"license": "AGPL-3.0-only"`.

## Notes

- `story_upload` is honest: desktop web does not expose story upload for most accounts, so it returns `Unsupported` rather than a fake success.
- The pane owns the browser. Closing the pane ends that device's session; cookies stay in `appdata/` for the next start. `device_stop` closes the browser without losing the profile.
- A pane opened by `device_start` belongs to the Tern window it was split from: killing the whole process group that asked for it (for example a harness that SIGKILLs the MCP) takes the pane down with it. Start the MCP from a normal shell or an editor session, not from a short-lived script.
- `agent-browser` is used through the binary terminal-browser ships, because that build speaks the `--cdp` path this server relies on.
