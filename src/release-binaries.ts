import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Octokit } from "octokit";
import { LatestBinary, downloadSourceForgeFile, getLatestBinaries } from "./download-binary.js";
import { AppError } from "./errors.js";
import { scrapeAstapHistory } from "./get-version-info.js";
import { ReleaseDescription } from "./astap-history.js";

export type BinaryManifestEntry = {
  platform: string;
  artifact: string;
  name: string;
  md5: string;
  size: number;
  publishedAt: string;
  sourceUrl: string;
};

type ReleaseOptions = {
  owner: string;
  repo: string;
  target?: string;
  dryRun?: boolean;
  force?: boolean;
  draft?: boolean;
};

type ReleaseDependencies = {
  getLatestBinaries: typeof getLatestBinaries;
  downloadSourceForgeFile: typeof downloadSourceForgeFile;
  scrapeAstapHistory: typeof scrapeAstapHistory;
};

const MANIFEST_PREFIX = "<!-- astap-binary-manifest:";
const MANIFEST_SUFFIX = " -->";

export const buildBinaryManifest = (binaries: LatestBinary[]): BinaryManifestEntry[] =>
  binaries
    .map(({ platform, artifact, file }) => ({
      platform,
      artifact,
      name: file.name,
      md5: file.md5,
      size: file.size,
      publishedAt: file.publishedAt,
      sourceUrl: file.url,
    }))
    .sort((left, right) => `${left.platform}:${left.artifact}`.localeCompare(`${right.platform}:${right.artifact}`));

const manifestKey = (manifest: BinaryManifestEntry[]) => JSON.stringify(manifest);
const encodeManifest = (manifest: BinaryManifestEntry[]) => Buffer.from(manifestKey(manifest)).toString("base64");

export const parseReleaseManifest = (body: string | null | undefined): BinaryManifestEntry[] | null => {
  const match = body?.match(/<!-- astap-binary-manifest:([A-Za-z0-9+/=]+) -->/);
  if (!match) return null;

  try {
    const manifest = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    return Array.isArray(manifest) ? manifest : null;
  } catch {
    return null;
  }
};

const releaseVersion = (manifest: BinaryManifestEntry[]) => {
  const timestamps = manifest.map((entry) => new Date(entry.publishedAt).getTime()).filter(Number.isFinite);
  if (timestamps.length === 0) throw new AppError("BINARY_DATE_MISSING", "SourceForge did not provide a valid binary publication date.", 5);
  return new Date(Math.max(...timestamps)).toISOString().slice(0, 10).replaceAll("-", ".");
};

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const entryVersion = (entry: BinaryManifestEntry) => {
  const timestamp = new Date(entry.publishedAt);
  return Number.isNaN(timestamp.getTime()) ? "unknown" : timestamp.toISOString().slice(0, 10).replaceAll("-", ".");
};

export const buildReleaseBody = (manifest: BinaryManifestEntry[], history: ReleaseDescription[]) => {
  const descriptions = new Map(history.map((release) => [release.id.replace("ASTAP_", ""), release.content]));
  const versions = [...new Set(manifest.map(entryVersion))]
    .filter((version) => version !== "unknown")
    .sort()
    .reverse();
  const lines = [
    "> [!IMPORTANT]",
    "> This is an automated mirror of the official ASTAP binaries published by Han Kleijn on SourceForge.",
    "",
    "## Changelog",
    "",
    ...versions.flatMap((version) => [
      `### ASTAP ${version}`,
      "",
      descriptions.get(version) || "No description was published for this binary version.",
      "",
    ]),
    "## Binaries",
    "",
    "| Platform | Artifact | Version | File | Size | MD5 | Official source |",
    "| --- | --- | --- | --- | ---: | --- | --- |",
    ...manifest.map(
      (entry) =>
        `| ${entry.platform} | ${entry.artifact} | ${entryVersion(entry)} | \`${entry.name}\` | ${formatBytes(entry.size)} | \`${entry.md5}\` | [SourceForge](${entry.sourceUrl}) |`,
    ),
    "",
    "## Official links",
    "",
    "- [ASTAP official website](https://www.hnsky.org/astap.htm)",
    "- [Program installation and Windows instructions](https://www.hnsky.org/astap.htm#installation)",
    "- [Linux installation instructions](https://www.hnsky.org/astap.htm#linux_installation)",
    "- [macOS installation instructions](https://www.hnsky.org/astap.htm#macos_installation)",
    "- [Official SourceForge downloads](https://sourceforge.net/projects/astap-program/files/)",
    "- [Official version history](https://www.hnsky.org/history_astap.htm)",
    "",
    `${MANIFEST_PREFIX}${encodeManifest(manifest)}${MANIFEST_SUFFIX}`,
  ];

  return lines.join("\n");
};

