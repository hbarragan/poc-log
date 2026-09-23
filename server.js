const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const rootDir = __dirname;
const rootPrefix = `${rootDir}${path.sep}`;
const writableDir = process.pkg ? path.dirname(process.execPath) : rootDir;
const dataDir = path.join(writableDir, "data");
const storePath = path.join(dataDir, "store.json");
const port = Number(process.env.PORT || 2500);
const maxRequestBytes = 1024 * 1024;
const maxLogReadBytes = Number(process.env.LOG_READ_BYTES || 8 * 1024 * 1024);
const maxTailLines = 10000;
const observabilityEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
const observabilityIntervalMs = Math.max(Number(process.env.OBSERVABILITY_INTERVAL_MS || 5000), 1000);
// Keep the combined first sync below Loki's default ingestion rate limit.
const observabilityReadBytes = Math.max(Number(process.env.OBSERVABILITY_READ_BYTES || 64 * 1024), 1024);
const lokiPushUrl = process.env.LOKI_PUSH_URL || "http://127.0.0.1:3100/loki/api/v1/push";
const tempoTracesUrl = process.env.OTLP_HTTP_TRACES_URL || "http://127.0.0.1:4318/v1/traces";
const observabilityStatePath = path.join(dataDir, "observability-state.json");
const hostName = os.hostname();

const observabilityStatus = {
  enabled: observabilityEnabled,
  lokiEnabled: true,
  intervalMs: observabilityIntervalMs,
  lokiPushUrl,
  tempoTracesUrl,
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastLokiError: null,
  lastTempoError: null,
  lastSummary: null,
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(storePath)) {
    writeStore(createDefaultStore());
  }
}

