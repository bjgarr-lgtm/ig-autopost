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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });

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
app.use(express.static(WEB_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

const activeProfileSetups = new Map();
let schedulerBusy = false;
let lastSchedulerTickAt = null;
let lastSchedulerError = "";

function createDefaultDb() {
  return { profiles: [], posts: [], targets: [], logs: [] };
}

function normalizePost(post) {
  const status = String(post?.status || "scheduled");
  return {
    ...post,
    status: status === "paused" ? "paused" : status,
    createdAt: Number(post?.createdAt || Date.now()),
    lastRunAt: post?.lastRunAt || null,
  };
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(createDefaultDb(), null, 2));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      profiles: parsed.profiles || [],
      posts: (parsed.posts || []).map(normalizePost),
      targets: parsed.targets || [],
      logs: parsed.logs || [],
    };
  } catch {
    return createDefaultDb();
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function id() {
  return Math.random().toString(36).slice(2, 12);
}

function log(level, message, extra = {}) {
  const db = loadDB();
  db.logs.unshift({
    id: id(),
    ts: Date.now(),
    level,
    message,
    extra,
  });
  db.logs = db.logs.slice(0, 300);
  saveDB(db);
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

function findPost(db, postId) {
  return db.posts.find(x => x.id === postId);
}

function getPostTargets(db, postId) {
  return db.targets.filter(x => x.postId === postId);
}

function ensureProfileIds(db, profileIds) {
  if (!Array.isArray(profileIds) || !profileIds.length) {
    throw new Error("Choose at least one account");
  }
  const readyProfiles = new Set(
    db.profiles.filter(profile => !profile.pending).map(profile => profile.id)
  );
  const unique = [...new Set(profileIds.map(value => String(value || "").trim()).filter(Boolean))];
  if (!unique.length) throw new Error("Choose at least one account");
  for (const profileId of unique) {
    if (!readyProfiles.has(profileId)) throw new Error(`Account is not ready: ${profileId}`);
  }
  return unique;
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

  const db = loadDB();
  const profile = findProfile(db, profileId);
  if (!profile) return;

  if (outcome.connected) {
    profile.pending = false;
    profile.connectedAt = Date.now();
    saveDB(db);
    log("info", "Instagram account connected", { profileId });
    return;
  }

  db.profiles = db.profiles.filter(x => x.id !== profileId);
  db.targets = db.targets.filter(t => t.profileId !== profileId);
  saveDB(db);
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
  });
});

app.get("/api/state", (req, res) => {
  const db = loadDB();
  db.profiles = db.profiles.map((profile, index) => normalizeProfile(profile, index));
  db.posts = db.posts.map(normalizePost);
  saveDB(db);
  res.json(db);
});

app.post("/api/profile/start", async (req, res) => {
  const db = loadDB();
  const profileId = id();
  const profilePath = path.join(PROFILES_DIR, profileId);

  db.profiles.push(normalizeProfile({
    id: profileId,
    name: `Account ${db.profiles.length + 1}`,
    createdAt: Date.now(),
    pending: true,
    connectedAt: null,
  }, db.profiles.length));
  saveDB(db);

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
  const db = loadDB();
  const p = db.profiles.find(x => x.id === profileId);
  if (!p) return res.status(404).json({ error: "Profile not found" });
  p.name = String(name || "").trim() || p.name;
  saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/profile/:id", (req, res) => {
  const profileId = req.params.id;
  const db = loadDB();
  db.profiles = db.profiles.filter(p => p.id !== profileId);
  db.targets = db.targets.filter(t => t.profileId !== profileId);
  saveDB(db);
  res.json({ ok: true });
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "File required" });
  const storedPath = storageRelativePath("uploads", req.file.filename);
  log("info", "Uploaded media", { path: storedPath, original: req.file.originalname });
  res.json({ path: storedPath, url: `/uploads/${req.file.filename}` });
});

