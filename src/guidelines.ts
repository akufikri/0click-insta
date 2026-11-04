import { DOM_MAP_JS } from "./introspect.ts";

export type ControlKind = "input" | "password" | "button" | "combobox" | "file" | "link";
export type Verification = "live" | "unverified";

export type GuideControl = {
  /** Key in src/selectors.ts when one exists, so the guide and the code cannot drift silently. */
  key?: string;
  kind: ControlKind;
  /** What a human reads on screen — the thing to search for when Instagram renames a class. */
  label: string;
  /** Selectors or context labels, best first. Context label means "the input whose nearby text is this". */
  find: string[];
  note?: string;
  /** "after-click" = only exists once another control was used; the inspector reports it as latent, not broken. */
  when?: "loaded" | "after-click";
};

export type GuideStep = {
  step: string;
  /** Free-form facts learned from a live run; rendered into the mapping file. */
  notes?: string;
  url?: string;
  /** JS predicate that is true when this step is on screen. */
  ready: string;
  probe: string;
  controls: GuideControl[];
  verified: Verification;
  verifiedAt?: string;
};

export type GuideName =
  | "home"
  | "login"
  | "signup"
  | "signup-code"
  | "challenge"
  | "create-post"
  | "edit-caption"
  | "post-modal"
  | "profile"
  | "following-list"
  | "feed"
  | "dm"
  | "notifications"
  | "story";

const SIGNUP_READY = `!!document.querySelector('input[type="password"]')`;

