import { Argument, Command, CommanderError, InvalidArgumentError } from "commander";
import { getVersionsInfo } from "./get-version-info.js";
import { createPullRequest } from "./create-pull-request.js";
import { createOctokit } from "./tools.js";
import { runChecks } from "./run-checks.js";
import { autoMerge } from "./auto-merge.js";
import { BINARY_ARTIFACTS, BinaryPlatform, downloadBinary, getArtifactNames } from "./download-binary.js";
import { AppError, serializeError } from "./errors.js";
import { releaseBinaries } from "./release-binaries.js";

const program = new Command();

const repo = "ASTAP";
const author = "CanardConfit";
const githubToken = () => program.opts().token ?? process.env.GITHUB_TOKEN;
const parseBoolean = (value: string) => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidArgumentError('Expected "true" or "false".');
};
const parseDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidArgumentError("Expected a valid date.");
  return date;
};
const writeSuccess = (data: unknown) => process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);

program.exitOverride().configureOutput({ writeErr: () => {} });

program
  .name("astap-scripts")
  .version("2.0.0")
  .description("CLI scripts used by github actions on the ASTAP repository.")
  .option("-t, --token <token>", "Token of GitHub for Octokit.");

program
  .command("releaseBinaries")
  .description("Publish changed ASTAP binaries as a GitHub release.")
  .option("--owner <owner>", "Target GitHub repository owner.", author)
  .option("--repo <repo>", "Target GitHub repository.", repo)
  .option("--target <branch>", "Target branch or commit for the release tag.", "main")
  .option("--dry-run", "Detect changes and generate the release without publishing it.")
  .option("--draft", "Create or update the release without publishing it.")
  .option("-f, --force", "Publish even if the binary manifest is unchanged.")
  .action(async (options: { owner: string; repo: string; target: string; dryRun?: boolean; draft?: boolean; force?: boolean }) => {
    const token = githubToken();
    if (!options.dryRun && !token) {
      throw new AppError("MISSING_GITHUB_TOKEN", "A GitHub token is required to publish a release.", 2, {
        acceptedSources: ["--token", "GITHUB_TOKEN"],
      });
    }

    const result = await releaseBinaries(createOctokit({ token }), {
      owner: options.owner,
      repo: options.repo,
      target: options.target,
      dryRun: options.dryRun,
      draft: options.draft,
      force: options.force,
    });
    writeSuccess(result);
  });

program
  .command("downloadBinary")
  .description("Download an ASTAP binary from SourceForge.")
  .option("-p, --platform <platform>", "Platform: windows, macos or linux.", "windows")
  .option("-a, --artifact <artifact>", "Platform-specific artifact (omit to use its default).")
  .option("-r, --release <version>", "Archived version (for example 2025.02.17) or latest.", "latest")
  .option("-o, --output <directory>", "Output directory.", process.env.ASTAP_DOWNLOAD_DIR ?? ".")
  .option("-f, --force", "Overwrite an existing file.")
  .action(async (options: { platform: string; artifact?: string; release: string; output: string; force?: boolean }) => {
    if (!(options.platform in BINARY_ARTIFACTS)) {
      throw new AppError("INVALID_PLATFORM", `Unknown platform: ${options.platform}.`, 2, {
        platform: options.platform,
        availablePlatforms: Object.keys(BINARY_ARTIFACTS),
      });
    }

    const platform = options.platform as BinaryPlatform;
    if (options.artifact && !getArtifactNames(platform).includes(options.artifact)) {
      throw new AppError("INVALID_ARTIFACT", `Unknown ${platform} artifact: ${options.artifact}.`, 2, {
        platform,
        artifact: options.artifact,
        availableArtifacts: getArtifactNames(platform),
      });
    }

    const result = await downloadBinary({
      platform,
      artifact: options.artifact,
      version: options.release,
      outputDirectory: options.output,
      force: options.force,
    });
    writeSuccess(result);
  });

