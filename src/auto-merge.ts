import { Octokit } from "octokit";
import { log } from "./tools.js";
import { AppError } from "./errors.js";

export const autoMerge = async (octokit: Octokit, owner: string, repo: string, forceMerge: boolean, printFormatted = true) => {
  const ret = { errors: [], outputs: [], logs: [] };
  const mergeFailures: Array<{ pullNumber: number; status?: number; message: string }> = [];

  log("AutoMerge", "[General] Getting PRs...", ret.logs, printFormatted);
  const time0Process = Date.now();
  const listPulls = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
  });
  log("AutoMerge", "[General] PRs got! (" + (Date.now() - time0Process) + "ms)", ret.logs, printFormatted);

  log("AutoMerge", "[General] Listing PRs...", ret.logs, printFormatted);
  const time1Process = Date.now();
  for (const pull of listPulls.data) {
    const create = new Date(pull.created_at);
    const now = new Date();
    const t = (now.getTime() - create.getTime()) / 3600000;
    log("AutoMerge", "[General] " + pull.title, ret.logs, printFormatted);
    log("AutoMerge", "[General] " + pull.html_url, ret.logs, printFormatted);
    log("AutoMerge", "[General] " + t + " hour(s).", ret.logs, printFormatted);
    if (!forceMerge) {
      if (t < 10) {
        log("AutoMerge", "[General] " + "-> Skipped", ret.logs, printFormatted);
        continue;
      }
    } else {
      log("AutoMerge", "[General] " + "-> Forced", ret.logs, printFormatted);
    }
    let mirror = false;
    let automation = false;
    for (const label of pull.labels) {
      if (label.name === "mirror") {
        mirror = true;
      }
      if (label.name === "automated pr") {
        automation = true;
      }
    }
    log("AutoMerge", "[General] " + "Automation: " + automation, ret.logs, printFormatted);
    log("AutoMerge", "[General] " + "Mirror: " + mirror, ret.logs, printFormatted);
    if (!mirror || !automation) continue;

    try {
      const result = await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: pull.number,
      });

      if (!result.data.merged) {
        mergeFailures.push({ pullNumber: pull.number, status: result.status, message: result.data.message || "Pull request was not merged." });
        continue;
      }

      ret.outputs.push({ key: "mergedPullRequest", value: pull.number });
      log("AutoMerge", "[General] Merged.", ret.logs, printFormatted);

      log("AutoMerge", "[General] Checking merge status.", ret.logs, printFormatted);

      const resultCheck = await octokit.rest.pulls.checkIfMerged({
        owner,
        repo,
        pull_number: pull.number,
      });
      log("AutoMerge", resultCheck.status === 204 ? "[General] Merge confirmed." : "[General] Merge not confirmed.", ret.logs, printFormatted);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 405 || status === 409) {
        mergeFailures.push({
          pullNumber: pull.number,
          status,
          message: error instanceof Error ? error.message : "Pull request was not merged.",
        });
        continue;
      }
      throw error;
    }
  }
  log("AutoMerge", "[General] PRs listing finished! (" + (Date.now() - time1Process) + "ms)", ret.logs, printFormatted);

  log("AutoMerge", "[General] Total Time: " + (Date.now() - time0Process) + "ms", ret.logs, printFormatted);
  if (mergeFailures.length > 0) {
    throw new AppError("PULL_REQUEST_MERGE_FAILED", `${mergeFailures.length} pull request(s) could not be merged.`, 5, {
      failures: mergeFailures,
    });
  }

  return ret;
};
