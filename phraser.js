"use strict";

const WORKER_URL = "https://dlrg-results.jp-gnad.workers.dev/";
const MAX_CONCURRENT_REQUESTS = 4;
const AUTH_SESSION_KEY = "dlrg-phraser-auth-year";

let currentResults = [];
let competitionListLoaded = false;

const loginScreen = document.getElementById("loginScreen");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("password");
const loginError = document.getElementById("loginError");
const app = document.getElementById("app");
const logoutButton = document.getElementById("logoutButton");
const competitionSelect = document.getElementById("competitionSelect");
const competitionListInfo = document.getElementById("competitionListInfo");
const manualCompetitionGroup = document.getElementById(
  "manualCompetitionGroup"
);
const competitionInput = document.getElementById("competition");
const loadButton = document.getElementById("loadButton");
const excelButton = document.getElementById("excelButton");
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

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return text;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Die Wettkampfliste enthält kein gültiges JSON.");
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
  const hasCompetitionCode = usesManualCode
    ? Boolean(competitionInput.value.trim())
    : Boolean(competitionSelect.value);

  manualCompetitionGroup.hidden = !usesManualCode;
  loadButton.disabled = !hasCompetitionCode;
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
  loadButton.disabled = true;
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

function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function stripHtml(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function extractTagText(html, tagName) {
  const expression = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );
  const match = html.match(expression);
  return match ? stripHtml(match[1]) : "";
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

function cleanCompetitionName(value, fallback) {
  let name = String(value || "")
    .replace(/\s*[-|]\s*(Ergebnisse|Results)\s*$/i, "")
    .trim();

  if (!name || /^(Ergebnisse|Results)$/i.test(name) || name.length > 180) {
    name = fallback;
  }

  return name;
}

function extractOverview(html, competitionCode) {
  const uuidSet = new Set();
  const uuidPattern =
    /\/results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  let match;

  while ((match = uuidPattern.exec(html)) !== null) {
    uuidSet.add(match[1].toLowerCase());
  }

  let competitionName = extractTagText(html, "h1");

  if (!competitionName || /^(Ergebnisse|Results)$/i.test(competitionName)) {
    competitionName = extractTagText(html, "title");
  }

  return {
    competitionName: cleanCompetitionName(competitionName, competitionCode),
    uuids: Array.from(uuidSet)
  };
}

function extractCompetitionEndDate(html) {
  const visibleText = extractVisibleText(html).join(" ");
  const dateRangeMatch = visibleText.match(
    /\b(\d{1,2}\.\d{1,2}\.\d{4})\s*[-–—]\s*(\d{1,2}\.\d{1,2}\.\d{4})\b/
  );

  if (dateRangeMatch) {
    return dateRangeMatch[2];
  }

  const singleDateMatch = visibleText.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/);
  return singleDateMatch ? singleDateMatch[1] : "";
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

function isRepeatedHeader(first, second, third) {
  const firstValue = String(first || "").trim().toLowerCase();
  const secondValue = String(second || "").trim().toLowerCase();
  const thirdValue = String(third || "").trim().toLowerCase();

  return (
    firstValue === "name" &&
    (secondValue === "verein" || secondValue === "club") &&
    (thirdValue === "zeit" || thirdValue === "time")
  );
}

function findResultHeader(tokens) {
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (isRepeatedHeader(tokens[index], tokens[index + 1], tokens[index + 2])) {
      return index;
    }
  }

  return -1;
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

function parseResultValue(firstValue, secondValue) {
  const first = String(firstValue || "").trim();
  const second = String(secondValue || "").trim();

  if (looksLikeTime(first)) {
    return { time: first, status: "", consumedValues: 1 };
  }

  const combinedMatch = first.match(/^(.+?)\s+(\d{1,3}:\d{2}[,.]\d{2})$/);

  if (combinedMatch && looksLikeStatus(combinedMatch[1])) {
    return {
      status: combinedMatch[1].trim(),
      time: combinedMatch[2].trim(),
      consumedValues: 1
    };
  }

  if (looksLikeStatus(first) && looksLikeTime(second)) {
    return { status: first, time: second, consumedValues: 2 };
  }

  if (looksLikeStatus(first)) {
    return { status: first, time: "", consumedValues: 1 };
  }

  return { status: "", time: "", consumedValues: 0 };
}

function parseResultPage(html, context) {
  const tokens = extractVisibleText(html);
  const headerIndex = findResultHeader(tokens);

  if (headerIndex === -1) {
    throw new Error("Überschriften Name/Verein/Zeit nicht gefunden.");
  }

  const metadata = parseTitle(findResultTitle(tokens, headerIndex));
  const results = [];
  let index = headerIndex + 3;

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

    const parsedValue = parseResultValue(firstResultValue, secondResultValue);

    if (parsedValue.consumedValues === 0) {
      break;
    }

    results.push({
      place: results.length + 1,
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

async function mapWithConcurrency(items, concurrency, task) {
  const output = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      output[currentIndex] = await task(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner()
  );

  await Promise.all(runners);
  return output;
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

async function loadAllResults() {
  const competitionCode = getSelectedCompetitionCode();

  if (!competitionCode) {
    statusElement.className = "status error";
    statusElement.textContent = "Bitte einen Wettkampfcode eingeben.";
    return;
  }

  loadButton.disabled = true;
  excelButton.disabled = true;
  currentResults = [];
  resultTable.replaceChildren();
  errorDetails.hidden = true;
  errorOutput.textContent = "";
  statusElement.className = "status";
  statusElement.textContent =
    "Wettkampf- und Ergebnisübersicht werden geladen ...";

  try {
    const [overviewHtml, competitionInfoHtml] = await Promise.all([
      fetchText(buildWorkerUrl(competitionCode)),
      fetchText(buildWorkerUrl(competitionCode, { mode: "competition" }))
    ]);
    const overview = extractOverview(overviewHtml, competitionCode);
    const competitionDate = extractCompetitionEndDate(competitionInfoHtml);

    if (overview.uuids.length === 0) {
      throw new Error("Auf der Übersichtsseite wurden keine UUIDs gefunden.");
    }

    pageTitle.textContent = overview.competitionName;
    let completed = 0;
    const errors = [];
    statusElement.textContent =
      `${overview.uuids.length} Ergebnislisten gefunden. Daten werden geladen ...`;

    const resultGroups = await mapWithConcurrency(
      overview.uuids,
      MAX_CONCURRENT_REQUESTS,
      async (uuid) => {
        try {
          const html = await fetchText(
            buildWorkerUrl(competitionCode, { uuid })
          );

          return parseResultPage(html, {
            competitionCode,
            competitionName: overview.competitionName,
            competitionDate
          });
        } catch (error) {
          errors.push(`${uuid}: ${error.message}`);
          return [];
        } finally {
          completed += 1;
          statusElement.textContent =
            `${completed} von ${overview.uuids.length} Ergebnislisten verarbeitet ...`;
        }
      }
    );

    currentResults = resultGroups.flat();
    renderTable(currentResults);
    excelButton.disabled = currentResults.length === 0;

    let statusText =
      `${overview.uuids.length} Ergebnislisten verarbeitet, ` +
      `${currentResults.length} Ergebniszeilen geladen`;
    statusText += competitionDate
      ? `, Wettkampfdatum: ${competitionDate}`
      : ", Wettkampfdatum nicht erkannt";

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
    loadButton.disabled = false;
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
loadButton.addEventListener("click", loadAllResults);
excelButton.addEventListener("click", exportToExcel);
competitionSelect.addEventListener("change", () => {
  setCompetitionControlsEnabled();

  if (competitionSelect.value === "__manual__") {
    competitionInput.focus();
  }
});
competitionInput.addEventListener("input", setCompetitionControlsEnabled);
competitionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    loadAllResults();
  }
});

initializeAuthentication();
