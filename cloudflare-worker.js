const COMPETITIONS_URL = "https://competition.dlrg.net/de/competitions";
const LIVE_RESULTS_URL =
  "https://dlrg.net/service.php?doc=apps/liveergebnisse&modus=data";
const LIVE_SOURCES_URL =
  "https://jp-gnad.github.io/dlrg-phraser/live-sources.json";
const COMPETITIONS_FROM = "2020-01-01";
const COMPETITIONS_TILL = "2099-12-31";
const COMPETITION_RESULT_LIMIT = 50;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_SELECTION_ITEMS = 120;
const LIVE_SOURCE_CACHE_MS = 5 * 60 * 1000;
let liveSourceConfigCache = {
  expiresAt: 0,
  config: createEmptyLiveSourceConfig()
};

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const competition = requestUrl.searchParams.get("competition");
    const uuid = requestUrl.searchParams.get("uuid");
    const mode = requestUrl.searchParams.get("mode");
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      if (mode === "competitions") {
        if (request.method !== "GET") {
          return methodNotAllowed(corsHeaders);
        }

        const competitions = await loadAllCompetitions();

        return jsonResponse(
          {
            competitions,
            count: competitions.length,
            from: COMPETITIONS_FROM
          },
          200,
          corsHeaders,
          "public, max-age=300"
        );
      }

      if (mode === "live-direct") {
        if (request.method !== "GET") {
          return methodNotAllowed(corsHeaders);
        }

        const edvnummer = requestUrl.searchParams.get("edvnummer");
        const wkid = requestUrl.searchParams.get("wkid");
        const ak = requestUrl.searchParams.get("ak") || "";
        const result = await loadDirectLiveResult(edvnummer, wkid, ak);

        return jsonResponse(
          result,
          200,
          corsHeaders,
          "no-store"
        );
      }

      if (!competition) {
        return jsonResponse(
          { error: "competition muss angegeben werden." },
          400,
          corsHeaders
        );
      }

      if (mode === "catalog") {
        if (request.method !== "GET") {
          return methodNotAllowed(corsHeaders);
        }

        const catalog = await loadCompetitionCatalog(competition);
        return jsonResponse(
          catalog,
          200,
          corsHeaders,
          "public, max-age=120"
        );
      }

      if (mode === "selection") {
        if (request.method !== "POST") {
          return methodNotAllowed(corsHeaders);
        }

        const body = await readJsonBody(request);
        const items = validateSelectionItems(body.items);
        const results = await loadSelectedResults(competition, items);

        return jsonResponse(
          { competition, results },
          200,
          corsHeaders
        );
      }

      if (request.method !== "GET") {
        return methodNotAllowed(corsHeaders);
      }

      const competitionBaseUrl =
        `${COMPETITIONS_URL}/${encodeURIComponent(competition)}`;
      let targetUrl;

      if (uuid) {
        targetUrl = `${competitionBaseUrl}/results/${encodeURIComponent(uuid)}`;
      } else if (mode === "competition") {
        targetUrl = competitionBaseUrl;
      } else {
        targetUrl = `${competitionBaseUrl}/results`;
      }

      const upstreamResponse = await fetchUpstream(targetUrl);
      const responseText = await upstreamResponse.text();

      return new Response(responseText, {
        status: upstreamResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      return jsonResponse(
        {
          error: "Die DLRG-Seite konnte nicht geladen werden.",
          details: String(error)
        },
        502,
        corsHeaders
      );
    }
  }
};

function methodNotAllowed(corsHeaders) {
  return jsonResponse(
    { error: "Diese Anfrage-Methode wird nicht unterstützt." },
    405,
    corsHeaders
  );
}

function fetchUpstream(targetUrl) {
  return fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0"
    }
  });
}

async function fetchTextOrThrow(targetUrl, label) {
  const response = await fetchUpstream(targetUrl);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }

  return text;
}

function jsonResponse(data, status, corsHeaders, cacheControl = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl
    }
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Der Anfrageinhalt ist kein gültiges JSON.");
  }
}

function validateSelectionItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Es wurden keine Ergebnislisten ausgewählt.");
  }

  if (items.length > MAX_SELECTION_ITEMS) {
    throw new Error(
      `Es können höchstens ${MAX_SELECTION_ITEMS} Ergebnislisten geladen werden.`
    );
  }

  return items.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Eine ausgewählte Ergebnisliste ist ungültig.");
    }

    if (item.source === "competition") {
      const uuid = String(item.uuid || "").toLowerCase();

      if (!/^[0-9a-f-]{36}$/.test(uuid)) {
        throw new Error("Eine Ergebnis-UUID ist ungültig.");
      }

      return {
        key: String(item.key || `competition:${uuid}`),
        source: "competition",
        uuid
      };
    }

    if (item.source === "live") {
      const edvnummer = String(item.edvnummer || "");
      const wkid = String(item.wkid || "");
      const ak = String(item.ak || "").trim();

      if (!/^\d{1,12}$/.test(edvnummer) || !/^\d{1,12}$/.test(wkid) || !ak) {
        throw new Error("Eine Live-Ergebnisliste ist ungültig.");
      }

      if (ak.length > 250) {
        throw new Error("Die Bezeichnung einer Ergebnisliste ist zu lang.");
      }

      return {
        key: String(item.key || `live:${edvnummer}:${wkid}:${ak}`),
        source: "live",
        edvnummer,
        wkid,
        ak
      };
    }

    throw new Error("Eine Ergebnisquelle ist ungültig.");
  });
}

async function loadSelectedResults(competition, items) {
  const competitionBaseUrl =
    `${COMPETITIONS_URL}/${encodeURIComponent(competition)}`;

  return mapWithConcurrency(
    items,
    MAX_CONCURRENT_REQUESTS,
    async (item) => {
      try {
        if (item.source === "competition") {
          const html = await fetchTextOrThrow(
            `${competitionBaseUrl}/results/${encodeURIComponent(item.uuid)}`,
            `Ergebnisliste ${item.uuid}`
          );

          return {
            key: item.key,
            source: item.source,
            html
          };
        }

        const data = await fetchLiveResults(item);
        return {
          key: item.key,
          source: item.source,
          data
        };
      } catch (error) {
        return {
          key: item.key,
          source: item.source,
          error: String(error)
        };
      }
    }
  );
}

async function loadDirectLiveResult(edvnummer, wkid, ak = "") {
  const liveItem = validateDirectLiveItem(edvnummer, wkid, ak);
  const data = await fetchLiveResults(liveItem);

  if (liveItem.ak) {
    return {
      edvnummer: liveItem.edvnummer,
      wkid: liveItem.wkid,
      ak: liveItem.ak,
      data
    };
  }

  const liveSourceConfig = await loadLiveSourceConfig();
  const events = normalizeLiveEvents(
    {
      edvnummer: liveItem.edvnummer,
      wkid: liveItem.wkid
    },
    data,
    liveSourceConfig
  );

  return {
    edvnummer: liveItem.edvnummer,
    wkid: liveItem.wkid,
    warning: liveSourceConfig.warning,
    count: events.length,
    events,
    data
  };
}

function validateDirectLiveItem(edvnummer, wkid, ak = "") {
  const cleanEdvnummer = String(edvnummer || "");
  const cleanWkid = String(wkid || "");
  const cleanAk = String(ak || "").trim();

  if (!/^\d{1,12}$/.test(cleanEdvnummer) || !/^\d{1,12}$/.test(cleanWkid)) {
    throw new Error("EDV-Nummer und WKID müssen angegeben werden.");
  }

  if (cleanAk.length > 250) {
    throw new Error("Die Bezeichnung einer Ergebnisliste ist zu lang.");
  }

  return {
    edvnummer: cleanEdvnummer,
    wkid: cleanWkid,
    ak: cleanAk
  };
}

