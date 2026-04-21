const { loadDB, saveDB } = require('./lib/db');
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT_DIR = __dirname;
const WEB_DIR = path.join(ROOT_DIR, "web");
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT_DIR);
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PROFILES_DIR = path.join(DATA_DIR, "profiles");
const DB_FILE = path.join(DATA_DIR, "db.json");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const APP_USER = String(process.env.APP_USER || "").trim();
const APP_PASS = String(process.env.APP_PASS || "");
const TICK_MS = 15000;
const PROFILE_LOGIN_POLL_MS = 2000;
const IG_FLOW_VERSION = "2026-04-07-b";
const DEBUG_CAPTURE_DEFAULT = String(process.env.DEBUG_CAPTURE || "1") !== "0";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });

function canWriteToDir(dirPath) {
  try {
    const testFile = path.join(dirPath, `.write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function getPlaywrightStatus() {
  try {
    const executablePath = chromium.executablePath();
    return {
      ok: !!executablePath,
      executablePath,
    };
  } catch (error) {
    return {
      ok: false,
      executablePath: "",
      error: error?.message || String(error),
    };
  }
}

function getStartupChecks() {
  const playwright = getPlaywrightStatus();
  return {
    checkedAt: Date.now(),
    nodeVersion: process.version,
    platform: process.platform,
    flowVersion: IG_FLOW_VERSION,
    dataDirExists: fs.existsSync(DATA_DIR),
    uploadsDirExists: fs.existsSync(UPLOADS_DIR),
    profilesDirExists: fs.existsSync(PROFILES_DIR),
    dbFileExists: fs.existsSync(DB_FILE),
    dataDirWritable: canWriteToDir(DATA_DIR),
    uploadsDirWritable: canWriteToDir(UPLOADS_DIR),
    profilesDirWritable: canWriteToDir(PROFILES_DIR),
    playwright,
    authEnabled: basicAuthEnabled(),
    debugCaptureDefault: DEBUG_CAPTURE_DEFAULT,
  };
}


const app = express();
app.use(express.json({ limit: "10mb" }));

function storageRelativePath(...parts) {
  return parts.join("/").replace(/\\/g, "/");
}

function storageAbsolutePath(relativePath) {
  return path.join(DATA_DIR, String(relativePath || "").replace(/^[/\\]+/, ""));
}

function basicAuthEnabled() {
  return !!(APP_USER && APP_PASS);
}

function normalizeText(str) {
  if (!str) return str;
  return str
    .replace(/[\u2018\u2019]/g, "'")   // curly → straight apostrophe
    .replace(/[\u201C\u201D]/g, '"')   // curly quotes
    .replace(/�/g, "'")                // corrupted replacement char
    .normalize("NFKC");
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function authRequired(req, res, next) {
  if (!basicAuthEnabled() || req.path === "/api/health") return next();
  const creds = parseBasicAuth(req.headers.authorization || "");
  if (creds && creds.user === APP_USER && creds.pass === APP_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="IG Autopost"');
  return res.status(401).send("Authentication required");
}


app.use(authRequired);
app.use((req, res, next) => {
  if (
    req.method === "GET" && (
      req.path === "/" ||
      req.path.endsWith(".html") ||
      req.path.endsWith(".js") ||
      req.path.endsWith(".css")
    )
  ) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});
app.use(express.static(WEB_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

const activeProfileSetups = new Map();
let schedulerBusy = false;
let lastSchedulerTickAt = null;
let lastSchedulerError = "";

let db = loadDB();

function getDB() {
  return db;
}

function commitDB(nextDb) {
  db = nextDb;
  commitDB(currentDb);
  return db;
}


function id() {
  return Math.random().toString(36).slice(2, 12);
}

function log(level, message, extra = {}) {
  db.logs.unshift({
    id: id(),
    ts: Date.now(),
    level,
    message,
    extra,
  });
  db.logs = db.logs.slice(0, 300);
  commitDB(currentDb);
  console.log(`[${level}] ${message}`, extra);
}

function normalizeProfile(profile, index = 0) {
  return {
    ...profile,
    name: String(profile?.name || `Account ${index + 1}`),
    pending: !!profile?.pending,
    connectedAt: profile?.connectedAt || null,
  };
}

function sendApiError(res, status, error) {
  const message = error && error.message ? error.message : String(error || "Unknown error");
  res.status(status).json({ error: message });
}

function findProfile(db, profileId) {
  return db.profiles.find(x => x.id === profileId);
}

function cleanupProfileSetup(profileId) {
  const active = activeProfileSetups.get(profileId);
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  activeProfileSetups.delete(profileId);
}

async function hasInstagramSession(browser) {
  const cookies = await browser.cookies(["https://www.instagram.com/"]);
  return cookies.some(cookie => cookie.name === "sessionid" && cookie.value);
}

async function finalizeProfileSetup(profileId, outcome = {}) {
  const active = activeProfileSetups.get(profileId);
  if (!active || active.finished) return;
  active.finished = true;
  cleanupProfileSetup(profileId);

  const currentDb = getDB();
  const profile = findProfile(currentDb, profileId);
  if (!profile) return;

  if (outcome.connected) {
    profile.pending = false;
    profile.connectedAt = Date.now();
    commitDB(currentDb);
    log("info", "Instagram account connected", { profileId });
    return;
  }

  currentDb.profiles = currentDb.profiles.filter(x => x.id !== profileId);
  currentDb.targets = currentDb.targets.filter(t => t.profileId !== profileId);
  commitDB(currentDb);
  log(outcome.error ? "error" : "info", outcome.error || "Instagram account setup cancelled", { profileId });
}

function watchProfileLogin(profileId, browser) {
  const active = activeProfileSetups.get(profileId);
  if (!active) return;

  const poll = async () => {
    const live = activeProfileSetups.get(profileId);
    if (!live || live.finished) return;

    try {
      const loggedIn = await hasInstagramSession(browser);
      if (loggedIn) {
        await finalizeProfileSetup(profileId, { connected: true });
        try {
          await browser.close();
        } catch {}
        return;
      }
    } catch (error) {
      await finalizeProfileSetup(profileId, { error: error.message || String(error) });
      try {
        await browser.close();
      } catch {}
      return;
    }

    live.timer = setTimeout(() => {
      poll().catch(err => log("error", "Profile login watcher crashed", { profileId, error: err.message || String(err) }));
    }, PROFILE_LOGIN_POLL_MS);
  };

  active.timer = setTimeout(() => {
    poll().catch(err => log("error", "Profile login watcher crashed", { profileId, error: err.message || String(err) }));
  }, PROFILE_LOGIN_POLL_MS);
}

const upload = multer({ dest: UPLOADS_DIR });

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    now: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    schedulerBusy,
    lastSchedulerTickAt,
    lastSchedulerError,
    hostedMode: DATA_DIR !== ROOT_DIR,
    authEnabled: basicAuthEnabled(),
    dataDir: DATA_DIR,
    flowVersion: IG_FLOW_VERSION,
    startupChecks: getStartupChecks(),
  });
});

app.get("/api/startup-checks", (req, res) => {
  res.json({ ok: true, checks: getStartupChecks() });
});

app.get("/api/state", (req, res) => {
  db = loadDB();
  db.profiles = db.profiles.map((profile, index) => normalizeProfile(profile, index));
  commitDB(db);
  res.json(db);
});

app.post("/api/profile/start", async (req, res) => {
  const currentDb = getDB();
  const profileId = id();
  const profilePath = path.join(PROFILES_DIR, profileId);

  currentDb.profiles.push(normalizeProfile({
    id: profileId,
    name: `Account ${currentDb.profiles.length + 1}`,
    createdAt: Date.now(),
    pending: true,
    connectedAt: null,
  }, currentDb.profiles.length));
  commitDB(currentDb);

  try {
    const browser = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1440, height: 1000 }
    });

    activeProfileSetups.set(profileId, {
      browser,
      finished: false,
      timer: null,
    });

    browser.on("close", () => {
      finalizeProfileSetup(profileId, { cancelled: true }).catch(err => {
        log("error", "Could not finish account setup after browser close", { profileId, error: err.message || String(err) });
      });
    });

    const existingPages = browser.pages();
    const page = existingPages.length ? existingPages[0] : await browser.newPage();
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

    watchProfileLogin(profileId, browser);
    log("info", "Opened login browser for new account", { profileId });

    res.json({ ok: true, profileId, pending: true });
  } catch (error) {
    await finalizeProfileSetup(profileId, { error: error.message || String(error) });
    sendApiError(res, 500, "Could not open Instagram login window");
  }
});

app.post("/api/profile/rename", (req, res) => {
  const { id: profileId, name } = req.body || {};
  const currentDb = getDB();
  const p = currentDb.profiles.find(x => x.id === profileId);
  if (!p) return res.status(404).json({ error: "Profile not found" });
  p.name = String(name || "").trim() || p.name;
  commitDB(currentDb);
  res.json({ ok: true });
});

app.delete("/api/profile/:id", (req, res) => {
  const profileId = req.params.id;
  const db = loadDB();
  db.profiles = db.profiles.filter(p => p.id !== profileId);
  db.targets = db.targets.filter(t => t.profileId !== profileId);
  commitDB(currentDb);
  res.json({ ok: true });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "File required" });
  const storedPath = storageRelativePath("uploads", req.file.filename);
  log("info", "Uploaded media", { path: storedPath, original: req.file.originalname });
  res.json({ path: storedPath, url: `/uploads/${req.file.filename}` });
});

function findPost(db, postId) {
  return db.posts.find(p => p.id === postId);
}

function createPostRecord(db, row) {
  const time = Number(row?.scheduledAt);
  if (!row?.imagePath) throw new Error("imagePath required");
  if (!Number.isFinite(time)) throw new Error("Invalid scheduledAt");
  if (!Array.isArray(row?.profileIds) || !row.profileIds.length) throw new Error("Choose at least one account");

  const postId = id();
  db.posts.unshift({
    id: postId,
    caption: String(normalizeText(row.caption) || ""),
    imagePath: row.imagePath,
    imageUrl: row.imageUrl || `/${String(row.imagePath).replaceAll("\\", "/")}`,
    scheduledAt: time,
    status: "scheduled",
    createdAt: Date.now(),
    lastRunAt: null
  });

  for (const profileId of row.profileIds) {
    currentDb.targets.push({
      id: id(),
      postId,
      profileId,
      status: "pending",
      error: "",
      updatedAt: Date.now(),
      attempts: 0
    });
  }

  return postId;
}

app.post("/api/post", (req, res) => {
  try {
    const db = loadDB();
    const postId = createPostRecord(db, req.body || {});
    commitDB(currentDb);
    log("info", "Scheduled post", { postId, profileCount: (req.body?.profileIds || []).length });
    res.json({ ok: true, postId });
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.post("/api/posts/import", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "No rows to import" });

  try {
    const currentDb = getDB();
    const postIds = [];
    for (const row of rows) {
      const postId = createPostRecord(currentDb, row);
      postIds.push(postId);
    }
    commitDB(currentDb);
    log("info", "Imported scheduled posts", { count: postIds.length });
    res.json({ ok: true, count: postIds.length, postIds });
  } catch (error) {
    sendApiError(res, 400, error);
  }
});

app.post("/api/post/:id/post-now", async (req, res) => {
  const postId = req.params.id;
  const result = await processPost(postId, true);
  res.json(result);
});

app.post("/api/post/:id/toggle-pause", (req, res) => {
  const postId = req.params.id;
  const currentDb = getDB();
  const post = findPost(currentDb, postId);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (post.status === "running") return res.status(400).json({ error: "Post is running" });
  if (post.status === "done") return res.status(400).json({ error: "Posted items cannot be paused" });
  post.status = post.status === "paused" ? "scheduled" : "paused";
  commitDB(currentDb);
  res.json({ ok: true, status: post.status });
});

app.post("/api/post/:id/update", (req, res) => {
  const postId = req.params.id;
  const { caption, scheduledAt, profileIds } = req.body || {};
  const currentDb = getDB();
  const post = findPost(currentDb, postId);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (post.status === "running") return res.status(400).json({ error: "Post is currently running" });

  const time = Number(scheduledAt);
  if (!Number.isFinite(time)) return res.status(400).json({ error: "Invalid scheduledAt" });
  if (!Array.isArray(profileIds) || !profileIds.length) return res.status(400).json({ error: "Choose at least one account" });

  post.caption = String(normalizeText(caption) || "");
  post.scheduledAt = time;
  if (post.status !== "done") post.status = "scheduled";

  currentDb.targets = currentDb.targets.filter(t => !(t.postId === postId && (t.status === "pending" || t.status === "failed" || t.status === "running")));
  for (const profileId of profileIds) {
    currentDb.targets.push({
      id: id(),
      postId,
      profileId,
      status: "pending",
      error: "",
      updatedAt: Date.now(),
      attempts: 0
    });
  }

  commitDB(currentDb);
  res.json({ ok: true });
});

app.post("/api/posts/bulk-reschedule", (req, res) => {
  const postIds = Array.isArray(req.body?.postIds) ? req.body.postIds : [];
  const minuteOffset = Number(req.body?.minuteOffset);
  if (!postIds.length) return res.status(400).json({ error: "Choose at least one post" });
  if (!Number.isFinite(minuteOffset)) return res.status(400).json({ error: "Invalid minuteOffset" });

  const currentDb = getDB();
  let changed = 0;
  for (const postId of postIds) {
    const post = findPost(currentDb, postId);
    if (!post || post.status === "running" || post.status === "done") continue;
    post.scheduledAt = Number(post.scheduledAt) + minuteOffset * 60 * 1000;
    post.status = "scheduled";
    changed += 1;
  }
  commitDB(currentDb);
  res.json({ ok: true, changed });
});

app.post("/api/target/:id/retry", (req, res) => {
  const targetId = req.params.id;
  const currentDb = getDB();
  const t = currentDb.targets.find(x => x.id === targetId);
  if (!t) return res.status(404).json({ error: "Target not found" });
  t.status = "pending";
  t.error = "";
  t.updatedAt = Date.now();
  commitDB(currentDb);
  log("info", "Reset target to pending", { targetId });
  res.json({ ok: true });
});

app.post("/api/post/:id/delete", (req, res) => {
  const postId = req.params.id;
  const db = loadDB();
  db.posts = db.posts.filter(p => p.id !== postId);
  db.targets = db.targets.filter(t => t.postId !== postId);
  commitDB(currentDb);
  res.json({ ok: true });
});

async function clickFirst(page, labels) {
  for (const label of labels) {
    const strategies = [
      () => page.getByRole("button", { name: label, exact: true }),
      () => page.getByRole("link", { name: label, exact: true }),
      () => page.getByRole("menuitem", { name: label, exact: true }),
      () => page.getByText(label, { exact: true }),
    ];
    for (const build of strategies) {
      try {
        const locator = build();
        if (await locator.count()) {
          await locator.first().click({ timeout: 1500 });
          return true;
        }
      } catch {}
    }
  }
  return false;
}

async function maybeDismissInstagramNoise(page) {
  await clickFirst(page, ["Not Now", "Cancel"]);
  await page.waitForTimeout(500);
  await clickFirst(page, ["Not Now", "Cancel"]);
}


async function captureDebugState(page, screenshotBase, label, extra = {}) {
  try {
    const screenshotPath = `${screenshotBase}-${label}.png`;
    const jsonPath = `${screenshotBase}-${label}.json`;

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    const payload = await page.evaluate(() => {
      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const visibleTextboxes = Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]'))
        .map((el, index) => ({
          index,
          tag: el.tagName,
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          placeholder: el.getAttribute("placeholder") || "",
          contenteditable: el.getAttribute("contenteditable") || "",
          visible: isVisible(el),
          value: typeof el.value === "string" ? el.value : "",
          text: (el.innerText || el.textContent || "").trim(),
        }))
        .filter(x => x.visible);

      const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"]'))
        .map((el, index) => ({
          index,
          tag: el.tagName,
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          text: (el.innerText || el.textContent || "").trim(),
          visible: isVisible(el),
        }))
        .filter(x => x.visible);

      return {
        url: location.href,
        title: document.title,
        visibleTextboxes,
        visibleButtons,
      };
    }).catch(() => ({
      url: page.url(),
      title: "",
      visibleTextboxes: [],
      visibleButtons: [],
    }));

    const out = {
      ts: new Date().toISOString(),
      label,
      flowVersion: IG_FLOW_VERSION,
      ...payload,
      ...extra,
      screenshot: screenshotPath,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    return out;
  } catch (error) {
    return {
      ts: new Date().toISOString(),
      label,
      flowVersion: IG_FLOW_VERSION,
      url: page.url(),
      error: error?.message || String(error),
    };
  }
}

function debugEnabledFor(post) {
  return DEBUG_CAPTURE_DEFAULT || !!post?.debug;
}

async function waitForFileInput(page, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const selectors = [
      'input[type="file"]',
      'input[accept*="image"]',
      'input[multiple][type="file"]',
    ];
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector);
        if (await locator.count()) return locator.first();
      } catch {}
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function openComposer(page) {
  try {
    await page.goto("https://www.instagram.com/create/select/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await maybeDismissInstagramNoise(page);
    const directInput = await waitForFileInput(page, 5000);
    if (directInput) return true;
  } catch {}

  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await maybeDismissInstagramNoise(page);
  } catch {}

  const selectors = [
    'a[href="/create/select/"]',
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    'div[role="menuitem"] svg[aria-label="New post"]',
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      if (await locator.count()) {
        await locator.first().click({ timeout: 1500 });
        const input = await waitForFileInput(page, 4000);
        if (input) return true;
      }
    } catch {}
  }

  const textOptions = ["Create", "New post"];
  for (const txt of textOptions) {
    try {
      const button = page.getByRole("button", { name: txt, exact: true });
      if (await button.count()) {
        await button.first().click({ timeout: 1500 });
        const input = await waitForFileInput(page, 2500);
        if (input) return true;
        if (await clickFirst(page, ["Post"])) {
          const postInput = await waitForFileInput(page, 4000);
          if (postInput) return true;
        }
      }
    } catch {}

    try {
      const text = page.getByText(txt, { exact: true });
      if (await text.count()) {
        await text.first().click({ timeout: 1500 });
        const input = await waitForFileInput(page, 2500);
        if (input) return true;
        if (await clickFirst(page, ["Post"])) {
          const postInput = await waitForFileInput(page, 4000);
          if (postInput) return true;
        }
      }
    } catch {}
  }

  try {
    if (await clickFirst(page, ["Post"])) {
      const postInput = await waitForFileInput(page, 4000);
      if (postInput) return true;
    }
  } catch {}

  return false;
}

async function clickNext(page) {
  const candidates = ["Next"];
  for (const txt of candidates) {
    const strategies = [
      () => page.getByRole("button", { name: txt, exact: true }),
      () => page.getByText(txt, { exact: true }),
    ];
    for (const build of strategies) {
      try {
        const locator = build();
        if (await locator.count()) {
          await locator.first().click({ timeout: 2000 });
          return txt;
        }
      } catch {}
    }
  }
  return null;
}

async function setCaption(page, caption) {
  const wanted = String(caption || "");
  const selectors = [
    'textarea[aria-label*="caption" i]',
    'textarea',
    '[contenteditable="true"][aria-label*="caption" i]',
    'div[role="textbox"][aria-label*="caption" i]',
    '[contenteditable="true"]',
  ];

  let box = null;
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          box = candidate;
          break;
        }
      }
      if (box) break;
    } catch {}
  }

  if (!box) {
    throw new Error("Caption box not found");
  }

  await box.waitFor({ timeout: 15000 });
  await box.scrollIntoViewIfNeeded().catch(() => {});
  await box.click({ timeout: 3000, force: true }).catch(() => {});
  await box.focus().catch(() => {});
  await page.waitForTimeout(300);

  const isTextArea = await box.evaluate(el => el.tagName === "TEXTAREA").catch(() => false);

  if (isTextArea) {
    await box.fill("").catch(() => {});
    if (wanted) {
      await box.fill(wanted).catch(() => {});
      const current = await box.inputValue().catch(() => "");
      if (current !== wanted) {
        await box.click({ timeout: 2000, force: true }).catch(() => {});
        await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
        await page.keyboard.press("A");
        await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
        await page.keyboard.press("Backspace");
        await page.keyboard.insertText(wanted);
      }
    }
  } else {
    await box.evaluate((el, value) => {
      el.focus();
      el.textContent = "";
      if (value) {
        const textNode = document.createTextNode(value);
        el.appendChild(textNode);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, wanted).catch(() => {});

    if (wanted) {
      const current = await box.evaluate(el => (el.innerText || el.textContent || "").trim()).catch(() => "");
      if (current !== wanted) {
        await box.click({ timeout: 2000, force: true }).catch(() => {});
        await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
        await page.keyboard.press("A");
        await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
        await page.keyboard.press("Backspace");
        await page.keyboard.insertText(wanted);
      }
    }
  }

  await page.waitForTimeout(750);

  const actual = await box.evaluate(el => {
    const value = typeof el.value === "string" ? el.value : "";
    const text = typeof el.innerText === "string" ? el.innerText : "";
    const content = typeof el.textContent === "string" ? el.textContent : "";
    return [value, text, content].join("\n").trim();
  }).catch(() => "");

  if (wanted && actual !== wanted && !actual.includes(wanted)) {
    throw new Error(`Caption did not stick in Instagram composer: ${actual || "<empty>"}`);
  }

  return true;
}

async function openAspectMenu(page) {
  const triggerLabels = ["Expand", "Select crop", "Crop"];
  for (const label of triggerLabels) {
    const strategies = [
      () => page.getByRole("button", { name: label, exact: true }),
      () => page.getByText(label, { exact: true }),
      () => page.locator(`svg[aria-label="${label}"]`).first(),
    ];
    for (const build of strategies) {
      try {
        const target = build();
        if (await target.count() && await target.first().isVisible().catch(() => false)) {
          await target.first().click({ timeout: 2000, force: true });
          await page.waitForTimeout(600);
          return label;
        }
      } catch {}
    }
  }
  return null;
}

async function expandToOriginalAspect(page) {
  const opened = await openAspectMenu(page);

  if (opened === "Expand") {
    return true;
  }

  const options = ["4:5", "Portrait", "Original", "Fit"];
  for (const label of options) {
    if (await clickFirst(page, [label])) {
      await page.waitForTimeout(600);
      return true;
    }
  }

  return false;
}

async function advanceToDetails(page, screenshotBase, debugMode) {
  if (page.url().includes("/create/details/")) return true;

  const firstNext = await clickNext(page);
  if (!firstNext) {
    throw new Error(`Could not find Next button (url: ${page.url()})`);
  }

  await page.waitForTimeout(2000);

  if (debugMode) {
    await captureDebugState(page, screenshotBase, "after-first-next", { nextResult: firstNext });
  }

  if (page.url().includes("/create/details/")) return true;

  const shareVisible = await page.getByRole("button", { name: "Share", exact: true }).count().catch(() => 0);
  const captionVisible = await page.locator('textarea[aria-label*="caption" i], textarea, [contenteditable="true"][aria-label*="caption" i]').count().catch(() => 0);
  if (shareVisible || captionVisible) {
    return true;
  }

  const secondNext = await clickNext(page);
  if (!secondNext) {
    throw new Error(`Could not find second Next button (url: ${page.url()})`);
  }

  await page.waitForTimeout(2000);

  if (debugMode) {
    await captureDebugState(page, screenshotBase, "after-second-next", { nextResult: secondNext });
  }

  await page.waitForURL("**/create/details/**", { timeout: 15000 });
  return true;
}

async function postToInstagram(target, post, profile) {
  const profilePath = path.join(PROFILES_DIR, profile.id);
  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });

  const page = await browser.newPage();
  const screenshotBase = path.join(UPLOADS_DIR, `debug-${post.id}-${profile.id}-${Date.now()}`);
  const debugMode = debugEnabledFor(post);

  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await maybeDismissInstagramNoise(page);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "home");
    }

    const opened = await openComposer(page);
    if (!opened) throw new Error(`Could not open composer (url: ${page.url()})`);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "composer-opened");
    }

    const fileInput = await waitForFileInput(page, 10000);
    if (!fileInput) throw new Error(`Could not find file input (url: ${page.url()})`);

    await fileInput.setInputFiles(storageAbsolutePath(post.imagePath));
    await page.waitForTimeout(3500);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "after-upload");
    }

    const aspectApplied = await expandToOriginalAspect(page);
    await page.waitForTimeout(1000);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "after-aspect", { aspectApplied });
    }

    await advanceToDetails(page, screenshotBase, debugMode);
    await page.waitForTimeout(1000);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "details-before-caption");
    }

    await setCaption(page, post.caption || "");

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "details-after-caption", { wantedCaption: String(post.caption || "") });
    }

    const share = page.getByRole("button", { name: "Share", exact: true });
    await share.waitFor({ timeout: 10000 });
    await share.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1000);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "before-share");
    }

    await share.click({ timeout: 5000 });

    const shared = await waitForShareSuccess(page, 45000);
    if (!shared) {
      throw new Error(`Instagram did not confirm share (url: ${page.url()})`);
    }

    await page.waitForTimeout(3000);

    if (debugMode) {
      await captureDebugState(page, screenshotBase, "success");
    } else {
      await page.screenshot({ path: `${screenshotBase}-success.png`, fullPage: true }).catch(() => {});
    }

    await browser.close();

    return { ok: true, flowVersion: IG_FLOW_VERSION };
  } catch (e) {
    if (debugMode) {
      await captureDebugState(page, screenshotBase, "error", { error: e.message || String(e) });
    } else {
      try {
        await page.screenshot({ path: `${screenshotBase}-error.png`, fullPage: true });
      } catch {}
    }
    await browser.close();
    return { ok: false, error: e.message || String(e), flowVersion: IG_FLOW_VERSION };
  }
}


app.post("/api/profile/:id/self-test", async (req, res) => {
  const profileId = req.params.id;
  const imagePath = String(req.body?.imagePath || "").trim();
  const caption = String(req.body?.caption || "self test");
  const useRelativeImagePath = imagePath || storageRelativePath("uploads", "");
  const currentDb = getDB();
  const profile = currentDb.profiles.find(x => x.id === profileId);
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  if (!imagePath) return res.status(400).json({ error: "imagePath required" });

  const profilePath = path.join(PROFILES_DIR, profile.id);
  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });

  const page = await browser.newPage();
  const testId = `selftest-${profile.id}-${Date.now()}`;
  const screenshotBase = path.join(UPLOADS_DIR, `debug-${testId}`);

  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await maybeDismissInstagramNoise(page);
    await captureDebugState(page, screenshotBase, "home");

    const opened = await openComposer(page);
    if (!opened) throw new Error(`Could not open composer (url: ${page.url()})`);
    await captureDebugState(page, screenshotBase, "composer-opened");

    const fileInput = await waitForFileInput(page, 10000);
    if (!fileInput) throw new Error(`Could not find file input (url: ${page.url()})`);

    await fileInput.setInputFiles(storageAbsolutePath(imagePath));
    await page.waitForTimeout(3500);
    await captureDebugState(page, screenshotBase, "after-upload");

    const aspectApplied = await expandToOriginalAspect(page);
    await page.waitForTimeout(1000);
    await captureDebugState(page, screenshotBase, "after-aspect", { aspectApplied });

    await advanceToDetails(page, screenshotBase, true);
    await page.waitForTimeout(1000);
    await captureDebugState(page, screenshotBase, "details-before-caption");

    await setCaption(page, caption);
    await captureDebugState(page, screenshotBase, "details-after-caption", { wantedCaption: caption });

    await browser.close();
    res.json({ ok: true, flowVersion: IG_FLOW_VERSION, testId, screenshotBase });
  } catch (error) {
    await captureDebugState(page, screenshotBase, "error", { error: error?.message || String(error) });
    await browser.close();
    res.status(500).json({ ok: false, flowVersion: IG_FLOW_VERSION, error: error?.message || String(error), testId, screenshotBase });
  }
});

async function processPost(postId, manual = false) {
  db = loadDB();
  const post = db.posts.find(p => p.id === postId);
  if (!post) return { ok: false, error: "Post not found" };
  if (!manual && post.status !== "scheduled") {
    return { ok: false, error: "Post is not runnable" };
  }

  const targets = db.targets.filter(t => t.postId === postId && (t.status === "pending" || t.status === "failed"));
  if (!targets.length) return { ok: false, error: "No pending targets" };

  post.status = "running";
  post.lastRunAt = Date.now();
  commitDB(currentDb);

  log("info", "Running post", { postId, targetCount: targets.length, manual, flowVersion: IG_FLOW_VERSION });

  let doneCount = 0;
  let failedCount = 0;

  for (const target of targets) {
    db = loadDB();
    const freshDb = db;
    const liveTarget = freshDb.targets.find(t => t.id === target.id);
    const profile = freshDb.profiles.find(p => p.id === target.profileId);
    const livePost = freshDb.posts.find(p => p.id === postId);

    if (!liveTarget || !profile || !livePost) continue;

    liveTarget.status = "running";
    liveTarget.updatedAt = Date.now();
    liveTarget.attempts = Number(liveTarget.attempts || 0) + 1;
    commitDB(freshDb);

    log("info", "Posting to account", { postId, profileId: profile.id, profileName: profile.name });

    const result = await postToInstagram(liveTarget, livePost, profile);

    db = loadDB();
    const postDb = db;
    const finalTarget = postDb.targets.find(t => t.id === target.id);
    if (!finalTarget) continue;

    if (result.ok) {
      finalTarget.status = "done";
      finalTarget.error = "";
      doneCount += 1;
      log("info", "Posted successfully", { postId, profileId: profile.id, profileName: profile.name });
    } else {
      finalTarget.status = "failed";
      finalTarget.error = result.error || "Unknown error";
      failedCount += 1;
      log("error", "Posting failed", { postId, profileId: profile.id, profileName: profile.name, error: finalTarget.error });
    }
    finalTarget.updatedAt = Date.now();

    const livePost2 = postDb.posts.find(p => p.id === postId);
    if (livePost2) {
      livePost2.status = failedCount ? "partial" : "running";
    }
    commitDB(postDb);
  }

  db = loadDB();
  const endDb = db;
  const endPost = endDb.posts.find(p => p.id === postId);
  const remaining = endDb.targets.filter(t => t.postId === postId && (t.status === "pending" || t.status === "running")).length;
  if (endPost) {
    if (remaining > 0) {
      endPost.status = "partial";
    } else {
      const anyFailed = endDb.targets.some(t => t.postId === postId && t.status === "failed");
      endPost.status = anyFailed ? "partial" : "done";
    }
  }
  commitDB(endDb);

  return { ok: true, doneCount, failedCount };
}

async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  lastSchedulerTickAt = Date.now();
  try {
    db = loadDB();
    const now = Date.now();
    const due = db.posts.filter(p => p.status === "scheduled" && Number(p.scheduledAt) <= now);
    for (const post of due) {
      await processPost(post.id, false);
    }
    lastSchedulerError = "";
  } catch (error) {
    lastSchedulerError = error.message || String(error);
    log("error", "Scheduler tick failed", { error: lastSchedulerError });
  } finally {
    schedulerBusy = false;
  }
}

app.use((err, req, res, next) => {
  log("error", "Unhandled server error", { error: err?.message || String(err) });
  sendApiError(res, 500, err);
});


setInterval(() => {
  try {
    commitDB(currentDb);
    console.log("Auto-saved DB");
  } catch (e) {
    console.error("Auto-save failed", e);
  }
}, 10000);

setInterval(() => {
  schedulerTick().catch(err => {
    lastSchedulerError = err.message || String(err);
    log("error", "Scheduler crashed", { error: lastSchedulerError });
  });
}, TICK_MS);

process.on("unhandledRejection", error => {
  log("error", "Unhandled promise rejection", { error: error?.message || String(error) });
});

process.on("uncaughtException", error => {
  log("error", "Uncaught exception", { error: error?.message || String(error) });
});

app.listen(PORT, HOST, () => {
  log("info", "Server started", {
    url: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
    dataDir: DATA_DIR,
    authEnabled: basicAuthEnabled(),
    flowVersion: IG_FLOW_VERSION,
  });
  console.log(`http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

