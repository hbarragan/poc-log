const state = {
  sources: [],
  views: [],
  settings: {
    lokiEnabled: true,
  },
  selectedSourceIds: new Set(),
  activeLevel: "all",
  compact: false,
  refreshTimer: null,
  currentViewId: "",
  editingSourceId: "",
  detailSourceId: "",
  detailResult: null,
  detailMatchIndex: -1,
};

const elements = {
  dashboardSection: document.querySelector("#dashboardSection"),
  adminSection: document.querySelector("#adminSection"),
  sections: document.querySelectorAll(".workspace"),
  navItems: document.querySelectorAll("[data-section]"),
  sourceList: document.querySelector("#sourceList"),
  selectAllSourcesButton: document.querySelector("#selectAllSourcesButton"),
  adminSourceList: document.querySelector("#adminSourceList"),
  sourceForm: document.querySelector("#sourceForm"),
  sourceFormTitle: document.querySelector("#sourceFormTitle"),
  adminMessage: document.querySelector("#adminMessage"),
  adminCount: document.querySelector("#adminCount"),
  settingsForm: document.querySelector("#settingsForm"),
  lokiEnabledSelect: document.querySelector("#lokiEnabledSelect"),
  settingsMessage: document.querySelector("#settingsMessage"),
  exportSourcesButton: document.querySelector("#exportSourcesButton"),
  importSourcesInput: document.querySelector("#importSourcesInput"),
  cancelSourceEdit: document.querySelector("#cancelSourceEdit"),
  logGrid: document.querySelector("#logGrid"),
  globalSearch: document.querySelector("#globalSearch"),
  tailSelect: document.querySelector("#tailSelect"),
  refreshSelect: document.querySelector("#refreshSelect"),
  reloadButton: document.querySelector("#reloadButton"),
  compactButton: document.querySelector("#compactButton"),
  levelButtons: document.querySelectorAll("[data-level]"),
  sourcesMetric: document.querySelector("#sourcesMetric"),
  linesMetric: document.querySelector("#linesMetric"),
  errorsMetric: document.querySelector("#errorsMetric"),
  refreshMetric: document.querySelector("#refreshMetric"),
  viewSelect: document.querySelector("#viewSelect"),
  saveViewButton: document.querySelector("#saveViewButton"),
  saveViewDialog: document.querySelector("#saveViewDialog"),
  viewName: document.querySelector("#viewName"),
  viewId: document.querySelector("#viewId"),
  viewMessage: document.querySelector("#viewMessage"),
  confirmSaveView: document.querySelector("#confirmSaveView"),
  detailDialog: document.querySelector("#detailDialog"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailSearch: document.querySelector("#detailSearch"),
  detailLevel: document.querySelector("#detailLevel"),
  detailTail: document.querySelector("#detailTail"),
  detailPrevMatch: document.querySelector("#detailPrevMatch"),
  detailNextMatch: document.querySelector("#detailNextMatch"),
  detailReload: document.querySelector("#detailReload"),
  detailVisibleCount: document.querySelector("#detailVisibleCount"),
  detailMatchCount: document.querySelector("#detailMatchCount"),
  detailErrorCount: document.querySelector("#detailErrorCount"),
  detailWarnCount: document.querySelector("#detailWarnCount"),
  detailLogLines: document.querySelector("#detailLogLines"),
  closeDetailButton: document.querySelector("#closeDetailButton"),
};

function debounce(callback, delay = 250) {
  let timerId;
  return (...args) => {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(() => callback(...args), delay);
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const payload = await response.json();

  if (!response.ok || payload.error) {
    throw new Error(payload.error || "Error API");
  }

  return payload;
}

function setMessage(message, isError = false) {
  elements.adminMessage.textContent = message;
  elements.adminMessage.style.color = isError ? "var(--red)" : "var(--muted)";
}

function resetSourceForm() {
  state.editingSourceId = "";
  elements.sourceForm.reset();
  document.querySelector("#sourceColor").value = "#2354d5";
  document.querySelector("#sourceId").readOnly = false;
  elements.sourceFormTitle.textContent = "Registrar fuente";
  elements.cancelSourceEdit.hidden = true;
}

function editSource(source) {
  state.editingSourceId = source.id;
  document.querySelector("#sourceName").value = source.name;
  document.querySelector("#sourceId").value = source.id;
  document.querySelector("#sourceId").readOnly = true;
  document.querySelector("#sourcePath").value = source.path;
  document.querySelector("#sourceColor").value = source.color || "#2354d5";
  elements.sourceFormTitle.textContent = `Editar fuente: ${source.id}`;
  elements.cancelSourceEdit.hidden = false;
  setMessage("Editando fuente existente.");
}

function downloadJson(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getSelectedLevels() {
  return state.activeLevel === "all" ? [] : [state.activeLevel];
}

function getCurrentFilters() {
  return {
    query: elements.globalSearch.value.trim(),
    levels: getSelectedLevels(),
    compact: state.compact,
    tail: Number(elements.tailSelect.value),
    refreshSeconds: Number(elements.refreshSelect.value),
  };
}

function updateSaveButton() {
  const hasSelectedSources = state.selectedSourceIds.size > 0;
  elements.saveViewButton.disabled = !hasSelectedSources;
  elements.saveViewButton.title = hasSelectedSources ? "Guardar vista actual" : "Selecciona al menos un log";
}

function updateSourceSelectionButton() {
  const totalSources = state.sources.length;
  const selectedCount = state.selectedSourceIds.size;
  const allSelected = totalSources > 0 && selectedCount === totalSources;

  elements.selectAllSourcesButton.disabled = totalSources === 0;
  elements.selectAllSourcesButton.textContent = allSelected ? "Quitar seleccion" : "Seleccionar todos";
  elements.selectAllSourcesButton.title = allSelected
    ? "Quitar todos los logs de la vista"
    : "Seleccionar todos los logs montados";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSourceDetail(source) {
  if (source.status?.kind === "directory" && source.status?.resolvedName) {
    return `id: ${source.id} · ultimo: ${source.status.resolvedName}`;
  }

  return `id: ${source.id}`;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function countOccurrences(text, query) {
  if (!query) return 0;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let count = 0;
  let index = lowerText.indexOf(lowerQuery);

  while (index !== -1) {
    count += 1;
    index = lowerText.indexOf(lowerQuery, index + lowerQuery.length);
  }

  return count;
}

function appendHighlightedText(target, text, query) {
  if (!query) {
    target.append(document.createTextNode(text));
    return;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let cursor = 0;
  let index = lowerText.indexOf(lowerQuery);

  while (index !== -1) {
    if (index > cursor) {
      target.append(document.createTextNode(text.slice(cursor, index)));
    }

    const mark = createElement("mark", "search-hit", text.slice(index, index + query.length));
    target.append(mark);
    cursor = index + query.length;
    index = lowerText.indexOf(lowerQuery, cursor);
  }

  if (cursor < text.length) {
    target.append(document.createTextNode(text.slice(cursor)));
  }
}

function lineMatchesDetailLevel(line, level) {
  if (level === "all") return true;
  if (level === "error") return line.level === "error" || line.level === "fatal";
  return line.level === level;
}

function renderSources() {
  elements.sourceList.replaceChildren();

  if (!state.sources.length) {
    elements.sourceList.append(createElement("p", "empty-state", "No hay logs registrados. Entra en Administracion y anade un path."));
    updateSourceSelectionButton();
    return;
  }

  state.sources.forEach((source) => {
    const label = createElement("label", "source-card");
    const checkbox = createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedSourceIds.has(source.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedSourceIds.add(source.id);
      } else {
        state.selectedSourceIds.delete(source.id);
      }
      updateSaveButton();
      updateSourceSelectionButton();
      refreshLogs();
    });

    const color = createElement("span", "source-color");
    color.style.background = source.color;

    const title = createElement("span", "source-title");
    title.append(createElement("strong", "", source.name));
    title.append(createElement("span", "", formatSourceDetail(source)));

    const status = createElement("span", source.status?.readable ? "status-dot" : "status-dot bad");
    status.title = source.status?.readable ? "Accesible" : "No accesible";

    label.append(checkbox, color, title, status);
    elements.sourceList.append(label);
  });

  updateSourceSelectionButton();
}

function renderAdminSources() {
  elements.adminSourceList.replaceChildren();
  elements.adminCount.textContent = `${state.sources.length} logs`;

  if (!state.sources.length) {
    elements.adminSourceList.append(createElement("p", "empty-state", "No hay fuentes configuradas."));
    return;
  }

  state.sources.forEach((source) => {
    const row = createElement("div", "admin-row");
    const details = createElement("div");
    const statusText = source.status?.readable ? "OK" : "No accesible";
    details.append(createElement("strong", "", `${source.name} · ${source.id} · ${statusText}`));
    details.append(createElement("code", "", source.path));
    if (source.status?.kind === "directory" && source.status?.resolvedPath) {
      details.append(createElement("code", "", `Leyendo: ${source.status.resolvedPath}`));
    }

    const actions = createElement("div", "row-actions");
    const editButton = createElement("button", "side-option", "Editar");
    editButton.type = "button";
    editButton.addEventListener("click", () => editSource(source));

    const removeButton = createElement("button", "danger-action", "Borrar");
    removeButton.type = "button";
    removeButton.addEventListener("click", () => deleteSource(source.id));

    actions.append(editButton, removeButton);
    row.append(details, actions);
    elements.adminSourceList.append(row);
  });
}

function renderViews() {
  const previousValue = state.currentViewId || elements.viewSelect.value;
  elements.viewSelect.replaceChildren();
  elements.viewSelect.append(new Option("Vista actual sin guardar", ""));

  state.views.forEach((view) => {
    elements.viewSelect.append(new Option(`${view.name} (${view.id})`, view.id));
  });

  elements.viewSelect.value = state.views.some((view) => view.id === previousValue) ? previousValue : "";
}

function renderSettings() {
  elements.lokiEnabledSelect.value = state.settings.lokiEnabled === false ? "false" : "true";
}

function renderEmptyDashboard() {
  elements.logGrid.replaceChildren();
  elements.logGrid.append(createElement("p", "empty-state", "Selecciona uno o varios logs para montar la vista."));
  elements.sourcesMetric.textContent = "0";
  elements.linesMetric.textContent = "0";
  elements.errorsMetric.textContent = "0";
}

function renderLogPanel(result) {
  const source = result.source;
  const panel = createElement("article", "log-panel");

  const head = createElement("div", "log-panel-head");
  const color = createElement("span", "log-color");
  color.style.background = source.color;

  const title = createElement("div");
  title.append(createElement("h3", "", source.name));
  const resolvedName = result.status?.kind === "directory" && result.status?.resolvedName
    ? ` · ${result.status.resolvedName}`
    : "";
  title.append(createElement("span", "", `id: ${source.id}${resolvedName} · ${formatBytes(result.status?.size)} · ${formatTime(result.status?.modifiedAt)}`));

  const actions = createElement("div", "log-panel-actions");
  const count = createElement("span", "log-count", `${result.lines.length}/${result.total}`);
  const openButton = createElement("button", "detail-open", "Ampliar");
  openButton.type = "button";
  openButton.addEventListener("click", () => openDetail(source.id));
  actions.append(count, openButton);
  head.append(color, title, actions);

  const list = createElement("div", "log-lines");

  if (result.error) {
    list.append(createElement("p", "empty-state", result.error));
  } else if (!result.lines.length) {
    list.append(createElement("p", "empty-state", "Sin lineas para los filtros activos."));
  } else {
    result.lines.forEach((line) => {
      const row = createElement("div", `log-line ${line.level}`);
      const level = createElement("span", "level", line.level);
      const message = createElement("span", "message", state.compact ? line.summary : line.message);
      const expand = createElement("button", "expand-line", "+");
      expand.type = "button";
      expand.title = "Expandir linea";
      expand.addEventListener("click", () => {
        const expanded = expand.textContent === "-";
        expand.textContent = expanded ? "+" : "-";
        message.textContent = expanded ? line.summary : line.message;
      });

      row.append(level, message, expand);
      list.append(row);
    });
  }

  panel.append(head, list);
  return panel;
}

async function loadDetailSource() {
  if (!state.detailSourceId) return;

  elements.detailReload.disabled = true;
  elements.detailLogLines.replaceChildren(createElement("p", "detail-empty", "Cargando log..."));

  try {
    const payload = await api("/api/logs/query", {
      method: "POST",
      body: JSON.stringify({
        sourceIds: [state.detailSourceId],
        levels: [],
        query: "",
        compact: false,
        tail: Number(elements.detailTail.value),
      }),
    });

    state.detailResult = payload.results[0] || null;
    renderDetail();
  } catch (error) {
    elements.detailLogLines.replaceChildren(createElement("p", "detail-empty", error.message));
  } finally {
    elements.detailReload.disabled = false;
  }
}

function getFilteredDetailLines() {
  const result = state.detailResult;
  if (!result) return [];

  const query = elements.detailSearch.value.trim().toLowerCase();
  const level = elements.detailLevel.value;

  return result.lines.filter((line) => {
    if (!lineMatchesDetailLevel(line, level)) return false;
    if (query && !line.message.toLowerCase().includes(query)) return false;
    return true;
  });
}

function renderDetail() {
  const result = state.detailResult;
  elements.detailLogLines.replaceChildren();

  if (!result) {
    elements.detailLogLines.append(createElement("p", "detail-empty", "Sin datos."));
    return;
  }

  const query = elements.detailSearch.value.trim();
  const filteredLines = getFilteredDetailLines();
  const allLines = result.lines;
  const matchCount = query
    ? allLines.reduce((total, line) => total + countOccurrences(line.message, query), 0)
    : 0;
  const visibleErrorCount = filteredLines.filter((line) => line.level === "error" || line.level === "fatal").length;
  const visibleWarnCount = filteredLines.filter((line) => line.level === "warn").length;

  elements.detailTitle.textContent = result.source.name;
  elements.detailSubtitle.textContent = [
    `id: ${result.source.id}`,
    result.status?.resolvedName || "",
    formatBytes(result.status?.size),
    formatTime(result.status?.modifiedAt),
  ].filter(Boolean).join(" · ");
  elements.detailVisibleCount.textContent = `${filteredLines.length}/${allLines.length} lineas`;
  elements.detailMatchCount.textContent = `${matchCount} coincidencias`;
  elements.detailErrorCount.textContent = `${visibleErrorCount} errores`;
  elements.detailWarnCount.textContent = `${visibleWarnCount} warnings`;

  if (result.error) {
    elements.detailLogLines.append(createElement("p", "detail-empty", result.error));
    return;
  }

  if (!filteredLines.length) {
    elements.detailLogLines.append(createElement("p", "detail-empty", "Sin lineas para estos filtros."));
    return;
  }

  filteredLines.forEach((line) => {
    const row = createElement("div", `detail-line ${line.level}`);
    const number = createElement("span", "detail-line-number", String(line.index + 1));
    const level = createElement("span", "detail-line-level", line.level);
    const message = createElement("span", "detail-line-message");
    appendHighlightedText(message, line.message, query);
    row.append(number, level, message);
    elements.detailLogLines.append(row);
  });

  state.detailMatchIndex = -1;
}

function focusDetailMatch(direction) {
  const matches = [...elements.detailLogLines.querySelectorAll(".search-hit")];
  if (!matches.length) return;

  matches.forEach((match) => match.classList.remove("active"));
  state.detailMatchIndex += direction;

  if (state.detailMatchIndex < 0) {
    state.detailMatchIndex = matches.length - 1;
  }

  if (state.detailMatchIndex >= matches.length) {
    state.detailMatchIndex = 0;
  }

  const activeMatch = matches[state.detailMatchIndex];
  activeMatch.classList.add("active");
  activeMatch.scrollIntoView({ block: "center", inline: "nearest" });
}

async function openDetail(sourceId) {
  state.detailSourceId = sourceId;
  state.detailResult = null;
  state.detailMatchIndex = -1;
  elements.detailSearch.value = "";
  elements.detailLevel.value = "all";

  if (!elements.detailDialog.open) {
    elements.detailDialog.showModal();
  }

  await loadDetailSource();
}

function renderLogs(results, generatedAt) {
  elements.logGrid.replaceChildren();

  if (!results.length) {
    renderEmptyDashboard();
    return;
  }

  let visibleLines = 0;
  let errorLines = 0;

  results.forEach((result) => {
    visibleLines += result.lines.length;
    errorLines += result.lines.filter((line) => line.level === "error" || line.level === "fatal").length;
    elements.logGrid.append(renderLogPanel(result));
  });

  elements.sourcesMetric.textContent = String(results.length);
  elements.linesMetric.textContent = String(visibleLines);
  elements.errorsMetric.textContent = String(errorLines);
  elements.refreshMetric.textContent = formatTime(generatedAt);
}

async function refreshLogs() {
  const sourceIds = Array.from(state.selectedSourceIds);

  if (!sourceIds.length) {
    renderEmptyDashboard();
    return;
  }

  elements.reloadButton.disabled = true;
  try {
    const payload = await api("/api/logs/query", {
      method: "POST",
      body: JSON.stringify({
        sourceIds,
        ...getCurrentFilters(),
      }),
    });
    renderLogs(payload.results, payload.generatedAt);
  } catch (error) {
    elements.logGrid.replaceChildren(createElement("p", "empty-state", error.message));
  } finally {
    elements.reloadButton.disabled = false;
  }
}

async function loadData() {
  const [sourcesPayload, viewsPayload, settingsPayload] = await Promise.all([
    api("/api/sources"),
    api("/api/views"),
    api("/api/settings"),
  ]);

  state.sources = sourcesPayload.sources;
  state.views = viewsPayload.views;
  state.settings = settingsPayload.settings;

  renderSources();
  renderAdminSources();
  renderSettings();
  renderViews();
}

async function saveSettings() {
  const payload = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      lokiEnabled: elements.lokiEnabledSelect.value === "true",
    }),
  });

  state.settings = payload.settings;
  renderSettings();
  elements.settingsMessage.style.color = "var(--muted)";
  elements.settingsMessage.textContent = state.settings.lokiEnabled
    ? "Carga hacia Loki activada."
    : "Carga hacia Loki desactivada.";
}