/** The map every AI should read before touching selectors: what is on screen, verified or not. */
export const GUIDES: Record<GuideName, GuideStep[]> = {
  home: [
    {
      step: "logged-in home feed with the left navigation rail",
      url: "https://www.instagram.com/",
      ready: `!!document.querySelector('a[href="/"] svg[aria-label="Home"], svg[aria-label="New post"], img[alt*="profile picture" i]')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        {
          key: "navHome",
          kind: "button",
          label: "Home",
          find: ['a[href="/"]', 'svg[aria-label="Home"]'],
          note: "the rail only exists while logged in; logged out the same URL redirects to the login wall",
        },
        { key: "navCreate", kind: "button", label: "New post", find: ['a[href="/create/select/"]', 'svg[aria-label="New post"]'] },
        { key: "navNotifications", kind: "button", label: "Notifications", find: ['svg[aria-label="Notifications"]', 'a[href="/notifications/"]'] },
        { kind: "link", label: "Explore / Reels / Direct", find: ['a[href="/explore/"]', 'a[href="/reels/"]', 'a[href="/direct/inbox/"]'] },
        {
          kind: "button",
          label: "profile avatar",
          find: ['img[alt$="profile picture" i]', 'img[alt*="profile picture" i]'],
          note: "alt is \"<handle>'s profile picture\" — this is how status and whoami learn the handle, so never rename it away",
        },
        { kind: "button", label: "More / Settings", find: ['svg[aria-label="Settings"]', 'svg[aria-label="More"]'] },
      ],
    },
    {
      step: "welcome / suggested follows overlay",
      ready: `(document.body ? document.body.innerText : '').includes('Welcome to Instagram')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { kind: "button", label: "Follow / Follow back", find: ["text:Follow", "text:Follow back"], note: "suggestions overlay only appears on fresh accounts" },
        { kind: "button", label: "Not now / Dismiss", find: ["text:Not now", "text:Dismiss", 'svg[aria-label="Close"]'] },
      ],
    },
  ],
  login: [
    {
      step: "password login form",
      url: "https://www.instagram.com/accounts/login/",
      ready: `!!document.querySelector('input[name="email"], input[name="username"]')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        {
          key: "loginUser",
          kind: "input",
          label: "Mobile number, username or email",
          find: ['input[name="email"]', 'input[name="username"]', 'input[aria-label*="username" i]'],
          note: "React-controlled: a programmatic fill is ignored and Submit silently does nothing. Click, Control+a, then type real key events",
        },
        {
          key: "loginPass",
          kind: "password",
          label: "Password",
          find: ['input[name="pass"]', 'input[name="password"]', 'input[type="password"]'],
          note: "same rule as the username field: type, never fill",
        },
        {
          key: "loginSubmit",
          kind: "button",
          label: "Log in",
          find: ["text:Log in", 'div[role="button"]', 'button[type="submit"]', 'input[type="submit"]'],
          note: 'input[type="submit"] exists but is zero-size and invisible — clicking it reports success and does nothing. The real button is the div[role="button"] whose text is exactly "Log in" (text match, not "Log in with Facebook")',
        },
        { kind: "link", label: "Create new account", find: ['a[href*="/accounts/emailsignup/"]'], note: "signup entry point from the login page" },
        { kind: "link", label: "Forgot password?", find: ['a[href*="/accounts/password/reset/"]'] },
      ],
    },
    {
      step: "auth_platform reCAPTCHA wall (out-of-process frames)",
      url: "https://www.instagram.com/auth_platform/recaptcha/",
      ready: `location.pathname.startsWith('/auth_platform/recaptcha')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        {
          kind: "button",
          label: "reCAPTCHA checkbox",
          find: ["CDP target: recaptcha/enterprise/anchor → #recaptcha-anchor"],
          note: "the widget is NOT in the page DOM. It lives in separate CDP targets: fbsbx.com/captcha/recaptcha/iframe (wrapper), google.com/recaptcha/enterprise/anchor (checkbox, #recaptcha-anchor) and .../bframe (image challenge). Click it through the anchor target; src/recaptcha.ts walks a human cursor path (CSR-S corner → bowed Bézier with jitter and pauses → small overshoot → press) because Enterprise scores pointer behaviour",
        },
        {
          kind: "input",
          label: "enterprise sitekey",
          find: ["k= parameter of the anchor/bframe target URL"],
          note: "6L… key is readable from the frame URL, so a provider solve is possible in principle; the checkbox path needs no key at all",
        },
        { kind: "button", label: "image challenge", find: ["#rc-imageselect inside the bframe target"], note: "only appears when the click escalates; stop and hand it to a human unless an image solver is wired" },
      ],
    },
    {
      step: "two-factor / security code",
      ready: `!!document.querySelector('input[name="verificationCode"], input[autocomplete="one-time-code"], input[aria-label*="code" i]')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "loginCode", kind: "input", label: "Security code", find: ['input[name="verificationCode"]', 'input[name="security_code"]', 'input[autocomplete="one-time-code"]'] },
        { key: "loginSubmit", kind: "button", label: "Confirm / Next", find: ["text:Confirm", "text:Next", 'button[type="submit"]'] },
      ],
    },
  ],
  signup: [
    {
      step: "Meta account form",
      url: "https://www.instagram.com/accounts/emailsignup/",
      ready: SIGNUP_READY,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        {
          kind: "input",
          label: "Mobile number or email",
          find: ["context:mobile number or email"],
          note: "no name, id or aria-label: select by the text next to it and write the value with the native setter, or React ignores it. Validation is live: example.com style addresses are rejected with \"Enter a correct email address\"",
        },
        { kind: "password", label: "Password", find: ["context:password", 'input[type="password"]'] },
        { kind: "input", label: "Full name", find: ["context:full name"] },
        { kind: "input", label: "Username", find: ['input[aria-label="Username"]', "context:username"], note: 'role="combobox" but it is a plain text input' },
        { key: "signupMonth", kind: "combobox", label: "Month", find: ['[aria-label="Select Month"]'] },
        { key: "signupDay", kind: "combobox", label: "Day", find: ['[aria-label="Select Day"]'] },
        { key: "signupYear", kind: "combobox", label: "Year", find: ['[aria-label="Select Year"]'] },
        { key: "signupSubmit", kind: "button", label: "Submit", find: ["text:Submit"], note: 'div[role="button"], not a <button>' },
        { kind: "button", label: "I already have an account", find: ["text:I already have an account"] },
      ],
    },
  ],
  "signup-code": [
    {
      step: "email or SMS confirmation code",
      ready: `!!document.querySelector('input[autocomplete="one-time-code"], input[aria-label*="code" i], input[type="text"]')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "signupCode", kind: "input", label: "Confirmation code", find: ['input[autocomplete="one-time-code"]', 'input[aria-label*="code" i]', 'input[type="text"]'] },
        { key: "signupConfirm", kind: "button", label: "Next / Confirm / Submit", find: ["text:Next", "text:Confirm", "text:Submit"], when: "after-click" },
      ],
    },
  ],
  challenge: [
    {
      step: "Cloudflare / captcha wall",
      ready: `!/^https?:\\/\\/www\\.instagram\\.com\\/$/.test(location.href) || /just a moment|verify you are human|confirm it'?s you/i.test(document.body ? document.body.innerText : '')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        { kind: "input", label: "captcha response field", find: ['textarea[name="g-recaptcha-response"]', 'textarea[name="h-captcha-response"]', 'input[name="cf-turnstile-response"]'], note: "token injection target for challenge_solve" },
        { kind: "button", label: "Turnstile checkbox", find: ["iframe[src*=turnstile]", "iframe[src*=challenges.cloudflare.com]"] },
        { kind: "button", label: "Continue / Try again", find: ["text:Continue", "text:Try again"] },
      ],
    },
    {
      step: "Instagram checkpoint (confirm identity, code, selfie)",
      url: "https://www.instagram.com/challenge/",
      ready: `location.pathname.includes('/challenge') || /confirm it'?s you|help us confirm|we detected unusual activity/i.test(document.body ? document.body.innerText : '')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      notes: "with a healthy session this route answers a generic 'Reload page' shell; real checkpoints (code entry, selfie) only render under a flagged session",
      controls: [
        { kind: "input", label: "security code", find: ['input[name="security_code"]', 'input[aria-label*="code" i]', 'input[type="text"]'] },
        { kind: "button", label: "Next / Continue / Confirm", find: ["text:Next", "text:Continue", "text:Confirm"] },
        { kind: "button", label: "Send code again / Resend", find: ["text:Send code again", "text:Resend"] },
        { kind: "button", label: "Try another way", find: ["text:Try another way"] },
        { kind: "button", label: "selfie / video check", find: ["text:Take a video selfie", "text:Take a selfie"], note: "human only; no automation path and none should be invented" },
      ],
    },
  ],
  "create-post": [
    {
      step: "create dialog, first screen",
      url: "https://www.instagram.com/",
      ready: `!!document.querySelector('a[href="/create/select/"], svg[aria-label="New post"]')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      notes: "the nav icon is an <svg> inside a role=button wrapper: click the wrapper, the svg alone does nothing. input[type=file] is present but intentionally zero-size, so the inspector treats a hidden file input as ok",
      controls: [
        { key: "navCreate", kind: "button", label: "Create", find: ['a[href="/create/select/"]', 'svg[aria-label="New post"]'] },
        { key: "fileInput", kind: "file", label: "Select from computer", find: ['input[type="file"]'], note: "always CSS: the input is canvas-hidden" },
        { kind: "button", label: "Post / Reel / Story tab", find: ["text:Post", "text:Reel", "text:Story"], note: "Reel and Story only appear for eligible accounts" },
      ],
    },
    {
      step: "crop then filter then caption",
      ready: `!!document.querySelector('div[role="dialog"]')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "nextButton", kind: "button", label: "Next", find: ["text:Next"], note: "click twice: crop then filter" },
        { key: "captionArea", kind: "input", label: "Write a caption", find: ['textarea[aria-label*="caption" i]', 'div[role="dialog"] div[contenteditable="true"]'], note: "textarea on most accounts, contenteditable on some" },
        { key: "shareButton", kind: "button", label: "Share", find: ["text:Share"] },
      ],
    },
    {
      step: "reel tab selected (kind=reel)",
      ready: `!!document.querySelector('div[role="dialog"]') && (document.body ? document.body.innerText : '').toLowerCase().includes('reel')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { kind: "button", label: "Reel tab", find: ["text:Reel"], note: "appears in the create dialog for accounts with reels enabled" },
        { key: "nextButton", kind: "button", label: "Next", find: ["text:Next"] },
        { key: "captionArea", kind: "input", label: "Write a caption", find: ['textarea[aria-label*="caption" i]', 'div[role="dialog"] div[contenteditable="true"]'] },
        { key: "shareButton", kind: "button", label: "Share", find: ["text:Share"] },
      ],
    },
    {
      step: "story tab (story_upload)",
      ready: `!!document.querySelector('div[role="dialog"]') && Array.from(document.querySelectorAll('div[role="dialog"] *')).some((node) => (node.innerText || '').trim() === 'Story')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "storyTab", kind: "button", label: "Story", find: ["text:Story"], note: "absent on most desktop accounts — story_upload must answer Unsupported, never fake success" },
        { key: "fileInput", kind: "file", label: "upload", find: ['input[type="file"]'] },
        { kind: "button", label: "Share to story", find: ["text:Share to story", "text:Share"] },
      ],
    },
    {
      step: "share confirmation",
      ready: `(document.body ? document.body.innerText : '').includes('Your post has been shared')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { kind: "button", label: "Done", find: ["text:Done"] },
        { kind: "link", label: "post permalink", find: ['div[role="dialog"] a[href*="/p/"]', 'div[role="dialog"] a[href*="/reel/"]'] },
      ],
    },
  ],
  "edit-caption": [
    {
      step: "edit dialog opened from a post",
      ready: `!!document.querySelector('div[role="dialog"] textarea, div[role="dialog"] div[contenteditable="true"]')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "captionArea", kind: "input", label: "Edit caption", find: ['div[role="dialog"] textarea[aria-label*="caption" i]', 'div[role="dialog"] div[contenteditable="true"]'] },
        { kind: "button", label: "Done", find: ["text:Done"] },
        { kind: "button", label: "Cancel", find: ["text:Cancel"] },
        { kind: "button", label: "accessibility captions", find: ["text:Add alt text", "text:Accessibility"], note: "do not confuse with the caption textarea" },
      ],
    },
  ],
  "post-modal": [
    {
      step: "single post view",
      url: "https://www.instagram.com/p/<shortcode>/",
      ready: `!!document.querySelector('article')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "moreOptions", kind: "button", label: "More options", find: ['article svg[aria-label="More options"]', 'svg[aria-label="More options"]'] },
        { key: "likeButton", kind: "button", label: "Like / Unlike", find: ['article section svg[aria-label="Like"]', 'article section svg[aria-label="Unlike"]'], note: "aria-label is the state: Like means not liked" },
        { key: "saveButton", kind: "button", label: "Save / Remove", find: ['article svg[aria-label="Save"]', 'article svg[aria-label="Remove"]'] },
        { key: "commentArea", kind: "input", label: "Add a comment", find: ['textarea[aria-label*="comment" i]'] },
        { key: "commentSubmit", kind: "button", label: "Post", find: ["text:Post"], note: "scope to article or the create dialog steals the click" },
        { key: "menuEdit", kind: "button", label: "Edit", find: ["text:Edit"], note: "only on your own posts", when: "after-click" },
        { key: "menuDelete", kind: "button", label: "Delete", find: ["text:Delete"], when: "after-click" },
        { key: "confirmDelete", kind: "button", label: "Delete (dialog)", find: ["text:Delete"], note: "second click inside div[role=dialog]", when: "after-click" },
      ],
    },
  ],
  profile: [
    {
      step: "profile header",
      url: "https://www.instagram.com/<username>/",
      ready: `!!document.querySelector('header section')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        { kind: "button", label: "Follow / Following / Requested", find: ["header button", 'header div[role="button"]'] },
        { key: "followButton", kind: "button", label: "Follow", find: ["text:Follow"], note: "read header button text first: idempotency depends on it" },
        { key: "unfollowConfirm", kind: "button", label: "Unfollow", find: ["text:Unfollow"], when: "after-click" },
        { key: "storyAvatar", kind: "button", label: "story ring", find: ["header canvas", 'header img[alt*="profile picture" i]'] },
        { kind: "link", label: "post grid", find: ['main a[href*="/p/"]', 'main a[href*="/reel/"]'] },
      ],
    },
  ],
  "following-list": [
    {
      step: "following dialog opened from a profile",
      url: "https://www.instagram.com/<username>/",
      ready: `!!document.querySelector('div[role="dialog"]') && /following/i.test(document.querySelector('div[role="dialog"]').innerText.slice(0, 40))`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      notes: "no 'follows you' badge in 2026 web: whether someone follows back is computed as following minus followers. Fast path is Instagram's own friendship API called from the page (cookie auth): GET /api/v1/friendships/<ds_user_id>/following|followers/?count=50&max_id=… with headers x-ig-app-id=936619743392459 and x-csrftoken; 50 users per request, whole 1.6k list in seconds. The dialog crawl (virtualised rows, ~1.6s per scroll) is the fallback when the API pushes back. Unfollow is POST /api/v1/friendships/destroy/<user_id>/ with user_id in the urlencoded body",
      controls: [
        {
          kind: "button",
          label: "N following (profile counter)",
          find: ["text/^[\d.,KM]+ following$/ on a link, div[role=button] or span"],
          note: "the counter is not an <a href> in current web: match its text, then click the node; clicking the count opens the dialog titled Following",
        },
        {
          kind: "input",
          label: "Search inside the list",
          find: ['div[role="dialog"] input[aria-label="Search input"]', 'div[role="dialog"] input[placeholder*="Search" i]'],
          note: "aria-label is literally \"Search input\". Typing filters rows in place; unfollow_selected uses it to find one handle without crawling the whole list. Never filter while computing a set difference",
        },
        { kind: "button", label: "Following (row button)",
          find: ['div[role="dialog"] a[href="/<handle>/"] → nearest ancestor containing a div[role=button] whose text is Following'],
          note: "click opens a small confirm dialog; the row button is what unfollow_bulk presses",
        },
        { kind: "button", label: "Unfollow (confirm)", find: ["text:Unfollow inside div[role=dialog]"], note: "second click, same as the profile path" },
        { kind: "button", label: "Close", find: ['svg[aria-label="Close"]'], note: "closes the list without touching the relationship" },
      ],
    },
  ],
  feed: [
    {
      step: "home feed",
      url: "https://www.instagram.com/",
      ready: `!!document.querySelector('main')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        { key: "navHome", kind: "button", label: "Home", find: ['a[href="/"]', 'svg[aria-label="Home"]'] },
        { key: "navNotifications", kind: "button", label: "Notifications", find: ['svg[aria-label="Notifications"]', 'a[href="/notifications/"]'] },
        { key: "feedPostLink", kind: "link", label: "post links", find: ['main a[href*="/p/"]', 'main a[href*="/reel/"]'] },
      ],
    },
  ],
  dm: [
    {
      step: "direct inbox",
      url: "https://www.instagram.com/direct/inbox/",
      ready: `!!document.querySelector('a[href^="/direct/t/"], svg[aria-label="New message"]')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      controls: [
        { key: "dmNewMessage", kind: "button", label: "New message", find: ['svg[aria-label="New message"]', 'a[href="/direct/new/"]'] },
        { key: "dmThread", kind: "link", label: "thread row", find: ['a[href^="/direct/t/"]'] },
      ],
    },
    {
      step: "new message dialog",
      ready: `!!document.querySelector('div[role="dialog"]')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "dmSearch", kind: "input", label: "Search", find: ['input[name="queryBox"]', 'input[placeholder*="Search" i]'] },
        { kind: "button", label: "recipient row", find: ['div[role="dialog"] div[role="button"]'], note: "match the username text exactly, display names collide" },
        { kind: "button", label: "Chat / Next", find: ["text:Chat", "text:Next"] },
      ],
    },
    {
      step: "thread composer",
      ready: `!!document.querySelector('textarea[placeholder*="Message" i], div[role="textbox"]')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      controls: [
        { key: "dmComposer", kind: "input", label: "Message", find: ['textarea[placeholder*="Message" i]', 'div[role="textbox"][contenteditable="true"]'] },
        { kind: "button", label: "Send", find: ["text:Send"], note: "Enter also sends" },
      ],
    },
  ],
  notifications: [
    {
      step: "notifications panel",
      url: "https://www.instagram.com/notifications/",
      ready: `!!document.querySelector('div[role="dialog"], main')`,
      probe: DOM_MAP_JS,
      verified: "live",
      verifiedAt: "2026-11-04",
      notes: "rows live in <main> as plain text lines; the filter tabs (All, People you follow, Comments, Follows, Tags & mentions, Verified) must be dropped",
      controls: [
        { key: "notificationsDialog", kind: "button", label: "notification rows", find: ['div[role="dialog"]', 'main'] },
        { kind: "button", label: "Follow back", find: ["text:Follow back"] },
      ],
    },
  ],
  story: [
    {
      step: "story viewer",
      url: "https://www.instagram.com/stories/<username>/",
      ready: `!!document.querySelector('section [role="progressbar"], div[role="dialog"] section')`,
      probe: DOM_MAP_JS,
      verified: "unverified",
      notes: "needs an account with an active story: with none, Instagram redirects /stories/<handle>/ to the profile and the ready check stays false",
      controls: [
        { kind: "button", label: "next story", find: ['button[aria-label="Next"]', 'div[role="dialog"] [aria-label="Next"]'] },
        { kind: "button", label: "close", find: ['svg[aria-label="Close"]'] },
        { kind: "input", label: "reply box", find: ['textarea[placeholder*="Reply" i]'] },
      ],
    },
  ],
};

