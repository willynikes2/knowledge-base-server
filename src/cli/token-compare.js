import { readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';

function usage() {
  console.log(`Usage: kb token-compare --raw=<paths> --summary=<paths> [options]

Required:
  --raw=PATHS          Comma-separated raw source files
  --summary=PATHS      Comma-separated synthesized/briefing files

Options:
  --agents=N           Number of agents sharing context (default: 3)
  --ingest-overhead=N  Extra one-time tokens for classify/summarize/synthesis
  --output-tokens=N    Optional output tokens per agent for total-cost math
  --input-price=N      Input price per 1M tokens
  --output-price=N     Output price per 1M tokens
  --json               Emit JSON instead of text

Notes:
  - Token counts are estimated with chars/4. This is for honest demo math, not exact billing.
  - Compare prompt/context cost, not network downloads.`);
}

function parseList(value) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => resolve(item));
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function readTargets(paths) {
  return paths.map(path => {
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new Error(`${path} is not a file`);
    }

    const text = readFileSync(path, 'utf8');
    return {
      path,
      name: basename(path),
      chars: text.length,
      estimated_tokens: estimateTokens(text),
    };
  });
}

function sum(items, key) {
  return items.reduce((total, item) => total + item[key], 0);
}

function pctSavings(from, to) {
  if (from <= 0) return 0;
  return ((from - to) / from) * 100;
}

function costFor(tokens, pricePerMillion) {
  if (typeof pricePerMillion !== 'number') return null;
  return (tokens / 1_000_000) * pricePerMillion;
}

function formatMoney(value) {
  return value == null ? 'n/a' : `$${value.toFixed(4)}`;
}

export function tokenCompare(args) {
  const options = {
    agents: 3,
    ingest_overhead: 0,
    output_tokens: 0,
    json: false,
  };

  for (const arg of args) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const [flag, rawValue] = arg.slice(2).split('=');
    const value = rawValue?.trim();

    switch (flag) {
      case 'raw':
        options.raw = parseList(value || '');
        break;
      case 'summary':
        options.summary = parseList(value || '');
        break;
      case 'agents':
        options.agents = Number.parseInt(value, 10);
        break;
      case 'ingest-overhead':
        options.ingest_overhead = Number.parseInt(value, 10);
        break;
      case 'output-tokens':
        options.output_tokens = Number.parseInt(value, 10);
        break;
      case 'input-price':
        options.input_price = Number.parseFloat(value);
        break;
      case 'output-price':
        options.output_price = Number.parseFloat(value);
        break;
      default:
        throw new Error(`Unknown flag: --${flag}`);
    }
  }

  if (!options.raw?.length || !options.summary?.length) {
    usage();
    process.exit(1);
  }

  if (!Number.isInteger(options.agents) || options.agents < 1) {
    throw new Error('--agents must be a positive integer');
  }

  const rawFiles = readTargets(options.raw);
  const summaryFiles = readTargets(options.summary);

  const rawTokens = sum(rawFiles, 'estimated_tokens');
  const summaryTokens = sum(summaryFiles, 'estimated_tokens');
  const outputTotal = options.agents * options.output_tokens;

  const noKbInputTokens = options.agents * rawTokens;
  const withKbFirstInputTokens = rawTokens + options.ingest_overhead + (options.agents * summaryTokens);
  const withKbLaterInputTokens = options.agents * summaryTokens;

  const result = {
    assumptions: {
      token_estimate: 'chars_div_4',
      agents: options.agents,
      ingest_overhead_tokens: options.ingest_overhead,
      output_tokens_per_agent: options.output_tokens,
    },
    raw: {
      files: rawFiles,
      total_estimated_tokens: rawTokens,
    },
    summary: {
      files: summaryFiles,
      total_estimated_tokens: summaryTokens,
    },
    scenarios: {
      no_kb: {
        input_tokens: noKbInputTokens,
        output_tokens: outputTotal,
        total_tokens: noKbInputTokens + outputTotal,
      },
      with_kb_first_run: {
        input_tokens: withKbFirstInputTokens,
        output_tokens: outputTotal,
        total_tokens: withKbFirstInputTokens + outputTotal,
      },
      with_kb_later_runs: {
        input_tokens: withKbLaterInputTokens,
        output_tokens: outputTotal,
        total_tokens: withKbLaterInputTokens + outputTotal,
      },
    },
    savings: {
      first_run_percent: Number(pctSavings(noKbInputTokens, withKbFirstInputTokens).toFixed(2)),
      later_run_percent: Number(pctSavings(noKbInputTokens, withKbLaterInputTokens).toFixed(2)),
    },
  };

  if (typeof options.input_price === 'number' || typeof options.output_price === 'number') {
    for (const scenario of Object.values(result.scenarios)) {
      scenario.input_cost = costFor(scenario.input_tokens, options.input_price);
      scenario.output_cost = costFor(scenario.output_tokens, options.output_price);
      scenario.total_cost = (scenario.input_cost || 0) + (scenario.output_cost || 0);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('Token Comparison');
  console.log('');
  console.log(`Agents: ${options.agents}`);
  console.log(`Raw source tokens: ${rawTokens}`);
  console.log(`Summary tokens: ${summaryTokens}`);
  console.log(`One-time ingest overhead: ${options.ingest_overhead}`);
  console.log('');
  console.log('Scenarios');
  console.log(`No KB input tokens: ${noKbInputTokens}`);
  console.log(`With KB first-run input tokens: ${withKbFirstInputTokens}`);
  console.log(`With KB later-run input tokens: ${withKbLaterInputTokens}`);
  console.log('');
  console.log('Savings');
  console.log(`First run: ${result.savings.first_run_percent}%`);
  console.log(`Later runs: ${result.savings.later_run_percent}%`);

  if (typeof options.input_price === 'number' || typeof options.output_price === 'number') {
    console.log('');
    console.log('Estimated Cost');
    console.log(`No KB total: ${formatMoney(result.scenarios.no_kb.total_cost)}`);
    console.log(`With KB first run total: ${formatMoney(result.scenarios.with_kb_first_run.total_cost)}`);
    console.log(`With KB later runs total: ${formatMoney(result.scenarios.with_kb_later_runs.total_cost)}`);
  }

  console.log('');
  console.log('Files');
  for (const file of rawFiles) {
    console.log(`raw     ${file.estimated_tokens.toString().padStart(6)}  ${file.path}`);
  }
  for (const file of summaryFiles) {
    console.log(`summary ${file.estimated_tokens.toString().padStart(6)}  ${file.path}`);
  }
}
