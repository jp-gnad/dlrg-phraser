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
const JRP_LV_RATING_CODES = new Set(["JRP2025", "JRP2026"]);
const JRP_RANK_POINTS = [
  20, 18, 16, 14, 13, 12, 11, 10, 8, 7, 6, 5, 4, 3, 2, 1
];
const JRP_OPEN_WATER_DISCIPLINES = new Set([
  "beach flags",
  "beach sprint",
  "board race",
  "oceanwoman oceanman",
  "oceanwoman",
  "oceanman",
  "surf race",
  "surf ski race"
]);
const JRP_POOL_DISCIPLINES = new Set([
  "manikin carry",
  "manikin carry with fins",
  "manikin tow with fins",
  "obstacle swim",
  "rescue medley",
  "super lifesaver"
]);
const JRP_POOL_TEAM_DISCIPLINES = new Set([
  "line throw",
  "manikin relay",
  "medley relay",
  "obstacle relay"
]);
const JRP_BEACH_TEAM_DISCIPLINES = new Set([
  "beach sprint relay",
  "board rescue",
  "ocean relay",
  "rescue tube rescue"
]);
const JRP_POOL_MIXED_DISCIPLINES = new Set([
  "mixed pool lifesaver relay"
]);
const JRP_BEACH_MIXED_DISCIPLINES = new Set([
  "mixed ocean lifesaver relay"
]);
const JRP_KNOWN_LV_RATINGS = {
  JRP2025: [
    ["Westfalen", 744, 33, 72, 20, 60, 72, 20, 217, 250],
    ["Nordrhein", 611, 64, 50, 13, 71, 53, 18, 237, 105],
    ["Sachsen-Anhalt", 601, 52, 55, 16, 45, 66, 16, 124, 227],
    ["Rheinland-Pfalz", 545, 56, 30, 14, 68, 43, 14, 193, 127],
    ["Brandenburg", 454, 42, 68, 18, 46, 32, 7, 97, 144],
    ["Bayern", 429, 46, 0, 0, 45, 11, 8, 246, 73],
    ["Niedersachsen", 380, 55, 43, 0, 56, 34, 13, 114, 65],
    ["Württemberg", 369, 22, 54, 12, 37, 44, 11, 4, 185],
    ["Schleswig-Holstein", 339, 45, 22, 11, 49, 40, 12, 102, 58],
    ["Berlin", 274, 0, 61, 0, 6, 47, 10, 21, 129],
    ["Hessen", 268, 33, 34, 0, 25, 45, 6, 41, 84],
    ["Sachsen", 192, 28, 34, 10, 18, 43, 5, 5, 49],
    ["Saar", 164, 29, 18, 0, 19, 5, 0, 71, 22],
    ["Bremen", 0, 0, 0, 0, 0, 0, 0, 0, 0]
  ]
};

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
const sourceIndicators = document.getElementById("sourceIndicators");
const competitionNetLink = document.getElementById("competitionNetLink");
const liveSourceLinks = document.getElementById("liveSourceLinks");
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

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/\//g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isJrpLvRatingCompetition(code) {
  return JRP_LV_RATING_CODES.has(normalizeCompetitionCode(code));
}

function isJrpCountableRound(event) {
  const round = String(event && event.round || "").trim();

  return /^Finale(?:\s+\d+)?$/.test(round) || round === "Ergebnis";
}

function getJrpIndividualDisciplineType(discipline) {
  const normalized = normalizeLookupText(discipline);

  if (JRP_POOL_DISCIPLINES.has(normalized)) {
    return "pool";
  }

  if (JRP_OPEN_WATER_DISCIPLINES.has(normalized)) {
    return "openWater";
  }

  return "";
}

function getJrpRankPoints(place) {
  const numericPlace = Number(place);

  if (!Number.isInteger(numericPlace) || numericPlace < 1) {
    return 0;
  }

  return JRP_RANK_POINTS[numericPlace - 1] || 0;
}

function getJrpFinalPlaceOffset(event, rows) {
  const roundMatch = String(event && event.round || "").match(
    /^Finale\s+(\d+)$/
  );
  const finalNumber = roundMatch ? Number(roundMatch[1]) : 1;

  if (!Number.isInteger(finalNumber) || finalNumber <= 1) {
    return 0;
  }

  const numericPlaces = rows
    .map((row) => Number(row.place))
    .filter((place) => Number.isInteger(place) && place > 0);

  if (
    numericPlaces.length > 0 &&
    Math.max(...numericPlaces) > (finalNumber - 1) * 8
  ) {
    return 0;
  }

  return (finalNumber - 1) * 8;
}

