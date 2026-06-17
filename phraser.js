"use strict";

const WORKER_URL = "https://dlrg-results.jp-gnad.workers.dev/";
const AUTH_SESSION_KEY = "dlrg-phraser-auth-year";
const EXPORT_LOG_URL = "downloaded-competitions/exported-competitions.csv";
const EXPORT_LOG_FILENAME = "exported-competitions.csv";
const EXPORT_LOG_STORAGE_KEY = "dlrg-phraser-export-log";
const EXPORT_BATCH_SIZE = 80;
const EXPORT_LOG_HEADERS = [
  "exported_at",
  "competition_code",
  "competition_name",
  "from",
  "till",
  "source",
  "event_count",
  "row_count",
  "catalog_signature",
  "data_signature",
  "stale_reason",
  "excel_file"
];

let currentResults = [];
let currentCatalog = null;
let activeEventType = "";
let activeChoiceId = "";
let catalogChoiceEvents = new Map();
let competitionListLoaded = false;
let competitionListCache = [];
let exportedCompetitionRecords = new Map();
let exportStateOverrides = new Map();
let exportLogLoaded = false;
let exportLogWarning = "";
let isExporting = false;

const loginScreen = document.getElementById("loginScreen");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("password");
const loginError = document.getElementById("loginError");
const app = document.getElementById("app");
const logoutButton = document.getElementById("logoutButton");
const competitionSelect = document.getElementById("competitionSelect");
const competitionListInfo = document.getElementById("competitionListInfo");
const reloadCompetitionListButton = document.getElementById(
  "reloadCompetitionListButton"
);
const manualCompetitionGroup = document.getElementById(
  "manualCompetitionGroup"
);
const competitionInput = document.getElementById("competition");
const exportActions = document.getElementById("exportActions");
const excelExportButton = document.getElementById("excelExportButton");
const exportInfo = document.getElementById("exportInfo");
const resultSelection = document.getElementById("resultSelection");
const selectionInfo = document.getElementById("selectionInfo");
const resultTabs = document.getElementById("resultTabs");
const resultCatalog = document.getElementById("resultCatalog");
const statusElement = document.getElementById("status");
const resultTable = document.getElementById("resultTable");
const pageTitle = document.getElementById("pageTitle");
const errorDetails = document.getElementById("errorDetails");
const errorOutput = document.getElementById("errorOutput");

function getCurrentYear() {
  return String(new Date().getFullYear());
}

function getExpectedPassword() {
  return `DLRG${getCurrentYear()}`;
}

function unlockApp() {
  sessionStorage.setItem(AUTH_SESSION_KEY, getCurrentYear());
  loginScreen.hidden = true;
  app.hidden = false;
  document.body.classList.remove("auth-locked");

  if (!competitionListLoaded) {
    loadCompetitionList();
  } else {
    competitionListInfo.textContent +=
      ` ${exportedCompetitionRecords.size} Exporte in der CSV/Browserspeicher-Liste.`;

    if (exportLogWarning) {
      competitionListInfo.textContent += ` Hinweis: ${exportLogWarning}`;
    }

    competitionSelect.focus();
  }
}

function lockApp() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  app.hidden = true;
  loginScreen.hidden = false;
  document.body.classList.add("auth-locked");
  loginForm.reset();
  loginError.textContent = "";
  passwordInput.focus();
}

function initializeAuthentication() {
  if (sessionStorage.getItem(AUTH_SESSION_KEY) === getCurrentYear()) {
    unlockApp();
  } else {
    lockApp();
  }
}

function buildWorkerUrl(competition, options = {}) {
  const url = new URL(WORKER_URL);

  if (competition) {
    url.searchParams.set("competition", competition);
  }

  if (options.uuid) {
    url.searchParams.set("uuid", options.uuid);
  }

  if (options.mode) {
    url.searchParams.set("mode", options.mode);
  }

  return url.toString();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Die Serverantwort enthält kein gültiges JSON.");
  }
}

function formatIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

function formatCompetitionDateRange(from, till) {
  const fromDate = formatIsoDate(from);
  const tillDate = formatIsoDate(till);

  if (!fromDate) {
    return "Datum unbekannt";
  }

  return tillDate && tillDate !== fromDate
    ? `${fromDate} - ${tillDate}`
    : fromDate;
}

function normalizeCompetitionCode(value) {
  return String(value || "").trim().toUpperCase();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if (character === "\n" && !inQuotes) {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += character;
  }

  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => String(cell).trim()));
}

function parseExportLogCsv(text) {
  const rows = parseCsv(text);
  const headers = rows.shift() || [];

  return rows
    .map((row) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = row[index] || "";
      });
      return record;
    })
    .filter((record) => normalizeCompetitionCode(record.competition_code));
}