async function exportSources() {
  const payload = await api("/api/sources/export");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJson(`poc-log-sources-${timestamp}.json`, payload);
  setMessage("Backup de fuentes exportado.");
}

async function importSources(file) {
  if (!file) return;

  const text = await file.text();
  const payload = JSON.parse(text);
  const response = await api("/api/sources/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  state.selectedSourceIds = new Set([...state.selectedSourceIds].filter((sourceId) => {
    return response.sources.some((source) => source.id === sourceId);
  }));
  resetSourceForm();
  await loadData();
  await refreshLogs();
  setMessage(`Backup importado: ${response.sources.length} fuentes.`);
}

function applyView(view) {
  state.currentViewId = view.id;
  state.selectedSourceIds = new Set(view.sourceIds);
  elements.globalSearch.value = view.filters?.query || "";
  elements.tailSelect.value = String(view.filters?.tail || 500);
  elements.refreshSelect.value = String(view.filters?.refreshSeconds ?? 5);
  state.compact = Boolean(view.filters?.compact);
  state.activeLevel = view.filters?.levels?.[0] || "all";

  elements.viewSelect.value = view.id;
  updateFilterButtons();
  updateSaveButton();
  renderSources();
  scheduleRefresh();
  refreshLogs();
}

function updateFilterButtons() {
  elements.levelButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.level === state.activeLevel);
  });
  elements.compactButton.classList.toggle("active", state.compact);
}

