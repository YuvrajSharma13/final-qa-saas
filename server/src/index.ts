import mongoose from 'mongoose';
import { createApp } from './app.js';
import { config } from './config.js';
import { recoverInterruptedFixes } from './autofix/service.js';
import { recoverInterruptedRuns } from './qa/queue.js';

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch((e: Error) => console.warn(`[db] index init ${m.modelName}:`, e.message))));
  await recoverInterruptedRuns();
  await recoverInterruptedFixes();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`AI QA SaaS API listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
