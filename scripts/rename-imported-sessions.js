#!/usr/bin/env node
// Renames Claude Desktop's auto-titled ("General coding session") imported
// CLI-session entries to match their real discussion names.
//
// Desktop stores one JSON per known CLI session under
//   ~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json
// Entries imported via the claude://resume deep link get no `title` field —
// the generic sidebar name is generated elsewhere — but if the file carries
// `title` + `titleSource: "user"`, Desktop displays it (and never re-titles).
// Titles are only read at app startup, so changes appear after Desktop is
// restarted; if Desktop rewrites a session file before then, rerun this.
//
// Title resolution, in order:
//   1. latest {"type":"custom-title"} record in the session's CLI transcript
//      (~/.claude/projects/<munged-cwd>/<cliSessionId>.jsonl) — this is the
//      name you see in Desktop/CLI for the original discussion
//   2. latest {"type":"summary"} record in the transcript (CLI's auto-name)
//   3. the cwd's folder name
// A " (copy)" suffix is added only when a second, natively-created Desktop
// entry exists for the same CLI session (a true duplicate pair).
//
// Usage: node scripts/rename-imported-sessions.js [--dry-run]

import fs from 'fs';
import path from 'path';
import os from 'os';

const DRY_RUN = process.argv.includes('--dry-run');
const STORE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const mungeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function transcriptTitle(cwd, cliSessionId) {
  const file = path.join(PROJECTS, mungeCwd(cwd), `${cliSessionId}.jsonl`);
  let customTitle = null;
  let summary = null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"custom-title"') && !line.includes('"summary"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    else if (rec.type === 'summary' && rec.summary) summary = rec.summary;
  }
  return customTitle || summary;
}

const sessionFiles = fs
  .readdirSync(STORE, { recursive: true })
  .filter((f) => /(^|\/)local_[0-9a-f-]+\.json$/.test(f))
  .map((f) => path.join(STORE, f));

// cliSessionId -> how many Desktop entries reference it (to detect duplicates)
const refCount = new Map();
const entries = [];
for (const file of sessionFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn(`skip (unreadable): ${file}`);
    continue;
  }
  entries.push({ file, data });
  if (data.cliSessionId) refCount.set(data.cliSessionId, (refCount.get(data.cliSessionId) || 0) + 1);
}

let renamed = 0;
let skippedTitled = 0;
let noSource = 0;
for (const { file, data } of entries) {
  if (data.title) {
    skippedTitled++;
    continue;
  }
  const { cliSessionId, cwd } = data;
  if (!cliSessionId || !cwd) {
    noSource++;
    continue;
  }
  let title = transcriptTitle(cwd, cliSessionId) || path.basename(cwd);
  // Imported entries are keyed local_<cliSessionId>; a second entry for the
  // same CLI session means a natively-created original also exists.
  const isDuplicate =
    refCount.get(cliSessionId) > 1 && data.sessionId === `local_${cliSessionId}`;
  if (isDuplicate) title += ' (copy)';

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${path.basename(file)} -> "${title}"`);
  if (!DRY_RUN) {
    data.title = title;
    data.titleSource = 'user';
    const tmp = `${file}.tmp-rename`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }
  renamed++;
}

console.log(
  `\n${DRY_RUN ? 'would rename' : 'renamed'}: ${renamed}, already titled: ${skippedTitled}, missing cwd/id: ${noSource}`
);
if (!DRY_RUN && renamed > 0) console.log('Restart Claude Desktop to see the new names.');