function scheduleRefresh() {
  window.clearInterval(state.refreshTimer);
  const refreshSeconds = Number(elements.refreshSelect.value);

  if (refreshSeconds > 0) {
    state.refreshTimer = window.setInterval(refreshLogs, refreshSeconds * 1000);
  }
}

async function saveCurrentView() {
  const sourceIds = Array.from(state.selectedSourceIds);
  if (!sourceIds.length) {
    elements.viewMessage.textContent = "Selecciona al menos un log.";
    return;
  }

  const payload = await api("/api/views", {
    method: "POST",
    body: JSON.stringify({
      id: elements.viewId.value.trim(),
      name: elements.viewName.value.trim(),
      sourceIds,
      filters: getCurrentFilters(),
      layout: "grid",
    }),
  });

  state.currentViewId = payload.view.id;
  const nextUrl = `${window.location.pathname}?view=${encodeURIComponent(payload.view.id)}`;
  window.history.replaceState({}, "", nextUrl);
  elements.saveViewDialog.close();
  elements.viewMessage.textContent = "";
  await loadData();
  elements.viewSelect.value = payload.view.id;
}

async function deleteSource(id) {
  await api(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  state.selectedSourceIds.delete(id);
  await loadData();
  await refreshLogs();
}

function activateSection(section) {
  const targetButton = [...elements.navItems].find((button) => button.dataset.section === section);
  if (!targetButton) return false;

  elements.navItems.forEach((item) => item.classList.toggle("active", item === targetButton));
  elements.sections.forEach((workspace) => {
    workspace.hidden = workspace.id !== `${section}Section`;
  });

  return true;
}

function bindEvents() {
  elements.navItems.forEach((button) => {
    button.addEventListener("click", () => {
      activateSection(button.dataset.section);
    });
  });

  elements.sourceForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(elements.sourceForm);
    try {
      const payload = await api("/api/sources", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          id: form.get("id"),
          path: form.get("path"),
          color: form.get("color"),
        }),
      });
      resetSourceForm();
      setMessage(`Fuente guardada: ${payload.source.id}`);
      await loadData();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.cancelSourceEdit.addEventListener("click", () => {
    resetSourceForm();
    setMessage("");
  });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.settingsMessage.textContent = "";
    try {
      await saveSettings();
    } catch (error) {
      elements.settingsMessage.textContent = error.message;
      elements.settingsMessage.style.color = "var(--red)";
    }
  });

  elements.exportSourcesButton.addEventListener("click", () => {
    exportSources().catch((error) => setMessage(error.message, true));
  });

  elements.importSourcesInput.addEventListener("change", () => {
    importSources(elements.importSourcesInput.files[0])
      .catch((error) => setMessage(error.message, true))
      .finally(() => {
        elements.importSourcesInput.value = "";
      });
  });

  elements.reloadButton.addEventListener("click", refreshLogs);
  elements.selectAllSourcesButton.addEventListener("click", () => {
    const allSelected = state.sources.length > 0 && state.selectedSourceIds.size === state.sources.length;
    state.selectedSourceIds = allSelected ? new Set() : new Set(state.sources.map((source) => source.id));
    updateSaveButton();
    renderSources();
    refreshLogs();
  });

  elements.globalSearch.addEventListener("input", debounce(refreshLogs));
  elements.tailSelect.addEventListener("change", refreshLogs);
  elements.refreshSelect.addEventListener("change", () => {
    scheduleRefresh();
    refreshLogs();
  });

  elements.levelButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeLevel = button.dataset.level;
      updateFilterButtons();
      refreshLogs();
    });
  });

  elements.compactButton.addEventListener("click", () => {
    state.compact = !state.compact;
    updateFilterButtons();
    refreshLogs();
  });

  elements.saveViewButton.addEventListener("click", () => {
    if (!state.selectedSourceIds.size) return;
    elements.viewName.value = state.currentViewId
      ? state.views.find((view) => view.id === state.currentViewId)?.name || ""
      : "";
    elements.viewId.value = "";
    elements.viewMessage.textContent = "";
    elements.saveViewDialog.showModal();
  });

  elements.confirmSaveView.addEventListener("click", async () => {
    if (!elements.viewName.value.trim()) {
      elements.viewName.reportValidity();
      return;
    }
    await saveCurrentView();
  });

  elements.closeDetailButton.addEventListener("click", () => {
    elements.detailDialog.close();
  });

  elements.detailSearch.addEventListener("input", debounce(renderDetail, 120));
  elements.detailLevel.addEventListener("change", renderDetail);
  elements.detailTail.addEventListener("change", loadDetailSource);
  elements.detailReload.addEventListener("click", loadDetailSource);
  elements.detailPrevMatch.addEventListener("click", () => focusDetailMatch(-1));
  elements.detailNextMatch.addEventListener("click", () => focusDetailMatch(1));

  elements.viewSelect.addEventListener("change", () => {
    const view = state.views.find((item) => item.id === elements.viewSelect.value);
    if (!view) {
      state.currentViewId = "";
      window.history.replaceState({}, "", window.location.pathname);
      updateSaveButton();
      return;
    }

    window.history.replaceState({}, "", `${window.location.pathname}?view=${encodeURIComponent(view.id)}`);
    applyView(view);
  });
}

async function init() {
  bindEvents();
  updateFilterButtons();
  await loadData();

  const searchParams = new URLSearchParams(window.location.search);
  const viewId = searchParams.get("view");
  const requestedSection = searchParams.get("section");
  const initialView = state.views.find((view) => view.id === viewId);

  if (requestedSection) {
    activateSection(requestedSection);
  }

  if (initialView) {
    applyView(initialView);
  } else if (!requestedSection || requestedSection === "dashboard") {
    renderEmptyDashboard();
    scheduleRefresh();
    updateSaveButton();
  }
}

init().catch((error) => {
  elements.logGrid.replaceChildren(createElement("p", "empty-state", error.message));
});