app.post("/api/post", (req, res) => {
  const { caption, imagePath, imageUrl, scheduledAt, profileIds } = req.body || {};
  if (!imagePath) return res.status(400).json({ error: "imagePath required" });
  const time = Number(scheduledAt);
  if (!Number.isFinite(time)) return res.status(400).json({ error: "Invalid scheduledAt" });

  const db = loadDB();
  let readyProfileIds;
  try {
    readyProfileIds = ensureProfileIds(db, profileIds);
  } catch (error) {
    return sendApiError(res, 400, error);
  }

  const postId = id();
  db.posts.unshift(normalizePost({
    id: postId,
    caption: String(caption || ""),
    imagePath,
    imageUrl: imageUrl || `/${String(imagePath).replaceAll("\\", "/")}`,
    scheduledAt: time,
    status: "scheduled",
    createdAt: Date.now(),
    lastRunAt: null
  }));

  for (const profileId of readyProfileIds) {
    db.targets.push({
      id: id(),
      postId,
      profileId,
      status: "pending",
      error: "",
      updatedAt: Date.now(),
      attempts: 0
    });
  }

  saveDB(db);
  log("info", "Scheduled post", { postId, profileCount: readyProfileIds.length });
  res.json({ ok: true, postId });
});

app.post("/api/post/:id/post-now", async (req, res) => {
  const postId = req.params.id;
  const result = await processPost(postId, true);
  res.json(result);
});

app.post("/api/post/:id/toggle-pause", (req, res) => {
  const postId = req.params.id;
  const db = loadDB();
  const post = findPost(db, postId);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (post.status === "done") return res.status(400).json({ error: "Posted items cannot be paused" });
  if (post.status === "running") return res.status(400).json({ error: "This post is running right now" });

  const nextStatus = post.status === "paused" ? "scheduled" : "paused";
  post.status = nextStatus;
  saveDB(db);
  log("info", nextStatus === "paused" ? "Paused post" : "Resumed post", { postId });
  res.json({ ok: true, status: nextStatus });
});

app.post("/api/post/:id/update", (req, res) => {
  const postId = req.params.id;
  const { caption, scheduledAt, profileIds } = req.body || {};
  const db = loadDB();
  const post = findPost(db, postId);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (post.status === "running") return res.status(400).json({ error: "This post is running right now" });

  const time = Number(scheduledAt);
  if (!Number.isFinite(time)) return res.status(400).json({ error: "Invalid scheduledAt" });

  let readyProfileIds;
  try {
    readyProfileIds = ensureProfileIds(db, profileIds);
  } catch (error) {
    return sendApiError(res, 400, error);
  }

  post.caption = String(caption || "");
  post.scheduledAt = time;
  if (post.status !== "paused" && post.status !== "done") {
    post.status = "scheduled";
  }

  const existingTargets = getPostTargets(db, postId);
  const targetByProfileId = new Map(existingTargets.map(target => [target.profileId, target]));
  db.targets = db.targets.filter(target => target.postId !== postId);

  for (const profileId of readyProfileIds) {
    const existing = targetByProfileId.get(profileId);
    db.targets.push(existing ? {
      ...existing,
      profileId,
      postId,
      updatedAt: Date.now(),
    } : {
      id: id(),
      postId,
      profileId,
      status: "pending",
      error: "",
      updatedAt: Date.now(),
      attempts: 0,
    });
  }

  saveDB(db);
  log("info", "Updated scheduled post", { postId, profileCount: readyProfileIds.length, scheduledAt: time });
  res.json({ ok: true });
});

