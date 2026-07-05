/**
 * Chickadee Bandit SDK
 * Shared utilities and helper factories for all hub apps.
 * Import: import { ... } from "/hub-sdk.js";
 */

// ── Avatar ─────────────────────────────────────────────────────────────────────
export const AVATAR_COLORS = [
  "#0284c7","#0891b2","#059669","#7c3aed","#db2777","#ea580c","#65a30d","#b45309",
];

export function memberColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initial(name) {
  return String(name).trim()[0]?.toUpperCase() ?? "?";
}

// ── HTML escaping ──────────────────────────────────────────────────────────────
export function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Member role ────────────────────────────────────────────────────────────────
export function isAdult(member) {
  return !!member && (member.role === "adult" || member.role === "admin");
}

// ── Relative dates ─────────────────────────────────────────────────────────────
export function formatRelativeDate(iso) {
  const now = new Date(), d = new Date(iso), diff = now - d;
  const mins = Math.floor(diff / 60_000), hours = Math.floor(diff / 3_600_000), days = Math.floor(diff / 86_400_000);
  if (mins  <  1) return "just now";
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days  <  7) return d.toLocaleDateString("en-US", { weekday: "short" });
  if (now.getFullYear() === d.getFullYear())
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Money formatting ───────────────────────────────────────────────────────────
/**
 * fmtMoney(cents)
 * Format an integer cent value as a USD currency string with no decimal places.
 * Negative values are prefixed with a minus sign outside the $: -$1,234
 * Null/undefined returns "—".
 * Use: fmtMoney(125000) → "$1,250"
 */
export function fmtMoney(cents) {
  if (cents == null) return "—";
  const abs = Math.abs(cents);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(abs / 100);
  return cents < 0 ? `-${formatted}` : formatted;
}

/**
 * fmtMoneyShort(cents)
 * Compact format for large amounts: $1.3M, $450K, $1,200.
 * Millions use one decimal place; ten-thousands and above use rounded K.
 * Use: fmtMoneyShort(45000000) → "$450K"
 *      fmtMoneyShort(125000000) → "$1.3M"
 */
export function fmtMoneyShort(cents) {
  if (cents == null) return "—";
  const abs = Math.abs(cents);
  const dollars = abs / 100;
  let formatted;
  if (dollars >= 1_000_000) formatted = `$${(dollars / 1_000_000).toFixed(1)}M`;
  else if (dollars >= 10_000) formatted = `$${Math.round(dollars / 1_000)}K`;
  else formatted = fmtMoney(abs);
  return cents < 0 ? `-${formatted}` : formatted;
}

// ── DB helper factory ──────────────────────────────────────────────────────────
/**
 * createDbHelper(dbUrl)
 * Returns an async dbq(sql, params) function that posts queries to the hub db proxy.
 * Use: const db = createDbHelper(window.__DB_URL);
 *      const { rows } = await db("SELECT * FROM items");
 */
export function createDbHelper(dbUrl) {
  return async function dbq(sql, params = []) {
    if (!dbUrl) return { rows: [] };
    const res = await fetch(dbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json;
  };
}

// ── Events helper factory ──────────────────────────────────────────────────────
/**
 * createEventsHelper(eventsUrl, sourceAppId)
 * Returns { publish, list } for the hub event log.
 * Use: const events = createEventsHelper(window.__EVENTS_URL, window.__APP_ID);
 *      await events.publish("allowance.weekly", { cents: 500 }, memberId);
 *      const past = await events.list({ type: "allowance.weekly", since: "2025-01-01T00:00:00Z" });
 */
export function createEventsHelper(eventsUrl, sourceAppId) {
  return {
    async publish(type, payload = {}, subjectId) {
      if (!eventsUrl) return null;
      const res = await fetch(eventsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_app_id: sourceAppId, type, payload, subject_id: subjectId }),
      });
      return res.ok ? res.json() : null;
    },
    async list({ type, subjectId, since, limit } = {}) {
      if (!eventsUrl) return [];
      const p = new URLSearchParams();
      if (type)      p.set("type", type);
      if (subjectId) p.set("subject_id", subjectId);
      if (since)     p.set("since", since);
      if (limit)     p.set("limit", String(limit));
      const res = await fetch(`${eventsUrl}?${p}`);
      return res.ok ? res.json() : [];
    },
  };
}

// ── Prefs helper factory ───────────────────────────────────────────────────────
/**
 * createPrefsHelper(prefsUrl)
 * Per-member, per-app key-value preferences.
 * Use: const prefs = createPrefsHelper(window.__PREFS_URL);
 *      await prefs.set("theme", "dark");
 *      const theme = await prefs.get("theme");
 *      const all = await prefs.getAll();
 */