function createDefaultStore() {
  const now = new Date().toISOString();
  const sources = [
    {
      id: "symcont-pharmasuite-api",
      name: "Symcont Pharmasuite API logs",
      path: "C:\\Adasoft\\Symcont-Pharmasuite-api\\logs\\app.log",
      color: "#2354d5",
    },
    {
      id: "symcont-pharmasuite-api-ws",
      name: "Symcont Pharmasuite API WS logs",
      path: "C:\\Adasoft\\Symcont-Pharmasuite-api\\logs\\ws.log",
      color: "#168657",
    },
    {
      id: "rockwell-pharmasuite-ai-server-ftps",
      name: "Rockwell PharmaSuite_AI_Server-ftps",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_AI_Server\\logs\\PharmaSuite_AI_Server-ftps.log",
      color: "#6842c2",
    },
    {
      id: "rockwell-pharmasuite-ai-server-config",
      name: "Rockwell PharmaSuite_AI_Server config",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_AI_Server\\logs\\PharmaSuite_AI_Server-ftps_ApplicationConfiguration.log",
      color: "#c97918",
    },
    {
      id: "rockwell-productioncentre-ebr-server",
      name: "Rockwell ProductionCentre_EBR_Server",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_EBR_Server\\logs\\PharmaSuite_EBR_Server-ftps.log",
      color: "#c0372b",
    },
    {
      id: "rockwell-pharmasuite-eihub-server",
      name: "Rockwell PharmaSuite_EIHub_Server",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_EIHub_Server\\logs\\PharmaSuite_EIHub_Server-ftps.log",
      color: "#0e7490",
    },
    {
      id: "productioncentre-ioserver-server",
      name: "ProductionCentre_IOServer_Server",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_IOServer_Server\\logs\\PharmaSuite_IOServer_Server-ftps.log",
      color: "#7c3aed",
    },
    {
      id: "pharmasuite-oe-server-ftps",
      name: "PharmaSuite_OE_Server-ftps",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_OE_Server\\logs\\PharmaSuite_OE_Server-ftps.log",
      color: "#047857",
    },
    {
      id: "pharmasuite-tom-server",
      name: "PharmaSuite_TOM_Server",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_TOM_Server\\logs\\PharmaSuite_TOM_Server-ftps.log",
      color: "#be123c",
    },
    {
      id: "pharmasuite-transition-server-ftps",
      name: "PharmaSuite_Transition_Server-ftps",
      path: "E:\\Rockwell\\SOS\\ProductionCentre_Transition_Server\\logs\\PharmaSuite_Transition_Server-ftps.log",
      color: "#4f46e5",
    },
  ].map((source) => ({
    ...source,
    createdAt: now,
    updatedAt: now,
  }));

  return {
    sources,
    settings: {
      lokiEnabled: true,
    },
    views: [
      {
        id: "pharmasuite-base",
        name: "PharmaSuite base",
        sourceIds: sources.map((source) => source.id),
        filters: {
          query: "",
          levels: [],
          compact: true,
          tail: 500,
          refreshSeconds: 5,
        },
        layout: "grid",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function normalizeSettings(input = {}) {
  return {
    lokiEnabled: input.lokiEnabled !== false,
  };
}

function normalizeStore(store) {
  return {
    sources: Array.isArray(store.sources) ? store.sources : [],
    views: Array.isArray(store.views) ? store.views : [],
    settings: normalizeSettings(store.settings),
  };
}

function readStore() {
  ensureStore();
  return normalizeStore(JSON.parse(fs.readFileSync(storePath, "utf8")));
}

function writeStore(store) {
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function slugifyId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function uniqueId(baseId, items) {
  const cleanBase = slugifyId(baseId) || `id-${Date.now()}`;
  let candidate = cleanBase;
  let index = 2;

  while (items.some((item) => item.id === candidate)) {
    candidate = `${cleanBase}-${index}`;
    index += 1;
  }

  return candidate;
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxRequestBytes) {
        reject(new Error("Payload demasiado grande"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido"));
      }
    });

    request.on("error", reject);
  });
}

function publicSource(source, knownStatus) {
  const status = knownStatus || getSourceStatus(source.path);

  return {
    id: source.id,
    name: source.name,
    path: source.path,
    color: source.color,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    status,
  };
}

function findNewestFile(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  let newestFile = null;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const candidatePath = path.join(directoryPath, entry.name);
    const candidateStat = fs.statSync(candidatePath);

    if (!newestFile || candidateStat.mtimeMs > newestFile.modifiedTime) {
      newestFile = {
        path: candidatePath,
        name: entry.name,
        size: candidateStat.size,
        modifiedAt: candidateStat.mtime.toISOString(),
        modifiedTime: candidateStat.mtimeMs,
      };
    }
  }

  return newestFile;
}

function getSourceStatus(sourcePath) {
  try {
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      const newestFile = findNewestFile(sourcePath);

      if (!newestFile) {
        return {
          exists: true,
          readable: false,
          kind: "directory",
          message: "DIRECTORY_EMPTY",
        };
      }

      return {
        exists: true,
        readable: true,
        kind: "directory",
        size: newestFile.size,
        modifiedAt: newestFile.modifiedAt,
        resolvedPath: newestFile.path,
        resolvedName: newestFile.name,
      };
    }

    return {
      exists: true,
      readable: stat.isFile(),
      kind: stat.isFile() ? "file" : "other",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      resolvedPath: stat.isFile() ? sourcePath : null,
      resolvedName: stat.isFile() ? path.basename(sourcePath) : null,
    };
  } catch (error) {
    return {
      exists: false,
      readable: false,
      kind: "missing",
      message: error.code || "NO_ACCESS",
    };
  }
}

function normalizeSource(input, existingSources, previousSource) {
  const normalizedPath = path.resolve(String(input.path || "").trim());
  const now = new Date().toISOString();
  const sourceName = String(input.name || path.basename(normalizedPath) || "Log").trim();
  const requestedId = input.id || sourceName;
  const id = previousSource ? previousSource.id : uniqueId(requestedId, existingSources);
  const color = String(input.color || previousSource?.color || "#2354d5").trim();

  if (!input.path || !normalizedPath) {
    throw new Error("Path requerido");
  }

  return {
    id,
    name: sourceName.slice(0, 80),
    path: normalizedPath,
    color,
    createdAt: previousSource?.createdAt || now,
    updatedAt: now,
  };
}

function exportSources(store) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sources: store.sources.map((source) => ({
      id: source.id,
      name: source.name,
      path: source.path,
      color: source.color,
    })),
  };
}

