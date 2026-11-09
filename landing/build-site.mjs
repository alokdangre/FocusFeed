import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, ".site-public");
const files = ["index.html", "privacy.html", "terms.html", "styles.css", "legal.css", "script.js", "robots.txt", "sitemap.xml", "llms.txt", "about.md", "_headers"];
const assets = ["bread.jpg", "cinema.jpg", "cloudbreak.webp", "favicon.svg", "ownfeed-mark.svg", "guitar.jpg", "last-light.webp", "space.jpg", "fonts"];
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "assets"), { recursive: true });
for (const name of files) await cp(path.join(root, name), path.join(output, name));
for (const name of assets) await cp(path.join(root, "assets", name), path.join(output, "assets", name), { recursive: true });

// Publish only the explicit runtime allowlist, never a ZIP of the repository.
const manifest = JSON.parse(await readFile(path.join(root, "../extension/manifest.json"), "utf8"));
const filename = `ownfeed-${manifest.version}.zip`;
const html = await readFile(path.join(root, "index.html"), "utf8");
if (!html.includes(`/downloads/${filename}`)) throw new Error("Update the download link to the current extension version before building.");
const downloads = path.join(output, "downloads");
await mkdir(downloads, { recursive: true });
const archive = path.join(downloads, filename);
execFileSync(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
  [path.join(root, "../tools/package_extension.py"), "--output", archive], { stdio: "inherit" });
await rm(archive.replace(/\.zip$/, ".release.json"));
const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(archive + ".sha256", `${hash}  ${filename}\n`);