export const GUIDE_NAMES = Object.keys(GUIDES) as GuideName[];

/**
 * Which screen each MCP tool drives. "no-ui" tools never touch Instagram's DOM.
 * src/server.ts is parsed by the test: a new tool without an entry fails the suite.
 */
export const TOOL_COVERAGE: Record<string, GuideName[] | "no-ui"> = {
  device_list: "no-ui",
  device_create: "no-ui",
  device_delete: "no-ui",
  device_start: "no-ui",
  device_stop: "no-ui",
  pane_command: "no-ui",
  proxy_set: "no-ui",
  stealth_apply: "no-ui",
  page_reload: "no-ui",
  eval_page: "no-ui",
  challenge_probe_text: "no-ui",
  ui_guide: "no-ui",
  logout: "no-ui",
  status: ["home"],
  login: ["login", "challenge"],
  register: ["signup", "signup-code", "challenge"],
  register_verify: ["signup-code", "challenge"],
  challenge_status: ["challenge"],
  captcha_state: ["challenge"],
  captcha_click: ["challenge"],
  inspect_screens: "no-ui",
  challenge_solve: ["challenge"],
  post: ["create-post"],
  edit_post: ["post-modal", "edit-caption"],
  delete_post: ["post-modal"],
  follow: ["profile"],
  unfollow_selected: ["following-list"],
  follow_status: ["following-list"],
  unfollow: ["profile"],
  like: ["post-modal"],
  unlike: ["post-modal"],
  comment: ["post-modal"],
  save: ["post-modal"],
  unsave: ["post-modal"],
  profile: ["profile"],
  following_list: ["following-list", "profile"],
  followers_list: ["following-list", "profile"],
  unfollow_bulk: ["following-list", "profile"],
  feed: ["feed", "home"],
  dm_list: ["dm"],
  dm_send: ["dm"],
  story_view: ["story", "profile"],
  story_upload: ["create-post"],
  notifications: ["notifications", "home"],
};

/** Checklist an AI runs before repairing anything: static guide + the live screen. */
export const REPAIR_RECIPE = [
  "1. ui_guide {device, flow} — read the static map and the live controls of the current screen.",
  "2. Compare live controls with the guide: the label text (aria, placeholder, nearby text) is the stable anchor, not class names.",
  "3. Probe deeper with eval_page when a control is missing: document.querySelectorAll('input,textarea,[role=button]') mapped with aria-label and parent text.",
  "4. Edit src/selectors.ts (candidate list, best first), keep the key name, restart the MCP.",
  "5. Prove it with the smallest action: eval_page value read-back or the real tool call.",
  "6. If the flow changed shape (new step, new dialog), add the step to src/guidelines.ts with verified:\"live\" and today's date.",
];
