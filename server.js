const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());
app.use(express.static("web"));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("profiles")) fs.mkdirSync("profiles");

const DB_FILE = "db.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ profiles: [], posts: [], targets: [] }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const upload = multer({ dest: "uploads/" });

const id = () => Math.random().toString(36).slice(2);

app.post("/api/profile", async (req, res) => {
  const profileId = id();
  const profilePath = path.join("profiles", profileId);

  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false
  });

  const page = await browser.newPage();
  await page.goto("https://www.instagram.com/");

  console.log("LOGIN THEN CLOSE WINDOW");

  browser.on("close", () => {
    const db = loadDB();
    db.profiles.push({ id: profileId });
    saveDB(db);
    console.log("Saved profile:", profileId);
  });

  res.json({ ok: true });
});

app.get("/api/profiles", (req, res) => {
  const db = loadDB();
  res.json(db.profiles);
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  res.json({ path: req.file.path });
});

app.post("/api/post", (req, res) => {
  const { caption, image, time, profiles } = req.body;

  const db = loadDB();
  const postId = id();

  db.posts.push({
    id: postId,
    caption,
    image_path: image,
    scheduled_at: time,
    status: "scheduled"
  });

  profiles.forEach(p => {
    db.targets.push({
      id: id(),
      post_id: postId,
      profile_id: p,
      status: "pending"
    });
  });

  saveDB(db);

  res.json({ ok: true });
});

app.get("/api/posts", (req, res) => {
  const db = loadDB();
  res.json(db);
});

async function postToIG(profileId, image, caption) {
  const profilePath = path.join("profiles", profileId);

  const browser = await chromium.launchPersistentContext(profilePath, {
    headless: false
  });

  const page = await browser.newPage();

  await page.goto("https://www.instagram.com/");
  await page.waitForTimeout(5000);

  try {
    await page.locator('svg[aria-label="New post"]').click();
    await page.waitForTimeout(2000);

    await page.setInputFiles('input[type="file"]', image);
    await page.waitForTimeout(3000);

    await page.getByText("Next").click();
    await page.waitForTimeout(1500);
    await page.getByText("Next").click();

    await page.waitForTimeout(2000);

    await page.locator("textarea").fill(caption);
    await page.getByText("Share").click();

    await page.waitForTimeout(5000);
    await browser.close();

    return { ok: true };

  } catch (e) {
    await browser.close();
    return { ok: false, error: e.message };
  }
}

setInterval(async () => {
  const db = loadDB();
  const now = Date.now();

  for (const post of db.posts) {
    if (post.status !== "scheduled" || post.scheduled_at > now) continue;

    const targets = db.targets.filter(t => t.post_id === post.id && t.status === "pending");

    let allDone = true;

    for (const t of targets) {
      const result = await postToIG(t.profile_id, post.image_path, post.caption);

      if (result.ok) {
        t.status = "done";
      } else {
        t.status = "failed";
        t.error = result.error;
        allDone = false;
      }
    }

    post.status = allDone ? "done" : "partial";
  }

  saveDB(db);

}, 30000);

app.listen(3000, () => {
  console.log("http://localhost:3000");
});