app.post("/api/posts/bulk-reschedule", (req, res) => {
  const { postIds, minutes } = req.body || {};
  const minuteShift = Number(minutes);
  if (!Array.isArray(postIds) || !postIds.length) return res.status(400).json({ error: "Choose at least one post" });
  if (!Number.isFinite(minuteShift) || minuteShift === 0) return res.status(400).json({ error: "Enter a non-zero minute shift" });

  const db = loadDB();
  let changed = 0;
  for (const rawPostId of postIds) {
    const post = findPost(db, rawPostId);
    if (!post) continue;
    if (post.status === "running" || post.status === "done") continue;
    post.scheduledAt = Number(post.scheduledAt || Date.now()) + minuteShift * 60000;
    if (post.status !== "paused") post.status = "scheduled";
    changed += 1;
  }

  saveDB(db);
  log("info", "Bulk rescheduled posts", { changed, minuteShift, postCount: postIds.length });
  res.json({ ok: true, changed });
});

app.post("/api/target/:id/retry", (req, res) => {
  const targetId = req.params.id;
  const db = loadDB();
  const t = db.targets.find(x => x.id === targetId);
  if (!t) return res.status(404).json({ error: "Target not found" });
  t.status = "pending";
  t.error = "";
  t.updatedAt = Date.now();
  const post = findPost(db, t.postId);
  if (post && post.status !== "paused" && post.status !== "running" && post.status !== "done") {
    post.status = "scheduled";
  }
  saveDB(db);
  log("info", "Reset target to pending", { targetId });
  res.json({ ok: true });
});

app.post("/api/post/:id/delete", (req, res) => {
  const postId = req.params.id;
  const db = loadDB();
  db.posts = db.posts.filter(p => p.id !== postId);
  db.targets = db.targets.filter(t => t.postId !== postId);
  saveDB(db);
  res.json({ ok: true });
});

