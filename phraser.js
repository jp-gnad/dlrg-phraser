"use strict";

const WORKER_URL = "https://dlrg-results.jp-gnad.workers.dev/";
const AUTH_SESSION_KEY = "dlrg-phraser-auth-year";

let currentResults = [];
let currentCatalog = null;
let activeEventType = "";
let activeChoiceId = "";
let catalogChoiceEvents = new Map();
let competitionListLoaded = false;

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
const excelButton = document.getElementById("excelButton");
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

function setCompetitionControlsEnabled() {
  const usesManualCode = competitionSelect.value === "__manual__";

  manualCompetitionGroup.hidden = !usesManualCode;
}

function renderCompetitionOptions(competitions) {
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
      option.value = competition.acronym;
      option.textContent =
        `${formatCompetitionDateRange(competition.from, competition.till)} | ` +
        `${competition.name} (${competition.acronym})`;
      group.appendChild(option);
    });

    competitionSelect.appendChild(group);
  });

  const manualOption = document.createElement("option");
  manualOption.value = "__manual__";
  manualOption.textContent = "Anderen Wettkampfcode manuell eingeben ...";
  competitionSelect.appendChild(manualOption);
}

async function loadCompetitionList() {
  competitionSelect.disabled = true;
  reloadCompetitionListButton.hidden = true;
  competitionListInfo.className = "field-hint";
  competitionListInfo.textContent = "Wettkampfliste wird geladen ...";

  try {
    const response = await fetchJson(
      buildWorkerUrl("", { mode: "competitions" })
    );
    const competitions = Array.isArray(response.competitions)
      ? response.competitions
      : [];

    if (competitions.length === 0) {
      throw new Error("Keine Wettkämpfe ab dem 01.01.2025 gefunden.");
    }

    renderCompetitionOptions(competitions);
    competitionListLoaded = true;
    competitionSelect.disabled = false;
    reloadCompetitionListButton.hidden = true;
    competitionListInfo.textContent =
      `${competitions.length} Wettkämpfe ab dem 01.01.2025 geladen.`;
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

function resetResultSelection() {
  currentCatalog = null;
  currentResults = [];
  activeEventType = "";
  activeChoiceId = "";
  catalogChoiceEvents = new Map();
  resultSelection.hidden = true;
  resultCatalog.replaceChildren();
  resultTable.replaceChildren();
  excelButton.disabled = true;
  selectionInfo.textContent = "";
  errorDetails.hidden = true;
  errorOutput.textContent = "";

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
    excelButton.disabled = true;
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
      throw new Error("Für diesen Wettkampf wurden keine Ergebnislisten gefunden.");
    }

    currentCatalog = catalog;
    pageTitle.textContent = catalog.competitionName || competitionCode;
    renderResultCatalog(catalog);

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
  return /^\d{1,3}:\d{2}[,.]\d{2}$/.test(String(value || "").trim());
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

  const combinedMatch = first.match(/^(.+?)\s+(\d{1,3}:\d{2}[,.]\d{2})$/);

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
  cell.textContent = text || "–";

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

function parseGermanDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (!match) {
    return null;
  }

  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function createSafeFileNamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 80);
}

