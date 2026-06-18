"use strict";

const WORKER_URL = "https://dlrg-results.jp-gnad.workers.dev/";
const AUTH_SESSION_KEY = "dlrg-phraser-auth-year";
const CUSTOM_EDV_VALUE = "__custom__";
const KNOWN_EDV_NUMBERS = [
  ["0100000", "Landesverband Baden"],
  ["0105000", "Bezirk Rhein-Neckar / Baden"],
  ["01050005", "DLRG-Jugend Bezirk Rhein-Neckar / Baden"],
  ["0105020", "Ortsgruppe Waibstadt / Baden"],
  ["01070005", "Bezirk Karlsruhe / Baden"],
  ["0202001", "Landesverband Niedersachsen"],
  ["0210000", "Landesverband Bayern"],
  ["0700000", "Landesverband Hessen"],
  ["0826000", "Bezirk Göttingen"],
  ["0832003", "Nienburg"],
  ["0861000", "Nürnberg"],
  ["0900000", "Landesverband Nordrhein"],
  ["0906000", "Bezirk Rhein-Erft-Kreis"],
  ["1300000", "Landesverband Westfalen"],
  ["1313012", "Schwerte"],
  ["1326000", "Bielefeld / Ostwestfalen-Lippe"],
  ["1404003", "Bietigheim-Bissingen / Ludwigsburg-Heilbronn"],
  ["1408008", "Ortsgruppe Sindelfingen / Wuerttemberg"],
  ["14300005", "Landesverband Württemberg"],
  ["1600000", "DLRG Bundesebene"],
  ["1602001", "IGDM / Mitteldeutsche Regionalmeisterschaften"]
];

let currentEvents = [];
let currentLiveId = null;

const loginScreen = document.getElementById("loginScreen");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("password");
const loginError = document.getElementById("loginError");
const app = document.getElementById("app");
const logoutButton = document.getElementById("logoutButton");
const liveLookupForm = document.getElementById("liveLookupForm");
const edvSelect = document.getElementById("edvSelect");
const customEdvGroup = document.getElementById("customEdvGroup");
const customEdvInput = document.getElementById("customEdvInput");
const wkidInput = document.getElementById("wkidInput");
const wkidDirectionInput = document.getElementById("wkidDirection");
const statusElement = document.getElementById("status");
const liveOverview = document.getElementById("liveOverview");
const liveTitle = document.getElementById("liveTitle");
const liveMeta = document.getElementById("liveMeta");
const categoryInfo = document.getElementById("categoryInfo");
const categoryList = document.getElementById("categoryList");
const resultTable = document.getElementById("resultTable");

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
  wkidInput.focus();
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

function initializeEdvOptions() {
  edvSelect.replaceChildren();

  KNOWN_EDV_NUMBERS.forEach(([number, label]) => {
    const option = document.createElement("option");
    option.value = number;
    option.textContent = `${number} - ${label}`;
    edvSelect.appendChild(option);
  });

  const customOption = document.createElement("option");
  customOption.value = CUSTOM_EDV_VALUE;
  customOption.textContent = "Eigene EDV-Nummer eingeben";
  edvSelect.appendChild(customOption);
  edvSelect.value = "1600000";
  updateCustomEdvVisibility();
}

function updateCustomEdvVisibility() {
  const useCustomEdv = edvSelect.value === CUSTOM_EDV_VALUE;
  customEdvGroup.hidden = !useCustomEdv;
  customEdvInput.required = useCustomEdv;

  if (useCustomEdv) {
    customEdvInput.focus();
  }
}

function getSelectedEdvNumber() {
  const value = edvSelect.value === CUSTOM_EDV_VALUE
    ? customEdvInput.value
    : edvSelect.value;

  const edvnummer = String(value || "").trim();

  if (!/^\d{1,12}$/.test(edvnummer)) {
    throw new Error("Bitte eine gültige EDV-Nummer eingeben.");
  }

  return edvnummer;
}

function parseLiveId() {
  const wkidValue = String(wkidInput.value || "").trim();

  if (wkidValue.includes(":")) {
    const match = wkidValue.match(/^(\d{1,12})\s*:\s*(\d{1,12})$/);

    if (!match) {
      throw new Error("Bitte WKID getrennt eingeben oder im Format edvnummer:wkid einfügen.");
    }

    setEdvNumber(match[1]);
    wkidInput.value = match[2];
    return {
      edvnummer: match[1],
      wkid: match[2]
    };
  }

  if (!/^\d{1,12}$/.test(wkidValue)) {
    throw new Error("Bitte eine gültige WKID eingeben.");
  }

  return {
    edvnummer: getSelectedEdvNumber(),
    wkid: wkidValue
  };
}