const getReleaseByTag = async (octokit: Octokit, owner: string, repo: string, tag: string) => {
  try {
    return (await octokit.rest.repos.getReleaseByTag({ owner, repo, tag })).data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
};

export const releaseBinaries = async (
  octokit: Octokit,
  { owner, repo, target = "main", dryRun = false, force = false, draft = false }: ReleaseOptions,
  dependencies: Partial<ReleaseDependencies> = {},
) => {
  const listBinaries = dependencies.getLatestBinaries ?? getLatestBinaries;
  const downloadFile = dependencies.downloadSourceForgeFile ?? downloadSourceForgeFile;
  const scrapeHistory = dependencies.scrapeAstapHistory ?? scrapeAstapHistory;
  const binaries = await listBinaries();
  const manifest = buildBinaryManifest(binaries);
  const version = releaseVersion(manifest);
  const tag = `v${version}`;
  const existingRelease = await getReleaseByTag(octokit, owner, repo, tag);
  const previousManifest = parseReleaseManifest(existingRelease?.body);

  if (existingRelease && !previousManifest) {
    throw new AppError("RELEASE_TAG_CONFLICT", `Release ${tag} already exists but was not created by this script.`, 4, {
      tag,
      releaseUrl: existingRelease.html_url,
    });
  }

  const expectedAssets = new Set(manifest.map((entry) => entry.name));
  const missingAsset =
    existingRelease?.assets.some((asset) => !expectedAssets.has(asset.name)) ||
    manifest.some((entry) => !existingRelease?.assets.some((asset) => asset.name === entry.name));
  const changed = force || !previousManifest || manifestKey(previousManifest) !== manifestKey(manifest) || Boolean(missingAsset);

  if (!changed && existingRelease && existingRelease.draft !== draft) {
    if (dryRun) {
      return {
        action: draft ? "would-unpublish" : "would-publish",
        tag,
        draft,
        releaseUrl: existingRelease.html_url,
        assets: manifest.length,
        manifest,
      };
    }

    const updated = (
      await octokit.rest.repos.updateRelease({
        owner,
        repo,
        release_id: existingRelease.id,
        draft,
      })
    ).data;
    return {
      action: draft ? "unpublished" : "published",
      tag,
      draft: updated.draft,
      releaseUrl: updated.html_url,
      assets: manifest.length,
      manifest,
    };
  }

  if (!changed) {
    return {
      action: "unchanged",
      tag,
      releaseUrl: existingRelease?.html_url,
      draft: existingRelease?.draft ?? draft,
      assets: manifest.length,
      manifest,
    };
  }

  const history = await scrapeHistory();
  const body = buildReleaseBody(manifest, history.releases);
  if (dryRun) return { action: existingRelease ? "would-update" : "would-create", tag, draft, assets: manifest.length, body, manifest };

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "astap-release-"));
  let release = existingRelease;
  try {
    const downloaded = [];
    for (const { file } of binaries) {
      downloaded.push(await downloadFile(file, temporaryDirectory, true));
    }

    if (!release) {
      release = (
        await octokit.rest.repos.createRelease({
          owner,
          repo,
          tag_name: tag,
          target_commitish: target,
          name: `ASTAP ${version} binaries`,
          body,
          draft: true,
          prerelease: false,
        })
      ).data;
    }

    for (const asset of release.assets) {
      await octokit.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: asset.id });
    }

    for (const binary of downloaded) {
      const data = await readFile(binary.outputPath);
      await octokit.rest.repos.uploadReleaseAsset({
        owner,
        repo,
        release_id: release.id,
        name: binary.name,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": data.byteLength,
        },
        data: data as unknown as string,
      });
    }

    const published = (
      await octokit.rest.repos.updateRelease({
        owner,
        repo,
        release_id: release.id,
        tag_name: tag,
        target_commitish: target,
        name: `ASTAP ${version} binaries`,
        body,
        draft,
        prerelease: false,
      })
    ).data;

    return {
      action: existingRelease ? "updated" : "created",
      tag,
      draft: published.draft,
      releaseUrl: published.html_url,
      assets: downloaded.map((binary) => binary.name),
      manifest,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