function isJrpLvRatingSourceEvent(event) {
  if (
    !event ||
    event.placeholder ||
    event.source === "computed" ||
    event.eventType === "LvRating" ||
    !isJrpCountableRound(event)
  ) {
    return false;
  }

  if (event.eventType === "Team") {
    return true;
  }

  return (
    event.eventType === "Individual" &&
    Boolean(getJrpIndividualDisciplineType(event.discipline))
  );
}

function getJrpLvRatingSourceEvents(catalog) {
  return Array.isArray(catalog && catalog.events)
    ? catalog.events.filter(isJrpLvRatingSourceEvent)
    : [];
}

function createJrpLvRatingEvent(code, placeholder) {
  const competitionCode = normalizeCompetitionCode(code);

  return {
    key: `computed:${competitionCode}:lv-rating`,
    source: "computed",
    computedType: "jrp-lv-rating",
    competition: competitionCode,
    eventType: "LvRating",
    discipline: "LV-Wertung",
    gender: "mixed",
    ageGroup: "LV-Wertung",
    round: "Ergebnis",
    date: "",
    placeholder
  };
}

function ensureComputedCatalogEvents(catalog, competitionCode) {
  if (!catalog || !Array.isArray(catalog.events)) {
    return catalog;
  }

  if (!isJrpLvRatingCompetition(competitionCode)) {
    return catalog;
  }

  const sourceEvents = getJrpLvRatingSourceEvents(catalog);
  const eventsWithoutOldLvRating = catalog.events.filter(
    (event) => event.eventType !== "LvRating"
  );

  return {
    ...catalog,
    events: [
      ...eventsWithoutOldLvRating,
      createJrpLvRatingEvent(competitionCode, sourceEvents.length === 0)
    ]
  };
}

function createJrpFallbackCatalog(competitionCode) {
  const code = normalizeCompetitionCode(competitionCode);
  const listEntry = findCompetitionListEntry(code);

  return ensureComputedCatalogEvents(
    {
      competition: code,
      competitionName:
        (listEntry && listEntry.name) || "Junioren Rettungspokal",
      from: (listEntry && listEntry.from) || "",
      till: (listEntry && listEntry.till) || "",
      source: "competition",
      warning: "Aktuell wurden noch keine Ergebnislisten gefunden.",
      count: 0,
      events: []
    },
    code
  );
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
  updateSourceIndicators();
}

function updateSelectedCompetitionExportState() {
  competitionSelect.classList.remove("is-exported");
}

function findCompetitionListEntry(code) {
  const normalizedCode = String(code || "").toUpperCase();
  return competitionListCache.find(
    (competition) => String(competition.acronym || "").toUpperCase() === normalizedCode
  );
}

function getSourceAvailabilityFromCatalog(catalog) {
  const source = String(catalog && catalog.source || "");

  return {
    competition: source === "competition" || source === "mixed",
    live: source === "live" || source === "mixed"
  };
}

function getSourceAvailability(code) {
  if (
    currentCatalog &&
    String(currentCatalog.competition || "").toUpperCase() ===
      String(code || "").toUpperCase()
  ) {
    return getSourceAvailabilityFromCatalog(currentCatalog);
  }

  const competition = findCompetitionListEntry(code);
  const sources = competition && competition.sources;

  if (sources && typeof sources === "object") {
    return {
      competition: Boolean(sources.competition),
      live: Boolean(sources.live)
    };
  }

  return {
    competition: false,
    live: false
  };
}

function hasAnySourceAvailability(availability) {
  return Boolean(availability.competition || availability.live);
}

function getAttemptedSourceAvailability(code) {
  const availability = getSourceAvailability(code);

  if (hasAnySourceAvailability(availability)) {
    return availability;
  }

  return {
    competition: Boolean(code),
    live: false
  };
}

function updateSourceIndicators(options = {}) {
  const code = getSelectedCompetitionCode();
  const availability = options.availability || getSourceAvailability(code);
  const attempted = Boolean(options.attempted);
  const hasSelection = Boolean(code);
  const showCompetitionLink = hasSelection && Boolean(availability.competition);

  sourceIndicators
    .querySelectorAll("[data-source-indicator]")
    .forEach((indicator) => {
      const source = indicator.dataset.sourceIndicator;
      const isAvailable = hasSelection && Boolean(availability[source]);
      indicator.classList.toggle("is-available", isAvailable && !attempted);
      indicator.classList.toggle("is-attempted", isAvailable && attempted);
      indicator.classList.toggle("is-unavailable", hasSelection && !isAvailable);
    });

  competitionNetLink.hidden = !showCompetitionLink;
  competitionNetLink.href = showCompetitionLink
    ? `https://competition.dlrg.net/de/competitions/${encodeURIComponent(code)}/results`
    : "#";
  updateLiveSourceLinks();
}