function setEdvNumber(edvnummer) {
  const hasKnownOption = KNOWN_EDV_NUMBERS.some(([number]) => number === edvnummer);

  edvSelect.value = hasKnownOption ? edvnummer : CUSTOM_EDV_VALUE;
  customEdvInput.value = hasKnownOption ? "" : edvnummer;
  updateCustomEdvVisibility();
}

function getWkidStep() {
  return wkidDirectionInput.value === "-1" ? -1 : 1;
}

function getNextLiveId(liveId) {
  const nextWkid = Number(liveId.wkid) + getWkidStep();

  if (!Number.isSafeInteger(nextWkid) || nextWkid < 0 || nextWkid > 999999999999) {
    return null;
  }

  return {
    edvnummer: liveId.edvnummer,
    wkid: String(nextWkid)
  };
}

function formatLiveId(liveId) {
  return `${liveId.edvnummer}:${liveId.wkid}`;
}

function prepareNextLiveId(liveId) {
  const nextLiveId = getNextLiveId(liveId);

  if (!nextLiveId) {
    return "";
  }

  wkidInput.value = nextLiveId.wkid;
  wkidInput.select();
  return formatLiveId(nextLiveId);
}

function buildWorkerUrl(options = {}) {
  const url = new URL(WORKER_URL);
  url.searchParams.set("mode", "live-direct");
  url.searchParams.set("edvnummer", options.edvnummer);
  url.searchParams.set("wkid", options.wkid);

  if (options.ak) {
    url.searchParams.set("ak", options.ak);
  }

  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
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

function setBusy(isBusy) {
  edvSelect.disabled = isBusy;
  customEdvInput.disabled = isBusy;
  wkidInput.disabled = isBusy;
  liveLookupForm.querySelectorAll(".direction-button").forEach((button) => {
    button.disabled = isBusy;
  });
  liveLookupForm.querySelector("button[type='submit']").disabled = isBusy;
  categoryList.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function resetOutput() {
  currentEvents = [];
  currentLiveId = null;
  liveOverview.hidden = true;
  liveTitle.textContent = "Live-Tabelle";
  liveMeta.replaceChildren();
  categoryInfo.textContent = "";
  categoryList.replaceChildren();
  resultTable.replaceChildren();
  resultTable.className = "";
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

function createMetaItem(label, value) {
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value || "-";
  liveMeta.append(term, description);
}

function getEventTypeLabel(value) {
  return value === "Individual" ? "Einzel" : "Mannschaft";
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

function getDisciplineLabel(event) {
  if (event.round && event.round !== "Ergebnis") {
    return `${event.discipline} - ${event.round}`;
  }

  return event.discipline || "Gesamtwertung";
}

function getCategoryButtonLabel(event) {
  return [
    getEventTypeLabel(event.eventType),
    event.ageGroup,
    getGenderLabel(event.gender),
    getDisciplineLabel(event)
  ].filter(Boolean).join(" | ");
}

function renderOverview(response) {
  const data = response.data || {};
  currentEvents = Array.isArray(response.events) ? response.events : [];

  liveOverview.hidden = false;
  liveTitle.textContent = String(data.wkname || "Live-Tabelle");
  liveMeta.replaceChildren();
  createMetaItem("EDV-Nummer", response.edvnummer);
  createMetaItem("WKID", response.wkid);
  createMetaItem("Name", data.wkname);
  createMetaItem("Stand", data.zeit);
  createMetaItem("Kategorien", String(currentEvents.length));

  categoryInfo.textContent = `${currentEvents.length} Ergebnislisten gefunden`;
  categoryList.replaceChildren();

  if (currentEvents.length === 0) {
    categoryInfo.textContent = "Keine Ergebnislisten gefunden.";
    return;
  }

  currentEvents.forEach((event, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-choice-button live-category-button";
    button.dataset.index = String(index);
    button.textContent = getCategoryButtonLabel(event);
    categoryList.appendChild(button);
  });

  loadCategory(currentEvents[0], 0);
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

function renderLiveTable(data, event) {
  const disciplines = getLiveDisciplines(data);
  const rows = Array.isArray(data && data.daten) ? data.daten : [];

  if (disciplines.length > 1) {
    renderMultiDisciplineTable(data, event, rows, disciplines);
    return;
  }

  renderSingleDisciplineTable(event, rows);
}

function renderSingleDisciplineTable(event, rows) {
  resultTable.replaceChildren();
  resultTable.className = "";

  const caption = document.createElement("caption");
  caption.textContent = getCategoryButtonLabel(event);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["Platz", "Name", "Gliederung", "Zeit", "Punkte", "DQ / Status"].forEach(
    (header) => createCell(headerRow, header, "th")
  );
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  rows.forEach((sourceRow) => {
    const row = document.createElement("tr");
    createCell(row, sourceRow.platz, "td", "number-cell");
    createCell(row, String(sourceRow.name || "").trim(), "td");
    createCell(row, String(sourceRow.gliederung || "").trim(), "td");
    createCell(row, String(sourceRow["zeit 1"] || "").trim(), "td");
    createCell(row, String(sourceRow["punkte 1"] || "").trim(), "td", "number-cell");
    createCell(row, String(sourceRow["strafe 1"] || "").trim(), "td");
    tbody.appendChild(row);
  });

  resultTable.append(caption, thead, tbody);
}

function renderMultiDisciplineTable(data, event, rows, disciplines) {
  resultTable.replaceChildren();
  resultTable.className = "multi-discipline-table";

  const caption = document.createElement("caption");
  caption.textContent = getCategoryButtonLabel(event);

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  [
    "Gesamtplatz",
    "Name",
    "Gliederung",
    "Gesamtpunkte",
    "Diff. zu Platz 1",
    ...disciplines.map((discipline) => discipline.name)
  ].forEach((header) => createCell(headerRow, header, "th"));
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  rows.forEach((sourceRow) => {
    const row = document.createElement("tr");
    createCell(row, sourceRow.platz, "td", "number-cell");
    createCell(row, String(sourceRow.name || "").trim(), "td");
    createCell(row, String(sourceRow.gliederung || "").trim(), "td");
    createCell(row, String(sourceRow.punkte || "").trim(), "td", "number-cell");
    createCell(row, String(sourceRow.diff || "").trim(), "td", "number-cell");

    disciplines.forEach((discipline) => {
      row.appendChild(createDisciplineCell(sourceRow, discipline.fieldNumber));
    });

    tbody.appendChild(row);
  });

  resultTable.append(caption, thead, tbody);
}

function createDisciplineCell(sourceRow, fieldNumber) {
  const cell = document.createElement("td");
  const time = String(sourceRow[`zeit ${fieldNumber}`] || "").trim();
  const points = String(sourceRow[`punkte ${fieldNumber}`] || "").trim();
  const penalty = String(sourceRow[`strafe ${fieldNumber}`] || "").trim();

  cell.className = "multi-discipline-cell";

  if (!time && !points && !penalty) {
    cell.classList.add("empty-cell");
    cell.textContent = "-";
    return cell;
  }

  [
    ["discipline-time", time],
    ["discipline-points", points ? `${points} Punkte` : ""],
    ["discipline-status", penalty ? `DQ / Status: ${penalty}` : ""]
  ].forEach(([className, value]) => {
    if (!value) {
      return;
    }

    const line = document.createElement("span");
    line.className = className;
    line.textContent = value;
    cell.appendChild(line);
  });

  return cell;
}

async function loadLiveId() {
  const liveId = parseLiveId();
  currentLiveId = liveId;
  resetOutput();
  currentLiveId = liveId;
  setBusy(true);
  statusElement.className = "status";
  statusElement.textContent = `${formatLiveId(liveId)} wird geladen ...`;

  try {
    const response = await fetchJson(buildWorkerUrl(liveId));
    renderOverview(response);
    const nextLiveId = prepareNextLiveId(liveId);
    statusElement.textContent =
      `${formatLiveId(response)} geladen. ` +
      (nextLiveId ? `Nächste Suche vorbereitet: ${nextLiveId}. ` : "") +
      "Wähle eine Ergebnisliste.";
  } catch (error) {
    console.error(error);
    resetOutput();
    statusElement.className = "status error";
    statusElement.textContent = `Fehler: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function loadCategory(event, index) {
  if (!currentLiveId || !event) {
    return;
  }

  categoryList.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.index === String(index));
  });
  setBusy(true);
  statusElement.className = "status";
  statusElement.textContent = `${event.ak} wird geladen ...`;

  try {
    const response = await fetchJson(
      buildWorkerUrl({
        ...currentLiveId,
        ak: event.ak
      })
    );
    renderLiveTable(response.data, event);
    statusElement.textContent = `${event.ak} geladen.`;
  } catch (error) {
    console.error(error);
    resultTable.replaceChildren();
    statusElement.className = "status error";
    statusElement.textContent = `Fehler: ${error.message}`;
  } finally {
    setBusy(false);
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

edvSelect.addEventListener("change", updateCustomEdvVisibility);

liveLookupForm.addEventListener("click", (event) => {
  const button = event.target.closest(".direction-button");

  if (!button || button.disabled) {
    return;
  }

  wkidDirectionInput.value = button.dataset.direction === "-1" ? "-1" : "1";
  liveLookupForm.querySelectorAll(".direction-button").forEach((directionButton) => {
    const isSelected = directionButton === button;
    directionButton.classList.toggle("is-selected", isSelected);
    directionButton.setAttribute("aria-pressed", String(isSelected));
  });
});

liveLookupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadLiveId();
});

categoryList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");

  if (!button || button.disabled) {
    return;
  }

  const index = Number(button.dataset.index);
  loadCategory(currentEvents[index], index);
});

initializeEdvOptions();
initializeAuthentication();
