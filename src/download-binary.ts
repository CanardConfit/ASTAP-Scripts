import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { XMLParser } from "fast-xml-parser";
import { AppError } from "./errors.js";

export const BINARY_ARTIFACTS = {
  windows: {
    installer: "astap_setup.exe",
    portable: "astapwin32.zip",
    "cli-x64": "astap_command-line_version_win64.zip",
    "cli-x86": "astap_command-line_version_win32.zip",
    "cli-arm64": "astap_command-line_version_win11_aarch64.zip",
  },
  macos: {
    "installer-x64": "astap.pkg",
    "installer-arm64": "astap_M1.pkg",
    "cli-x64": "astap_command-line_version_macOS_x86_64.zip",
    "cli-arm64": "astap_command-line_version_macOS_M1.zip",
  },
  linux: {
    "deb-x64": "astap_amd64.deb",
    "deb-arm64": "astap_aarch64.deb",
    "deb-armv7": "astap_armhf.deb",
    "deb-x86": "astap_i386.deb",
    "rpm-x64": "astap_amd64.rpm",
    "tar-x64": "astap_amd64.tar.gz",
    "tar-arm64": "astap_aarch64.tar.gz",
    "tar-armv7": "astap_armhf.tar.gz",
    "cli-x64": "astap_command-line_version_Linux_amd64.zip",
    "cli-arm64": "astap_command-line_version_Linux_aarch64.zip",
    "cli-armv7": "astap_command-line_version_Linux_armhf.zip",
  },
} as const;

export type BinaryPlatform = keyof typeof BINARY_ARTIFACTS;

export type SourceForgeFile = {
  name: string;
  path: string;
  url: string;
  publishedAt: string;
  size: number;
  md5: string;
};

type DownloadOptions = {
  platform?: BinaryPlatform;
  artifact?: string;
  version?: string;
  outputDirectory?: string;
  force?: boolean;
};

export type LatestBinary = {
  platform: BinaryPlatform;
  artifact: string;
  file: SourceForgeFile;
};

const PLATFORM_FOLDERS: Record<BinaryPlatform, string> = {
  windows: "windows_installer",
  macos: "macOS installer",
  linux: "linux_installer",
};

const DEFAULT_ARTIFACTS: Record<BinaryPlatform, string> = {
  windows: "installer",
  macos: "installer-x64",
  linux: "deb-x64",
};
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
});

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

export const parseSourceForgeFeed = (xml: string): SourceForgeFile[] => {
  const document = parser.parse(xml);
  const items = asArray(document?.rss?.channel?.item);

  return items.flatMap((item): SourceForgeFile[] => {
    const media = item.content;
    const path = String(item.title ?? "").trim();
    const url = String(media?.url ?? item.link ?? "").trim();
    const md5 = String(media?.hash?.["#text"] ?? media?.hash ?? "")
      .trim()
      .toLowerCase();

    if (!path || !url) return [];

    return [
      {
        name: basename(path),
        path,
        url,
        publishedAt: String(item.pubDate ?? ""),
        size: Number(media?.filesize ?? 0),
        md5,
      },
    ];
  });
};

const normalizeVersion = (version: string) => version.trim().replace(/^v/i, "").replaceAll("-", ".");
const splitFileName = (fileName: string) => {
  const compoundExtension = [".pkg.tar.zst", ".tar.gz"].find((extension) => fileName.toLowerCase().endsWith(extension));
  const extensionIndex = compoundExtension ? fileName.length - compoundExtension.length : fileName.lastIndexOf(".");
  return { stem: fileName.slice(0, extensionIndex), extension: fileName.slice(extensionIndex) };
};

export const getArtifactNames = (platform: BinaryPlatform) => Object.keys(BINARY_ARTIFACTS[platform]);

