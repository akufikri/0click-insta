export type Loc =
  | { css: string }
  | { find: "role" | "text" | "label" | "placeholder" | "alt"; value: string };

/** First candidate that resolves wins; the rest are the fallback chain when Instagram ships a new DOM. */
export const S = {
  loginUser: [{ css: 'input[name="email"]' }, { css: 'input[name="username"]' }, { css: 'input[aria-label*="username" i]' }],
  loginPass: [{ css: 'input[name="pass"]' }, { css: 'input[name="password"]' }, { css: 'input[type="password"]' }],
  loginCode: [{ css: 'input[name="verificationCode"]' }, { css: 'input[name="security_code"]' }],
  loginSubmit: [
    { find: "text", value: "Log in" },
    { css: 'div[role="button"]' },
    { css: 'button[type="submit"]' },
    { css: 'input[type="submit"]' },
  ],
  navCreate: [{ css: 'a[href="/create/select/"]' }, { css: 'svg[aria-label="New post"]' }],
  navHome: [{ css: 'a[href="/"]' }, { css: 'svg[aria-label="Home"]' }],
  navNotifications: [
    { css: 'svg[aria-label="Notifications"]' },
    { css: 'a[href="/notifications/"]' },
  ],
  newPostButton: [{ find: "text", value: "Post" }],
  fileInput: [{ css: 'input[type="file"]' }],
  nextButton: [{ find: "text", value: "Next" }],
  shareButton: [{ find: "text", value: "Share" }],
  captionArea: [
    { css: 'div[role="dialog"] textarea[aria-label*="caption" i]' },
    { css: 'div[role="dialog"] div[contenteditable="true"]' },
    { css: 'textarea[aria-label*="caption" i]' },
  ],
  moreOptions: [
    { css: 'article svg[aria-label="More options"]' },
    { css: 'svg[aria-label="More options"]' },
    { css: 'div[role="button"][aria-label="More options"]' },
  ],
  menuEdit: [{ find: "text", value: "Edit" }],
  menuDelete: [{ find: "text", value: "Delete" }],
  confirmDelete: [{ find: "text", value: "Delete" }],
  followButton: [{ css: 'header button' }],
  followingButton: [{ css: 'header button' }],
  unfollowConfirm: [{ find: "text", value: "Unfollow" }],
  likeButton: [
    { css: 'article section svg[aria-label="Like"]' },
    { css: 'article section svg[aria-label="Unlike"]' },
    { css: 'svg[aria-label="Like"]' },
    { css: 'svg[aria-label="Unlike"]' },
  ],
  commentArea: [
    { css: 'article textarea[aria-label*="comment" i]' },
    { css: 'textarea[aria-label*="comment" i]' },
  ],
  commentSubmit: [{ find: "text", value: "Post" }],
  saveButton: [{ css: 'article svg[aria-label="Save"]' }, { css: 'article svg[aria-label="Remove"]' }],
  storyAvatar: [
    { css: 'header canvas' },
    { css: 'header img[alt*="profile picture" i]' },
  ],
  storyTab: [{ find: "text", value: "Story" }],
  feedPostLink: [{ css: 'main a[href*="/p/"], main a[href*="/reel/"]' }],
  dmThread: [{ css: 'a[href^="/direct/t/"]' }, { css: 'div[role="button"][tabindex="0"]' }],
  dmNewMessage: [{ css: 'svg[aria-label="New message"]' }, { css: 'a[href="/direct/new/"]' }],
  dmSearch: [{ css: 'input[name="queryBox"]' }, { css: 'input[placeholder*="Search" i]' }],
  dmResult: [{ css: 'div[role="dialog"] div[role="button"]' }],
  dmComposer: [
    { css: 'div[role="dialog"] textarea[placeholder*="Message" i]' },
    { css: 'textarea[placeholder*="Message" i]' },
    { css: 'div[role="textbox"][contenteditable="true"]' },
  ],
  profileBio: [{ css: "header section div > span" }],
  profileCounts: [{ css: "header section ul li" }],
  notificationsDialog: [{ css: 'main' }, { css: 'div[role="dialog"]' }],
  challengeFrame: [{ css: 'iframe[src*="challenge"], iframe[src*="captcha"]' }],
  signupSubmit: [{ find: "text", value: "Submit" }],
  signupMonth: [{ css: '[aria-label="Select Month"]' }],
  signupDay: [{ css: '[aria-label="Select Day"]' }],
  signupYear: [{ css: '[aria-label="Select Year"]' }],
  signupCode: [
    { css: 'input[aria-label*="code" i]' },
    { css: 'input[autocomplete="one-time-code"]' },
    { css: 'input[type="text"]' },
  ],
  signupConfirm: [{ find: "text", value: "Next" }, { find: "text", value: "Confirm" }, { find: "text", value: "Submit" }],
} satisfies Record<string, Loc[]>;

export type SelectorKey = keyof typeof S;

export type LocatorAction = "click" | "fill" | "type" | "hover" | "upload";

/** Locator -> agent-browser argv. Signatures come from `agent-browser find <locator> <value> <action> [text]`. */
export function actionArgv(loc: Loc, action: LocatorAction, payload?: string | string[]): string[] {
  const files = Array.isArray(payload) ? payload : [];
  if ("css" in loc) {
    switch (action) {
      case "click":
        return ["click", loc.css];
      case "hover":
        return ["hover", loc.css];
      case "fill":
        return ["fill", loc.css, String(payload ?? "")];
      case "type":
        return ["type", loc.css, String(payload ?? "")];
      case "upload":
        return ["upload", loc.css, ...files];
    }
  }
  switch (action) {
    case "click":
      return ["find", loc.find, loc.value, "click"];
    case "hover":
      return ["find", loc.find, loc.value, "hover"];
    case "fill":
      return ["find", loc.find, loc.value, "fill", String(payload ?? "")];
    case "type":
      return ["find", loc.find, loc.value, "type", String(payload ?? "")];
    case "upload":
      return ["find", loc.find, loc.value, "upload", ...files];
  }
}
