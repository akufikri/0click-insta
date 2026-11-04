# mapping/

Selector maps for every Instagram screen this server drives. One file per flow, generated from `src/guidelines.ts`.

| file | flow | steps | verified live |
|---|---|---|---|
| [home-map.md](./home-map.md) | home | 2 | yes |
| [login-map.md](./login-map.md) | login | 3 | yes |
| [signup-map.md](./signup-map.md) | signup | 1 | yes |
| [signup-code-map.md](./signup-code-map.md) | signup-code | 1 | no |
| [challenge-map.md](./challenge-map.md) | challenge | 2 | yes |
| [create-post-map.md](./create-post-map.md) | create-post | 5 | yes |
| [edit-caption-map.md](./edit-caption-map.md) | edit-caption | 1 | no |
| [post-modal-map.md](./post-modal-map.md) | post-modal | 1 | no |
| [profile-map.md](./profile-map.md) | profile | 1 | yes |
| [following-list-map.md](./following-list-map.md) | following-list | 1 | yes |
| [feed-map.md](./feed-map.md) | feed | 1 | yes |
| [dm-map.md](./dm-map.md) | dm | 3 | yes |
| [notifications-map.md](./notifications-map.md) | notifications | 1 | yes |
| [story-map.md](./story-map.md) | story | 1 | no |

Regenerate after editing the guide:

```bash
npm run maps
```

## Run the inspector on any account

```bash
npm run inspect -- --device <id>                  # every mapped screen
npm run inspect -- --device <id> --flows profile,dm
npm run inspect -- --device <id> --username someone_else
```

Each run writes `mapping/inspect/<timestamp>-<device>.md`: per screen, whether the ready check fired, every selector key with **ok** or **dead**, which candidate matched, and the live controls it saw. Exit code 2 means something is dead. The same sweep is available to an agent as the MCP tool `inspect_screens`, so a new account (or a new Instagram deploy) is re-mapped with one call instead of guesswork.

The generated files are checked by `npm test`: if a map and the guide disagree, the test fails, so the docs cannot rot.

## Rules

- A **label** (aria-label, placeholder, nearby heading text) is the anchor. Class names and DOM depth are not.
- A **ready check** must be a JS expression that is true exactly when the step is on screen; it is what `ui_guide` and the flows both use.
- `verified: "live"` means a human-or-agent run on the real page on the date shown. Anything else is a starting guess and must be probed before use.
- Keys in the tables (`loginUser`, `captionArea`, …) are the names in `src/selectors.ts`. Never rename a key to paper over a DOM change: add a candidate instead.

## Add a flow

1. Write its steps in `src/guidelines.ts` (`step`, `url?`, `ready`, `probe`, `controls`, `verified`).
2. `npm run maps`.
3. Implement the flow in `src/ig.ts` using `S` keys, and the tool in `src/server.ts`.
4. Verify live and flip `verified` to `"live"` with today's date.
