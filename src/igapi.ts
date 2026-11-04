import { evalJson } from "./agent.ts";
import { fail } from "./errors.ts";
import { sleep } from "./sleep.ts";

export type ApiUser = { username: string; id: string; fullName: string };
export type ApiList = {
  users: ApiUser[];
  pages: number;
  complete: boolean;
  status: string;
  blocked: boolean;
  elapsedMs: number;
};

export const IG_APP_ID = "936619743392459";

const COOKIES_JS = `(() => {
  const pick = (name) => {
    const match = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  };
  return { userId: pick('ds_user_id'), csrf: pick('csrftoken') };
})()`;

export async function sessionIds(deviceId: string): Promise<{ userId: string; csrf: string }> {
  const ids = await evalJson<{ userId: string | null; csrf: string | null }>(deviceId, COOKIES_JS);
  if (!ids.userId) fail("NotLoggedIn", "no ds_user_id cookie on this device: the session is not logged in");
  return { userId: ids.userId, csrf: ids.csrf ?? "" };
}

/**
 * Reads a followers/following list through Instagram's own friendship API instead of
 * scrolling the dialog: 50 users per request, seconds instead of minutes.
 */
export async function friendshipList(
  deviceId: string,
  kind: "following" | "followers",
  options: { userId?: string; count?: number; maxPages?: number } = {},
): Promise<ApiList> {
  const started = Date.now();
  const session = await sessionIds(deviceId);
  const userId = options.userId ?? session.userId;
  const count = Math.min(Math.max(options.count ?? 50, 1), 200);
  const maxPages = Math.min(Math.max(options.maxPages ?? 200, 1), 400);
  const result = await evalJson<{
    users: ApiUser[];
    pages: number;
    complete: boolean;
    status: string;
    blocked: boolean;
    reason?: string;
    lastBody?: string;
  }>(
    deviceId,
    `(async () => {
      const pick = (name) => {
        const match = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]+)'));
        return match ? decodeURIComponent(match[2]) : null;
      };
      const csrf = pick('csrftoken') || '';
      const headers = { 'x-ig-app-id': '${IG_APP_ID}', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' };
      const users = [];
      const seen = new Set();
      let maxId = null;
      let pages = 0;
      let status = 'ok';
      let blocked = false;
      let complete = false;
      let lastBody = '';
      while (pages < ${maxPages}) {
        const url = '/api/v1/friendships/${userId}/${kind}/?count=${count}' + (maxId ? '&max_id=' + encodeURIComponent(maxId) : '');
        let response = null;
        let text = '';
        try {
          response = await fetch(url, { headers, credentials: 'include' });
          text = await response.text();
          lastBody = text.slice(0, 300);
        } catch (error) {
          status = 'network';
          break;
        }
        if (response.status !== 200) {
          status = 'http-' + response.status;
          blocked = response.status === 429 || response.status === 403 || /feedback_required/i.test(text);
          break;
        }
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (error) {
          status = 'bad-json';
          break;
        }
        pages += 1;
        const batch = Array.isArray(json.users) ? json.users : [];
        for (const user of batch) {
          const username = user.username;
          if (!username || seen.has(username)) continue;
          seen.add(username);
          users.push({ username, id: String(user.pk || user.pk_id || user.id || ''), fullName: user.full_name || '' });
        }
        maxId = json.next_max_id || null;
        if (!maxId || batch.length === 0) {
          complete = true;
          break;
        }
      }
      return { users, pages, complete, status, blocked, lastBody };
    })()`,
    300_000,
  );
  return {
    users: result.users ?? [],
    pages: result.pages ?? 0,
    complete: result.complete === true,
    status: result.status ?? "unknown",
    blocked: result.blocked === true,
    elapsedMs: Date.now() - started,
  };
}

export type DestroyResult = { ok: boolean; following: boolean | null; status: string; blocked: boolean; message?: string };

