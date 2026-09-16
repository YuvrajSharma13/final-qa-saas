// Starts the local GitHub-compatible test server with a QuickBite repo (used to smoke-test scripts/github-live-test.ts).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GitHubTestServer } from './github-test-server.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiqa-ghsrv-'));
const gh = await new GitHubTestServer().start(tmp);
const u = gh.addUser('live-user', 'Live User');
await gh.createRepo('live-user', 'quickbite-test', path.resolve(here, '../../../quickbite'));
console.log(JSON.stringify({ url: gh.url, token: u.token }));
