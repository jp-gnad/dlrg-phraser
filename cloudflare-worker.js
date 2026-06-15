const COMPETITIONS_URL = "https://competition.dlrg.net/de/competitions";
const COMPETITIONS_FROM = "2025-01-01";
const COMPETITIONS_TILL = "2099-12-31";
const COMPETITION_RESULT_LIMIT = 50;
const MAX_CONCURRENT_LIST_REQUESTS = 4;

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const competition = requestUrl.searchParams.get("competition");
    const uuid = requestUrl.searchParams.get("uuid");
    const mode = requestUrl.searchParams.get("mode");

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { error: "Nur GET-Anfragen werden unterstützt." },
        405,
        corsHeaders
      );
    }

    try {
      if (mode === "competitions") {
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

      if (!competition) {
        return jsonResponse(
          { error: "competition muss angegeben werden." },
          400,
          corsHeaders
        );
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

function fetchUpstream(targetUrl) {
  return fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0"
    }
  });
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

async function loadAllCompetitions() {
  const ranges = createCompetitionRanges();
  const competitionGroups = await mapWithConcurrency(
    ranges,
    MAX_CONCURRENT_LIST_REQUESTS,
    (range) => fetchCompetitionRange(range.from, range.till)
  );
  const competitionsByAcronym = new Map();

  competitionGroups.flat().forEach((competition) => {
    competitionsByAcronym.set(competition.acronym, competition);
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

  for (let year = 2025; year <= horizonYear; year += 1) {
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

  const upstreamResponse = await fetchUpstream(competitionsUrl.toString());
  const responseText = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    throw new Error(
      `Wettkampfliste ${from} bis ${till}: HTTP ${upstreamResponse.status}`
    );
  }

  const competitions = extractCompetitions(responseText);

  if (
    competitions.length < COMPETITION_RESULT_LIMIT ||
    from === till
  ) {
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
        const values = JSON.parse(readJsonArray(chunk, arrayStart));

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

function readJsonArray(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

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
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error("Unvollständige Wettkampfliste empfangen.");
}