const getArtifactFileName = (platform: BinaryPlatform, artifact?: string) => {
  const selectedArtifact = artifact ?? DEFAULT_ARTIFACTS[platform];
  const artifacts = BINARY_ARTIFACTS[platform] as Record<string, string>;
  const fileName = artifacts[selectedArtifact];

  if (!fileName) {
    throw new AppError("INVALID_ARTIFACT", `Unknown ${platform} artifact: ${selectedArtifact}.`, 2, {
      platform,
      artifact: selectedArtifact,
      availableArtifacts: getArtifactNames(platform),
    });
  }

  return fileName;
};

export const selectBinary = (files: SourceForgeFile[], platform: BinaryPlatform, artifact?: string, version = "latest"): SourceForgeFile => {
  const currentName = getArtifactFileName(platform, artifact);
  let file: SourceForgeFile | undefined;

  if (version.toLowerCase() !== "latest" && !/^v?\d{4}[-.]\d{2}[-.]\d{2}$/i.test(version.trim())) {
    throw new AppError("INVALID_RELEASE", `Invalid release: ${version}.`, 2, {
      expectedFormat: "latest, YYYY.MM.DD or YYYY-MM-DD",
      release: version,
    });
  }

  if (version.toLowerCase() === "latest") {
    file = files.find((candidate) => candidate.name.toLowerCase() === currentName.toLowerCase() && !candidate.path.toLowerCase().includes("/older"));
  } else {
    const normalizedVersion = normalizeVersion(version);
    const { stem, extension } = splitFileName(currentName);
    file = files.find((candidate) => {
      const candidateName = candidate.name.toLowerCase();
      const candidateVersion = candidateName
        .match(/v?(\d{4})[-.](\d{2})[-.](\d{2})/)
        ?.slice(1)
        .join(".");
      return (
        candidate.path.toLowerCase().includes("/older") &&
        candidateName.includes(stem.toLowerCase()) &&
        candidateName.endsWith(extension.toLowerCase()) &&
        candidateVersion === normalizedVersion
      );
    });
  }

  if (!file) {
    throw new AppError("BINARY_NOT_FOUND", `No binary found for ${platform} ${artifact ?? DEFAULT_ARTIFACTS[platform]} ${version}.`, 3, {
      platform,
      artifact: artifact ?? DEFAULT_ARTIFACTS[platform],
      release: version,
    });
  }

  return file;
};

const hashFile = async (filePath: string) => {
  const hash = createHash("md5");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
};

const fileExists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const downloadToFile = async (url: string, destination: string, redirectsLeft = 10): Promise<void> => {
  await new Promise<void>((resolveDownload, rejectDownload) => {
    const client = new URL(url).protocol === "http:" ? httpGet : httpsGet;
    const request = client(url, { headers: { "user-agent": "ASTAP-Scripts/2.0" } }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft === 0) {
          rejectDownload(new AppError("DOWNLOAD_REDIRECT_LIMIT", "Too many redirects while downloading the binary.", 5));
          return;
        }

        downloadToFile(new URL(location, url).toString(), destination, redirectsLeft - 1).then(resolveDownload, rejectDownload);
        return;
      }

      if (status !== 200) {
        response.resume();
        rejectDownload(new AppError("DOWNLOAD_HTTP_ERROR", `Binary download failed with HTTP ${status}.`, 5, { httpStatus: status }));
        return;
      }

      pipeline(response, createWriteStream(destination)).then(resolveDownload, rejectDownload);
    });

    request.on("error", rejectDownload);
    request.setTimeout(60_000, () => request.destroy(new AppError("DOWNLOAD_TIMEOUT", "Binary download timed out.", 5)));
  });
};

const requestText = async (url: string, redirectsLeft = 10): Promise<string> =>
  new Promise<string>((resolveRequest, rejectRequest) => {
    const client = new URL(url).protocol === "http:" ? httpGet : httpsGet;
    const request = client(url, { headers: { "user-agent": "ASTAP-Scripts/2.0" } }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft === 0) {
          rejectRequest(new AppError("SOURCEFORGE_REDIRECT_LIMIT", "Too many redirects while retrieving the SourceForge feed.", 5));
          return;
        }
        requestText(new URL(location, url).toString(), redirectsLeft - 1).then(resolveRequest, rejectRequest);
        return;
      }

      if (status !== 200) {
        response.resume();
        rejectRequest(new AppError("SOURCEFORGE_HTTP_ERROR", `SourceForge feed request failed with HTTP ${status}.`, 5, { httpStatus: status }));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveRequest(Buffer.concat(chunks).toString("utf8")));
      response.on("error", rejectRequest);
    });

    request.on("error", rejectRequest);
    request.setTimeout(30_000, () => request.destroy(new AppError("SOURCEFORGE_TIMEOUT", "SourceForge feed request timed out.", 5)));
  });