async function loadCompetitionCatalog(competition) {
  const competitionBaseUrl =
    `${COMPETITIONS_URL}/${encodeURIComponent(competition)}`;
  const [
    overviewResult,
    competitionResult,
    liveSourceConfig
  ] = await Promise.all([
    fetchTextResult(
      `${competitionBaseUrl}/results`,
      "Ergebnisübersicht"
    ),
    fetchTextResult(
      competitionBaseUrl,
      "Wettkampfseite"
    ),
    loadLiveSourceConfig()
  ]);
  const knownLiveCompetition = getKnownLiveCompetition(
    liveSourceConfig,
    competition
  );
  const details = overviewResult.ok
    ? extractResultDetailsOrFallback(
      overviewResult.text,
      knownLiveCompetition ? knownLiveCompetition.name : competition
    )
    : {
      name: knownLiveCompetition ? knownLiveCompetition.name : competition,
      from: knownLiveCompetition ? knownLiveCompetition.from : "",
      till: knownLiveCompetition ? knownLiveCompetition.till : "",
      events: []
    };
  const competitionEvents = normalizeCompetitionEvents(details.events || []);
  let events = competitionEvents;
  let source = "competition";
  const warnings = [];

  if (!overviewResult.ok && !knownLiveCompetition) {
    warnings.push(overviewResult.error);
  }

  if (!competitionResult.ok && !knownLiveCompetition) {
    warnings.push(competitionResult.error);
  }

  if (liveSourceConfig.warning) {
    warnings.push(liveSourceConfig.warning);
  }

  const liveReferenceFilter = getKnownLiveReferences(
    liveSourceConfig,
    competition
  );
  const liveResultUrls = getKnownLiveResultPages(
    liveSourceConfig,
    competition
  );
  const externalResultsUrl = competitionResult.ok
    ? extractExternalResultsUrl(competitionResult.text)
    : "";

  if (externalResultsUrl) {
    liveResultUrls.push(externalResultsUrl);
  }

  if (liveResultUrls.length > 0) {
    try {
      const liveCatalogs = await mapWithConcurrency(
        dedupeValues(liveResultUrls),
        MAX_CONCURRENT_REQUESTS,
        (url) => loadLiveCatalog(url, liveSourceConfig, liveReferenceFilter)
      );
      const liveEvents = dedupeCatalogEvents(liveCatalogs.flat());

      if (liveEvents.length > 0) {
        events = dedupeCatalogEvents([...events, ...liveEvents]);
        source = competitionEvents.length > 0 ? "mixed" : "live";
      }
    } catch (error) {
      warnings.push(
        `Zusätzliche Live-Ergebnisse konnten nicht geladen werden: ${error}`
      );
    }
  }

  if (liveResultUrls.length === 0 && liveReferenceFilter.size > 0) {
    try {
      const liveEvents = await loadDirectLiveCatalog(
        Array.from(liveReferenceFilter),
        liveSourceConfig
      );

      if (liveEvents.length > 0) {
        events = dedupeCatalogEvents([...events, ...liveEvents]);
        source = competitionEvents.length > 0 ? "mixed" : "live";
      }
    } catch (error) {
      warnings.push(
        `Direkte Live-Ergebnisse konnten nicht geladen werden: ${error}`
      );
    }
  }

  if (events.length === 0) {
    throw new Error("In der Ergebnisübersicht wurden keine Listen gefunden.");
  }

  const useKnownLiveMetadata =
    knownLiveCompetition && competitionEvents.length === 0;

  return {
    competition,
    competitionName: String(
      (useKnownLiveMetadata && knownLiveCompetition.name) ||
        details.name ||
        (knownLiveCompetition && knownLiveCompetition.name) ||
        competition
    ),
    from: normalizeDate(
      (useKnownLiveMetadata && knownLiveCompetition.from) ||
        details.from ||
        (knownLiveCompetition && knownLiveCompetition.from)
    ),
    till: normalizeDate(
      (useKnownLiveMetadata && knownLiveCompetition.till) ||
        details.till ||
        (knownLiveCompetition && knownLiveCompetition.till)
    ),
    source,
    warning: warnings.join(" "),
    count: events.length,
    events: sortCatalogEvents(events)
  };
}

async function fetchTextResult(targetUrl, label) {
  try {
    return {
      ok: true,
      text: await fetchTextOrThrow(targetUrl, label)
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: `${label}: ${error}`
    };
  }
}