/** Unfollows one account with the same endpoint the web UI uses. */
export async function friendshipDestroy(deviceId: string, userId: string): Promise<DestroyResult> {
  const session = await sessionIds(deviceId);
  return evalJson<DestroyResult>(
    deviceId,
    `(async () => {
      const headers = {
        'x-ig-app-id': '${IG_APP_ID}',
        'x-csrftoken': ${JSON.stringify(session.csrf)},
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/x-www-form-urlencoded',
      };
      const body = new URLSearchParams({ user_id: ${JSON.stringify(userId)} }).toString();
      let response = null;
      let text = '';
      try {
        response = await fetch('/api/v1/friendships/destroy/${userId}/', { method: 'POST', headers, body, credentials: 'include' });
        text = await response.text();
      } catch (error) {
        return { ok: false, following: null, status: 'network', blocked: false, message: String(error) };
      }
      let json = null;
      try { json = JSON.parse(text); } catch (error) { json = null; }
      const blocked = response.status === 429 || /feedback_required|rate limit|please wait/i.test(text);
      return {
        ok: response.status === 200 && !!json && json.status === 'ok',
        following: json && json.friendship_status ? json.friendship_status.following : null,
        status: 'http-' + response.status,
        blocked,
        message: json && json.message ? json.message : text.slice(0, 200),
      };
    })()`,
  );
}

export type ApiUnfollowReport = {
  requested: number;
  unfollowed: string[];
  failed: Array<{ username: string; status: string; message?: string }>;
  blocked: boolean;
  elapsedMs: number;
};

/** Batch unfollow with pacing, stopping the moment Instagram pushes back. */
export async function unfollowManyApi(
  deviceId: string,
  targets: Array<{ username: string; id: string }>,
  options: { paceMinMs?: number; paceMaxMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<ApiUnfollowReport> {
  const started = Date.now();
  const paceMin = options.paceMinMs ?? Number(process.env.IG_API_UNFOLLOW_MIN_MS ?? 700);
  const paceMax = options.paceMaxMs ?? Number(process.env.IG_API_UNFOLLOW_MAX_MS ?? 1600);
  const report: ApiUnfollowReport = { requested: targets.length, unfollowed: [], failed: [], blocked: false, elapsedMs: 0 };
  for (const [index, target] of targets.entries()) {
    const result = await friendshipDestroy(deviceId, target.id);
    if (result.ok && result.following === false) report.unfollowed.push(target.username);
    else report.failed.push({ username: target.username, status: result.status, message: result.message });
    if (result.blocked) {
      report.blocked = true;
      break;
    }
    options.onProgress?.(index + 1, targets.length);
    const wait = paceMin + Math.round(Math.random() * Math.max(0, paceMax - paceMin));
    await sleep(wait);
  }
  report.elapsedMs = Date.now() - started;
  return report;
}

export type FriendshipState = { userId: string; following: boolean | null; followedBy: boolean | null; status: string };

/**
 * Authoritative per-account check: does this user follow me back right now?
 * Used as a guard before any unfollow, because the list endpoints can miss accounts.
 */
export async function friendshipShowMany(
  deviceId: string,
  userIds: string[],
  options: { paceMinMs?: number; paceMaxMs?: number } = {},
): Promise<FriendshipState[]> {
  if (userIds.length === 0) return [];
  const session = await sessionIds(deviceId);
  const paceMin = options.paceMinMs ?? 120;
  const paceMax = options.paceMaxMs ?? 320;
  return evalJson<FriendshipState[]>(
    deviceId,
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const headers = {
        'x-ig-app-id': '${IG_APP_ID}',
        'x-csrftoken': ${JSON.stringify(session.csrf)},
        'x-requested-with': 'XMLHttpRequest',
      };
      const ids = ${JSON.stringify(userIds)};
      const out = [];
      for (const id of ids) {
        try {
          const response = await fetch('/api/v1/friendships/show/' + id + '/', { headers, credentials: 'include' });
          const text = await response.text();
          let json = null;
          try { json = JSON.parse(text); } catch (error) { json = null; }
          out.push({
            userId: id,
            following: json && typeof json.following === 'boolean' ? json.following : null,
            followedBy: json && typeof json.followed_by === 'boolean' ? json.followed_by : null,
            status: 'http-' + response.status,
          });
        } catch (error) {
          out.push({ userId: id, following: null, followedBy: null, status: 'network' });
        }
        await sleep(${paceMin} + Math.round(Math.random() * ${Math.max(0, paceMax - paceMin)}));
      }
      return out;
    })()`,
    300_000,
  );
}