program
  .command("runChecks")
  .addArgument(
    new Argument("[printJsonFormat]", "Specify if you prefer a JSON at the end of the program or live log.")
      .argParser<boolean>(parseBoolean)
      .default(true),
  )
  .description("Runs tests to verify that a PR must be created")
  .helpCommand(
    "after",
    `
    Example:
    $ runChecks
    $ runChecks false
  `,
  )
  .action(async (printJsonFormat) => {
    const result = await runChecks(createOctokit({ token: githubToken() }), author, repo, printJsonFormat);
    writeSuccess(result);
  });

program
  .command("getVersionsInfo")
  .addArgument(new Argument("<specifiedDate>", "Date of versions from which we retrieve").argParser<Date>(parseDate))
  .addArgument(
    new Argument("[printJsonFormat]", "Specify if you prefer a JSON at the end of the program or live log.")
      .argParser<boolean>(parseBoolean)
      .default(true),
  )
  .description("Retrieves information about versions released since the specified date")
  .helpCommand(
    "after",
    `
    Example:
    $ getVersionsInfo 2023-10-08
    $ getVersionsInfo 2023-10-08 false
  `,
  )
  .action(async (specifiedDate, printJsonFormat) => {
    const result = await getVersionsInfo(specifiedDate, createOctokit({ token: githubToken() }), author, repo, printJsonFormat);
    writeSuccess(result);
  });

program
  .command("createPullRequest")
  .addArgument(new Argument("<runChecks>", "Allows you to choose whether createPullRequest calls runChecks.").argParser<boolean>(parseBoolean))
  .addArgument(
    new Argument(
      "[specifiedDate]",
      "If filled, createPullRequest will self execute getVersionInfo, and it's the date of versions from which we retrieve.",
    )
      .argParser<Date | null>((value) => (value != "" ? parseDate(value) : null))
      .default(""),
  )
  .addArgument(new Argument("[raw]", "If filled, createPullRequest need the return of getVersionsInfo script.").default(""))
  .description("Create a Pull Request.")
  .helpCommand(
    "after",
    `
    Example:
    $ createPullRequest true -t <token>
    $ createPullRequest false 2023-12-05 -t <token>
    $ createPullRequest false 2023-12-05 "{JSON OF GETVERSIONINFO}" -t <token>
  `,
  )
  .action(async (runChecks, specifiedDate, raw) => {
    if (raw == "" && !specifiedDate && !runChecks) {
      throw new AppError("MISSING_VERSION_INPUT", "specifiedDate is required when raw is empty and runChecks is false.", 2);
    }
    if (!githubToken()) {
      throw new AppError("MISSING_GITHUB_TOKEN", "A GitHub token is required to create a pull request.", 2);
    }
    const result = await createPullRequest(createOctokit({ token: githubToken() }), author, repo, runChecks, raw, specifiedDate);
    writeSuccess(result);
  });

program
  .command("autoMerge")
  .addArgument(new Argument("<forceMerge>", "Allows you to choose if program ignore wait time or not.").argParser<boolean>(parseBoolean))
  .addArgument(
    new Argument("[printJsonFormat]", "Specify if you prefer a JSON at the end of the program or live log.")
      .argParser<boolean>(parseBoolean)
      .default(true),
  )
  .description("Auto-Merge automated PR if time of wait is done.")
  .helpCommand(
    "after",
    `
    Example:
    $ autoMerge false -t <token>
    $ autoMerge true -t <token>
  `,
  )
  .action(async (forceMerge, printJsonFormat) => {
    if (!githubToken()) {
      throw new AppError("MISSING_GITHUB_TOKEN", "A GitHub token is required to merge a pull request.", 2);
    }
    const result = await autoMerge(createOctokit({ token: githubToken() }), author, repo, forceMerge, printJsonFormat);
    writeSuccess(result);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const normalizedError =
      error instanceof CommanderError ? new AppError("CLI_USAGE_ERROR", error.message, 2, { commanderCode: error.code }) : error;
    const { exitCode, payload } = serializeError(normalizedError);
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = exitCode;
  }
}
