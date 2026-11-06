// Checks that .env.example and the code agree on which settings exist.
//
// Every variable keyholder or audit/run.sh reads must appear in .env.example,
// set or commented out, so nobody has to read the source to find a setting.
// And every variable .env.example lists must still be read somewhere, so it
// doesn't keep documenting a setting that no longer does anything.
//
//   node scripts/check-env-docs.mjs

import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

// Read from the shell, never from .env: DUALDRIVE_ENV says where .env is, and
// NVM_BIN is set by nvm.
const SHELL_ONLY = new Set(['DUALDRIVE_ENV', 'NVM_BIN']);

const used = new Map();
const use = (name, file) => {
  if (!SHELL_ONLY.has(name)) {
    used.set(name, used.get(name) ?? file);
  }
};

for (const file of readdirSync(new URL('keyholder/src/', root))) {
  const text = read(`keyholder/src/${file}`);
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|\b(?:required|list)\('([A-Z][A-Z0-9_]*)'\)/g)) {
    use(match[1] ?? match[2], `keyholder/src/${file}`);
  }
}
// ${NAME:?...} and ${NAME:-...}: the settings run.sh requires or reads if set.
// Comment lines are skipped; they mention ${VAR} as an example.
const runSh = read('audit/run.sh')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
for (const match of runSh.matchAll(/\$\{([A-Z][A-Z0-9_]*):[?-]/g)) {
  use(match[1], 'audit/run.sh');
}

const documented = new Set([...read('.env.example').matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

const undocumented = [...used].filter(([name]) => !documented.has(name));
const unused = [...documented].filter((name) => !used.has(name));

for (const [name, file] of undocumented) {
  console.error(`${name} is read in ${file} but missing from .env.example`);
}
for (const name of unused) {
  console.error(`${name} is in .env.example but nothing reads it`);
}
if (undocumented.length > 0 || unused.length > 0) {
  process.exit(1);
}
console.log(`.env.example matches the ${used.size} settings the code reads.`);