function normalizeImportedSources(input) {
  const rawSources = Array.isArray(input) ? input : input.sources;
  const ids = new Set();

  if (!Array.isArray(rawSources)) {
    throw new Error("Backup invalido: falta array sources");
  }

  return rawSources.map((rawSource, index) => {
    const id = slugifyId(rawSource.id);
    const sourcePath = String(rawSource.path || "").trim();
    const name = String(rawSource.name || id || `Log ${index + 1}`).trim();
    const color = String(rawSource.color || "#2354d5").trim();

    if (!id) {
      throw new Error(`Fuente ${index + 1}: id requerido`);
    }

    if (!sourcePath) {
      throw new Error(`Fuente ${id}: path requerido`);
    }

    if (ids.has(id)) {
      throw new Error(`Fuente duplicada: ${id}`);
    }

    ids.add(id);

    return {
      id,
      name: name.slice(0, 80),
      path: path.resolve(sourcePath),
      color,
      createdAt: rawSource.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
}

function normalizeView(input, existingViews, previousView) {
  const now = new Date().toISOString();
  const viewName = String(input.name || "Vista logs").trim().slice(0, 80);
  const id = previousView ? previousView.id : uniqueId(input.id || viewName, existingViews);
  const sourceIds = Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [];

  return {
    id,
    name: viewName,
    sourceIds,
    filters: {
      query: String(input.filters?.query || ""),
      levels: Array.isArray(input.filters?.levels) ? input.filters.levels.map(String) : [],
      compact: Boolean(input.filters?.compact),
      tail: Number(input.filters?.tail || 500),
      refreshSeconds: Number(input.filters?.refreshSeconds || 5),
      dateFrom: input.filters?.dateFrom ? String(input.filters.dateFrom) : null,
      dateTo: input.filters?.dateTo ? String(input.filters.dateTo) : null,
      timePreset: ["5m", "15m", "30m", "1h"].includes(input.filters?.timePreset) ? input.filters.timePreset : "",
    },
    layout: String(input.layout || "grid"),
    createdAt: previousView?.createdAt || now,
    updatedAt: now,
  };
}

function detectLevel(line) {
  if (/\b(fatal|critical|crit)\b/i.test(line)) return "fatal";
  if (/\b(error|err|exception|stacktrace|failed|failure)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  if (/\b(debug|trace)\b/i.test(line)) return "debug";
  return "info";
}

function parseLogTimestamp(line, fallbackDate) {
  const text = String(line || "");
  const isoMatch = text.match(/^\s*(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?/i);
  const localMatch = text.match(/^\s*(\d{2})[\/-](\d{2})[\/-](\d{4})[T\s](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/);
  const timeMatch = text.match(/^\s*(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?/);
  let date;
  let raw;
  let inferredDate = false;

  if (isoMatch) {
    raw = isoMatch[0].trim();
    const fraction = String(isoMatch[7] || "").padEnd(3, "0").slice(0, 3);
    const zone = isoMatch[8];
    if (zone) {
      const normalizedZone = zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
      date = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T${isoMatch[4]}:${isoMatch[5]}:${isoMatch[6]}.${fraction}${normalizedZone}`);
    } else {
      date = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]), Number(isoMatch[4]), Number(isoMatch[5]), Number(isoMatch[6]), Number(fraction));
    }
  } else if (localMatch) {
    raw = localMatch[0].trim();
    const fraction = String(localMatch[7] || "").padEnd(3, "0").slice(0, 3);
    date = new Date(Number(localMatch[3]), Number(localMatch[2]) - 1, Number(localMatch[1]), Number(localMatch[4]), Number(localMatch[5]), Number(localMatch[6]), Number(fraction));
  } else if (timeMatch && fallbackDate) {
    raw = timeMatch[0].trim();
    const base = new Date(fallbackDate);
    const fraction = String(timeMatch[4] || "").padEnd(3, "0").slice(0, 3);
    date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3]), Number(fraction));
    inferredDate = true;
  }

  if (!date || Number.isNaN(date.getTime())) {
    return { timestamp: null, timestampRaw: null, timestampInferred: false };
  }

  return {
    timestamp: date.toISOString(),
    timestampRaw: raw,
    timestampInferred: inferredDate,
  };
}

function simplifyLine(line) {
  const simplified = line
    .replace(/^\s*\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return simplified.length > 180 ? `${simplified.slice(0, 179)}…` : simplified;
}

function readLastBytes(filePath) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, maxLogReadBytes);
  const start = Math.max(0, stat.size - bytesToRead);
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(bytesToRead);

  try {
    fs.readSync(handle, buffer, 0, bytesToRead, start);
  } finally {
    fs.closeSync(handle);
  }

  return {
    text: buffer.toString("utf8"),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    truncated: start > 0,
  };
}

function querySource(source, options) {
  const status = getSourceStatus(source.path);

  if (!status.readable) {
    return {
      source: publicSource(source, status),
      status,
      lines: [],
      total: 0,
      error: "Log no accesible",
    };
  }

  const raw = readLastBytes(status.resolvedPath);
  const query = String(options.query || "").toLowerCase();
  const selectedLevels = new Set(Array.isArray(options.levels) ? options.levels : []);
  const tail = Math.min(Math.max(Number(options.tail || 500), 1), maxTailLines);
  const dateFrom = options.dateFrom ? Date.parse(options.dateFrom) : null;
  const dateTo = options.dateTo ? Date.parse(options.dateTo) : null;

  let previousTimestamp = null;
  const allLines = raw.text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((message, index) => {
      const level = detectLevel(message);
      const parsedTimestamp = parseLogTimestamp(message, raw.modifiedAt);
      if (parsedTimestamp.timestamp) {
        previousTimestamp = parsedTimestamp.timestamp;
      } else if (previousTimestamp) {
        parsedTimestamp.timestamp = previousTimestamp;
        parsedTimestamp.timestampInferred = true;
      }
      return {
        index,
        level,
        ...parsedTimestamp,
        message,
        summary: simplifyLine(message) || message.slice(0, 180),
      };
    });

  const filtered = allLines.filter((line) => {
    if (selectedLevels.size && !selectedLevels.has(line.level)) return false;
    if (query && !line.message.toLowerCase().includes(query)) return false;
    const lineTime = line.timestamp ? Date.parse(line.timestamp) : null;
    if (Number.isFinite(dateFrom) && (!Number.isFinite(lineTime) || lineTime < dateFrom)) return false;
    if (Number.isFinite(dateTo) && (!Number.isFinite(lineTime) || lineTime > dateTo)) return false;
    return true;
  });

  const visibleLines = filtered.slice(-tail).reverse();

  return {
    source: publicSource(source, status),
    status: {
      ...status,
      truncated: raw.truncated,
      readBytes: Math.min(status.size || 0, maxLogReadBytes),
    },
    lines: visibleLines,
    total: filtered.length,
  };
}

function selectSources(store, sourceIds) {
  if (!Array.isArray(sourceIds) || !sourceIds.length) {
    return store.sources;
  }

  const selectedIds = new Set(sourceIds.map(String));
  return store.sources.filter((source) => selectedIds.has(source.id));
}

function querySources(store, options) {
  return selectSources(store, options.sourceIds).map((source) => querySource(source, options));
}

function readObservabilityState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(observabilityStatePath, "utf8"));
    return {
      sources: parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
    };
  } catch {
    return { sources: {} };
  }
}

function writeObservabilityState(state) {
  fs.writeFileSync(observabilityStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readNewLogLines(source, sourceState = {}) {
  const status = getSourceStatus(source.path);

  if (!status.readable || !status.resolvedPath) {
    return {
      status,
      lines: [],
      nextState: sourceState,
      readBytes: 0,
      error: status.message || "Log no accesible",
    };
  }

  const resolvedPath = status.resolvedPath;
  const sameFile = sourceState.path === resolvedPath;
  let position = sameFile ? Number(sourceState.position || 0) : 0;
  let pending = sameFile ? String(sourceState.pending || "") : "";

  if (!Number.isFinite(position) || position < 0 || position > status.size) {
    position = 0;
    pending = "";
  }

  const bytesToRead = Math.min(status.size - position, observabilityReadBytes);
  if (!bytesToRead) {
    return {
      status,
      lines: [],
      nextState: { path: resolvedPath, position, pending },
      readBytes: 0,
    };
  }

  const buffer = Buffer.alloc(bytesToRead);
  const handle = fs.openSync(resolvedPath, "r");

  try {
    fs.readSync(handle, buffer, 0, bytesToRead, position);
  } finally {
    fs.closeSync(handle);
  }

  const text = `${pending}${buffer.toString("utf8")}`;
  const fragments = text.split(/\r?\n/);
  const endsWithNewLine = /(?:\r?\n)$/.test(text);
  const nextPending = endsWithNewLine ? "" : fragments.pop() || "";
  const lines = fragments.filter(Boolean);

  return {
    status,
    lines,
    readBytes: bytesToRead,
    nextState: {
      path: resolvedPath,
      position: position + bytesToRead,
      pending: nextPending,
    },
  };
}

function nowNanoseconds(offset = 0) {
  return (BigInt(Date.now()) * 1000000n + BigInt(offset)).toString();
}

function appendLokiLine(streams, labels, timestamp, message) {
  const key = JSON.stringify(labels);
  let stream = streams.get(key);

  if (!stream) {
    stream = { stream: labels, values: [] };
    streams.set(key, stream);
  }

  stream.values.push([timestamp, message]);
}

async function postJson(url, payload, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${response.status} ${body.slice(0, 300)}`.trim());
    }
  } finally {
    clearTimeout(timeout);
  }
}

function otlpAttribute(key, value) {
  if (typeof value === "number") {
    return { key, value: { intValue: String(Math.trunc(value)) } };
  }

  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }

  return { key, value: { stringValue: String(value) } };
}

function createHexId(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function buildTempoTrace(startedAt, finishedAt, sourceSummaries, lokiPublished) {
  const traceId = createHexId(16);
  const rootSpanId = createHexId(8);
  const startNano = (BigInt(startedAt) * 1000000n).toString();
  const endNano = (BigInt(finishedAt) * 1000000n).toString();
  const childSpans = sourceSummaries.map((summary) => ({
    traceId,
    spanId: createHexId(8),
    parentSpanId: rootSpanId,
    name: "logs.source.sync",
    kind: 1,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: [
      otlpAttribute("log.source.id", summary.sourceId),
      otlpAttribute("log.source.name", summary.sourceName),
      otlpAttribute("log.lines.read", summary.linesRead),
      otlpAttribute("log.lines.published", summary.linesPublished),
      otlpAttribute("log.read.bytes", summary.readBytes),
      otlpAttribute("log.status", summary.error ? "error" : "ok"),
      ...(summary.error ? [otlpAttribute("error.message", summary.error)] : []),
    ],
  }));

  return {
    traceId,
    resourceSpans: [
      {
        resource: {
          attributes: [
            otlpAttribute("service.name", "adasoft-logger-api"),
            otlpAttribute("service.version", "1.0.0"),
            otlpAttribute("host.name", hostName),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "adasoft.logger.sync", version: "1.0.0" },
            spans: [
              {
                traceId,
                spanId: rootSpanId,
                name: "logs.sync",
                kind: 1,
                startTimeUnixNano: startNano,
                endTimeUnixNano: endNano,
                attributes: [
                  otlpAttribute("logs.sources.total", sourceSummaries.length),
                  otlpAttribute("logs.lines.published", lokiPublished),
                  otlpAttribute("loki.endpoint", lokiPushUrl),
                ],
              },
              ...childSpans,
            ],
          },
        ],
      },
    ],
  };
}

async function syncObservability() {
  if (!observabilityEnabled || observabilityStatus.running) return;

  observabilityStatus.running = true;
  observabilityStatus.lastStartedAt = new Date().toISOString();
  const startedAt = Date.now();
  const currentState = readObservabilityState();
  const nextState = { sources: { ...currentState.sources } };
  const streams = new Map();
  const sourceSummaries = [];
  let lineOffset = 0;
  let publishedLines = 0;
  let lokiPublishedLines = 0;

  try {
    const store = readStore();
    const lokiEnabled = store.settings.lokiEnabled;
    observabilityStatus.lokiEnabled = lokiEnabled;

    for (const source of store.sources) {
      const delta = readNewLogLines(source, currentState.sources[source.id]);
      nextState.sources[source.id] = delta.nextState;
      const summary = {
        sourceId: source.id,
        sourceName: source.name,
        linesRead: delta.lines.length,
        linesPublished: 0,
        readBytes: delta.readBytes,
        error: delta.error || null,
      };

      for (const line of delta.lines) {
        if (lokiEnabled) {
          const level = detectLevel(line);
          const parsedTimestamp = parseLogTimestamp(line, delta.status.modifiedAt);
          const lokiTimestamp = parsedTimestamp.timestamp
            ? (BigInt(new Date(parsedTimestamp.timestamp).getTime()) * 1000000n + BigInt(lineOffset)).toString()
            : nowNanoseconds(lineOffset);
          appendLokiLine(streams, {
            job: "adasoft-logger-api",
            service_name: source.name,
            host: hostName,
            source_id: source.id,
            source_name: source.name,
            level,
          }, lokiTimestamp, line);
          summary.linesPublished += 1;
          publishedLines += 1;
        }
        lineOffset += 1;
      }

      sourceSummaries.push(summary);
    }

    if (lokiEnabled && streams.size) {
      await postJson(lokiPushUrl, { streams: [...streams.values()] });
    }

    writeObservabilityState(nextState);
    lokiPublishedLines = publishedLines;
    observabilityStatus.lastLokiError = null;
  } catch (error) {
    observabilityStatus.lastLokiError = error.message || "Error publicando en Loki";
  }

  const finishedAt = Date.now();

  try {
    const trace = buildTempoTrace(startedAt, finishedAt, sourceSummaries, lokiPublishedLines);
    await postJson(tempoTracesUrl, { resourceSpans: trace.resourceSpans });
    observabilityStatus.lastTempoError = null;
    observabilityStatus.lastSummary = {
      traceId: trace.traceId,
      sources: sourceSummaries.length,
      linesPublished: lokiPublishedLines,
      completedAt: new Date(finishedAt).toISOString(),
    };
  } catch (error) {
    observabilityStatus.lastTempoError = error.message || "Error publicando en Tempo";
  } finally {
    observabilityStatus.lastFinishedAt = new Date().toISOString();
    observabilityStatus.running = false;
  }
}

function startObservabilitySync() {
  if (!observabilityEnabled) return;
  syncObservability();
  setInterval(syncObservability, observabilityIntervalMs).unref();
}

function getSourceStats(source) {
  const result = querySource(source, { levels: [], query: "", tail: maxTailLines });
  const counts = {
    fatal: 0,
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
  };

  for (const line of result.lines) {
    counts[line.level] = (counts[line.level] || 0) + 1;
  }

  return {
    source: result.source,
    status: result.status,
    total: result.total,
    returned: result.lines.length,
    counts,
    error: result.error,
  };
}

function buildOpenApiDocument() {
  return {
    openapi: "3.0.0",
    info: {
      title: "Adasoft POC Log API",
      version: "1.0.0",
    },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/api/ai/sources": {
        get: {
          summary: "Lista fuentes de logs configuradas",
        },
      },
      "/api/ai/search": {
        post: {
          summary: "Busca en logs por ids, texto y niveles",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sourceIds: { type: "array", items: { type: "string" } },
                    query: { type: "string" },
                    levels: { type: "array", items: { type: "string", enum: ["fatal", "error", "warn", "info", "debug"] } },
                    tail: { type: "number" },
                    dateFrom: { type: "string", format: "date-time" },
                    dateTo: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/ai/stats": {
        post: {
          summary: "Cuenta niveles por fuente",
        },
      },
      "/api/ai/source/{id}/latest": {
        get: {
          summary: "Devuelve el fichero efectivo leido para una fuente",
        },
      },
      "/mcp": {
        post: {
          summary: "Endpoint MCP Streamable HTTP basico con JSON-RPC 2.0",
        },
      },
    },
  };
}

async function handleAiApi(request, response, url, store) {
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/ai/openapi.json") {
    sendJson(response, 200, buildOpenApiDocument());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/ai/sources") {
    sendJson(response, 200, { sources: store.sources.map((source) => publicSource(source)) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/ai/search") {
    const body = await parseBody(request);
    const results = querySources(store, {
      sourceIds: body.sourceIds,
      query: body.query || "",
      levels: Array.isArray(body.levels) ? body.levels : [],
      tail: body.tail || 500,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
    });
    sendJson(response, 200, { results, generatedAt: new Date().toISOString() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/ai/stats") {
    const body = await parseBody(request);
    const stats = selectSources(store, body.sourceIds).map(getSourceStats);
    sendJson(response, 200, { stats, generatedAt: new Date().toISOString() });
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/api/ai/source/") && pathname.endsWith("/latest")) {
    const parts = pathname.split("/");
    const id = decodeURIComponent(parts[4] || "");
    const source = store.sources.find((item) => item.id === id);

    if (!source) {
      sendError(response, 404, "Fuente no encontrada");
      return true;
    }

    sendJson(response, 200, { source: publicSource(source) });
    return true;
  }

  return false;
}

function mcpToolDefinitions() {
  return [
    {
      name: "list_log_sources",
      description: "Lista fuentes de logs configuradas y su estado de lectura.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "query_logs",
      description: "Busca texto o niveles en una o varias fuentes de logs.",
      inputSchema: {
        type: "object",
        properties: {
          sourceIds: { type: "array", items: { type: "string" }, description: "Ids de fuentes. Si se omite, consulta todas." },
          query: { type: "string", description: "Texto a buscar. Opcional." },
          levels: { type: "array", items: { type: "string", enum: ["fatal", "error", "warn", "info", "debug"] } },
          tail: { type: "number", description: "Lineas maximas por fuente." },
          dateFrom: { type: "string", description: "Fecha inicial inclusiva en formato ISO 8601." },
          dateTo: { type: "string", description: "Fecha final inclusiva en formato ISO 8601." },
        },
      },
    },
    {
      name: "get_log_stats",
      description: "Devuelve conteos por nivel para una o varias fuentes.",
      inputSchema: {
        type: "object",
        properties: {
          sourceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "get_latest_log_file",
      description: "Devuelve el fichero real usado por una fuente. En carpetas, devuelve el ultimo fichero modificado.",
      inputSchema: {
        type: "object",
        required: ["sourceId"],
        properties: {
          sourceId: { type: "string" },
        },
      },
    },
  ];
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function isJsonRpcRequest(message) {
  return message && message.method && message.id !== undefined && message.id !== null;
}

function mcpToolContent(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function callMcpTool(store, name, args = {}) {
  if (name === "list_log_sources") {
    return mcpToolContent({ sources: store.sources.map((source) => publicSource(source)) });
  }

  if (name === "query_logs") {
    return mcpToolContent({
      results: querySources(store, {
        sourceIds: args.sourceIds,
        query: args.query || "",
        levels: Array.isArray(args.levels) ? args.levels : [],
        tail: args.tail || 500,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      }),
      generatedAt: new Date().toISOString(),
    });
  }

  if (name === "get_log_stats") {
    return mcpToolContent({
      stats: selectSources(store, args.sourceIds).map(getSourceStats),
      generatedAt: new Date().toISOString(),
    });
  }

  if (name === "get_latest_log_file") {
    const source = store.sources.find((item) => item.id === String(args.sourceId || ""));
    if (!source) {
      throw new Error("Fuente no encontrada");
    }
    return mcpToolContent({ source: publicSource(source) });
  }

  throw new Error(`Tool no soportada: ${name}`);
}

function isAllowedMcpOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const hostHeader = String(request.headers.host || "");
    const allowedHosts = new Set([
      hostHeader,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
    ]);

    if (allowedHosts.has(originUrl.host)) return true;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(originUrl.hostname)) return true;
  } catch {
    return false;
  }

  return false;
}

function mcpCorsHeaders(request) {
  const origin = request.headers.origin;
  return {
    "Access-Control-Allow-Origin": origin && isAllowedMcpOrigin(request) ? origin : "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, Mcp-Session-Id",
    "Vary": "Origin",
  };
}

async function handleMcp(request, response) {
  if (!isAllowedMcpOrigin(request)) {
    sendJson(response, 403, jsonRpcError(null, -32000, "Origin no permitido"), mcpCorsHeaders(request));
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, mcpCorsHeaders(request));
    response.end();
    return;
  }

  if (request.method === "GET") {
    response.writeHead(405, {
      ...mcpCorsHeaders(request),
      "Allow": "POST, GET, OPTIONS",
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, {
      ...mcpCorsHeaders(request),
      "Allow": "POST, GET, OPTIONS",
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  const store = readStore();
  const message = await parseBody(request);

  if (!isJsonRpcRequest(message)) {
    response.writeHead(202, {
      ...mcpCorsHeaders(request),
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  try {
    if (message.method === "initialize") {
      sendJson(response, 200, jsonRpcResult(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "adasoft-logger-api",
          version: "1.0.0",
        },
      }), {
        ...mcpCorsHeaders(request),
        "MCP-Protocol-Version": "2025-06-18",
      });
      return;
    }

    if (message.method === "tools/list") {
      sendJson(response, 200, jsonRpcResult(message.id, { tools: mcpToolDefinitions() }), mcpCorsHeaders(request));
      return;
    }

    if (message.method === "tools/call") {
      const params = message.params || {};
      sendJson(response, 200, jsonRpcResult(message.id, callMcpTool(store, params.name, params.arguments || {})), mcpCorsHeaders(request));
      return;
    }

    sendJson(response, 200, jsonRpcError(message.id, -32601, "Metodo no encontrado"), mcpCorsHeaders(request));
  } catch (error) {
    sendJson(response, 200, jsonRpcError(message.id, -32000, error.message || "Error MCP"), mcpCorsHeaders(request));
  }
}

async function handleApi(request, response, url) {
  const store = readStore();
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/observability/status") {
    sendJson(response, 200, {
      ...observabilityStatus,
      lokiEnabled: store.settings.lokiEnabled,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/settings") {
    sendJson(response, 200, { settings: store.settings });
    return;
  }

  if (request.method === "POST" && pathname === "/api/settings") {
    const body = await parseBody(request);
    store.settings = normalizeSettings(body);
    observabilityStatus.lokiEnabled = store.settings.lokiEnabled;
    writeStore(store);
    sendJson(response, 200, { settings: store.settings });
    return;
  }

  if (pathname.startsWith("/api/ai/") && await handleAiApi(request, response, url, store)) {
    return;
  }

  if (request.method === "GET" && pathname === "/api/sources") {
    sendJson(response, 200, { sources: store.sources.map((source) => publicSource(source)) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/sources/export") {
    sendJson(response, 200, exportSources(store));
    return;
  }

  if (request.method === "POST" && pathname === "/api/sources/import") {
    const body = await parseBody(request);
    const importedSources = normalizeImportedSources(body);
    const validSourceIds = new Set(importedSources.map((source) => source.id));

    store.sources = importedSources;
    store.views = store.views.map((view) => ({
      ...view,
      sourceIds: view.sourceIds.filter((sourceId) => validSourceIds.has(sourceId)),
      updatedAt: new Date().toISOString(),
    }));

    writeStore(store);
    sendJson(response, 200, { sources: store.sources.map((source) => publicSource(source)) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/sources") {
    const body = await parseBody(request);
    const existingIndex = body.id ? store.sources.findIndex((source) => source.id === body.id) : -1;
    const previousSource = existingIndex >= 0 ? store.sources[existingIndex] : null;
    const source = normalizeSource(body, store.sources, previousSource);

    if (existingIndex >= 0) {
      store.sources[existingIndex] = source;
    } else {
      store.sources.push(source);
    }

    writeStore(store);
    sendJson(response, 200, { source: publicSource(source) });
    return;
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/sources/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    store.sources = store.sources.filter((source) => source.id !== id);
    store.views = store.views.map((view) => ({
      ...view,
      sourceIds: view.sourceIds.filter((sourceId) => sourceId !== id),
    }));
    writeStore(store);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/views") {
    sendJson(response, 200, { views: store.views });
    return;
  }

  if (request.method === "POST" && pathname === "/api/views") {
    const body = await parseBody(request);
    const existingIndex = body.id ? store.views.findIndex((view) => view.id === body.id) : -1;
    const previousView = existingIndex >= 0 ? store.views[existingIndex] : null;
    const view = normalizeView(body, store.views, previousView);
    const validSourceIds = new Set(store.sources.map((source) => source.id));
    view.sourceIds = view.sourceIds.filter((sourceId) => validSourceIds.has(sourceId));

    if (existingIndex >= 0) {
      store.views[existingIndex] = view;
    } else {
      store.views.push(view);
    }

    writeStore(store);
    sendJson(response, 200, { view });
    return;
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/views/")) {
    const id = decodeURIComponent(pathname.split("/").pop());
    store.views = store.views.filter((view) => view.id !== id);
    writeStore(store);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/logs/query") {
    const body = await parseBody(request);
    const requestedSourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : [];
    const sources = store.sources.filter((source) => requestedSourceIds.includes(source.id));
    const results = sources.map((source) => querySource(source, body));
    sendJson(response, 200, { results, generatedAt: new Date().toISOString() });
    return;
  }

  sendError(response, 404, "API no encontrada");
}

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://127.0.0.1:${port}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = path.resolve(rootDir, relativePath);

  if (filePath !== rootDir && !filePath.startsWith(rootPrefix)) {
    return null;
  }

  return filePath;
}

function serveStatic(request, response) {
  const filePath = resolveRequestPath(request.url || "/");

  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

ensureStore();

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/mcp") {
    handleMcp(request, response).catch((error) => {
      sendJson(response, 400, jsonRpcError(null, -32700, error.message || "Error MCP"));
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    handleApi(request, response, url).catch((error) => {
      sendError(response, 400, error.message || "Error API");
    });
    return;
  }

  serveStatic(request, response);
});

server.listen(port, () => {
  console.log(`POC Log running at http://127.0.0.1:${port}/`);
  console.log(`Datos persistentes: ${storePath}`);
  console.log(`Observabilidad: Loki ${lokiPushUrl} | Tempo ${tempoTracesUrl}`);
  startObservabilitySync();
});