function getLiveSourceReferences() {
  if (!currentCatalog || !Array.isArray(currentCatalog.events)) {
    return [];
  }

  const references = new Map();

  currentCatalog.events.forEach((event) => {
    if (event.source !== "live" || !event.edvnummer || !event.wkid) {
      return;
    }

    const key = `${event.edvnummer}:${event.wkid}`;
    references.set(key, {
      edvnummer: event.edvnummer,
      wkid: event.wkid
    });
  });

  return Array.from(references.values()).sort((left, right) => {
    const wkidDifference = Number(left.wkid) - Number(right.wkid);
    return wkidDifference ||
      String(left.edvnummer).localeCompare(String(right.edvnummer), "de");
  });
}

function updateLiveSourceLinks() {
  const references = getLiveSourceReferences();

  liveSourceLinks.replaceChildren();
  liveSourceLinks.hidden = references.length === 0;

  references.forEach((reference) => {
    const link = document.createElement("a");
    const url = new URL("live-check.html", window.location.href);
    url.searchParams.set("edvnummer", reference.edvnummer);
    url.searchParams.set("wkid", reference.wkid);

    link.className = "live-source-link";
    link.href = url.toString();
    link.textContent = `${reference.edvnummer}:${reference.wkid}`;
    link.title = "Im Live-ID-Prüfer öffnen";
    liveSourceLinks.appendChild(link);
  });
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
  const hasExportableEvents =
    Boolean(currentCatalog) &&
    Array.isArray(currentCatalog.events) &&
    currentCatalog.events.some((event) => !event.placeholder);
  const canExport = isReady && hasExportableEvents;

  exportActions.hidden = !isReady;
  excelExportButton.disabled = !canExport || isExporting;
  updateExportInfo();
}