async function clickVisibleByText(page, labels) {
  const lowerLabels = labels.map(label => String(label || "").toLowerCase());
  const selectors = [
    'button',
    '[role="button"]',
    'a',
    '[role="menuitem"]'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({
      hasText: new RegExp(`^(${labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "i")
    });
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      try {
        if (!(await candidate.isVisible())) continue;
        const text = String((await candidate.innerText()).trim()).toLowerCase();
        if (!lowerLabels.includes(text)) continue;
        await candidate.click({ timeout: 2000 });
        return true;
      } catch {}
    }
  }
  return false;
}

async function maybeDismissInstagramNoise(page) {
  await clickVisibleByText(page, ["Not Now", "Cancel"]);
  await page.waitForTimeout(500);
  await clickVisibleByText(page, ["Not Now", "Cancel"]);
}

async function waitForFileInput(page, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const fileInput = page.locator('input[type="file"]');
    if (await fileInput.count()) {
      try {
        if (await fileInput.first().isVisible()) return fileInput.first();
      } catch {
        return fileInput.first();
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function openComposer(page) {
  await page.goto("https://www.instagram.com/create/select/", { waitUntil: "domcontentloaded", timeout: 60000 });
  let fileInput = await waitForFileInput(page, 5000);
  if (fileInput) return fileInput;

  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await maybeDismissInstagramNoise(page);

  const iconSelectors = [
    'svg[aria-label="New post"]',
    'svg[aria-label="Create"]',
    'a[href="/create/select/"]',
    'div[role="menuitem"] svg[aria-label="New post"]',
  ];

  for (const selector of iconSelectors) {
    const locator = page.locator(selector);
    if (await locator.count()) {
      try {
        await locator.first().click({ timeout: 2000 });
        fileInput = await waitForFileInput(page, 3000);
        if (fileInput) return fileInput;
      } catch {}
    }
  }

  await clickVisibleByText(page, ["Create", "New post"]);
  await page.waitForTimeout(1000);
  await clickVisibleByText(page, ["Post"]);
  await page.waitForTimeout(1000);
  fileInput = await waitForFileInput(page, 5000);
  return fileInput;
}

async function clickNext(page) {
  const labels = ["Next", "Share"];
  for (const label of labels) {
    const clicked = await clickVisibleByText(page, [label]);
    if (clicked) return label;
  }
  return null;
}

async function setCaption(page, caption) {
  const selectors = ["textarea", 'div[role="textbox"]', 'textarea[aria-label]', '[contenteditable="true"]'];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const field = locator.nth(index);
      try {
        if (!(await field.isVisible())) continue;
        await field.fill(caption);
        return true;
      } catch {}
    }
  }
  return false;
}

async function postToInstagram(target, post, profile) {
  const profilePath = path.join(PROFILES_DIR, profile.id);
  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });

  const page = browser.pages().length ? browser.pages()[0] : await browser.newPage();
  const screenshotBase = path.join(UPLOADS_DIR, `debug-${post.id}-${profile.id}-${Date.now()}`);

  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    await maybeDismissInstagramNoise(page);

    const fileInput = await openComposer(page);
    if (!fileInput) throw new Error(`Could not find file input at ${page.url()}`);
    await fileInput.setInputFiles(storageAbsolutePath(post.imagePath));
    await page.waitForTimeout(3000);

    let step = await clickNext(page);
    if (!step) throw new Error(`Could not find first Next button at ${page.url()}`);
    await page.waitForTimeout(1500);

    step = await clickNext(page);
    await page.waitForTimeout(2000);

    const captionOk = await setCaption(page, post.caption || "");
    if (!captionOk) throw new Error(`Could not find caption field at ${page.url()}`);

    const shareClicked = await clickVisibleByText(page, ["Share"]);
    if (!shareClicked) throw new Error(`Could not find Share button at ${page.url()}`);

    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${screenshotBase}-success.png`, fullPage: true });
    await browser.close();

    return { ok: true };
  } catch (error) {
    try {
      await page.screenshot({ path: `${screenshotBase}-error.png`, fullPage: true });
    } catch {}
    await browser.close();
    return { ok: false, error: error.message || String(error) };
  }
}

async function processPost(postId, manual = false) {
  const db = loadDB();
  const post = findPost(db, postId);
  if (!post) return { ok: false, error: "Post not found" };
  if (post.status === "paused" && !manual) {
    return { ok: false, error: "Post is paused" };
  }
  if (!manual && post.status !== "scheduled" && post.status !== "partial") {
    return { ok: false, error: "Post is not runnable" };
  }

  const targets = db.targets.filter(t => t.postId === postId && (t.status === "pending" || t.status === "failed"));
  if (!targets.length) return { ok: false, error: "No pending targets" };

  post.status = "running";
  post.lastRunAt = Date.now();
  saveDB(db);

  log("info", "Running post", { postId, targetCount: targets.length, manual });

  let doneCount = 0;
  let failedCount = 0;

  for (const target of targets) {
    const freshDb = loadDB();
    const liveTarget = freshDb.targets.find(t => t.id === target.id);
    const profile = freshDb.profiles.find(p => p.id === target.profileId);
    const livePost = freshDb.posts.find(p => p.id === postId);

    if (!liveTarget || !profile || !livePost) continue;

    liveTarget.status = "running";
    liveTarget.updatedAt = Date.now();
    liveTarget.attempts = Number(liveTarget.attempts || 0) + 1;
    saveDB(freshDb);

    log("info", "Posting to account", { postId, profileId: profile.id, profileName: profile.name });

    const result = await postToInstagram(liveTarget, livePost, profile);

    const postDb = loadDB();
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
    saveDB(postDb);
  }

  const endDb = loadDB();
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
  saveDB(endDb);

  return { ok: true, doneCount, failedCount };
}

async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  lastSchedulerTickAt = Date.now();
  try {
    const db = loadDB();
    const now = Date.now();
    const due = db.posts.filter(p => (p.status === "scheduled" || p.status === "partial") && Number(p.scheduledAt) <= now);
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
  });
  schedulerTick().catch(err => {
    lastSchedulerError = err.message || String(err);
    log("error", "Startup catch-up failed", { error: lastSchedulerError });
  });
  console.log(`http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