async function exportToExcel() {
  if (!Array.isArray(currentResults) || currentResults.length === 0) {
    statusElement.className = "status error";
    statusElement.textContent = "Es sind keine Ergebnisse für den Excel-Export vorhanden.";
    return;
  }

  if (typeof ExcelJS === "undefined") {
    statusElement.className = "status error";
    statusElement.textContent =
      "ExcelJS konnte nicht geladen werden. Bitte die Internetverbindung prüfen.";
    return;
  }

  excelButton.disabled = true;
  statusElement.className = "status";
  statusElement.textContent = "Excel-Arbeitsmappe wird erstellt ...";

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "DLRG Ergebnis-Export";
    workbook.lastModifiedBy = "DLRG Ergebnis-Export";
    workbook.created = new Date();
    workbook.modified = new Date();

    const worksheet = workbook.addWorksheet("Ergebnisse", {
      views: [{ state: "frozen", ySplit: 1 }]
    });

    const excelRows = currentResults.map((result) => [
      Number(result.place) || "",
      result.competitionName || "",
      parseGermanDate(result.competitionDate),
      result.ageGroup || "",
      result.gender || "",
      result.discipline || "",
      result.name || "",
      result.club || "",
      result.time || "",
      result.status || ""
    ]);

    worksheet.addTable({
      name: "DLRGErgebnisse",
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      style: {
        theme: "TableStyleMedium2",
        showFirstColumn: false,
        showLastColumn: false,
        showRowStripes: true,
        showColumnStripes: false
      },
      columns: [
        { name: "Platz", filterButton: true },
        { name: "Wettkampf", filterButton: true },
        { name: "Datum", filterButton: true },
        { name: "AK", filterButton: true },
        { name: "Gender", filterButton: true },
        { name: "Disziplin", filterButton: true },
        { name: "Name", filterButton: true },
        { name: "Verein", filterButton: true },
        { name: "Zeit", filterButton: true },
        { name: "DQ / Status", filterButton: true }
      ],
      rows: excelRows
    });

    [9, 48, 13, 13, 11, 36, 32, 34, 13, 18].forEach((width, index) => {
      worksheet.getColumn(index + 1).width = width;
    });

    worksheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: "middle" };

      if (rowNumber > 1) {
        row.height = 20;
      }
    });

    [2, 6, 7, 8, 10].forEach((columnNumber) => {
      worksheet.getColumn(columnNumber).alignment = {
        vertical: "middle",
        wrapText: true
      };
    });

    for (let rowNumber = 2; rowNumber <= excelRows.length + 1; rowNumber += 1) {
      worksheet.getCell(rowNumber, 1).numFmt = "0";
      const dateCell = worksheet.getCell(rowNumber, 3);

      if (dateCell.value instanceof Date) {
        dateCell.numFmt = "dd.mm.yyyy";
      }

      worksheet.getCell(rowNumber, 9).numFmt = "@";
      const statusCell = worksheet.getCell(rowNumber, 10);

      if (String(statusCell.value || "").trim()) {
        statusCell.font = { bold: true, color: { argb: "FFC00000" } };
      }
    }

    const firstResult = currentResults[0];
    const infoSheet = workbook.addWorksheet("Informationen");
    infoSheet.addRows([
      ["Eigenschaft", "Wert"],
      ["Wettkampfcode", firstResult.competitionCode || ""],
      ["Wettkampf", firstResult.competitionName || ""],
      ["Wettkampfdatum", parseGermanDate(firstResult.competitionDate)],
      ["Exportdatum", new Date()],
      ["Anzahl Ergebniszeilen", currentResults.length]
    ]);
    infoSheet.getColumn(1).width = 25;
    infoSheet.getColumn(2).width = 60;
    infoSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    infoSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0068AD" }
    };
    infoSheet.getCell("B4").numFmt = "dd.mm.yyyy";
    infoSheet.getCell("B5").numFmt = "dd.mm.yyyy hh:mm";
    infoSheet.views = [{ state: "frozen", ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const competitionCode =
      createSafeFileNamePart(getSelectedCompetitionCode()) || "Wettkampf";
    const datePart = String(firstResult.competitionDate || "")
      .split(".")
      .reverse()
      .join("-");
    const fileName = `DLRG_${competitionCode}_Ergebnisse${
      datePart ? `_${datePart}` : ""
    }.xlsx`;
    const downloadUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.download = fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

    statusElement.textContent =
      `${currentResults.length} Ergebniszeilen wurden als Excel-Datei gespeichert.`;
  } catch (error) {
    console.error(error);
    statusElement.className = "status error";
    statusElement.textContent = `Fehler beim Excel-Export: ${error.message}`;
  } finally {
    excelButton.disabled = currentResults.length === 0;
  }
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
  excelButton.disabled = true;
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
    renderTable(currentResults);
    excelButton.disabled = currentResults.length === 0;

    let statusText =
      `${selectedEvents.length} Ergebnislisten verarbeitet, ` +
      `${currentResults.length} Ergebniszeilen geladen`;

    if (errors.length > 0) {
      statusText += `, ${errors.length} Ergebnislisten übersprungen`;
      errorDetails.hidden = false;
      errorOutput.textContent = errors.join("\n");
    }

    statusElement.textContent = `${statusText}.`;
  } catch (error) {
    console.error(error);
    currentResults = [];
    excelButton.disabled = true;
    statusElement.className = "status error";
    statusElement.textContent = `Fehler: ${error.message}`;
  } finally {
    competitionSelect.disabled = false;
    competitionInput.disabled = false;
    setCatalogButtonsDisabled(false);
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
excelButton.addEventListener("click", exportToExcel);
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