function updateExportInfo() {
  if (!currentCatalog) {
    exportInfo.textContent = "";
    return;
  }

  const code = getSelectedCompetitionCode();
  const state = getExportState(code);

  if (
    Array.isArray(currentCatalog.events) &&
    !currentCatalog.events.some((event) => !event.placeholder)
  ) {
    exportInfo.textContent =
      "Dieser Wettkampf hat aktuell nur vorgemerkte Kategorien ohne Ergebnislisten.";
    return;
  }

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

const EVENT_TYPE_LABELS = {
  Individual: "Einzel",
  Team: "Mannschaft",
  LvRating: "LV-Wertung"
};

function getEventTypeLabel(value) {
  return EVENT_TYPE_LABELS[value] || String(value || "Ergebnis");
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

  const finalMatch = String(value || "").match(/^Finale\s+(\d+)$/);

  if (finalMatch) {
    return 10000 + Number(finalMatch[1]);
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
    button.disabled = disabled || button.dataset.placeholder === "true";
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
                button.dataset.placeholder = String(roundEvents.every(
                  (event) => event.placeholder
                ));
                button.disabled = button.dataset.placeholder === "true";
                button.setAttribute(
                  "aria-label",
                  `${discipline}, ${ageGroup}, ${getGenderLabel(gender)}, ${round}`
                );
                label.textContent = getGenderLabel(gender);
                roundLabel.textContent = button.disabled
                  ? "noch keine Ergebnisliste"
                  : round;
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

  const realEvents = events.filter((event) => !event.placeholder);
  const placeholderEvents = events.length - realEvents.length;

  if (activeEventType === "LvRating") {
    selectionInfo.textContent =
      `${realEvents.length} Wertungskategorie berechenbar`;
  } else {
    selectionInfo.textContent =
      `${realEvents.length} ${getEventTypeLabel(activeEventType)}-Ergebnislisten`;
  }

  if (placeholderEvents > 0) {
    selectionInfo.textContent += `, ${placeholderEvents} vorgemerkt`;
  }
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
  const eventTypes = ["Individual", "Team", "LvRating"].filter((eventType) =>
    catalog.events.some((event) => event.eventType === eventType)
  );

  resultTabs.querySelectorAll(".result-tab").forEach((tab) => {
    tab.hidden = !eventTypes.includes(tab.dataset.eventType);
  });

  resultSelection.hidden = false;
  setActiveEventType(eventTypes[0]);
}

function getCatalogSourceText(source) {
  if (source === "live") {
    return "aus DLRG.net";
  }

  if (source === "mixed") {
    return "aus Competition.net und DLRG.net";
  }

  return "aus Competition.net";
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
    let catalog = await fetchJson(
      buildWorkerUrl(competitionCode, { mode: "catalog" })
    );
    catalog = ensureComputedCatalogEvents(catalog, competitionCode);

    if (!Array.isArray(catalog.events) || catalog.events.length === 0) {
      currentCatalog = catalog;
      updateSourceIndicators();
      updateExportStateFromCatalog(catalog);
      refreshCompetitionOptions();
      throw new Error("Für diesen Wettkampf wurden keine Ergebnislisten gefunden.");
    }

    currentCatalog = catalog;
    updateSourceIndicators();
    const exportStateMessage = updateExportStateFromCatalog(catalog);
    refreshCompetitionOptions();
    pageTitle.textContent = catalog.competitionName || competitionCode;
    renderResultCatalog(catalog);
    setExportControlsReady(true);

    const realEventCount = catalog.events.filter(
      (event) => !event.placeholder && event.source !== "computed"
    ).length;
    const computedEventCount = catalog.events.filter(
      (event) => !event.placeholder && event.source === "computed"
    ).length;
    const placeholderCount =
      catalog.events.length - realEventCount - computedEventCount;
    statusElement.textContent =
      realEventCount > 0
        ? `${realEventCount} Ergebnislisten ${getCatalogSourceText(catalog.source)} zugeordnet. ` +
          "Wähle bei der gewünschten Disziplin Geschlecht und Runde."
        : "Aktuell sind noch keine Ergebnislisten vorhanden.";

    if (computedEventCount > 0) {
      statusElement.textContent +=
        ` ${computedEventCount} Wertungskategorie ist berechenbar.`;
    }

    if (placeholderCount > 0) {
      statusElement.textContent +=
        ` ${placeholderCount} Wertungskategorie ist vorgemerkt.`;
    }

    if (catalog.warning) {
      statusElement.textContent += ` Hinweis: ${catalog.warning}`;
    }

    if (exportStateMessage) {
      statusElement.textContent += ` Export-Hinweis: ${exportStateMessage}`;
    }
  } catch (error) {
    console.error(error);
    if (isJrpLvRatingCompetition(competitionCode)) {
      const catalog = createJrpFallbackCatalog(competitionCode);
      currentCatalog = catalog;
      updateSourceIndicators();
      updateExportStateFromCatalog(catalog);
      refreshCompetitionOptions();
      pageTitle.textContent = catalog.competitionName || competitionCode;
      renderResultCatalog(catalog);
      setExportControlsReady(true);
      statusElement.className = "status";
      statusElement.textContent =
        "Aktuell sind noch keine Ergebnislisten vorhanden. " +
        "1 Wertungskategorie ist vorgemerkt.";
      return;
    }

    const attemptedSourceAvailability = currentCatalog
      ? getSourceAvailabilityFromCatalog(currentCatalog)
      : getAttemptedSourceAvailability(competitionCode);
    resetResultSelection();
    updateSourceIndicators({
      attempted: true,
      availability: attemptedSourceAvailability
    });
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

function renderJrpLvRatingTable(rows) {
  resultTable.replaceChildren();
  resultTable.className = "lv-rating-table";

  const headers = [
    "Platz",
    "Gliederung",
    "Punkte",
    "Pool Mannschaft f",
    "Pool Mannschaft m",
    "Pool Mixed x",
    "Pool Mixed -",
    "Beach Mannschaft f",
    "Beach Mannschaft m",
    "Beach Mixed x",
    "Beach Mixed -",
    "Einzel f",
    "Einzel m"
  ];
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((header) => createCell(headerRow, header, "th"));
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");

  rows.forEach((result) => {
    const row = document.createElement("tr");
    createCell(row, result.place, "td", "number-cell");
    createCell(row, result.lv, "td");
    createCell(row, result.totalPoints, "td", "number-cell");
    createCell(row, formatOptionalPoints(result.poolTeamFemalePoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.poolTeamMalePoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.poolMixedPoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.poolMixedDashPoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.beachTeamFemalePoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.beachTeamMalePoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.beachMixedPoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.beachMixedDashPoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.individualFemalePoints), "td", "number-cell");
    createCell(row, formatOptionalPoints(result.individualMalePoints), "td", "number-cell");
    tbody.appendChild(row);
  });

  resultTable.append(thead, tbody);
}

function formatOptionalPoints(value) {
  const points = Number(value);

  return points ? points : "";
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

function normalizeSelectionResultRows(result, event, context) {
  if (result.error) {
    throw new Error(result.error);
  }

  if (result.source === "live") {
    return normalizeLiveResultRows(result.data, event, context);
  }

  return parseResultPage(result.html, context).map((row) => ({
    ...row,
    ageGroup: event.ageGroup || row.ageGroup,
    gender: event.gender || row.gender,
    discipline: event.discipline || row.discipline
  }));
}

async function fetchRowsForEvents(events, context, statusPrefix) {
  const rowsByEvent = [];
  const errors = [];
  let processedEvents = 0;

  for (const eventBatch of chunkArray(events, EXPORT_BATCH_SIZE)) {
    const response = await fetchJson(
      buildWorkerUrl(context.competitionCode, { mode: "selection" }),
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
        rowsByEvent.push({
          event,
          rows: normalizeSelectionResultRows(result, event, context)
        });
      } catch (error) {
        errors.push(`${getDisciplineLabel(event)}: ${error.message}`);
      }
    });

    processedEvents += eventBatch.length;
    statusElement.textContent =
      `${statusPrefix}: ${processedEvents} von ${events.length} Ergebnislisten verarbeitet ...`;
  }

  return { rowsByEvent, errors };
}

function getLvBucket(lvBuckets, lv) {
  const cleanLv = String(lv || "").trim() || "Ohne Gliederung";

  if (!lvBuckets.has(cleanLv)) {
    lvBuckets.set(cleanLv, {
      lv: cleanLv,
      poolTeamFemalePoints: 0,
      poolTeamMalePoints: 0,
      poolMixedPoints: 0,
      poolMixedDashPoints: 0,
      beachTeamFemalePoints: 0,
      beachTeamMalePoints: 0,
      beachMixedPoints: 0,
      beachMixedDashPoints: 0,
      individualFemalePoints: 0,
      individualMalePoints: 0,
      sourceResultCount: 0
    });
  }

  return lvBuckets.get(cleanLv);
}

function assignJrpPlaces(rows) {
  let previousPoints = null;
  let previousPlace = 0;

  return rows.map((row, index) => {
    const place =
      previousPoints === row.totalPoints ? previousPlace : index + 1;
    previousPoints = row.totalPoints;
    previousPlace = place;

    return {
      ...row,
      place
    };
  });
}

function addJrpTeamPoints(lvBucket, event, points) {
  const discipline = normalizeLookupText(event.discipline);

  if (JRP_POOL_TEAM_DISCIPLINES.has(discipline)) {
    if (event.gender === "w") {
      lvBucket.poolTeamFemalePoints += points;
    } else if (event.gender === "m") {
      lvBucket.poolTeamMalePoints += points;
    }
    return;
  }

  if (JRP_BEACH_TEAM_DISCIPLINES.has(discipline)) {
    if (event.gender === "w") {
      lvBucket.beachTeamFemalePoints += points;
    } else if (event.gender === "m") {
      lvBucket.beachTeamMalePoints += points;
    }
    return;
  }

  if (JRP_POOL_MIXED_DISCIPLINES.has(discipline)) {
    lvBucket.poolMixedPoints += points;
    return;
  }

  if (JRP_BEACH_MIXED_DISCIPLINES.has(discipline)) {
    lvBucket.beachMixedPoints += points;
  }
}

function createKnownJrpLvRatingRows(context) {
  const knownRows = JRP_KNOWN_LV_RATINGS[normalizeCompetitionCode(
    context.competitionCode
  )];

  if (!knownRows) {
    return [];
  }

  return knownRows.map((values, index) => {
    const [
      lv,
      totalPoints,
      poolTeamFemalePoints,
      poolTeamMalePoints,
      poolMixedPoints,
      beachTeamFemalePoints,
      beachTeamMalePoints,
      beachMixedPoints,
      individualFemalePoints,
      individualMalePoints
    ] = values;

    return {
      competitionCode: context.competitionCode,
      competitionName: context.competitionName,
      competitionDate: context.competitionDate,
      place: totalPoints > 0 ? index + 1 : "",
      lv,
      totalPoints,
      poolTeamFemalePoints,
      poolTeamMalePoints,
      poolMixedPoints,
      poolMixedDashPoints: 0,
      beachTeamFemalePoints,
      beachTeamMalePoints,
      beachMixedPoints,
      beachMixedDashPoints: 0,
      individualFemalePoints,
      individualMalePoints,
      sourceResultCount: 0
    };
  });
}

function calculateJrpLvRatingFromRows(rowsByEvent, context) {
  const lvBuckets = new Map();

  rowsByEvent.forEach(({ event, rows }) => {
    const placeOffset = getJrpFinalPlaceOffset(event, rows);

    rows.forEach((result) => {
      const place = Number(result.place) + placeOffset;

      if (!Number.isInteger(place) || place < 1) {
        return;
      }

      const lvBucket = getLvBucket(lvBuckets, result.club);
      const points = getJrpRankPoints(place);

      if (event.eventType === "Team") {
        addJrpTeamPoints(lvBucket, event, points);
        lvBucket.sourceResultCount += 1;
        return;
      }

      if (event.eventType !== "Individual" || !["w", "m"].includes(result.gender)) {
        return;
      }

      const disciplineType = getJrpIndividualDisciplineType(event.discipline);

      if (!disciplineType) {
        return;
      }

      if (result.gender === "w") {
        lvBucket.individualFemalePoints += points;
      } else {
        lvBucket.individualMalePoints += points;
      }

      lvBucket.sourceResultCount += 1;
    });
  });

  const rows = Array.from(lvBuckets.values())
    .map((lvBucket) => {
      const totalPoints =
        lvBucket.poolTeamFemalePoints +
        lvBucket.poolTeamMalePoints +
        lvBucket.poolMixedPoints +
        lvBucket.poolMixedDashPoints +
        lvBucket.beachTeamFemalePoints +
        lvBucket.beachTeamMalePoints +
        lvBucket.beachMixedPoints +
        lvBucket.beachMixedDashPoints +
        lvBucket.individualFemalePoints +
        lvBucket.individualMalePoints;

      return {
        competitionCode: context.competitionCode,
        competitionName: context.competitionName,
        competitionDate: context.competitionDate,
        lv: lvBucket.lv,
        totalPoints,
        poolTeamFemalePoints: lvBucket.poolTeamFemalePoints,
        poolTeamMalePoints: lvBucket.poolTeamMalePoints,
        poolMixedPoints: lvBucket.poolMixedPoints,
        poolMixedDashPoints: lvBucket.poolMixedDashPoints,
        beachTeamFemalePoints: lvBucket.beachTeamFemalePoints,
        beachTeamMalePoints: lvBucket.beachTeamMalePoints,
        beachMixedPoints: lvBucket.beachMixedPoints,
        beachMixedDashPoints: lvBucket.beachMixedDashPoints,
        individualFemalePoints: lvBucket.individualFemalePoints,
        individualMalePoints: lvBucket.individualMalePoints,
        sourceResultCount: lvBucket.sourceResultCount
      };
    })
    .sort((left, right) =>
      right.totalPoints - left.totalPoints ||
      left.lv.localeCompare(right.lv, "de")
    );

  return assignJrpPlaces(rows);
}

function getJrpLvRatingEvents() {
  return getJrpLvRatingSourceEvents(currentCatalog);
}

async function calculateJrpLvRating(context, statusPrefix) {
  const knownRows = createKnownJrpLvRatingRows(context);

  if (knownRows.length > 0) {
    return {
      rows: knownRows,
      errors: [],
      sourceEventCount: 0,
      sourceDescription: "offizieller JRP2025-LV-Wertung"
    };
  }

  const sourceEvents = getJrpLvRatingEvents();

  if (sourceEvents.length === 0) {
    throw new Error("Für die LV-Wertung sind noch keine Final-Ergebnislisten vorhanden.");
  }

  const { rowsByEvent, errors } = await fetchRowsForEvents(
    sourceEvents,
    context,
    statusPrefix
  );
  const rows = calculateJrpLvRatingFromRows(rowsByEvent, context);

  if (rows.length === 0) {
    throw new Error("Aus den Final-Ergebnislisten konnte keine LV-Wertung berechnet werden.");
  }

  return {
    rows,
    errors,
    sourceEventCount: sourceEvents.length
  };
}

function createJrpLvRatingExportRows(rows) {
  return rows.map((row) => ({
    "Quelle": "berechnet",
    "Typ": "LV-Wertung",
    "Wettkampfcode": row.competitionCode,
    "Wettkampf": row.competitionName,
    "Datum": row.competitionDate,
    "Platz": row.place,
    "Gliederung": row.lv,
    "Punkte": row.totalPoints,
    "Pool Mannschaft f": formatOptionalPoints(row.poolTeamFemalePoints),
    "Pool Mannschaft m": formatOptionalPoints(row.poolTeamMalePoints),
    "Pool Mixed x": formatOptionalPoints(row.poolMixedPoints),
    "Pool Mixed -": formatOptionalPoints(row.poolMixedDashPoints),
    "Beach Mannschaft f": formatOptionalPoints(row.beachTeamFemalePoints),
    "Beach Mannschaft m": formatOptionalPoints(row.beachTeamMalePoints),
    "Beach Mixed x": formatOptionalPoints(row.beachMixedPoints),
    "Beach Mixed -": formatOptionalPoints(row.beachMixedDashPoints),
    "Einzel f": formatOptionalPoints(row.individualFemalePoints),
    "Einzel m": formatOptionalPoints(row.individualMalePoints)
  }));
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
  if (source === "live") {
    return "DLRG.net";
  }

  if (source === "computed") {
    return "berechnet";
  }

  return "competition.net";
}

function getSourceId(event) {
  if (event.source === "live") {
    return `${event.edvnummer}:${event.wkid}`;
  }

  if (event.source === "computed") {
    return event.computedType || "";
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
      birthYear: "",
      birthYearShort: ""
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
    birthYear,
    birthYearShort: rawYear.length === 4 ? rawYear.slice(-2) : rawYear
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

function getLiveIndividualDisciplineKey(index, field) {
  return `__discipline_${index}_${field}`;
}

function getTrimmedCellValue(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function formatLiveIndividualPenalty(rawTime, penalty) {
  const cleanTime = getTrimmedCellValue(rawTime);
  const cleanPenalty = getTrimmedCellValue(penalty);

  return [
    cleanPenalty,
    cleanTime && !looksLikeTime(cleanTime) ? cleanTime : ""
  ].filter(Boolean).join(" / ");
}

function createLiveIndividualExportRows(data, event) {
  const rows = Array.isArray(data && data.daten) ? data.daten : [];
  const disciplines = getLiveDisciplines(data);

  return rows.map((sourceRow, index) => {
    const athlete = parseBirthYearFromName(sourceRow.name);
    const row = {
      "Name": athlete.name,
      "Gender": event.gender,
      "AK": event.ageGroup,
      "Jahrgang": athlete.birthYearShort,
      "Gliederung": getTrimmedCellValue(sourceRow.gliederung),
      "__blank_1": "",
      "__blank_2": "",
      "__blank_3": "",
      "Gesamtplatz":
        sourceRow.platz === undefined || sourceRow.platz === null
          ? index + 1
          : sourceRow.platz,
      "Gesamtpunkte": getTrimmedCellValue(sourceRow.punkte),
      "Diff. zu Platz 1": getTrimmedCellValue(sourceRow.diff),
      "__blank_4": "",
      "__blank_5": ""
    };

    disciplines.forEach((discipline, disciplineIndex) => {
      const fieldNumber = discipline.fieldNumber;
      const rawTime = getTrimmedCellValue(sourceRow[`zeit ${fieldNumber}`]);
      const points = getTrimmedCellValue(sourceRow[`punkte ${fieldNumber}`]);
      const penalty = getTrimmedCellValue(sourceRow[`strafe ${fieldNumber}`]);

      row[getLiveIndividualDisciplineKey(disciplineIndex, "name")] =
        discipline.name;
      row[getLiveIndividualDisciplineKey(disciplineIndex, "blank_before")] = "";
      row[getLiveIndividualDisciplineKey(disciplineIndex, "time")] =
        looksLikeTime(rawTime) ? rawTime : "";
      row[getLiveIndividualDisciplineKey(disciplineIndex, "points")] = points;
      row[getLiveIndividualDisciplineKey(disciplineIndex, "penalty")] =
        formatLiveIndividualPenalty(rawTime, penalty);
      row[getLiveIndividualDisciplineKey(disciplineIndex, "blank_after")] = "";
    });

    return row;
  });
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
  if (result.source === "live" && event.eventType === "Individual") {
    return createLiveIndividualExportRows(result.data, event);
  }

  return isLiveMultiDisciplineData(result.data)
    ? createLiveMultiDisciplineExportRows(result.data, event, context)
    : createLiveSingleDisciplineExportRows(result.data, event, context);
}

function getSheetKey(source, eventType) {
  return `${source}:${eventType}`;
}

function getSheetName(source, eventType) {
  if (source === "computed") {
    return getEventTypeLabel(eventType);
  }

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
    ? currentCatalog.events.filter(
        (event) => !event.placeholder && event.source !== "computed"
      )
    : [];
  const computedEvents = Array.isArray(currentCatalog && currentCatalog.events)
    ? currentCatalog.events.filter(
        (event) => !event.placeholder && event.source === "computed"
      )
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

  for (const event of computedEvents) {
    if (event.computedType !== "jrp-lv-rating") {
      continue;
    }

    try {
      const calculation = await calculateJrpLvRating(
        context,
        "LV-Wertung für Excel wird berechnet"
      );
      const rows = createJrpLvRatingExportRows(calculation.rows);
      addExportRows(sheetGroups, "computed", event.eventType, rows);
      rowCount += rows.length;
      errors.push(...calculation.errors);
    } catch (error) {
      errors.push(`${getDisciplineLabel(event)}: ${error.message}`);
    }
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
const JRP_LV_RATING_EXPORT_HEADERS = [
  "Quelle",
  "Typ",
  "Wettkampfcode",
  "Wettkampf",
  "Datum",
  "Platz",
  "Gliederung",
  "Punkte",
  "Pool Mannschaft f",
  "Pool Mannschaft m",
  "Pool Mixed x",
  "Pool Mixed -",
  "Beach Mannschaft f",
  "Beach Mannschaft m",
  "Beach Mixed x",
  "Beach Mixed -",
  "Einzel f",
  "Einzel m"
];

const LIVE_INDIVIDUAL_EXPORT_HEADERS = [
  { key: "Name", label: "Nachname, Vorname" },
  { key: "Gender", label: "Gender" },
  { key: "AK", label: "Altersklasse" },
  { key: "Jahrgang", label: "Jahrgang" },
  { key: "Gliederung", label: "Ortsgruppe" },
  { key: "__blank_1", label: "" },
  { key: "__blank_2", label: "" },
  { key: "__blank_3", label: "" },
  { key: "Gesamtplatz", label: "Gesamt Platzierung" },
  { key: "Gesamtpunkte", label: "3-Kampf Punkte" },
  { key: "Diff. zu Platz 1", label: "Punktedifferenz" },
  { key: "__blank_4", label: "" },
  { key: "__blank_5", label: "" }
];

function normalizeSheetHeader(header) {
  return typeof header === "string"
    ? { key: header, label: header }
    : header;
}

function getLiveIndividualExportHeaders(sheet) {
  const headers = [...LIVE_INDIVIDUAL_EXPORT_HEADERS];
  const disciplineNames = new Map();

  sheet.rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      const match = key.match(/^__discipline_(\d+)_name$/);

      if (match) {
        const index = Number(match[1]);

        if (!disciplineNames.has(index)) {
          disciplineNames.set(index, String(row[key] || "Disziplin").trim());
        }
      }
    });
  });

  Array.from(disciplineNames.entries())
    .sort(([left], [right]) => left - right)
    .forEach(([index, name]) => {
      const disciplineName = name || "Disziplin";

      headers.push(
        {
          key: getLiveIndividualDisciplineKey(index, "blank_before"),
          label: ""
        },
        {
          key: getLiveIndividualDisciplineKey(index, "time"),
          label: `${disciplineName} Zeit`
        },
        {
          key: getLiveIndividualDisciplineKey(index, "points"),
          label: `${disciplineName} Punkte`
        },
        {
          key: getLiveIndividualDisciplineKey(index, "penalty"),
          label: `${disciplineName} DQ/Strafe Code`
        },
        {
          key: getLiveIndividualDisciplineKey(index, "blank_after"),
          label: ""
        }
      );
    });

  return headers;
}

function getSheetHeaders(sheet) {
  if (sheet.source === "competition") {
    return COMPETITION_EXPORT_HEADERS;
  }

  if (sheet.source === "computed" && sheet.eventType === "LvRating") {
    return JRP_LV_RATING_EXPORT_HEADERS;
  }

  if (sheet.source === "live" && sheet.eventType === "Individual") {
    return getLiveIndividualExportHeaders(sheet);
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
  const headers = getSheetHeaders(sheet).map(normalizeSheetHeader);
  const headerRow =
    "<Row>" +
    headers.map((header) => createCellXml(header.label, "Header")).join("") +
    "</Row>";
  const dataRows = sheet.rows
    .map((row) =>
      "<Row>" +
      headers.map((header) => createCellXml(row[header.key])).join("") +
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
      competition: event.competition,
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
    if (
      selectedEvents.length === 1 &&
      selectedEvents[0].computedType === "jrp-lv-rating"
    ) {
      const context = {
        competitionCode,
        competitionName: currentCatalog.competitionName || competitionCode,
        competitionDate: getCatalogCompetitionDate()
      };
      const calculation = await calculateJrpLvRating(
        context,
        "LV-Wertung wird berechnet"
      );

      currentResults = calculation.rows;
      renderJrpLvRatingTable(calculation.rows);
      statusElement.textContent =
        calculation.sourceDescription
          ? `${calculation.rows.length} Landesverbände aus ${calculation.sourceDescription} geladen.`
          : `${calculation.rows.length} Landesverbände aus ` +
            `${calculation.sourceEventCount} Final-Ergebnislisten berechnet.`;

      if (calculation.errors.length > 0) {
        statusElement.textContent +=
          ` ${calculation.errors.length} Ergebnislisten wurden übersprungen.`;
        errorDetails.hidden = false;
        errorOutput.textContent = calculation.errors.join("\n");
      }

      return;
    }

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
