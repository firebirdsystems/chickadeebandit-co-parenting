#!/usr/bin/env node
/**
 * sync-hub-sdk.mjs — keep the two LIVE copies of hub-sdk.js in sync.
 *
 * There are exactly two copies that matter, and they live in two SEPARATE repos:
 *
 *   1. Canonical : app-template/hub-sdk.js (this repo). Published to the
 *      app-template GitHub repo, which every app's dev.mjs fetches at dev time.
 *      This is the file you edit.
 *   2. Runtime   : packages/hub/public/hub-sdk.js in the chickadeebandit hub repo.
 *      Served to apps at /hub-sdk.js in production.
 *
 * Because they live in different repos with independent deploy pipelines, no single
 * build owns both — so this script copies canonical -> runtime, and `--check` mode
 * (used by the hub repo's CI guard and any pre-push hook) fails on drift.
 *
 *   node sync-hub-sdk.mjs           # copy canonical -> runtime copy
 *   node sync-hub-sdk.mjs --check   # exit 1 if they differ (no write)
 *
 * Assumes the hub repo is checked out as a sibling of the apps repo
 * (…/chickadeebandit next to …/chickadeebandit-apps). Override if not:
 *
 *   HUB_SDK_DEST=/path/to/chickadeebandit/packages/hub/public/hub-sdk.js node sync-hub-sdk.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, "hub-sdk.js");
const DEST = process.env.HUB_SDK_DEST
  ?? path.resolve(HERE, "../../chickadeebandit/packages/hub/public/hub-sdk.js");

const check = process.argv.includes("--check");

if (!fs.existsSync(SRC)) {
  console.error(`Canonical source missing: ${SRC}`);
  process.exit(2);
}
if (!fs.existsSync(DEST)) {
  console.error(`Hub runtime copy not found: ${DEST}`);
  console.error("Check out the chickadeebandit hub repo as a sibling, or set HUB_SDK_DEST.");
  process.exit(2);
}

const src  = fs.readFileSync(SRC);
const dest = fs.readFileSync(DEST);

if (src.equals(dest)) {
  console.log("hub-sdk.js in sync ✓");
  process.exit(0);
}

if (check) {
  console.error("DRIFT: app-template/hub-sdk.js and the hub runtime copy differ.");
  console.error(`  canonical: ${SRC}`);
  console.error(`  runtime:   ${DEST}`);
  console.error("Run `npm run sync-sdk` from app-template/ to update the runtime copy.");
  process.exit(1);
}

fs.writeFileSync(DEST, src);
console.log(`Synced hub-sdk.js → ${DEST}`);
