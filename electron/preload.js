const { contextBridge } = require("electron");
const os = require("os");
const path = require("path");

contextBridge.exposeInMainWorld("desktopMeta", {
  platform: process.platform,
  homeDir: os.homedir(),
  sep: path.sep
});
