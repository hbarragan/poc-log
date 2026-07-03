const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = __dirname;
const distDir = path.join(rootDir, "dist");
const payloadDir = path.join(distDir, "service-payload");
const payloadDataDir = path.join(payloadDir, "data");
const payloadToolsDir = path.join(payloadDir, "tools");

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function removeDirectory(directoryPath) {
  fs.rmSync(directoryPath, { recursive: true, force: true });
}

fs.mkdirSync(distDir, { recursive: true });

execSync("npm run build", {
  cwd: rootDir,
  stdio: "inherit",
  windowsHide: true,
});

removeDirectory(payloadDir);
fs.mkdirSync(payloadDataDir, { recursive: true });
fs.mkdirSync(payloadToolsDir, { recursive: true });

copyFile(path.join(distDir, "poc-log.exe"), path.join(payloadDir, "poc-log.exe"));
copyFile(path.join(rootDir, "tools", "nssm.exe"), path.join(payloadToolsDir, "nssm.exe"));
copyFile(path.join(rootDir, "data", "store.json"), path.join(payloadDataDir, "store.default.json"));

execSync("npx --yes pkg service-installer.js --targets node18-win-x64 --output dist/poc-log-service-installer.exe --config service-pkg.json", {
  cwd: rootDir,
  stdio: "inherit",
  windowsHide: true,
});

console.log(`Instalador generado: ${path.join(distDir, "poc-log-service-installer.exe")}`);
