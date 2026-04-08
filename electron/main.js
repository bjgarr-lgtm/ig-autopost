const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const APP_ID = "com.bjgarr.igautopost";
const PRODUCT_NAME = "IG Autopost";
const isDev = !app.isPackaged;
const SERVER_PORT = Number(process.env.PORT || 3000);
const SERVER_HOST = "127.0.0.1";
const APP_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const STARTUP_TIMEOUT_MS = 45000;

let mainWindow = null;
let tray = null;
let serverProc = null;
let quitting = false;

app.setAppUserModelId(APP_ID);

function getRuntimeDataDir() {
  return path.join(app.getPath("userData"), "runtime");
}

function ensureRuntimeDirs() {
  const runtimeDir = getRuntimeDataDir();
  for (const name of ["", "uploads", "profiles"]) {
    fs.mkdirSync(path.join(runtimeDir, name), { recursive: true });
  }
  return runtimeDir;
}

function getServerLogPath() {
  return path.join(getRuntimeDataDir(), "server.log");
}

function getServerEntry() {
  if (isDev) return path.join(app.getAppPath(), "server.js");
  return path.join(process.resourcesPath, "app.asar", "server.js");
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
  });
}

async function waitForServerReady() {
  const started = Date.now();
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    try {
      const health = await fetchJson(`${APP_URL}/api/health`);
      if (health && health.ok) return health;
    } catch {}
    await wait(800);
  }
  throw new Error("Local server did not become ready in time.");
}

function startServer() {
  if (serverProc) return;

  const runtimeDir = ensureRuntimeDirs();
  const serverEntry = getServerEntry();
  const serverLogPath = getServerLogPath();

  fs.mkdirSync(path.dirname(serverLogPath), { recursive: true });

  const outFd = fs.openSync(serverLogPath, "a");
  const errFd = fs.openSync(serverLogPath, "a");

  serverProc = spawn(process.execPath, [serverEntry], {
    cwd: isDev ? app.getAppPath() : process.resourcesPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // 🔥 CRITICAL FIX
      DATA_DIR: runtimeDir,
      HOST: SERVER_HOST,
      PORT: String(SERVER_PORT)
    },
    stdio: ["ignore", outFd, errFd],
    windowsHide: true
  });

  serverProc.on("exit", (code, signal) => {
    if (!quitting) {
      dialog.showErrorBox(
        `${PRODUCT_NAME} stopped`,
        `The local server exited unexpectedly.\n\nCode: ${code}\nSignal: ${signal || "none"}\n\nLog: ${serverLogPath}`
      );
    }
    serverProc = null;
  });
}

function stopServer() {
  if (!serverProc) return;
  try { serverProc.kill(); } catch {}
  serverProc = null;
}

function createTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, "..", "assets", "icon.ico");
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_NAME);

  tray.on("double-click", () => showMainWindow());

  const menu = Menu.buildFromTemplate([
    { label: `Open ${PRODUCT_NAME}`, click: () => showMainWindow() },
    { type: "separator" },
    { label: "Open app data folder", click: () => shell.openPath(getRuntimeDataDir()) },
    { label: "Open uploads folder", click: () => shell.openPath(path.join(getRuntimeDataDir(), "uploads")) },
    { label: "Open profiles folder", click: () => shell.openPath(path.join(getRuntimeDataDir(), "profiles")) },
    { label: "Open server log", click: () => shell.openPath(getServerLogPath()) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    title: PRODUCT_NAME,
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

async function boot() {
  createTray();
  startServer();

  await waitForServerReady();

  if (!mainWindow) createWindow();

  await mainWindow.loadURL(APP_URL);
  mainWindow.show();
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(() => {
    boot().catch((error) => {
      dialog.showErrorBox("Startup failed", error?.message || String(error));
      app.quit();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });

  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });

  app.on("activate", () => showMainWindow());
}