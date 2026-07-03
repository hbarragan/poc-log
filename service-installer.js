const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const serviceName = process.env.POC_LOG_SERVICE_NAME || "AdasoftLoggerApi";
const displayName = process.env.POC_LOG_DISPLAY_NAME || "Adasoft Logger Api";
const legacyServiceNames = ["AdasoftPocLog"].filter((name) => name !== serviceName);
const installDir = process.env.POC_LOG_INSTALL_DIR || "C:\\Adasoft\\poc-log-service";
const port = process.env.PORT || "2500";
const payloadDir = path.join(__dirname, "dist", "service-payload");
const payloadNssm = path.join(payloadDir, "tools", "nssm.exe");
const tempNssm = path.join(os.tmpdir(), "poc-log-nssm.exe");
const observabilityStateFile = "observability-state.json";
const tempObservabilityState = path.join(os.tmpdir(), `poc-log-${observabilityStateFile}`);

function log(message) {
  console.log(`[poc-log-service] ${message}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.stdio || "pipe",
    windowsHide: true,
    timeout: options.timeout || 30000,
  });
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 15000,
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    error: result.error,
  };
}

function requireAdmin() {
  const result = tryRun("net", ["session"]);

  if (!result.ok) {
    console.error("Ejecuta este instalador como Administrador.");
    process.exit(1);
  }
}

function serviceExists(targetServiceName = serviceName) {
  return tryRun("sc.exe", ["query", targetServiceName]).ok;
}

function queryService(targetServiceName = serviceName) {
  const result = tryRun("sc.exe", ["query", targetServiceName], { timeout: 5000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const stateMatch = output.match(/(?:STATE|ESTADO)\s*:\s*(\d+)\s+([A-Z_]+)/i);

  return {
    exists: result.ok,
    stateCode: stateMatch ? Number.parseInt(stateMatch[1], 10) : null,
    stateName: stateMatch ? stateMatch[2].toUpperCase() : null,
    output,
  };
}

function waitForServiceState(expectedState, timeoutMs = 30000, targetServiceName = serviceName) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const service = queryService(targetServiceName);

    if (expectedState === "ABSENT" && !service.exists) return true;
    if (expectedState === "STOPPED" && service.stateCode === 1) return true;
    if (service.stateName === expectedState) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  }

  return false;
}

function copyDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (sourcePath.endsWith(path.join("data", "store.default.json"))) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);

      const activeStorePath = path.join(targetDir, "store.json");
      if (!fs.existsSync(activeStorePath)) {
        fs.copyFileSync(sourcePath, activeStorePath);
      }
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function assertSafeInstallDir(directoryPath) {
  const resolvedPath = path.resolve(directoryPath);
  const rootPath = path.parse(resolvedPath).root;
  const normalizedPath = resolvedPath.toLowerCase();
  const blockedPaths = new Set([
    rootPath.toLowerCase(),
    path.resolve("C:\\Adasoft").toLowerCase(),
    path.resolve("C:\\Windows").toLowerCase(),
    path.resolve("C:\\Program Files").toLowerCase(),
    path.resolve("C:\\Program Files (x86)").toLowerCase(),
  ]);

  if (blockedPaths.has(normalizedPath)) {
    throw new Error(`Ruta de instalacion no segura para borrar: ${resolvedPath}`);
  }

  return resolvedPath;
}

function removeInstallDirectory() {
  const safeInstallDir = assertSafeInstallDir(installDir);

  if (!fs.existsSync(safeInstallDir)) return;

  log(`Borrando carpeta de instalacion ${safeInstallDir}`);
  fs.rmSync(safeInstallDir, { recursive: true, force: true });
}

function backupObservabilityState() {
  const sourcePath = path.join(installDir, "data", observabilityStateFile);
  fs.rmSync(tempObservabilityState, { force: true });

  if (!fs.existsSync(sourcePath)) return false;

  fs.copyFileSync(sourcePath, tempObservabilityState);
  log("Preservando offset de observabilidad");
  return true;
}

function restoreObservabilityState(hasBackup) {
  if (!hasBackup || !fs.existsSync(tempObservabilityState)) return;

  const targetPath = path.join(installDir, "data", observabilityStateFile);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(tempObservabilityState, targetPath);
  fs.rmSync(tempObservabilityState, { force: true });
}

function removeServiceIfExists(nssmPath, targetServiceName = serviceName) {
  if (!serviceExists(targetServiceName)) return;

  const service = queryService(targetServiceName);
  if (service.stateCode !== 1) {
    log(`Parando servicio ${targetServiceName}`);
    tryRun("sc.exe", ["stop", targetServiceName], { timeout: 15000 });

    if (!waitForServiceState("STOPPED", 20000, targetServiceName)) {
      log(`No se pudo confirmar parada. Intentando con NSSM.`);
      tryRun(nssmPath, ["stop", targetServiceName], { timeout: 15000 });
      if (!waitForServiceState("STOPPED", 10000, targetServiceName)) {
        throw new Error(`No se pudo parar el servicio ${targetServiceName}`);
      }
    }
  } else {
    log(`Servicio ${targetServiceName} ya estaba parado`);
  }

  log(`Eliminando servicio ${targetServiceName}`);
  tryRun("sc.exe", ["delete", targetServiceName], { timeout: 15000 });

  if (!waitForServiceState("ABSENT", 20000, targetServiceName)) {
    log(`No se pudo confirmar eliminacion. Intentando con NSSM.`);
    tryRun(nssmPath, ["remove", targetServiceName, "confirm"], { timeout: 15000 });
    if (!waitForServiceState("ABSENT", 10000, targetServiceName)) {
      throw new Error(`No se pudo eliminar el servicio ${targetServiceName}`);
    }
  }
}

function installService(nssmPath) {
  const appExe = path.join(installDir, "poc-log.exe");
  const stdoutPath = path.join(installDir, "logs", "service-out.log");
  const stderrPath = path.join(installDir, "logs", "service-err.log");

  fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });

  log(`Instalando servicio ${serviceName}`);
  run(nssmPath, ["install", serviceName, appExe]);
  run(nssmPath, ["set", serviceName, "DisplayName", displayName]);
  run(nssmPath, ["set", serviceName, "Description", "Adasoft Logger Api en puerto 2500"]);
  run(nssmPath, ["set", serviceName, "AppDirectory", installDir]);
  run(nssmPath, ["set", serviceName, "AppStdout", stdoutPath]);
  run(nssmPath, ["set", serviceName, "AppStderr", stderrPath]);
  run(nssmPath, ["set", serviceName, "AppRotateFiles", "1"]);
  run(nssmPath, ["set", serviceName, "AppRotateOnline", "1"]);
  run(nssmPath, ["set", serviceName, "AppRotateBytes", "10485760"]);
  run(nssmPath, ["set", serviceName, "Start", "SERVICE_AUTO_START"]);
  run(nssmPath, ["set", serviceName, "AppEnvironmentExtra", `PORT=${port}`]);

  log(`Arrancando servicio ${serviceName}`);
  run(nssmPath, ["start", serviceName], { stdio: "inherit" });
}

function main() {
  requireAdmin();

  if (!fs.existsSync(payloadNssm)) {
    throw new Error(`No existe NSSM embebido: ${payloadNssm}`);
  }

  fs.copyFileSync(payloadNssm, tempNssm);

  for (const legacyServiceName of legacyServiceNames) {
    removeServiceIfExists(tempNssm, legacyServiceName);
  }

  removeServiceIfExists(tempNssm);
  const hasObservabilityState = backupObservabilityState();
  removeInstallDirectory();

  log(`Actualizando ficheros en ${installDir}`);
  copyDirectory(payloadDir, installDir);
  restoreObservabilityState(hasObservabilityState);

  installService(path.join(installDir, "tools", "nssm.exe"));
  log(`OK. Servicio instalado. URL: http://127.0.0.1:${port}/`);
}

main();
