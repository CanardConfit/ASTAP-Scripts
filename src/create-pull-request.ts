import { Octokit } from "octokit";
import { format } from "date-fns";
import { getVersionsInfo } from "./get-version-info.js";
import { log } from "./tools.js";
import { runChecks } from "./run-checks.js";
import { AppError } from "./errors.js";

export const createPullRequest = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  runChecks_b: boolean,
  raw = "",
  specifiedDate: Date = null,
) => {
  const logs: string[] = [];
  log("CreatePullRequest", "[Run Checks] Run checks...", logs);
  const time00Process = Date.now();
  // Check if a PR is necessary
  if (runChecks_b) {
    const checks = await runChecks(octokit, owner, repo, true);
    const needUpdate = checks.outputs.find((value) => value.key === "needUpdate")?.value;
    const firstCommitDate = checks.outputs.find((value) => value.key === "firstCommitDate")?.value;

    if (needUpdate !== true) {
      log("CreatePullRequest", "[General] No update required.", logs);
      return { created: false, reason: "NO_UPDATE", logs };
    }
    if (typeof firstCommitDate !== "string") {
      throw new AppError("CHECK_OUTPUT_MISSING", "runChecks did not return firstCommitDate.", 5);
    }
    specifiedDate = new Date(firstCommitDate);
  }
  log("CreatePullRequest", "[Run Checks] Checked! (" + (Date.now() - time00Process) + "ms)", logs);

  // Parsing data from getVersionInfo
  log("CreatePullRequest", "[Prepare PR] Parsing getVersionInfo data...", logs);
  const time0Process = Date.now();

  let versionsRaw;
  if (raw !== "") {
    try {
      versionsRaw = JSON.parse(raw);
      if (typeof versionsRaw === "string") versionsRaw = JSON.parse(versionsRaw);
    } catch (error) {
      throw new AppError("INVALID_VERSION_DATA", "raw is not valid version JSON.", 2, undefined, error);
    }
  } else {
    if (!specifiedDate || Number.isNaN(specifiedDate.getTime())) {
      throw new AppError("INVALID_SPECIFIED_DATE", "A valid specifiedDate is required.", 2);
    }
    versionsRaw = await getVersionsInfo(specifiedDate, octokit, owner, repo, true);
  }

  if (!versionsRaw || !Array.isArray(versionsRaw.commits)) {
    throw new AppError("INVALID_VERSION_DATA", "Version data must contain a commits array.", 2);
  }

  const versions: Record<string, { commits: Set<unknown>; content: string }> = {};
  log("CreatePullRequest", "[Prepare PR] Data parsed! (" + (Date.now() - time0Process) + "ms)", logs);

  // Gathering commits
  log("CreatePullRequest", "[Prepare PR] Gathering commits...", logs);
  const time1Process = Date.now();
  versionsRaw.commits.forEach(function (a: { title: string; content: string; commit: unknown }) {
    const title = a.title.replace("v", "");
    versions[title] = versions[title] || { commits: new Set(), content: a.content.trim() };
    versions[title].commits.add(a.commit);
  });
  log("CreatePullRequest", "[Prepare PR] Gathering commits finished! (" + (Date.now() - time1Process) + "ms)", logs);

  // Creation of the changelog
  log("CreatePullRequest", "[Prepare PR] Creating changelog...", logs);
  const time2Process = Date.now();
  let changelog = "";
  for (const key in versions) {
    const commits = Array.from(versions[key].commits).join(") (");
    const content = versions[key].content;

    changelog += `### ASTAP_${key} (${commits})\n\n${content}\n\n`;
  }
  log("CreatePullRequest", "[Prepare PR] Changelog finished! (" + (Date.now() - time2Process) + "ms)", logs);

  // Definition of the merge date
  const currentDate = new Date();
  const mergeDate = new Date();
  const hours = 10;
  mergeDate.setTime(mergeDate.getTime() + hours * 60 * 60 * 1000);
  log("CreatePullRequest", "[General] Merge date is after " + format(mergeDate, "yyyy-MM-dd HH:mm:ss"), logs);

  // Pull Request creation
  log("CreatePullRequest", "[PR] Creating pull request...", logs);
  const time3Process = Date.now();
  const result = await octokit.rest.pulls.create({
    title: "[Automation] [" + format(currentDate, "yyyy-MM-dd") + "] Mirroring from the Mercury repo",
    owner,
    repo,
    head: "imported",
    base: "main",
    body: [
      "## Changelog",
      "",
      changelog,
      "",
      "",
      "> **NOTE**: This PR is automatically generated and will be automatically merged after **" + format(mergeDate, "yyyy-MM-dd HH:mm:ss") + "**.",
    ].join("\n"),
  });
  log("CreatePullRequest", "[PR] Pull request created! (" + (Date.now() - time3Process) + "ms)", logs);

  // Add labels to Pull Request
  log("CreatePullRequest", "[PR] Adding labels to PR...", logs);
  const time4Process = Date.now();
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: result.data.number,
    labels: ["mirror", "automated pr"],
  });
  log("CreatePullRequest", "[PR] Pull request completely finished! (" + (Date.now() - time4Process) + "ms)", logs);

  log("CreatePullRequest", "[General] Total Time: " + (Date.now() - time00Process) + "ms", logs);

  return {
    created: true,
    pullRequest: {
      number: result.data.number,
      url: result.data.html_url,
    },
    mergeAfter: mergeDate.toISOString(),
    logs,
  };
};
