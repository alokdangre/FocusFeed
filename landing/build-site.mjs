import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, ".site-public");
const files = ["index.html", "privacy.html", "terms.html", "styles.css", "legal.css", "script.js"];
const assets = ["bread.jpg", "cinema.jpg", "cloudbreak.webp", "favicon.svg", "guitar.jpg", "last-light.webp", "space.jpg", "ownfeed-extension.zip", "fonts"];
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "assets"), { recursive: true });
for (const name of files) await cp(path.join(root, name), path.join(output, name));
for (const name of assets) await cp(path.join(root, "assets", name), path.join(output, "assets", name), { recursive: true });
