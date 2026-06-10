#!/usr/bin/env node
// Aggregates LOCAL Claude Code token usage into data/claude.json.
//
// Claude Code writes a JSONL transcript per session under ~/.claude/projects/.
// This reads only the per-message token counts (input/output/cache), the model,
// and the timestamp — never any prompt or response text — and rolls them up by
// day and by model for the last N days. Run it locally, then commit the output:
//
//     node scripts/claude-usage.js && git add data/claude.json
//
// Nothing here touches the network or the cloud GitHub Action.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DAYS = 30;
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const OUT = path.join(__dirname, '..', 'data', 'claude.json');

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function main() {
  const files = walk(ROOT);
  if (!files.length) {
    console.error(`No Claude Code transcripts found under ${ROOT}.`);
    process.exit(1);
  }

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const perDay = new Map();   // 'YYYY-MM-DD' -> { input, output }
  const perModel = new Map(); // model id     -> total tokens
  let totalInput = 0, totalOutput = 0;
  let messages = 0;

  for (const file of files) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); }
    catch { continue; }

    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }

      const msg = row.message || {};
      const usage = msg.usage || row.usage;
      const ts = row.timestamp || msg.timestamp;
      const model = msg.model || row.model;
      if (!usage || !ts || !model) continue;
      if (String(model).includes('<')) continue; // skip synthetic placeholders

      const t = Date.parse(ts);
      if (isNaN(t) || t < cutoff) continue;

      const input = (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);
      const output = usage.output_tokens || 0;
      if (input === 0 && output === 0) continue;

      const day = new Date(t).toISOString().slice(0, 10);
      if (!perDay.has(day)) perDay.set(day, { input: 0, output: 0 });
      const slot = perDay.get(day);
      slot.input += input;
      slot.output += output;

      totalInput += input;
      totalOutput += output;
      perModel.set(model, (perModel.get(model) || 0) + input + output);
      messages++;
    }
  }

  if (perDay.size === 0) {
    console.error(`No usage found in the last ${DAYS} days.`);
    process.exit(1);
  }

  // Fill in zero-days so the chart reads as a continuous timeline.
  const daily = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const v = perDay.get(day) || { input: 0, output: 0 };
    daily.push({ date: day, input: v.input, output: v.output });
  }

  const total = totalInput + totalOutput;
  const models = [...perModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, tokens]) => ({ name, tokens, pct: total ? Math.round((tokens / total) * 100) : 0 }));

  const out = {
    generated_at: new Date().toISOString(),
    source: 'claude-code-local',
    period_days: DAYS,
    days_active: daily.filter(d => (d.input + d.output) > 0).length,
    messages,
    total_tokens: total,
    input_tokens: totalInput,
    output_tokens: totalOutput,
    primary_model: models.length ? models[0].name : null,
    daily,
    models,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log(`${files.length} transcripts · ${messages} messages · ${(total / 1e6).toFixed(1)}M tokens over ${out.days_active}/${DAYS} active days`);
  console.log(`Primary model: ${out.primary_model}`);
}

main();
