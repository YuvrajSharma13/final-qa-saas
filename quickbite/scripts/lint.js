// Project lint: syntax check for every JS file plus the team's UI copy guideline
// ("never show generic 'Request failed' / 'Something went wrong' messages to customers").
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const BANNED_COPY = [/Request failed/i, /Something went wrong/i];
const problems = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) check(full);
  }
}

function check(file) {
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`${rel}: syntax error\n${e.stderr}`);
  }
  if (rel.startsWith(`public${path.sep}`)) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const re of BANNED_COPY) if (re.test(line)) problems.push(`${rel}:${i + 1}: customer-facing copy "${line.match(re)[0]}" is not allowed (copy guideline QB-12)`);
      });
  }
}

walk(root);
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} lint problem(s)`);
  process.exit(1);
}
console.log('lint ok');
