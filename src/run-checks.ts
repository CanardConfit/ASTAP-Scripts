import { Octokit } from "octokit";
import { format } from "date-fns";
import { getLastCommitByAuthor, log, prExists } from "./tools.js";
import { AppError } from "./errors.js";

const baseBranch = "main";
const targetBranch = "imported";
const authorEmail = "han.k@hnsky.org";

export const runChecks = async (octokit: Octokit, owner: string, repo: string, printFormatted = true) => {
  const ret = { errors: [], outputs: [], logs: [] };

  log("RunChecks", "[General] Get last commit on " + targetBranch + " from " + authorEmail + "...", ret.logs, printFormatted);
  const time0Process = Date.now();
  const importedCommit = await getLastCommitByAuthor(octokit, owner, repo, targetBranch, authorEmail);
  if (!importedCommit) {
    throw new AppError("COMMIT_NOT_FOUND", `No commit found for ${authorEmail} on ${targetBranch}.`, 3, {
      branch: targetBranch,
      authorEmail,
    });
  }
  log("RunChecks", "[General] Last commit retrieved! (" + (Date.now() - time0Process) + "ms)", ret.logs, printFormatted);

  log("RunChecks", "[General] Get last commit on " + targetBranch + " from " + authorEmail + "...", ret.logs, printFormatted);
  const time1Process = Date.now();
  const mainCommit = await getLastCommitByAuthor(octokit, owner, repo, baseBranch, authorEmail);
  if (!mainCommit) {
    throw new AppError("COMMIT_NOT_FOUND", `No commit found for ${authorEmail} on ${baseBranch}.`, 3, {
      branch: baseBranch,
      authorEmail,
    });
  }
  log("RunChecks", "[General] Last commit retrieved! (" + (Date.now() - time1Process) + "ms)", ret.logs, printFormatted);

  log("RunChecks", "[General] Determination of information...", ret.logs, printFormatted);
  const time2Process = Date.now();
  const authorDate = mainCommit.commit.author?.date;
  if (!authorDate) {
    throw new AppError("INVALID_COMMIT_DATA", "The latest commit has no author date.", 5, { commit: mainCommit.sha });
  }
  const mainCommitDate = new Date(authorDate);
  mainCommitDate.setDate(mainCommitDate.getDate() + 1);
  mainCommitDate.setHours(0, 0, 0, 0);
  const formattedMainCommitDate = format(new Date(mainCommitDate), "yyyy-MM-dd");
  ret.outputs.push({ key: "firstCommitDate", value: formattedMainCommitDate });

  const isLastCommitOnMain = mainCommit.sha === importedCommit.sha;

  if (!isLastCommitOnMain) {
    try {
      await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${baseBranch}...${targetBranch}`,
      });
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        throw new AppError(
          "MIRROR_HISTORY_DISCONNECTED",
          `${targetBranch} has no common ancestor with ${baseBranch}; repair the mirrored branch before creating a pull request.`,
          5,
          {
            baseBranch,
            baseCommit: mainCommit.sha,
            targetBranch,
            targetCommit: importedCommit.sha,
          },
          error,
        );
      }
      throw error;
    }
  }

  const isPRExists = await prExists(octokit, owner, repo, `${owner}:${targetBranch}`, baseBranch);

  ret.outputs.push({ key: "needUpdate", value: !isLastCommitOnMain && !isPRExists });

  log("RunChecks", "[General] Finished! (" + (Date.now() - time2Process) + "ms)", ret.logs, printFormatted);

  log("RunChecks", "[General] Total Time: " + (Date.now() - time0Process) + "ms", ret.logs, printFormatted);
  return ret;
};