function escapeCsvValue(value) {
  const text = String(value === undefined || value === null ? "" : value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function createExportLogCsv() {
  const records = Array.from(exportedCompetitionRecords.values()).sort(
    (left, right) =>
      String(left.competition_code || "").localeCompare(
        String(right.competition_code || ""),
        "de"
      )
  );
  const lines = [
    EXPORT_LOG_HEADERS.join(","),
    ...records.map((record) =>
      EXPORT_LOG_HEADERS.map((header) =>
        escapeCsvValue(record[header] || "")
      ).join(",")
    )
  ];

  return `${lines.join("\n")}\n`;
}

function mergeExportRecords(records) {
  records.forEach((record) => {
    const key = normalizeCompetitionCode(record.competition_code);

    if (!key) {
      return;
    }

    exportedCompetitionRecords.set(key, {
      ...record,
      competition_code: key
    });
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function createHash(value) {
  const text = stableStringify(value);
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createCatalogSignature(catalog) {
  const events = Array.isArray(catalog && catalog.events)
    ? catalog.events
    : [];

  return createHash({
    competitionName: catalog && catalog.competitionName,
    from: catalog && catalog.from,
    till: catalog && catalog.till,
    source: catalog && catalog.source,
    events: events.map((event) => ({
      source: event.source,
      eventType: event.eventType,
      round: event.round || "",
      ageGroup: event.ageGroup || "",
      gender: event.gender || "",
      discipline: event.discipline || "",
      uuid: event.uuid || "",
      edvnummer: event.edvnummer || "",
      wkid: event.wkid || "",
      ak: event.ak || ""
    }))
  });
}

function createDataSignature(sheets) {
  return createHash(
    sheets.map((sheet) => ({
      source: sheet.source,
      eventType: sheet.eventType,
      rows: sheet.rows
    }))
  );
}

function readStoredExportRecords() {
  try {
    return JSON.parse(localStorage.getItem(EXPORT_LOG_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeStoredExportRecords() {
  try {
    localStorage.setItem(
      EXPORT_LOG_STORAGE_KEY,
      JSON.stringify(Array.from(exportedCompetitionRecords.values()))
    );
  } catch {
    // The CSV download is the durable cross-device record.
  }
}

async function loadExportLog() {
  if (exportLogLoaded) {
    return;
  }

  mergeExportRecords(readStoredExportRecords());

  try {
    const response = await fetch(`${EXPORT_LOG_URL}?v=${Date.now()}`, {
      cache: "no-store"
    });

    if (response.ok) {
      mergeExportRecords(parseExportLogCsv(await response.text()));
    } else if (response.status !== 404) {
      exportLogWarning =
        `Export-Liste konnte nicht gelesen werden: HTTP ${response.status}`;
    }
  } catch (error) {
    exportLogWarning =
      `Export-Liste konnte nicht gelesen werden: ${error.message}`;
  }

  exportLogLoaded = true;
}

function isCompetitionExported(code) {
  return exportedCompetitionRecords.has(normalizeCompetitionCode(code));
}

function getExportState(code) {
  const key = normalizeCompetitionCode(code);

  return exportStateOverrides.get(key) ||
    (exportedCompetitionRecords.has(key) ? "current" : "");
}

function getExportStatePrefix(state) {
  if (state === "current") {
    return "✓ ";
  }

  if (state === "stale") {
    return "! ";
  }

  if (state === "missing") {
    return "!! ";
  }

  return "";
}

function applyExportStateClass(option, state) {
  option.classList.toggle("competition-exported-option", state === "current");
  option.classList.toggle("competition-export-stale-option", state === "stale");
  option.classList.toggle("competition-export-missing-option", state === "missing");
}

function updateExportStateFromCatalog(catalog) {
  const code = normalizeCompetitionCode(getSelectedCompetitionCode());
  const record = exportedCompetitionRecords.get(code);

  if (!code || !record) {
    exportStateOverrides.delete(code);
    return "";
  }

  if (!Array.isArray(catalog.events) || catalog.events.length === 0) {
    exportStateOverrides.set(code, "missing");
    return "Aktuell wurden keine Ergebnislisten gefunden.";
  }

  if (record.catalog_signature) {
    const currentSignature = createCatalogSignature(catalog);

    if (record.catalog_signature !== currentSignature) {
      exportStateOverrides.set(code, "stale");
      return "Die Ergebnisübersicht hat sich seit dem letzten Export geändert.";
    }
  } else if (
    (record.event_count &&
      Number(record.event_count) !== catalog.events.length) ||
    (record.source && record.source !== catalog.source)
  ) {
    exportStateOverrides.set(code, "stale");
    return "Die Ergebnisübersicht passt nicht mehr zum alten CSV-Eintrag.";
  }

  exportStateOverrides.set(code, "current");
  return "";
}

function slugifyFilename(value) {
  return String(value || "export")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "export";
}

function downloadTextFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setCompetitionControlsEnabled() {
  const usesManualCode = competitionSelect.value === "__manual__";

  manualCompetitionGroup.hidden = !usesManualCode;
  updateSelectedCompetitionExportState();
}

function updateSelectedCompetitionExportState() {
  competitionSelect.classList.remove("is-exported");
}

function refreshCompetitionOptions() {
  if (competitionListCache.length === 0) {
    updateSelectedCompetitionExportState();
    return;
  }

  const selectedValue = competitionSelect.value;
  renderCompetitionOptions(competitionListCache);
  competitionSelect.value = selectedValue;
  setCompetitionControlsEnabled();
}

function renderCompetitionOptions(competitions) {
  competitionListCache = competitions;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Wettkampf auswählen ...";
  competitionSelect.replaceChildren(placeholder);

  const competitionsByYear = new Map();

  competitions.forEach((competition) => {
    const year = String(competition.from || "").slice(0, 4) || "Ohne Datum";

    if (!competitionsByYear.has(year)) {
      competitionsByYear.set(year, []);
    }

    competitionsByYear.get(year).push(competition);
  });

  competitionsByYear.forEach((yearCompetitions, year) => {
    const group = document.createElement("optgroup");
    group.label = year;

    yearCompetitions.forEach((competition) => {
      const option = document.createElement("option");
      const exportState = getExportState(competition.acronym);
      option.value = competition.acronym;
      option.textContent =
        `${getExportStatePrefix(exportState)}` +
        `${formatCompetitionDateRange(competition.from, competition.till)} | ` +
        `${competition.name} (${competition.acronym})`;
      applyExportStateClass(option, exportState);
      group.appendChild(option);
    });

    competitionSelect.appendChild(group);
  });

  const manualOption = document.createElement("option");
  manualOption.value = "__manual__";
  manualOption.textContent = "Anderen Wettkampfcode manuell eingeben ...";
  competitionSelect.appendChild(manualOption);
  updateSelectedCompetitionExportState();
}

async function loadCompetitionList() {
  competitionSelect.disabled = true;
  reloadCompetitionListButton.hidden = true;
  competitionListInfo.className = "field-hint";
  competitionListInfo.textContent = "Wettkampfliste wird geladen ...";

  try {
    const [response] = await Promise.all([
      fetchJson(buildWorkerUrl("", { mode: "competitions" })),
      loadExportLog()
    ]);
    const competitions = Array.isArray(response.competitions)
      ? response.competitions
      : [];

    if (competitions.length === 0) {
      throw new Error("Keine Wettkämpfe ab dem 01.01.2020 gefunden.");
    }

    renderCompetitionOptions(competitions);
    competitionListLoaded = true;
    competitionSelect.disabled = false;
    reloadCompetitionListButton.hidden = true;
    competitionListInfo.textContent =
      `${competitions.length} Wettkämpfe ab dem 01.01.2020 geladen.`;
    competitionSelect.focus();
  } catch (error) {
    console.error(error);
    competitionSelect.replaceChildren();

    const manualOption = document.createElement("option");
    manualOption.value = "__manual__";
    manualOption.textContent = "Wettkampfcode manuell eingeben";
    competitionSelect.appendChild(manualOption);
    competitionSelect.disabled = false;
    reloadCompetitionListButton.hidden = false;
    competitionListInfo.className = "field-hint error";
    competitionListInfo.textContent =
      `Wettkampfliste nicht verfügbar: ${error.message}`;
    manualCompetitionGroup.hidden = false;
    competitionInput.focus();
  }

  setCompetitionControlsEnabled();
}

function getSelectedCompetitionCode() {
  return competitionSelect.value === "__manual__"
    ? competitionInput.value.trim()
    : competitionSelect.value;
}

function setExportControlsReady(isReady) {
  exportActions.hidden = !isReady;
  excelExportButton.disabled = !isReady || isExporting;
  updateExportInfo();
}

function updateExportInfo() {
  if (!currentCatalog) {
    exportInfo.textContent = "";
    return;
  }

  const code = getSelectedCompetitionCode();
  const state = getExportState(code);

  if (state === "current") {
    exportInfo.textContent = "Dieser Wettkampf ist bereits aktuell exportiert.";
    return;
  }

  if (state === "stale") {
    exportInfo.textContent =
      "Dieser Wettkampf wurde schon exportiert, die Ergebnisübersicht hat sich aber geändert.";
    return;
  }

  if (state === "missing") {
    exportInfo.textContent =
      "Dieser Wettkampf wurde schon exportiert, aktuell sind aber keine Ergebnislisten vorhanden.";
    return;
  }

  exportInfo.textContent = "Dieser Wettkampf ist noch nicht in der Exportliste markiert.";
}

function resetResultSelection() {
  currentCatalog = null;
  currentResults = [];
  activeEventType = "";
  activeChoiceId = "";
  catalogChoiceEvents = new Map();
  resultSelection.hidden = true;
  resultCatalog.replaceChildren();
  resultTable.replaceChildren();
  selectionInfo.textContent = "";
  errorDetails.hidden = true;
  errorOutput.textContent = "";
  setExportControlsReady(false);

  resultTabs.querySelectorAll(".result-tab").forEach((tab) => {
    tab.hidden = false;
    tab.setAttribute("aria-selected", "false");
  });
}

function getGenderLabel(value) {
  if (value === "w") {
    return "weiblich";
  }

  if (value === "m") {
    return "männlich";
  }

  return "gemischt";
}

function getEventTypeLabel(value) {
  return value === "Individual" ? "Einzel" : "Mannschaft";
}

function getRoundSortValue(value) {
  if (value === "Vorlauf") {
    return 0;
  }

  const intermediateMatch = String(value || "").match(
    /^Zwischenlauf\s+(\d+)$/
  );

  if (intermediateMatch) {
    return 100 + Number(intermediateMatch[1]);
  }

  if (value === "Ergebnis") {
    return 9000;
  }

  if (value === "Finale") {
    return 10000;
  }

  return 8000;
}

function groupEventsByRound(events) {
  const groups = new Map();

  events.forEach((event) => {
    const round = event.round || "Ergebnis";

    if (!groups.has(round)) {
      groups.set(round, []);
    }

    groups.get(round).push(event);
  });

  return Array.from(groups.entries()).sort(([left], [right]) => {
    const orderDifference =
      getRoundSortValue(left) - getRoundSortValue(right);
    return orderDifference || left.localeCompare(right, "de");
  });
}

function setCatalogButtonsDisabled(disabled) {
  resultCatalog.querySelectorAll(".result-choice-button").forEach((button) => {
    button.disabled = disabled;
  });
}

function renderCatalogTable() {
  resultCatalog.replaceChildren();
  catalogChoiceEvents = new Map();

  if (!currentCatalog || !activeEventType) {
    return;
  }

  const events = currentCatalog.events.filter(
    (event) => event.eventType === activeEventType
  );
  const genderOrder = ["w", "m", "mixed"];
  const ageGroups = new Map();

  events.forEach((event) => {
    if (!ageGroups.has(event.ageGroup)) {
      ageGroups.set(event.ageGroup, new Map());
    }

    const disciplines = ageGroups.get(event.ageGroup);

    if (!disciplines.has(event.discipline)) {
      disciplines.set(event.discipline, new Map());
    }

    const genders = disciplines.get(event.discipline);

    if (!genders.has(event.gender)) {
      genders.set(event.gender, []);
    }

    genders.get(event.gender).push(event);
  });

  const sortedAgeGroups = Array.from(ageGroups.entries()).sort(
    ([left], [right]) => left.localeCompare(right, "de")
  );

  sortedAgeGroups.forEach(([ageGroup, disciplines]) => {
    const section = document.createElement("section");
    section.className = "age-group-section";
    const title = document.createElement("h3");
    title.className = "age-group-title";
    title.textContent = ageGroup;
    section.appendChild(title);

    Array.from(disciplines.entries())
      .sort(([left], [right]) => left.localeCompare(right, "de"))
      .forEach(([discipline, genders]) => {
        const row = document.createElement("div");
        row.className = "discipline-row";
        const name = document.createElement("div");
        name.className = "discipline-name";
        name.textContent = discipline;
        row.appendChild(name);
        const buttonRow = document.createElement("div");
        buttonRow.className = "round-button-row";

        genderOrder.forEach((gender) => {
          const choiceEvents = genders.get(gender) || [];

          if (choiceEvents.length > 0) {
            groupEventsByRound(choiceEvents).forEach(
              ([round, roundEvents]) => {
                const choiceId =
                  `${activeEventType}:${ageGroup}:${discipline}:` +
                  `${gender}:${round}`;
                const button = document.createElement("button");
                const label = document.createElement("span");
                const roundLabel = document.createElement("small");
                button.className = "result-choice-button";
                button.type = "button";
                button.dataset.choiceId = choiceId;
                button.setAttribute(
                  "aria-label",
                  `${discipline}, ${ageGroup}, ${getGenderLabel(gender)}, ${round}`
                );
                label.textContent = getGenderLabel(gender);
                roundLabel.textContent = round;
                button.append(label, roundLabel);

                if (choiceId === activeChoiceId) {
                  button.classList.add("is-selected");
                }

                catalogChoiceEvents.set(choiceId, roundEvents);
                buttonRow.appendChild(button);
              }
            );
          }
        });

        row.appendChild(buttonRow);
        section.appendChild(row);
      });

    resultCatalog.appendChild(section);
  });

  selectionInfo.textContent =
    `${events.length} ${getEventTypeLabel(activeEventType)}-Ergebnislisten`;
}

function setActiveEventType(eventType) {
  if (!currentCatalog) {
    return;
  }

  const eventTypeChanged =
    Boolean(activeEventType) && activeEventType !== eventType;
  activeEventType = eventType;
  activeChoiceId = "";

  if (eventTypeChanged) {
    currentResults = [];
    resultTable.replaceChildren();
    errorDetails.hidden = true;
    errorOutput.textContent = "";
  }

  resultTabs.querySelectorAll(".result-tab").forEach((tab) => {
    const isActive = tab.dataset.eventType === eventType;
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  });

  renderCatalogTable();
}

function renderResultCatalog(catalog) {
  const eventTypes = ["Individual", "Team"].filter((eventType) =>
    catalog.events.some((event) => event.eventType === eventType)
  );

  resultTabs.querySelectorAll(".result-tab").forEach((tab) => {
    tab.hidden = !eventTypes.includes(tab.dataset.eventType);
  });

  resultSelection.hidden = false;
  setActiveEventType(eventTypes[0]);
}

async function loadResultCatalog() {
  const competitionCode = getSelectedCompetitionCode();

  if (!competitionCode) {
    resetResultSelection();
    statusElement.className = "status error";
    statusElement.textContent = "Bitte einen Wettkampfcode eingeben.";
    return;
  }

  resetResultSelection();
  competitionSelect.disabled = true;
  competitionInput.disabled = true;
  statusElement.className = "status";
  statusElement.textContent =
    "Ergebnisübersicht und Zuordnungen werden geladen ...";

  try {
    const catalog = await fetchJson(
      buildWorkerUrl(competitionCode, { mode: "catalog" })
    );

    if (!Array.isArray(catalog.events) || catalog.events.length === 0) {
      currentCatalog = catalog;
      updateExportStateFromCatalog(catalog);
      refreshCompetitionOptions();
      throw new Error("Für diesen Wettkampf wurden keine Ergebnislisten gefunden.");
    }

    currentCatalog = catalog;
    const exportStateMessage = updateExportStateFromCatalog(catalog);
    refreshCompetitionOptions();
    pageTitle.textContent = catalog.competitionName || competitionCode;
    renderResultCatalog(catalog);
    setExportControlsReady(true);

    const sourceText =
      catalog.source === "live"
        ? "inklusive offizieller Vorläufe und Finals"
        : "aus der competition.net-Übersicht";
    statusElement.textContent =
      `${catalog.events.length} Ergebnislisten ${sourceText} zugeordnet. ` +
      "Wähle bei der gewünschten Disziplin Geschlecht und Runde.";

    if (catalog.warning) {
      statusElement.textContent += ` Hinweis: ${catalog.warning}`;
    }

    if (exportStateMessage) {
      statusElement.textContent += ` Export-Hinweis: ${exportStateMessage}`;
    }
  } catch (error) {
    console.error(error);
    resetResultSelection();
    statusElement.className = "status error";
    statusElement.textContent = `Fehler: ${error.message}`;
  } finally {
    competitionSelect.disabled = false;
    competitionInput.disabled = false;
  }
}

function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function extractVisibleText(html) {
  let cleaned = String(html || "");

  cleaned = cleaned
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(
      /<\/(div|p|li|tr|td|th|h1|h2|h3|h4|h5|h6|section|article|header|footer|main|nav|button|a|span)>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(cleaned)
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseTitle(title) {
  const match = String(title || "").match(
    /^(.*?)\s+(weiblich|männlich|female|male|gemischt|mixed|mix)\s*-\s*(.+)$/i
  );

  if (!match) {
    return { ageGroup: "", gender: "", discipline: "" };
  }

  const genderText = match[2].toLowerCase();
  let gender = "mixed";

  if (genderText === "weiblich" || genderText === "female") {
    gender = "w";
  } else if (genderText === "männlich" || genderText === "male") {
    gender = "m";
  }

  return {
    ageGroup: match[1].trim(),
    gender,
    discipline: match[3].trim()
  };
}

function looksLikeTime(value) {
  const normalized = String(value || "").trim();

  return (
    /^\d{1,3}:\d{2}[,.]\d{2}$/.test(normalized) ||
    /^-:--[,.]--$/.test(normalized)
  );
}

function looksLikeStatus(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (!normalized) {
    return false;
  }

  const writtenStatuses = [
    "ABGEMELDET",
    "NICHT ANGETRETEN",
    "NICHT BEENDET",
    "DID NOT START",
    "DID NOT FINISH",
    "WITHDRAWN"
  ];

  if (writtenStatuses.includes(normalized)) {
    return true;
  }

  const statusCodePattern =
    /^(?:(?:DQ|DSQ|DISQ|DNF|DNS|DNC|WD|WDR|NS|NA|N\.A\.|OTL|EXH|SCR)\s*[A-Z0-9-]*)(?:\s*[,;/+]\s*(?:(?:DQ|DSQ|DISQ|DNF|DNS|DNC|WD|WDR|NS|NA|N\.A\.|OTL|EXH|SCR)\s*[A-Z0-9-]*))*$/i;

  return (
    statusCodePattern.test(normalized) ||
    (normalized.length <= 25 &&
      /^[A-Z][A-Z0-9-]*(?:\s*[,;/+]\s*[A-Z][A-Z0-9-]*)*$/.test(normalized))
  );
}

function isFooter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.includes("datenschutz") || normalized.includes("impressum");
}

function isResultSectionBoundary(value) {
  const normalized = String(value || "").trim().toLowerCase();

  return (
    /^lauf(?:\s+\d+)?\b/.test(normalized) ||
    /^heat(?:\s+\d+)?\b/.test(normalized) ||
    normalized === "läufe" ||
    normalized === "heats" ||
    normalized === "bahn" ||
    normalized === "lane"
  );
}

function getResultColumnType(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "zeit" || normalized === "time") {
    return "time";
  }

  if (
    normalized === "platz" ||
    normalized === "place" ||
    normalized === "rank"
  ) {
    return "place";
  }

  return "";
}

function isRepeatedHeader(first, second, third) {
  const firstValue = String(first || "").trim().toLowerCase();
  const secondValue = String(second || "").trim().toLowerCase();

  return (
    firstValue === "name" &&
    (secondValue === "verein" || secondValue === "club") &&
    Boolean(getResultColumnType(third))
  );
}

function findResultHeader(tokens) {
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (isRepeatedHeader(tokens[index], tokens[index + 1], tokens[index + 2])) {
      return {
        index,
        resultColumnType: getResultColumnType(tokens[index + 2])
      };
    }
  }

  return null;
}

function findResultTitle(tokens, headerIndex) {
  const possibleTitles = tokens.slice(0, headerIndex);

  for (let index = possibleTitles.length - 1; index >= 0; index -= 1) {
    const metadata = parseTitle(possibleTitles[index]);

    if (metadata.ageGroup && metadata.gender && metadata.discipline) {
      return possibleTitles[index];
    }
  }

  for (let windowSize = 2; windowSize <= 5; windowSize += 1) {
    for (
      let index = possibleTitles.length - windowSize;
      index >= 0;
      index -= 1
    ) {
      const candidate = possibleTitles.slice(index, index + windowSize).join(" ");
      const metadata = parseTitle(candidate);

      if (metadata.ageGroup && metadata.gender && metadata.discipline) {
        return candidate;
      }
    }
  }

  return "";
}

function parseResultValue(firstValue, secondValue, resultColumnType) {
  const first = String(firstValue || "").trim();
  const second = String(secondValue || "").trim();

  if (resultColumnType === "place") {
    const placementMatch = first.match(/^(\d+)\.?$/);

    if (placementMatch) {
      return {
        place: Number(placementMatch[1]),
        time: "",
        status: "",
        consumedValues: 1
      };
    }

    if (looksLikeStatus(first)) {
      return {
        place: "",
        time: "",
        status: first,
        consumedValues: 1
      };
    }

    return { place: "", status: "", time: "", consumedValues: 0 };
  }

  if (looksLikeTime(first)) {
    return { place: "", time: first, status: "", consumedValues: 1 };
  }

  const combinedMatch = first.match(
    /^(.+?)\s+(\d{1,3}:\d{2}[,.]\d{2}|-:--[,.]--)$/
  );

  if (combinedMatch && looksLikeStatus(combinedMatch[1])) {
    return {
      place: "",
      status: combinedMatch[1].trim(),
      time: combinedMatch[2].trim(),
      consumedValues: 1
    };
  }

  if (looksLikeStatus(first) && looksLikeTime(second)) {
    return {
      place: "",
      status: first,
      time: second,
      consumedValues: 2
    };
  }

  if (looksLikeStatus(first)) {
    return { place: "", status: first, time: "", consumedValues: 1 };
  }

  return { place: "", status: "", time: "", consumedValues: 0 };
}

function parseResultPage(html, context) {
  const tokens = extractVisibleText(html);
  const resultHeader = findResultHeader(tokens);

  if (!resultHeader) {
    throw new Error("Überschriften Name/Verein/Zeit oder Platz nicht gefunden.");
  }

  const metadata = parseTitle(findResultTitle(tokens, resultHeader.index));
  const results = [];
  let index = resultHeader.index + 3;

  while (index + 2 < tokens.length) {
    const name = tokens[index];
    const club = tokens[index + 1];
    const firstResultValue = tokens[index + 2];
    const secondResultValue = tokens[index + 3] || "";

    if (
      isResultSectionBoundary(name) ||
      isResultSectionBoundary(club) ||
      isResultSectionBoundary(firstResultValue) ||
      isRepeatedHeader(name, club, firstResultValue) ||
      isFooter(name) ||
      isFooter(club) ||
      isFooter(firstResultValue)
    ) {
      break;
    }

    const parsedValue = parseResultValue(
      firstResultValue,
      secondResultValue,
      resultHeader.resultColumnType
    );

    if (parsedValue.consumedValues === 0) {
      break;
    }

    results.push({
      place:
        resultHeader.resultColumnType === "place"
          ? parsedValue.place
          : results.length + 1,
      competitionCode: context.competitionCode,
      competitionName: context.competitionName,
      competitionDate: context.competitionDate,
      ageGroup: metadata.ageGroup,
      gender: metadata.gender,
      discipline: metadata.discipline,
      name,
      club,
      time: parsedValue.time,
      status: parsedValue.status
    });

    index += 2 + parsedValue.consumedValues;
  }

  if (results.length === 0) {
    throw new Error("Keine Ergebniszeilen erkannt.");
  }

  return results;
}

function createCell(row, value, type, className = "") {
  const cell = document.createElement(type);
  const text = value === undefined || value === null ? "" : String(value);
  cell.textContent = text || "-";

  if (!text) {
    cell.classList.add("empty-cell");
  }

  if (className) {
    cell.classList.add(className);
  }

  row.appendChild(cell);
  return cell;
}

function renderTable(results) {
  resultTable.replaceChildren();
  resultTable.className = "";

  const headers = [
    "Platz",
    "Wettkampf",
    "Datum",
    "AK",
    "Gender",
    "Disziplin",
    "Name",
    "Verein",
    "Zeit",
    "DQ / Status"
  ];
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  headers.forEach((header) => createCell(headerRow, header, "th"));
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");

  results.forEach((result) => {
    const row = document.createElement("tr");
    createCell(row, result.place, "td", "number-cell");
    createCell(row, result.competitionName, "td");
    createCell(row, result.competitionDate, "td", "date-cell");
    createCell(row, result.ageGroup, "td");
    createCell(row, result.gender, "td");
    createCell(row, result.discipline, "td");
    createCell(row, result.name, "td");
    createCell(row, result.club, "td");
    createCell(row, result.time, "td", "time-cell");
    createCell(row, result.status, "td", result.status ? "status-cell" : "");
    tbody.appendChild(row);
  });

  resultTable.append(thead, tbody);
}

function isLiveMultiDisciplineData(data) {
  return (
    Array.isArray(data && data.disziplinen) &&
    data.disziplinen
      .map((discipline) => String(discipline || "").trim())
      .filter(Boolean).length > 1
  );
}

function getLiveDisciplines(data) {
  return Array.isArray(data && data.disziplinen)
    ? data.disziplinen
        .map((discipline, index) => ({
          name: String(discipline || "").trim(),
          fieldNumber: index + 1
        }))
        .filter((discipline) => discipline.name)
    : [];
}

function renderLiveMultiDisciplineTable(data, event, context) {
  const rows = Array.isArray(data && data.daten) ? data.daten : [];
  const disciplines = getLiveDisciplines(data);
  resultTable.replaceChildren();
  resultTable.className = "multi-discipline-table";

  const caption = document.createElement("caption");
  caption.textContent = [
    event.ageGroup,
    getGenderLabel(event.gender),
    getDisciplineLabel(event)
  ].filter(Boolean).join(" - ");

  const headers = [
    "Gesamtplatz",
    "Name",
    "Gliederung",
    "Gesamtpunkte",
    "Diff. zu Platz 1",
    ...disciplines.map((discipline) => discipline.name)
  ];
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((header) => createCell(headerRow, header, "th"));
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");

  rows.forEach((sourceRow, index) => {
    const row = document.createElement("tr");
    createCell(
      row,
      sourceRow.platz === undefined || sourceRow.platz === null
        ? ""
        : sourceRow.platz,
      "td",
      "number-cell"
    );
    createCell(
      row,
      String(sourceRow.name || "").trim(),
      "td"
    );
    createCell(row, String(sourceRow.gliederung || "").trim(), "td");
    createCell(row, String(sourceRow.punkte || "").trim(), "td", "number-cell");
    createCell(row, String(sourceRow.diff || "").trim(), "td", "number-cell");

    disciplines.forEach((discipline) => {
      const rawTime =
        String(sourceRow[`zeit ${discipline.fieldNumber}`] || "").trim();
      const points =
        String(sourceRow[`punkte ${discipline.fieldNumber}`] || "").trim();
      const penalty =
        String(sourceRow[`strafe ${discipline.fieldNumber}`] || "").trim();
      row.appendChild(createLiveDisciplineCell(rawTime, points, penalty));
    });

    tbody.appendChild(row);
  });

  resultTable.append(caption, thead, tbody);
}

function createLiveDisciplineCell(rawTime, points, penalty) {
  const cell = document.createElement("td");
  const cleanTime = String(rawTime || "").trim();
  const cleanPoints = String(points || "").trim();
  const cleanPenalty = String(penalty || "").trim();

  cell.className = "multi-discipline-cell";

  if (!cleanTime && !cleanPoints && !cleanPenalty) {
    cell.classList.add("empty-cell");
    cell.textContent = "-";
    return cell;
  }

  if (cleanTime) {
    const timeLine = document.createElement("span");
    timeLine.className = "discipline-time";
    timeLine.textContent = cleanTime;
    cell.appendChild(timeLine);
  }

  if (cleanPoints) {
    const pointsLine = document.createElement("span");
    pointsLine.className = "discipline-points";
    pointsLine.textContent = `${cleanPoints} Punkte`;
    cell.appendChild(pointsLine);
  }

  if (cleanPenalty) {
    const penaltyLine = document.createElement("span");
    penaltyLine.className = "discipline-status";
    penaltyLine.textContent = `DQ / Status: ${cleanPenalty}`;
    cell.appendChild(penaltyLine);
  }

  return cell;
}

function getDisciplineLabel(event) {
  if (event.round && event.round !== "Ergebnis") {
    return `${event.discipline} - ${event.round}`;
  }

  return event.discipline;
}

function getCatalogCompetitionDate() {
  if (!currentCatalog) {
    return "";
  }

  return formatIsoDate(currentCatalog.till || currentCatalog.from);
}

function normalizeLiveResultRows(data, event, context) {
  const rows = Array.isArray(data && data.daten) ? data.daten : [];
  const disciplines = Array.isArray(data && data.disziplinen)
    ? data.disziplinen
        .map((discipline) => String(discipline || "").trim())
        .filter(Boolean)
    : [];

  if (disciplines.length > 1) {
    return normalizeLiveMultiDisciplineRows(rows, disciplines, event, context);
  }

  return rows.map((row, index) => {
    const rawTime = String(row["zeit 1"] || "").trim();
    const penalty = String(row["strafe 1"] || "").trim();
    const hasTime = looksLikeTime(rawTime);
    const statusParts = [];

    if (penalty) {
      statusParts.push(penalty);
    }

    if (rawTime && !hasTime) {
      statusParts.push(rawTime);
    }

    return {
      place: row.platz === undefined || row.platz === null
        ? index + 1
        : row.platz,
      competitionCode: context.competitionCode,
      competitionName: context.competitionName,
      competitionDate: context.competitionDate,
      ageGroup: event.ageGroup,
      gender: event.gender,
      discipline: getDisciplineLabel(event),
      name: String(row.name || "")
        .replace(/\s+\(\d{2,4}\)\s*$/, "")
        .trim(),
      club: String(row.gliederung || "").trim(),
      time: hasTime ? rawTime : "",
      status: statusParts.join(" / ")
    };
  });
}

function normalizeLiveMultiDisciplineRows(rows, disciplines, event, context) {
  const output = [];

  rows.forEach((row, index) => {
    const baseResult = {
      competitionCode: context.competitionCode,
      competitionName: context.competitionName,
      competitionDate: context.competitionDate,
      ageGroup: event.ageGroup,
      gender: event.gender,
      name: String(row.name || "")
        .replace(/\s+\(\d{2,4}\)\s*$/, "")
        .trim(),
      club: String(row.gliederung || "").trim()
    };
    const totalStatus = formatPointsStatus(row.punkte, row.diff);

    if (totalStatus || row.platz !== undefined) {
      output.push({
        ...baseResult,
        place: row.platz === undefined || row.platz === null
          ? index + 1
          : row.platz,
        discipline: getDisciplineLabel(event),
        time: "",
        status: totalStatus
      });
    }

    disciplines.forEach((discipline, disciplineIndex) => {
      const fieldNumber = disciplineIndex + 1;
      const rawTime = String(row[`zeit ${fieldNumber}`] || "").trim();
      const points = String(row[`punkte ${fieldNumber}`] || "").trim();
      const penalty = String(row[`strafe ${fieldNumber}`] || "").trim();
      const status = formatDisciplineStatus(rawTime, points, penalty);

      if (!rawTime && !points && !penalty) {
        return;
      }

      output.push({
        ...baseResult,
        place: "",
        discipline,
        time: looksLikeTime(rawTime) ? rawTime : "",
        status
      });
    });
  });

  return output;
}

function formatPointsStatus(points, diff) {
  const cleanPoints = String(points || "").trim();
  const cleanDiff = String(diff || "").trim();

  if (!cleanPoints && !cleanDiff) {
    return "";
  }

  return [
    cleanPoints ? `${cleanPoints} Punkte` : "",
    cleanDiff ? `Diff. ${cleanDiff}` : ""
  ].filter(Boolean).join(" / ");
}

function formatDisciplineStatus(rawTime, points, penalty) {
  const statusParts = [];
  const cleanTime = String(rawTime || "").trim();
  const cleanPoints = String(points || "").trim();
  const cleanPenalty = String(penalty || "").trim();

  if (cleanPoints) {
    statusParts.push(`${cleanPoints} Punkte`);
  }

  if (cleanPenalty) {
    statusParts.push(`Strafe: ${cleanPenalty}`);
  }

  if (cleanTime && !looksLikeTime(cleanTime)) {
    statusParts.push(cleanTime);
  }

  return statusParts.join(" / ");
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function getRoundLabel(event) {
  return event.round || "Ergebnis";
}

function getSourceLabel(source) {
  return source === "live" ? "DLRG.net" : "competition.net";
}

function getSourceId(event) {
  if (event.source === "live") {
    return `${event.edvnummer}:${event.wkid}`;
  }

  return event.uuid || "";
}

function getBaseDisciplineLabel(event) {
  return event.discipline || "Gesamtwertung";
}

function parseBirthYearFromName(value) {
  const text = String(value || "").trim();
  const match = text.match(/\((\d{2}|\d{4})\)\s*$/);

  if (!match) {
    return {
      name: text,
      birthYear: ""
    };
  }

  const rawYear = match[1];
  let birthYear = rawYear;

  if (rawYear.length === 2) {
    const currentTwoDigitYear = Number(getCurrentYear().slice(2));
    const year = Number(rawYear);
    birthYear = String((year <= currentTwoDigitYear ? 2000 : 1900) + year);
  }

  return {
    name: text.replace(/\s+\(\d{2,4}\)\s*$/, "").trim(),
    birthYear
  };
}

function createCompetitionExportRows(result, event, context) {
  return parseResultPage(result.html, context).map((row) => ({
    "Quelle": "competition.net",
    "Typ": getEventTypeLabel(event.eventType),
    "Runde": getRoundLabel(event),
    "Platz": row.place,
    "Wettkampfcode": context.competitionCode,
    "Wettkampf": context.competitionName,
    "Datum": context.competitionDate,
    "AK": event.ageGroup || row.ageGroup,
    "Gender": getGenderLabel(event.gender || row.gender),
    "Disziplin": getBaseDisciplineLabel(event) || row.discipline,
    "Name": row.name,
    "Geburtsjahr": "",
    "Verein": row.club,
    "Zeit": row.time,
    "DQ / Status": row.status,
    "Quelle-ID": getSourceId(event)
  }));
}

function createLiveBaseExportRow(event, context, sourceRow, index) {
  const athlete = parseBirthYearFromName(sourceRow.name);

  return {
    "Quelle": "DLRG.net",
    "Typ": getEventTypeLabel(event.eventType),
    "Runde": getRoundLabel(event),
    "Wettkampfcode": context.competitionCode,
    "Wettkampf": context.competitionName,
    "Datum": context.competitionDate,
    "AK": event.ageGroup,
    "Gender": getGenderLabel(event.gender),
    "Gesamtplatz":
      sourceRow.platz === undefined || sourceRow.platz === null
        ? index + 1
        : sourceRow.platz,
    "Name": athlete.name,
    "Geburtsjahr": athlete.birthYear,
    "Gliederung": String(sourceRow.gliederung || "").trim(),
    "Gesamtpunkte": "",
    "Diff. zu Platz 1": "",
    "Quelle-ID": getSourceId(event)
  };
}

function addLiveDisciplineColumns(target, disciplineName, rawTime, points, penalty) {
  const cleanName = String(disciplineName || "Disziplin").trim();
  const cleanTime = String(rawTime || "").trim();
  const cleanPoints = String(points || "").trim();
  const cleanPenalty = String(penalty || "").trim();
  const statusParts = [];

  if (cleanPenalty) {
    statusParts.push(cleanPenalty);
  }

  if (cleanTime && !looksLikeTime(cleanTime)) {
    statusParts.push(cleanTime);
  }

  target[`${cleanName} Zeit`] = looksLikeTime(cleanTime) ? cleanTime : "";
  target[`${cleanName} Punkte`] = cleanPoints;
  target[`${cleanName} DQ / Status`] = statusParts.join(" / ");
}

function createLiveMultiDisciplineExportRows(data, event, context) {
  const rows = Array.isArray(data && data.daten) ? data.daten : [];
  const disciplines = getLiveDisciplines(data);

  return rows.map((sourceRow, index) => {
    const row = createLiveBaseExportRow(event, context, sourceRow, index);
    row["Gesamtpunkte"] = String(sourceRow.punkte || "").trim();
    row["Diff. zu Platz 1"] = String(sourceRow.diff || "").trim();

    disciplines.forEach((discipline) => {
      addLiveDisciplineColumns(
        row,
        discipline.name,
        sourceRow[`zeit ${discipline.fieldNumber}`],
        sourceRow[`punkte ${discipline.fieldNumber}`],
        sourceRow[`strafe ${discipline.fieldNumber}`]
      );
    });

    return row;
  });
}

function createLiveSingleDisciplineExportRows(data, event, context) {
  const rows = Array.isArray(data && data.daten) ? data.daten : [];
  const discipline =
    getLiveDisciplines(data)[0] || {
      name: getBaseDisciplineLabel(event),
      fieldNumber: 1
    };

  return rows.map((sourceRow, index) => {
    const row = createLiveBaseExportRow(event, context, sourceRow, index);
    addLiveDisciplineColumns(
      row,
      discipline.name,
      sourceRow[`zeit ${discipline.fieldNumber}`],
      sourceRow[`punkte ${discipline.fieldNumber}`],
      sourceRow[`strafe ${discipline.fieldNumber}`]
    );
    return row;
  });
}

function createLiveExportRows(result, event, context) {
  return isLiveMultiDisciplineData(result.data)
    ? createLiveMultiDisciplineExportRows(result.data, event, context)
    : createLiveSingleDisciplineExportRows(result.data, event, context);
}

function getSheetKey(source, eventType) {
  return `${source}:${eventType}`;
}

function getSheetName(source, eventType) {
  const sourceLabel = source === "live" ? "DLRG.net" : "Competition.net";
  return `${sourceLabel} ${getEventTypeLabel(eventType)}`;
}

function addExportRows(sheetGroups, source, eventType, rows) {
  if (rows.length === 0) {
    return;
  }

  const key = getSheetKey(source, eventType);

  if (!sheetGroups.has(key)) {
    sheetGroups.set(key, {
      source,
      eventType,
      name: getSheetName(source, eventType),
      rows: []
    });
  }

  sheetGroups.get(key).rows.push(...rows);
}

function normalizeSelectionResultForExport(result, event, context) {
  if (result.error) {
    throw new Error(result.error);
  }

  return result.source === "live"
    ? createLiveExportRows(result, event, context)
    : createCompetitionExportRows(result, event, context);
}

async function collectExportSheets() {
  const events = Array.isArray(currentCatalog && currentCatalog.events)
    ? currentCatalog.events
    : [];
  const competitionCode = getSelectedCompetitionCode();
  const context = {
    competitionCode,
    competitionName: currentCatalog.competitionName || competitionCode,
    competitionDate: getCatalogCompetitionDate()
  };
  const sheetGroups = new Map();
  const errors = [];
  let processedEvents = 0;
  let rowCount = 0;

  for (const eventBatch of chunkArray(events, EXPORT_BATCH_SIZE)) {
    const response = await fetchJson(
      buildWorkerUrl(competitionCode, { mode: "selection" }),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          items: eventBatch.map(createSelectionRequestItem)
        })
      }
    );
    const responses = Array.isArray(response.results) ? response.results : [];
    const eventsByKey = new Map(eventBatch.map((event) => [event.key, event]));

    responses.forEach((result) => {
      const event = eventsByKey.get(result.key);

      if (!event) {
        errors.push(`${result.key}: Ergebnisliste ist nicht im Katalog.`);
        return;
      }

      try {
        const rows = normalizeSelectionResultForExport(result, event, context);
        addExportRows(sheetGroups, event.source, event.eventType, rows);
        rowCount += rows.length;
      } catch (error) {
        errors.push(`${getDisciplineLabel(event)}: ${error.message}`);
      }
    });

    processedEvents += eventBatch.length;
    statusElement.textContent =
      `${processedEvents} von ${events.length} Ergebnislisten für Excel verarbeitet ...`;
  }

  return {
    sheets: Array.from(sheetGroups.values()),
    errors,
    rowCount,
    dataSignature: createDataSignature(Array.from(sheetGroups.values()))
  };
}

const COMPETITION_EXPORT_HEADERS = [
  "Quelle",
  "Typ",
  "Runde",
  "Platz",
  "Wettkampfcode",
  "Wettkampf",
  "Datum",
  "AK",
  "Gender",
  "Disziplin",
  "Name",
  "Geburtsjahr",
  "Verein",
  "Zeit",
  "DQ / Status",
  "Quelle-ID"
];
const LIVE_EXPORT_BASE_HEADERS = [
  "Quelle",
  "Typ",
  "Runde",
  "Wettkampfcode",
  "Wettkampf",
  "Datum",
  "AK",
  "Gender",
  "Gesamtplatz",
  "Name",
  "Geburtsjahr",
  "Gliederung",
  "Gesamtpunkte",
  "Diff. zu Platz 1",
  "Quelle-ID"
];

function getSheetHeaders(sheet) {
  if (sheet.source === "competition") {
    return COMPETITION_EXPORT_HEADERS;
  }

  const headers = [...LIVE_EXPORT_BASE_HEADERS];
  const seen = new Set(headers);

  sheet.rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    });
  });

  return headers;
}

function escapeXml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeWorksheetName(name, usedNames) {
  const base = String(name || "Tabelle")
    .replace(/[\\/?*[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31) || "Tabelle";
  let candidate = base;
  let counter = 2;

  while (usedNames.has(candidate)) {
    const suffix = ` ${counter}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function createCellXml(value, styleId = "") {
  const styleAttribute = styleId ? ` ss:StyleID="${styleId}"` : "";
  return `<Cell${styleAttribute}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function createWorksheetXml(sheet, usedNames) {
  const name = sanitizeWorksheetName(sheet.name, usedNames);
  const headers = getSheetHeaders(sheet);
  const headerRow =
    "<Row>" +
    headers.map((header) => createCellXml(header, "Header")).join("") +
    "</Row>";
  const dataRows = sheet.rows
    .map((row) =>
      "<Row>" +
      headers.map((header) => createCellXml(row[header])).join("") +
      "</Row>"
    )
    .join("");

  return (
    `<Worksheet ss:Name="${escapeXml(name)}">` +
    `<Table>${headerRow}${dataRows}</Table>` +
    "</Worksheet>"
  );
}

function createWorkbookXml(sheets) {
  const usedNames = new Set();
  const worksheets = sheets
    .filter((sheet) => sheet.rows.length > 0)
    .map((sheet) => createWorksheetXml(sheet, usedNames))
    .join("");

  if (!worksheets) {
    throw new Error("Es wurden keine exportierbaren Ergebniszeilen gefunden.");
  }

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:html="http://www.w3.org/TR/REC-html40">' +
    "<Styles>" +
    '<Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style>' +
    "</Styles>" +
    worksheets +
    "</Workbook>"
  );
}

function createExportFilename() {
  const code = getSelectedCompetitionCode();
  const date = currentCatalog && (currentCatalog.from || currentCatalog.till)
    ? currentCatalog.from || currentCatalog.till
    : new Date().toISOString().slice(0, 10);
  return `${slugifyFilename(`${date}_${code}_${currentCatalog.competitionName}`)}.xls`;
}

function createExportLogRecord(excelFile, rowCount, dataSignature) {
  const code = normalizeCompetitionCode(getSelectedCompetitionCode());
  const catalogSignature = createCatalogSignature(currentCatalog);

  return {
    exported_at: new Date().toISOString(),
    competition_code: code,
    competition_name: currentCatalog.competitionName || code,
    from: currentCatalog.from || "",
    till: currentCatalog.till || "",
    source: currentCatalog.source || "",
    event_count: String((currentCatalog.events || []).length),
    row_count: String(rowCount),
    catalog_signature: catalogSignature,
    data_signature: dataSignature,
    stale_reason: "",
    excel_file: excelFile
  };
}

function createSelectionRequestItem(event) {
  if (event.source === "competition") {
    return {
      key: event.key,
      source: event.source,
      uuid: event.uuid
    };
  }

  return {
    key: event.key,
    source: event.source,
    edvnummer: event.edvnummer,
    wkid: event.wkid,
    ak: event.ak
  };
}

async function loadSelectedResults(selectedEvents, choiceId) {
  const competitionCode = getSelectedCompetitionCode();

  if (!currentCatalog || selectedEvents.length === 0) {
    statusElement.className = "status error";
    statusElement.textContent = "Für diese Auswahl sind keine Ergebnisse vorhanden.";
    return;
  }

  activeChoiceId = choiceId;
  resultCatalog.querySelectorAll(".result-choice-button").forEach((button) => {
    button.classList.toggle(
      "is-selected",
      button.dataset.choiceId === activeChoiceId
    );
  });
  competitionSelect.disabled = true;
  competitionInput.disabled = true;
  setCatalogButtonsDisabled(true);
  currentResults = [];
  resultTable.replaceChildren();
  errorDetails.hidden = true;
  errorOutput.textContent = "";
  statusElement.className = "status";
  statusElement.textContent =
    `${selectedEvents.length} ausgewählte Ergebnislisten werden geladen ...`;

  try {
    const response = await fetchJson(
      buildWorkerUrl(competitionCode, { mode: "selection" }),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          items: selectedEvents.map(createSelectionRequestItem)
        })
      }
    );
    const responses = Array.isArray(response.results) ? response.results : [];
    const eventsByKey = new Map(
      selectedEvents.map((event) => [event.key, event])
    );
    const context = {
      competitionCode,
      competitionName: currentCatalog.competitionName || competitionCode,
      competitionDate: getCatalogCompetitionDate()
    };
    const errors = [];
    const multiDisciplineTables = [];
    const resultGroups = responses.map((result) => {
      const event = eventsByKey.get(result.key);

      if (!event) {
        errors.push(`${result.key}: Ergebnisliste ist nicht im Katalog.`);
        return [];
      }

      if (result.error) {
        errors.push(`${getDisciplineLabel(event)}: ${result.error}`);
        return [];
      }

      try {
        if (result.source === "live") {
          if (isLiveMultiDisciplineData(result.data)) {
            multiDisciplineTables.push({
              data: result.data,
              event,
              context
            });
            return [];
          }

          const rows = normalizeLiveResultRows(result.data, event, context);

          if (rows.length === 0) {
            throw new Error("Keine Ergebniszeilen vorhanden.");
          }

          return rows;
        }

        return parseResultPage(result.html, context).map((row) => ({
          ...row,
          ageGroup: event.ageGroup || row.ageGroup,
          gender: event.gender || row.gender,
          discipline: getDisciplineLabel(event) || row.discipline
        }));
      } catch (error) {
        errors.push(`${getDisciplineLabel(event)}: ${error.message}`);
        return [];
      }
    });

    currentResults = resultGroups.flat();
    const hasMultiDisciplineTable = multiDisciplineTables.length > 0;

    if (hasMultiDisciplineTable) {
      const table = multiDisciplineTables[0];
      renderLiveMultiDisciplineTable(table.data, table.event, table.context);

      if (multiDisciplineTables.length > 1 || currentResults.length > 0) {
        errors.push(
          "Diese Auswahl enthÃ¤lt mehrere Tabellenformate. Angezeigt wird die erste Mehrkampf-Tabelle."
        );
      }
    } else {
      renderTable(currentResults);
    }

    let statusText =
      `${selectedEvents.length} Ergebnislisten verarbeitet, `;

    if (hasMultiDisciplineTable) {
      const visibleRows = Array.isArray(multiDisciplineTables[0].data.daten)
        ? multiDisciplineTables[0].data.daten.length
        : 0;
      statusText += `${visibleRows} Mehrkampfzeilen angezeigt`;
    } else {
      statusText += `${currentResults.length} Ergebniszeilen geladen`;
    }

    if (errors.length > 0) {
      statusText += `, ${errors.length} Ergebnislisten übersprungen`;
      errorDetails.hidden = false;
      errorOutput.textContent = errors.join("\n");
    }

    statusElement.textContent = `${statusText}.`;
  } catch (error) {
    console.error(error);
    currentResults = [];
    statusElement.className = "status error";
    statusElement.textContent = `Fehler: ${error.message}`;
  } finally {
    competitionSelect.disabled = false;
    competitionInput.disabled = false;
    setCatalogButtonsDisabled(false);
  }
}

async function exportCurrentCompetition() {
  if (!currentCatalog || !Array.isArray(currentCatalog.events)) {
    statusElement.className = "status error";
    statusElement.textContent = "Bitte zuerst einen Wettkampf auswählen.";
    return;
  }

  if (currentCatalog.events.length === 0) {
    statusElement.className = "status error";
    statusElement.textContent = "Für diesen Wettkampf gibt es keine exportierbaren Ergebnislisten.";
    return;
  }

  isExporting = true;
  competitionSelect.disabled = true;
  competitionInput.disabled = true;
  setCatalogButtonsDisabled(true);
  setExportControlsReady(true);
  statusElement.className = "status";
  statusElement.textContent = "Excel-Export wird vorbereitet ...";

  try {
    await loadExportLog();
    const exportData = await collectExportSheets();
    const workbookXml = createWorkbookXml(exportData.sheets);
    const excelFile = createExportFilename();

    downloadTextFile(
      workbookXml,
      excelFile,
      "application/vnd.ms-excel;charset=utf-8"
    );

    const record = createExportLogRecord(
      excelFile,
      exportData.rowCount,
      exportData.dataSignature
    );
    mergeExportRecords([record]);
    exportStateOverrides.set(record.competition_code, "current");
    writeStoredExportRecords();
    refreshCompetitionOptions();
    setExportControlsReady(true);

    window.setTimeout(() => {
      downloadTextFile(
        createExportLogCsv(),
        EXPORT_LOG_FILENAME,
        "text/csv;charset=utf-8"
      );
    }, 250);

    statusElement.textContent =
      `${exportData.rowCount} Zeilen als Excel exportiert. ` +
      "Die aktualisierte CSV-Exportliste wird zusätzlich heruntergeladen.";

    if (exportData.errors.length > 0) {
      statusElement.textContent +=
        ` ${exportData.errors.length} Ergebnislisten wurden übersprungen.`;
      errorDetails.hidden = false;
      errorOutput.textContent = exportData.errors.join("\n");
    }
  } catch (error) {
    console.error(error);
    statusElement.className = "status error";
    statusElement.textContent = `Excel-Export fehlgeschlagen: ${error.message}`;
  } finally {
    isExporting = false;
    competitionSelect.disabled = false;
    competitionInput.disabled = false;
    setCatalogButtonsDisabled(false);
    setExportControlsReady(Boolean(currentCatalog));
  }
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (passwordInput.value === getExpectedPassword()) {
    loginError.textContent = "";
    loginForm.reset();
    unlockApp();
    return;
  }

  loginError.textContent = "Das Passwort ist nicht korrekt.";
  passwordInput.select();
});

logoutButton.addEventListener("click", lockApp);
competitionSelect.addEventListener("change", () => {
  setCompetitionControlsEnabled();

  if (competitionSelect.value === "__manual__") {
    resetResultSelection();
    competitionInput.focus();
  } else if (competitionSelect.value) {
    loadResultCatalog();
  } else {
    resetResultSelection();
  }
});
competitionInput.addEventListener("input", () => {
  setCompetitionControlsEnabled();
  resetResultSelection();
});
reloadCompetitionListButton.addEventListener("click", loadCompetitionList);
excelExportButton.addEventListener("click", exportCurrentCompetition);
competitionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadResultCatalog();
  }
});
resultTabs.addEventListener("click", (event) => {
  const tab = event.target.closest(".result-tab");

  if (tab && currentCatalog) {
    setActiveEventType(tab.dataset.eventType);
  }
});
resultCatalog.addEventListener("click", (event) => {
  const button = event.target.closest(".result-choice-button");

  if (!button || button.disabled) {
    return;
  }

  const selectedEvents = catalogChoiceEvents.get(button.dataset.choiceId) || [];
  loadSelectedResults(selectedEvents, button.dataset.choiceId);
});

initializeAuthentication();
