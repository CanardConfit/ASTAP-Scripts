import { format } from "date-fns";
import { Octokit } from "octokit";
import { load } from "cheerio";
import { parseAstapHistory } from "./astap-history.js";
import { log } from "./tools.js";
import { AppError } from "./errors.js";

const HISTORY_URL = "https://www.hnsky.org/history_astap.htm";

export const scrapeAstapHistory = async () => {
  let response: Response;
  try {
    response = await fetch(HISTORY_URL, {
      headers: { "user-agent": "ASTAP-Scripts/2.0" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new AppError("HISTORY_PAGE_UNAVAILABLE", "Unable to retrieve the ASTAP history page.", 5, { url: HISTORY_URL }, error);
  }

  if (!response.ok) {
    throw new AppError("HISTORY_PAGE_HTTP_ERROR", `ASTAP history request failed with HTTP ${response.status}.`, 5, {
      url: HISTORY_URL,
      httpStatus: response.status,
    });
  }

  const html = new TextDecoder("windows-1252").decode(await response.arrayBuffer());
  const $ = load(html);
  const paragraphs = $("p")
    .toArray()
    .map((element) => $(element).text());
  return { paragraphsCount: paragraphs.length, releases: parseAstapHistory(paragraphs) };
};

export const getVersionsInfo = async (specifiedDate: Date, octokit: Octokit, owner: string, repo: string, printFormatted = true) => {
  const logs: string[] = [];
  const startedAt = Date.now();
  const formattedDate = format(specifiedDate, "yyyy-MM-dd");

  log("GetVersionsInfo", `[General] Specified Date: ${formattedDate}`, logs, printFormatted);
  log("GetVersionsInfo", "[History] Fetching official release history...", logs, printFormatted);

  const history = await scrapeAstapHistory();
  log("GetVersionsInfo", `[History] Parsed ${history.paragraphsCount} paragraphs.`, logs, printFormatted);

  const releases = history.releases;
  const releasesById = new Map(releases.map((release) => [release.id, release.content]));
  log("GetVersionsInfo", `[Cleaner] Found ${releases.length} release descriptions.`, logs, printFormatted);

  log("GetVersionsInfo", "[Commits] Getting commits...", logs, printFormatted);
  const commitsRaw = await octokit.rest.repos.listCommits({
    repo,
    owner,
    sha: "imported",
    since: formattedDate,
  });

  const commits = commitsRaw.data
    .map((commit) => {
      const date = commit.commit.author?.date;
      if (date?.startsWith(formattedDate)) return null;

      const title = commit.commit.message.split("\n")[0].replaceAll("'", "").trim();
      const releaseId = `ASTAP_${title.replace(/^v/i, "").replaceAll("-", ".")}`;

      return {
        date,
        commit: commit.sha,
        title,
        content: releasesById.get(releaseId) || "Nothing found about this version",
      };
    })
    .filter((commit) => commit !== null);

  log("GetVersionsInfo", `[General] Total Time: ${Date.now() - startedAt}ms`, logs, printFormatted);

  const result = { commits, logs };
  return result;
};