export function createPrefsHelper(prefsUrl) {
  return {
    async get(key) {
      if (!prefsUrl) return null;
      const res = await fetch(`${prefsUrl}?key=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      return (await res.json()).value ?? null;
    },
    async getAll() {
      if (!prefsUrl) return {};
      const res = await fetch(prefsUrl);
      return res.ok ? res.json() : {};
    },
    async set(key, value) {
      if (!prefsUrl) return;
      await fetch(prefsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: String(value) }),
      });
    },
    async delete(key) {
      if (!prefsUrl) return;
      await fetch(`${prefsUrl}?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    },
  };
}

// ── Files helper factory ───────────────────────────────────────────────────────
/**
 * createFilesHelper(filesUrl)
 * Upload, list, serve and delete files via the hub file proxy.
 * Use: const files = createFilesHelper(window.__FILES_URL);
 *      const { id, url } = await files.upload(fileInputEl.files[0]);
 *      const { files: list, totalBytes, limit } = await files.list();
 *      await files.delete(id);
 */
export function createFilesHelper(filesUrl) {
  return {
    async upload(file, onProgress) {
      if (!filesUrl) throw new Error("No files URL");
      const form = new FormData();
      form.append("file", file);
      // XMLHttpRequest used so callers can track upload progress
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", filesUrl);
        xhr.onload = () => {
          if (xhr.status === 201) resolve(JSON.parse(xhr.responseText));
          else reject(new Error(JSON.parse(xhr.responseText)?.error ?? `Upload failed: ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("Upload failed"));
        if (onProgress) xhr.upload.onprogress = onProgress;
        xhr.send(form);
      });
    },
    async list() {
      if (!filesUrl) return { files: [], totalBytes: 0, limit: 0 };
      const res = await fetch(filesUrl);
      return res.ok ? res.json() : { files: [], totalBytes: 0, limit: 0 };
    },
    async delete(fileId) {
      if (!filesUrl) return;
      await fetch(`${filesUrl}/${fileId}`, { method: "DELETE" });
    },
    url(fileId) {
      return filesUrl ? `${filesUrl}/${fileId}` : null;
    },
  };
}

// ── Confirmation dialog ────────────────────────────────────────────────────────
/**
 * hubConfirm(message, opts?)
 * Show the hub's confirmation dialog. Returns a Promise<boolean>.
 * When running inside a hub iframe the dialog is rendered by the parent hub frame.
 * Falls back to window.confirm() when used outside the hub.
 *
 * Use: const ok = await hubConfirm("Delete this item?");
 *      const ok = await hubConfirm("Delete plant?", { description: "All care data will be removed.", confirmLabel: "Delete" });
 */
export function hubConfirm(message, opts = {}) {
  if (window.parent === window) {
    const text = typeof message === "string" ? message : (message.message ?? message.title ?? "Are you sure?");
    return Promise.resolve(window.confirm(text));
  }
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    function handler(e) {
      if (e.data?.type === "hub:confirm:response" && e.data.id === id) {
        window.removeEventListener("message", handler);
        resolve(!!e.data.result);
      }
    }
    window.addEventListener("message", handler);
    const payload = typeof message === "string"
      ? { message, ...opts }
      : { message: message.message ?? message.title, ...message, ...opts };
    window.parent.postMessage({ type: "hub:confirm", id, ...payload }, "*");
  });
}

/**
 * hubAlert(message, opts?)
 * Show a single-button notification dialog rendered by the parent hub frame,
 * avoiding the browser's "an embedded page says…" iframe alert chrome.
 * Falls back to window.alert() when used outside the hub.
 *
 * Use: await hubAlert("Save failed");
 *      hubAlert("Heads up", { description: "Pick at least one option.", confirmLabel: "OK" });
 */
export function hubAlert(message, opts = {}) {
  if (window.parent === window) {
    const text = typeof message === "string" ? message : (message.message ?? message.title ?? "");
    window.alert(text);
    return Promise.resolve();
  }
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    function handler(e) {
      if (e.data?.type === "hub:alert:response" && e.data.id === id) {
        window.removeEventListener("message", handler);
        resolve();
      }
    }
    window.addEventListener("message", handler);
    const payload = typeof message === "string"
      ? { message, ...opts }
      : { message: message.message ?? message.title, ...message, ...opts };
    window.parent.postMessage({ type: "hub:alert", id, ...payload }, "*");
  });
}

// ── Deep linking ───────────────────────────────────────────────────────────────
/**
 * hubOpen(appId, params?)
 * Ask the parent hub frame to navigate to another installed app.
 * Use: hubOpen("finance", { view: "allowances" });
 */
export function hubOpen(appId, params = {}) {
  window.parent.postMessage({ type: "hub:open", appId, params }, "*");
}

/**
 * hubAppUrl(appId?, params?)
 * Build a URL that opens an app through the hub shell. Use this for notification
 * click targets; `/run/{app}` is the isolated app runtime and should not be used
 * as a user-facing link.
 * Use: hubAppUrl("event-rsvps", { eventId }) -> "/open/event-rsvps?eventId=..."
 */
export function hubAppUrl(appId = window.__APP_ID, params = {}) {
  if (!appId) return "/";
  const qs = new URLSearchParams(params).toString();
  return `/open/${encodeURIComponent(appId)}${qs ? `?${qs}` : ""}`;
}

/**
 * normalizeHubUrl(url?, appId?)
 * Converts old app-runtime links (`/run/{app}`) into hub-shell links
 * (`/open/{app}`), and defaults empty URLs to the current app's hub URL.
 */
export function normalizeHubUrl(url, appId = window.__APP_ID) {
  if (!url) return hubAppUrl(appId);
  return String(url).replace(/^\/run\//, "/open/");
}

/**
 * sendHubNotification({ title, body, audience?, url?, data? })
 * Send an app-scoped push notification through the hub. `audience` defaults to
 * "all"; pass a member id or member-id array for private/targeted items.
 * Returns the hub response JSON (`{ web, expo }`) or null on failure.
 */
export async function sendHubNotification({ title, body, audience = "all", url, data } = {}) {
  if (!title || !body) throw new Error("sendHubNotification requires title and body");
  const payloadData = data && typeof data === "object" && !Array.isArray(data)
    ? { ...data }
    : data;
  if (payloadData && typeof payloadData.url === "string") {
    payloadData.url = normalizeHubUrl(payloadData.url);
  }
  try {
    const res = await fetch(window.__NOTIFY_URL ?? "/api/notifications/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        audience,
        url: normalizeHubUrl(url),
        data: payloadData,
      }),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// ── Cross-app writes ───────────────────────────────────────────────────────────
/**
 * crossWrite(targetAppId, key, ops)
 * Write to another app's exported KV key using patch ops.
 * Requires the calling app to declare "app.{targetAppId}.{key}" in data_access.writes
 * and the target app to list {key} in its exports.
 *
 * ops follow the same format as the store PATCH endpoint:
 *   { op: "array_append", path: "items", value: { name: "Flour" } }
 *   { op: "array_remove", path: "items", value: { name: "Flour" } }
 *   { op: "set", path: "count", value: 5 }
 *   { op: "increment", path: "count", by: 1 }
 *   { op: "delete", path: "some.key" }
 *
 * Use: await crossWrite("grocery", "items", [{ op: "array_append", path: "items", value: { name: "Flour" } }]);
 */
export async function crossWrite(targetAppId, key, ops) {
  const url = window.__CROSS_WRITE_URL;
  if (!url) throw new Error("crossWrite is not available outside the hub");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetAppId, key, ops }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `crossWrite failed: ${res.status}`);
  return json;
}

// ── Widget event poller ────────────────────────────────────────────────────────
/**
 * createEventPoller(eventsUrl, eventType, callback, intervalMs = 30000)
 * Polls the event log and calls callback(newEvents) when new events arrive.
 * Returns a stop() function.
 * Use: const stop = createEventPoller(window.__EVENTS_URL, "allowance.weekly", events => render(events));
 */
export function createEventPoller(eventsUrl, eventType, callback, intervalMs = 30_000) {
  let since = new Date().toISOString();
  let timer = null;

  async function poll() {
    if (!eventsUrl) return;
    try {
      const p = new URLSearchParams({ type: eventType, since });
      const res = await fetch(`${eventsUrl}?${p}`);
      if (!res.ok) return;
      const events = await res.json();
      if (events.length > 0) {
        since = events[0].created_at; // events are desc, so first is newest
        callback(events);
      }
    } catch { /* non-fatal */ }
  }

  poll(); // immediate first fetch
  timer = setInterval(poll, intervalMs);
  return () => clearInterval(timer);
}

/**
 * createStreamHelper(streamUrl, eventType, callback)
 * Opens an SSE connection to the hub stream endpoint and calls callback(event)
 * for each matching event. Auto-reconnects on close to handle SSE connection limits.
 * Returns { connect(), disconnect() }.
 *
 * Use: const stream = createStreamHelper(window.__STREAM_URL, "stroke", onStroke);
 *      stream.connect();
 *      // later: stream.disconnect();
 */
export function createStreamHelper(streamUrl, eventType, callback) {
  let es = null;
  let stopped = false;

  function connect() {
    if (!streamUrl || stopped) return;
    const url = eventType
      ? `${streamUrl}?type=${encodeURIComponent(eventType)}`
      : streamUrl;
    es = new EventSource(url);
    es.addEventListener("event", (e) => {
      try { callback(JSON.parse(e.data)); } catch { /* skip malformed */ }
    });
    es.onerror = () => {
      es?.close();
      es = null;
      if (!stopped) setTimeout(connect, 2_000);
    };
  }

  function disconnect() {
    stopped = true;
    es?.close();
    es = null;
  }

  return { connect, disconnect };
}
