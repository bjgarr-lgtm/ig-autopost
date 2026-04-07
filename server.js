const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static("web"));
app.use("/uploads", express.static("uploads"));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("profiles")) fs.mkdirSync("profiles");

const DB_FILE = "db.json";
const TICK_MS = 15000;
const PROFILE_LOGIN_POLL_MS = 2000;

const activeProfileSetups = new Map();

function createDefaultDb() {
  return { profiles: [], posts: [], targets: [], logs: [] };
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(createDefaultDb(), null, 2));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      profiles: parsed.profiles || [],
      posts: parsed.posts || [],
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
  const message = error && error.message ? error.message : String(error || 'Unknown error');
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

const upload = multer({ dest: "uploads/" });

app.get("/api/state", (req, res) => {
  const db = loadDB();
  db.profiles = db.profiles.map((profile, index) => normalizeProfile(profile, index));
  saveDB(db);
  res.json(db);
});

app.post("/api/profile/start", async (req, res) => {
  const db = loadDB();
  const profileId = id();
  const profilePath = path.join("profiles", profileId);

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
  log("info", "Uploaded media", { path: req.file.path, original: req.file.originalname });
  res.json({ path: req.file.path, url: "/" + req.file.path.replaceAll("\\", "/") });
});

app.post("/api/post", (req, res) => {
  const { caption, imagePath, imageUrl, scheduledAt, profileIds } = req.body || {};
  if (!imagePath) return res.status(400).json({ error: "imagePath required" });
  if (!Array.isArray(profileIds) || !profileIds.length) return res.status(400).json({ error: "Choose at least one account" });
  const time = Number(scheduledAt);
  if (!Number.isFinite(time)) return res.status(400).json({ error: "Invalid scheduledAt" });

  const db = loadDB();
  const postId = id();
  db.posts.unshift({
    id: postId,
    caption: String(caption || ""),
    imagePath,
    imageUrl: imageUrl || ("/" + imagePath.replaceAll("\\", "/")),
    scheduledAt: time,
    status: "scheduled",
    createdAt: Date.now(),
    lastRunAt: null
  });

  for (const profileId of profileIds) {
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
  log("info", "Scheduled post", { postId, profileCount: profileIds.length });
  res.json({ ok: true, postId });
});

app.post("/api/post/:id/post-now", async (req, res) => {
  const postId = req.params.id;
  const result = await processPost(postId, true);
  res.json(result);
});

app.post("/api/target/:id/retry", (req, res) => {
  const targetId = req.params.id;
  const db = loadDB();
  const t = db.targets.find(x => x.id === targetId);
  if (!t) return res.status(404).json({ error: "Target not found" });
  t.status = "pending";
  t.error = "";
  t.updatedAt = Date.now();
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

async function clickFirst(page, labels) {
  for (const label of labels) {
    const locator = page.getByText(label, { exact: true });
    if (await locator.count()) {
      try {
        await locator.first().click({ timeout: 1500 });
        return true;
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

async function openComposer(page) {
  const postMenuSelectors = [
    'div[role="menuitem"]:has-text("Post")',
    'div[role="button"]:has-text("Post")',
    'a:has-text("Post")'
  ];

  const clickPostMenuItem = async () => {
    for (const selector of postMenuSelectors) {
      const locator = page.locator(selector);
      if (await locator.count()) {
        try {
          await locator.first().click({ timeout: 1500 });
          return true;
        } catch {}
      }
    }

    const postText = page.getByText("Post", { exact: true });
    if (await postText.count()) {
      try {
        await postText.first().click({ timeout: 1500 });
        return true;
      } catch {}
    }

    return false;
  };

  const directSelectors = [
    'a[href="/create/select/"]',
    'svg[aria-label="New post"]',
    'div[role="menuitem"] svg[aria-label="New post"]'
  ];

  for (const selector of directSelectors) {
    const locator = page.locator(selector);
    if (await locator.count()) {
      try {
        await locator.first().click({ timeout: 1500 });
        return true;
      } catch {}
    }
  }

  const createTriggers = [
    'svg[aria-label="Create"]',
    'button:has-text("Create")',
    'div[role="button"]:has-text("Create")'
  ];

  for (const selector of createTriggers) {
    const locator = page.locator(selector);
    if (await locator.count()) {
      try {
        await locator.first().click({ timeout: 1500 });
        await page.waitForTimeout(500);
        if (await clickPostMenuItem()) return true;
      } catch {}
    }
  }

  const textOptions = ["New post", "Create"];
  for (const txt of textOptions) {
    const locator = page.getByText(txt, { exact: true });
    if (await locator.count()) {
      try {
        await locator.first().click({ timeout: 1500 });
        if (txt === "New post") return true;
        await page.waitForTimeout(500);
        if (await clickPostMenuItem()) return true;
      } catch {}
    }
  }

  return await clickPostMenuItem();
}

async function clickNext(page) {
  const candidates = ["Next", "Share"];
  for (const txt of candidates) {
    const locator = page.getByText(txt, { exact: true });
    if (await locator.count()) {
      try {
        await locator.first().click({ timeout: 2000 });
        return txt;
      } catch {}
    }
  }
  return null;
}

async function setCaption(page, caption) {
  const selectors = ["textarea", 'div[role="textbox"]', 'textarea[aria-label]'];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (await locator.count()) {
      try {
        await locator.first().fill(caption);
        return true;
      } catch {}
    }
  }
  return false;
}

async function postToInstagram(target, post, profile) {
  const profilePath = path.join("profiles", profile.id);
  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: { width: 1440, height: 1000 }
  });

  const page = await browser.newPage();
  const screenshotBase = path.join("uploads", `debug-${post.id}-${profile.id}-${Date.now()}`);

  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    await maybeDismissInstagramNoise(page);

    const opened = await openComposer(page);
    if (!opened) throw new Error("Could not find Instagram new post button");

    await page.waitForTimeout(2000);

    const fileInput = page.locator('input[type="file"]');
    if (!await fileInput.count()) throw new Error("Could not find file input");
    await fileInput.first().setInputFiles(path.resolve(post.imagePath));
    await page.waitForTimeout(3000);

    let step = await clickNext(page);
    if (!step) throw new Error("Could not find first Next button");
    await page.waitForTimeout(1500);

    step = await clickNext(page);
    await page.waitForTimeout(2000);

    const captionOk = await setCaption(page, post.caption || "");
    if (!captionOk) throw new Error("Could not find caption field");

    const shareClicked = await clickFirst(page, ["Share"]);
    if (!shareClicked) throw new Error("Could not find Share button");

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

let schedulerBusy = false;

async function processPost(postId, manual = false) {
  const db = loadDB();
  const post = db.posts.find(p => p.id === postId);
  if (!post) return { ok: false, error: "Post not found" };
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
  try {
    const db = loadDB();
    const now = Date.now();
    const due = db.posts.filter(p => (p.status === "scheduled" || p.status === "partial") && Number(p.scheduledAt) <= now);
    for (const post of due) {
      await processPost(post.id, false);
    }
  } finally {
    schedulerBusy = false;
  }
}

setInterval(() => {
  schedulerTick().catch(err => log("error", "Scheduler tick crashed", { error: err.message || String(err) }));
}, TICK_MS);

app.use((err, req, res, next) => {
  log("error", "Unhandled server error", {
    path: req?.path,
    method: req?.method,
    error: err?.message || String(err),
  });

  if (req?.path && req.path.startsWith('/api/')) {
    return sendApiError(res, 500, err || 'Server error');
  }

  next(err);
});

process.on('unhandledRejection', (error) => {
  log('error', 'Unhandled promise rejection', { error: error?.message || String(error) });
});

process.on('uncaughtException', (error) => {
  log('error', 'Uncaught exception', { error: error?.message || String(error) });
});

app.listen(3000, () => {
  log("info", "Server started", { url: "http://localhost:3000" });
  console.log("http://localhost:3000");
});