async function loadLiveSourceConfig() {
  const now = Date.now();

  if (liveSourceConfigCache.expiresAt > now) {
    return liveSourceConfigCache.config;
  }

  try {
    const response = await fetch(LIVE_SOURCES_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const config = normalizeLiveSourceConfig(await response.json());
    liveSourceConfigCache = {
      expiresAt: now + LIVE_SOURCE_CACHE_MS,
      config
    };

    return config;
  } catch (error) {
    const config = {
      ...createEmptyLiveSourceConfig(),
      warning:
        `Live-Quellen-Konfiguration konnte nicht geladen werden: ${error}`
    };
    liveSourceConfigCache = {
      expiresAt: now + 60 * 1000,
      config
    };

    return config;
  }
}

function createEmptyLiveSourceConfig() {
  return {
    competitions: [],
    resultPages: {},
    references: {},
    eventTypes: {},
    warning: ""
  };
}

function normalizeLiveSourceConfig(config) {
  const output = createEmptyLiveSourceConfig();

  if (Array.isArray(config && config.competitions)) {
    output.competitions = config.competitions
      .filter((competition) => competition && competition.acronym)
      .map((competition) => ({
        acronym: String(competition.acronym).trim(),
        name: String(competition.name || competition.acronym).trim(),
        from: normalizeDate(competition.from),
        till: normalizeDate(competition.till)
      }))
      .filter((competition) => competition.acronym && competition.name);
  }

  if (config && config.resultPages && typeof config.resultPages === "object") {
    Object.entries(config.resultPages).forEach(([code, urls]) => {
      const acronym = String(code || "").trim().toUpperCase();

      if (!acronym || !Array.isArray(urls)) {
        return;
      }

      output.resultPages[acronym] = urls
        .map((url) => String(url || "").trim())
        .filter(Boolean);
    });
  }

  if (config && config.eventTypes && typeof config.eventTypes === "object") {
    Object.entries(config.eventTypes).forEach(([key, value]) => {
      const normalizedType =
        String(value || "").toLowerCase() === "individual"
          ? "Individual"
          : "Team";

      output.eventTypes[String(key || "").trim()] = normalizedType;
    });
  }

  if (config && config.references && typeof config.references === "object") {
    Object.entries(config.references).forEach(([code, references]) => {
      const acronym = String(code || "").trim().toUpperCase();

      if (!acronym || !Array.isArray(references)) {
        return;
      }

      output.references[acronym] = references
        .map((reference) => String(reference || "").trim())
        .filter((reference) => /^\d{1,12}:\d{1,12}$/.test(reference));
    });
  }

  return output;
}

function getKnownLiveResultPages(liveSourceConfig, competition) {
  const acronym = String(competition || "").toUpperCase();
  return liveSourceConfig.resultPages[acronym]
    ? [...liveSourceConfig.resultPages[acronym]]
    : [];
}

function getKnownLiveCompetition(liveSourceConfig, competition) {
  const acronym = String(competition || "").toUpperCase();
  return liveSourceConfig.competitions.find(
    (item) => item.acronym.toUpperCase() === acronym
  );
}

function getKnownLiveReferences(liveSourceConfig, competition) {
  const acronym = String(competition || "").toUpperCase();
  return new Set(liveSourceConfig.references[acronym] || []);
}

function dedupeValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function dedupeCatalogEvents(events) {
  const eventsByKey = new Map();

  events.forEach((event) => {
    eventsByKey.set(event.key, event);
  });

  return Array.from(eventsByKey.values());
}

function normalizeCompetitionEvents(events) {
  return events
    .filter((event) => event && event.id)
    .map((event) => {
      const uuid = String(event.id).toLowerCase();

      return {
        key: `competition:${uuid}`,
        source: "competition",
        uuid,
        eventType:
          String(event.eventType || "").toLowerCase() === "individual"
            ? "Individual"
            : "Team",
        discipline: String(event.discipline || "").trim(),
        gender: normalizeGender(event.gender),
        ageGroup: String(event.agegroup || "").trim(),
        round: normalizeCompetitionRound(event.round),
        date: normalizeDate(event.date)
      };
    })
    .filter((event) => event.discipline);
}

function extractResultDetailsOrFallback(html, competition) {
  try {
    return extractResultDetails(html);
  } catch {
    return {
      name: competition,
      events: []
    };
  }
}

function normalizeGender(value) {
  const normalized = String(value || "").toLowerCase();

  if (normalized === "female" || normalized === "weiblich") {
    return "w";
  }

  if (
    normalized === "male" ||
    normalized === "männlich" ||
    normalized === "maennlich" ||
    normalized === "mã¤nnlich" ||
    normalized.includes("nnlich")
  ) {
    return "m";
  }

  return "mixed";
}

function normalizeCompetitionRound(round) {
  const value = round && round.type;
  const normalized = String(value || "").toLowerCase();
  const roundNumber = normalizeRoundNumber(round && round.round);

  if (
    normalized.includes("semi") ||
    normalized.includes("quarter") ||
    normalized.includes("intermediate") ||
    normalized.includes("zwischen")
  ) {
    return `Zwischenlauf ${roundNumber || 1}`;
  }

  if (normalized.includes("final")) {
    return "Finale";
  }

  if (
    normalized.includes("heat") ||
    normalized.includes("prelim") ||
    normalized.includes("qualif") ||
    normalized.includes("vorlauf")
  ) {
    return roundNumber
      ? `Zwischenlauf ${roundNumber}`
      : "Vorlauf";
  }

  if (roundNumber) {
    return `Zwischenlauf ${roundNumber}`;
  }

  return value ? String(value) : "Ergebnis";
}

function normalizeRoundNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeDate(value) {
  const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function sortCatalogEvents(events) {
  return [...events].sort((left, right) => {
    const fields = ["eventType", "ageGroup", "discipline", "gender", "round"];

    for (const field of fields) {
      const comparison = String(left[field] || "").localeCompare(
        String(right[field] || ""),
        "de"
      );

      if (comparison) {
        return comparison;
      }
    }

    return left.key.localeCompare(right.key, "de");
  });
}

async function loadLiveCatalog(
  externalResultsUrl,
  liveSourceConfig,
  referenceFilter = new Set()
) {
  assertAllowedExternalUrl(externalResultsUrl);
  const externalHtml = await fetchTextOrThrow(
    externalResultsUrl,
    "Externe Ergebnisseite"
  );
  let references = extractLiveReferences(externalHtml);

  if (referenceFilter.size > 0) {
    references = references.filter((reference) =>
      referenceFilter.has(`${reference.edvnummer}:${reference.wkid}`)
    );
  }

  if (references.length === 0) {
    return [];
  }

  const sourceCatalogs = await mapWithConcurrency(
    references,
    MAX_CONCURRENT_REQUESTS,
    async (reference) => {
      const data = await fetchLiveResults(reference);
      return normalizeLiveEvents(reference, data, liveSourceConfig);
    }
  );

  return sourceCatalogs.flat();
}

async function loadDirectLiveCatalog(referenceKeys, liveSourceConfig) {
  const references = referenceKeys
    .map(parseLiveReferenceKey)
    .filter(Boolean);

  const sourceCatalogs = await mapWithConcurrency(
    references,
    MAX_CONCURRENT_REQUESTS,
    async (reference) => {
      const data = await fetchLiveResults(reference);
      return normalizeLiveEvents(reference, data, liveSourceConfig);
    }
  );

  return sourceCatalogs.flat();
}

function parseLiveReferenceKey(referenceKey) {
  const match = String(referenceKey || "").match(/^(\d{1,12}):(\d{1,12})$/);

  if (!match) {
    return null;
  }

  return {
    edvnummer: match[1],
    wkid: match[2]
  };
}

function assertAllowedExternalUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const allowed =
    hostname === "dlrg.de" ||
    hostname.endsWith(".dlrg.de") ||
    hostname === "dlrg-jugend.de" ||
    hostname.endsWith(".dlrg-jugend.de") ||
    hostname === "dlrg.net" ||
    hostname.endsWith(".dlrg.net");

  if (url.protocol !== "https:" || !allowed) {
    throw new Error("Die externe Ergebnisquelle ist nicht erlaubt.");
  }
}

function extractLiveReferences(html) {
  const references = [];
  const seen = new Set();
  const pattern =
    /showLiveErgebnisse\([^,]+,\s*['"](\d+)['"]\s*,\s*(\d+)/g;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const key = `${match[1]}:${match[2]}`;

    if (!seen.has(key)) {
      seen.add(key);
      references.push({
        edvnummer: match[1],
        wkid: match[2]
      });
    }
  }

  return references;
}

async function fetchLiveResults({ edvnummer, wkid, ak = "" }) {
  const url = new URL(LIVE_RESULTS_URL);
  url.searchParams.set("edvnummer", edvnummer);
  url.searchParams.set("wkid", wkid);
  url.searchParams.set("callback", "phraserCallback");

  if (ak) {
    url.searchParams.set("ak", ak);
    url.searchParams.set("gld", "");
    url.searchParams.set("qgld", "");
  }

  const response = await fetch(url.toString(), {
    redirect: "follow",
    headers: {
      "Accept": "text/javascript,application/javascript",
      "User-Agent": "Mozilla/5.0"
    }
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Live-Ergebnisse ${wkid}: HTTP ${response.status}`);
  }

  return parseJsonpResponse(text);
}

function parseJsonpResponse(text) {
  const start = text.indexOf("('");
  const end = text.lastIndexOf("');");

  if (start === -1 || end <= start) {
    throw new Error("Die Live-Ergebnisquelle lieferte kein gültiges JSONP.");
  }

  const jsonText = decodeSingleQuotedString(text.slice(start + 2, end));

  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error("Die Live-Ergebnisquelle lieferte kein gültiges JSON.");
  }
}

function decodeSingleQuotedString(value) {
  let output = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character !== "\\") {
      output += character;
      continue;
    }

    index += 1;
    const escaped = value[index];

    if (escaped === "n") {
      output += "\n";
    } else if (escaped === "r") {
      output += "\r";
    } else if (escaped === "t") {
      output += "\t";
    } else if (escaped === "b") {
      output += "\b";
    } else if (escaped === "f") {
      output += "\f";
    } else if (escaped === "v") {
      output += "\v";
    } else if (escaped === "u") {
      const hex = value.slice(index + 1, index + 5);

      if (!/^[0-9a-f]{4}$/i.test(hex)) {
        throw new Error("Ungültige Unicode-Escapesequenz in JSONP.");
      }

      output += String.fromCharCode(parseInt(hex, 16));
      index += 4;
    } else if (escaped === "x") {
      const hex = value.slice(index + 1, index + 3);

      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        throw new Error("Ungültige Escapesequenz in JSONP.");
      }

      output += String.fromCharCode(parseInt(hex, 16));
      index += 2;
    } else {
      output += escaped;
    }
  }

  return output;
}

function normalizeLiveEvents(reference, data, liveSourceConfig) {
  const sourceName = String(data.wkname || "");
  const eventType =
    liveSourceConfig.eventTypes[`${reference.edvnummer}:${reference.wkid}`] ||
    (/individual|einzel/i.test(sourceName) ? "Individual" : "Team");
  const round = normalizeLiveRound(sourceName);
  const categories = Array.isArray(data.aks) ? data.aks : [];

  return categories
    .map((ak) => parseLiveCategory(String(ak), eventType, round))
    .filter(Boolean)
    .map((metadata) => ({
      key:
        `live:${reference.edvnummer}:${reference.wkid}:${metadata.ak}`,
      source: "live",
      edvnummer: reference.edvnummer,
      wkid: reference.wkid,
      ak: metadata.ak,
      eventType: metadata.eventType,
      discipline: metadata.discipline,
      gender: metadata.gender,
      ageGroup: metadata.ageGroup,
      round: metadata.round,
      date: ""
    }));
}

function normalizeLiveRound(sourceName) {
  const normalized = String(sourceName || "").toLowerCase();
  const intermediateMatch = normalized.match(
    /(?:zwischenlauf|intermediate|semi-?final|quarter-?final)\D*(\d+)?/
  );

  if (intermediateMatch) {
    return `Zwischenlauf ${Number(intermediateMatch[1]) || 1}`;
  }

  if (normalized.includes("final")) {
    return "Finale";
  }

  if (
    normalized.includes("heat") ||
    normalized.includes("prelim") ||
    normalized.includes("qualif") ||
    normalized.includes("vorlauf")
  ) {
    return "Vorlauf";
  }

  return "Ergebnis";
}

function parseLiveCategory(ak, eventType, round) {
  const genderMatch = ak.match(
    /\s+(female|male|mixed|weiblich|männlich|maennlich|m\S?nnlich|gemischt)$/i
  );

  if (!genderMatch) {
    return null;
  }

  const gender = normalizeGender(genderMatch[1]);
  const parts = ak
    .slice(0, genderMatch.index)
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const firstPart = parts.shift() || "";
  const ageGroup = stripLiveCategoryEventType(firstPart);
  const categoryEventType =
    getLiveCategoryEventType(firstPart) ||
    getLiveAgeGroupEventType(ageGroup, eventType) ||
    eventType;
  const roundFromCategory = parts
    .map((part) => normalizeLiveCategoryRound(part))
    .find(Boolean);
  const disciplineParts = parts.filter(
    (part) => !isRoundCategoryPart(part)
  );
  const discipline = disciplineParts.join(" - ").trim() || "Gesamtwertung";

  return {
    ak,
    eventType: categoryEventType,
    round: roundFromCategory || round,
    ageGroup,
    gender,
    discipline
  };
}

function getLiveCategoryEventType(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (/^(?:einzel|individual)\b/.test(normalized)) {
    return "Individual";
  }

  if (/^(?:mannschaft|team|relay|staffel)\b/.test(normalized)) {
    return "Team";
  }

  return "";
}

function stripLiveCategoryEventType(value) {
  return String(value || "")
    .trim()
    .replace(/^(?:einzel|individual|mannschaft|team|relay|staffel)\s+/i, "")
    .trim();
}

function getLiveAgeGroupEventType(ageGroup, defaultEventType) {
  if (defaultEventType !== "Individual") {
    return "";
  }

  const match = String(ageGroup || "").match(/^AK\s+(\d{3,})\+?/i);

  if (match) {
    return "Team";
  }

  return "";
}

function normalizeLiveCategoryRound(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const numberMatch = normalized.match(/\d+/);
  const number = numberMatch ? Number(numberMatch[0]) : 0;

  if (
    normalized.includes("zwischen") ||
    normalized.includes("intermediate") ||
    normalized.includes("semi") ||
    normalized.includes("quarter")
  ) {
    return `Zwischenlauf ${number || 1}`;
  }

  if (normalized.includes("final")) {
    return "Finale";
  }

  if (
    normalized.includes("vorlauf") ||
    normalized.includes("heat") ||
    normalized.includes("prelim") ||
    normalized.includes("qualif")
  ) {
    return "Vorlauf";
  }

  return "";
}

function isRoundCategoryPart(value) {
  return /^(?:finale?|vorlauf|heats?|preliminaries|qualifications?|zwischenlauf(?:\s+\d+)?|intermediate(?:\s+round)?(?:\s+\d+)?|semi-?finals?|quarter-?finals?)$/i.test(
    String(value || "").trim()
  );
}

function extractResultDetails(html) {
  const details = extractJsonProperty(html, "resultDetails");

  if (!details || typeof details !== "object") {
    throw new Error("Ergebnisübersicht konnte nicht ausgelesen werden.");
  }

  return details;
}

function extractExternalResultsUrl(html) {
  const chunks = extractNextDataChunks(html);

  for (const chunk of chunks) {
    let searchFrom = 0;

    while (searchFrom < chunk.length) {
      const markerIndex = chunk.indexOf('"links":', searchFrom);

      if (markerIndex === -1) {
        break;
      }

      const valueStart = markerIndex + '"links":'.length;

      try {
        const links = JSON.parse(readJsonValue(chunk, valueStart));

        if (Array.isArray(links)) {
          const resultLink = links.find(
            (link) =>
              link &&
              /^results?$/i.test(String(link.name || "").trim()) &&
              link.url
          );

          if (resultLink) {
            return String(resultLink.url);
          }
        }
      } catch {
        // Continue with another links property.
      }

      searchFrom = valueStart + 1;
    }
  }

  return "";
}

function extractJsonProperty(html, propertyName) {
  const marker = `"${propertyName}":`;
  const chunks = extractNextDataChunks(html);

  for (const chunk of chunks) {
    const markerIndex = chunk.indexOf(marker);

    if (markerIndex === -1) {
      continue;
    }

    const valueStart = markerIndex + marker.length;

    try {
      return JSON.parse(readJsonValue(chunk, valueStart));
    } catch {
      // Continue with another script chunk.
    }
  }

  return null;
}

async function loadAllCompetitions() {
  const ranges = createCompetitionRanges();
  const [competitionGroups, liveSourceConfig] = await Promise.all([
    mapWithConcurrency(
      ranges,
      MAX_CONCURRENT_REQUESTS,
      (range) => fetchCompetitionRange(range.from, range.till)
    ),
    loadLiveSourceConfig()
  ]);
  const competitionsByAcronym = new Map();

  competitionGroups.flat().forEach((competition) => {
    competitionsByAcronym.set(competition.acronym, competition);
  });

  liveSourceConfig.competitions.forEach((competition) => {
    if (!competitionsByAcronym.has(competition.acronym)) {
      competitionsByAcronym.set(competition.acronym, competition);
    }
  });

  return Array.from(competitionsByAcronym.values()).sort((left, right) => {
    const dateComparison = left.from.localeCompare(right.from);
    return dateComparison || left.name.localeCompare(right.name, "de");
  });
}

function createCompetitionRanges() {
  const currentYear = new Date().getUTCFullYear();
  const horizonYear = currentYear + 5;
  const ranges = [];

  for (
    let year = Number(COMPETITIONS_FROM.slice(0, 4));
    year <= horizonYear;
    year += 1
  ) {
    ranges.push({
      from: `${year}-01-01`,
      till: `${year}-12-31`
    });
  }

  if (horizonYear < 2099) {
    ranges.push({
      from: `${horizonYear + 1}-01-01`,
      till: COMPETITIONS_TILL
    });
  }

  return ranges;
}

async function fetchCompetitionRange(from, till) {
  const competitionsUrl = new URL(COMPETITIONS_URL);
  competitionsUrl.searchParams.set("from", from);
  competitionsUrl.searchParams.set("till", till);

  const responseText = await fetchTextOrThrow(
    competitionsUrl.toString(),
    `Wettkampfliste ${from} bis ${till}`
  );
  const competitions = extractCompetitions(responseText);

  if (competitions.length < COMPETITION_RESULT_LIMIT || from === till) {
    return competitions;
  }

  const split = splitDateRange(from, till);
  const [leftCompetitions, rightCompetitions] = await Promise.all([
    fetchCompetitionRange(split.left.from, split.left.till),
    fetchCompetitionRange(split.right.from, split.right.till)
  ]);

  return [...leftCompetitions, ...rightCompetitions];
}

function splitDateRange(from, till) {
  const start = parseIsoDate(from);
  const end = parseIsoDate(till);
  const middleTime = start.getTime() + Math.floor(
    (end.getTime() - start.getTime()) / 2
  );
  const middle = new Date(middleTime);
  const rightStart = new Date(middle);
  rightStart.setUTCDate(rightStart.getUTCDate() + 1);

  return {
    left: {
      from,
      till: formatIsoDate(middle)
    },
    right: {
      from: formatIsoDate(rightStart),
      till
    }
  };
}

function parseIsoDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(value) {
  return value.toISOString().slice(0, 10);
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

function extractCompetitions(html) {
  const marker = '"values":[';
  const chunks = extractNextDataChunks(html);

  for (const chunk of chunks) {
    let searchFrom = 0;

    while (searchFrom < chunk.length) {
      const markerIndex = chunk.indexOf(marker, searchFrom);

      if (markerIndex === -1) {
        break;
      }

      const arrayStart = markerIndex + marker.length - 1;

      try {
        const values = JSON.parse(readJsonValue(chunk, arrayStart));

        if (Array.isArray(values)) {
          const competitions = values
            .filter((item) => item && item.acronym && item.name)
            .map((item) => ({
              acronym: String(item.acronym).trim(),
              name: String(item.name).trim(),
              from: String(item.from || ""),
              till: String(item.till || "")
            }))
            .filter((item) => item.from >= COMPETITIONS_FROM);

          if (competitions.length > 0 || values.length === 0) {
            return competitions;
          }
        }
      } catch {
        // Search for the next values array if this one is unrelated.
      }

      searchFrom = arrayStart + 1;
    }
  }

  throw new Error("Wettkampfliste konnte nicht ausgelesen werden.");
}

function extractNextDataChunks(html) {
  const chunks = [];
  const pattern =
    /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)<\/script>/g;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // Ignore malformed or unrelated script chunks.
    }
  }

  return chunks;
}

function readJsonValue(text, startIndex) {
  let index = startIndex;

  while (/\s/.test(text[index] || "")) {
    index += 1;
  }

  const opening = text[index];
  const closing = opening === "[" ? "]" : opening === "{" ? "}" : "";

  if (!closing) {
    throw new Error("JSON-Objekt oder -Array erwartet.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let cursor = index; cursor < text.length; cursor += 1) {
    const character = text[cursor];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;

      if (depth === 0) {
        return text.slice(index, cursor + 1);
      }
    }
  }

  throw new Error("Unvollständige JSON-Daten empfangen.");
}