export const getSourceForgeFiles = async (platform: BinaryPlatform): Promise<SourceForgeFile[]> => {
  const folder = encodeURIComponent(PLATFORM_FOLDERS[platform]);
  const rssUrl = `https://sourceforge.net/projects/astap-program/rss?path=/${folder}`;
  let feed: string;
  try {
    feed = await requestText(rssUrl);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("SOURCEFORGE_UNAVAILABLE", "Unable to retrieve the SourceForge file feed.", 5, { platform }, error);
  }

  let files: SourceForgeFile[];
  try {
    files = parseSourceForgeFeed(feed);
  } catch (error) {
    throw new AppError("SOURCEFORGE_FEED_INVALID", "The SourceForge file feed could not be parsed.", 5, { platform }, error);
  }

  if (files.length === 0) {
    throw new AppError("SOURCEFORGE_FEED_EMPTY", "The SourceForge file feed contains no downloadable files.", 5, { platform });
  }

  return files;
};

export const getLatestBinaries = async (): Promise<LatestBinary[]> => {
  const platforms = Object.keys(BINARY_ARTIFACTS) as BinaryPlatform[];
  const filesByPlatform = new Map<BinaryPlatform, SourceForgeFile[]>();
  for (const platform of platforms) {
    filesByPlatform.set(platform, await getSourceForgeFiles(platform));
  }

  return platforms.flatMap((platform) =>
    getArtifactNames(platform).map((artifact) => ({
      platform,
      artifact,
      file: selectBinary(filesByPlatform.get(platform) ?? [], platform, artifact),
    })),
  );
};

export const downloadSourceForgeFile = async (file: SourceForgeFile, outputDirectory: string, force = false) => {
  const outputPath = resolve(outputDirectory, file.name);
  const temporaryPath = `${outputPath}.part-${process.pid}`;

  if (!force && (await fileExists(outputPath))) {
    throw new AppError("FILE_EXISTS", `${outputPath} already exists.`, 4, { outputPath, hint: "Use --force to overwrite it." });
  }

  try {
    await mkdir(resolve(outputDirectory), { recursive: true });
    await downloadToFile(file.url, temporaryPath);

    const md5 = await hashFile(temporaryPath);
    if (file.md5 && md5 !== file.md5) {
      throw new AppError("CHECKSUM_MISMATCH", `Checksum mismatch for ${file.name}.`, 6, { expectedMd5: file.md5, actualMd5: md5 });
    }

    if (force) await rm(outputPath, { force: true });
    await rename(temporaryPath, outputPath);

    return { ...file, outputPath, md5 };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (error instanceof AppError) throw error;

    const systemError = error as NodeJS.ErrnoException;
    if (systemError?.code) {
      throw new AppError("FILESYSTEM_ERROR", systemError.message, 7, {
        systemCode: systemError.code,
        ...(systemError.path ? { path: systemError.path } : {}),
      });
    }

    throw new AppError("DOWNLOAD_FAILED", error instanceof Error ? error.message : "The binary download failed.", 5);
  }
};

export const downloadBinary = async ({
  platform = "windows",
  artifact,
  version = "latest",
  outputDirectory = process.env.ASTAP_DOWNLOAD_DIR ?? ".",
  force = false,
}: DownloadOptions = {}) => {
  const files = await getSourceForgeFiles(platform);
  const file = selectBinary(files, platform, artifact, version);
  return downloadSourceForgeFile(file, outputDirectory, force);
};
