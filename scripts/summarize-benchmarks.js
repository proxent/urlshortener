#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const FAILURE_RATE_LIMIT = 0.01;

function usage() {
  console.error(`Usage:
  node scripts/summarize-benchmarks.js [options] <run-dir>...

Options:
  --json-out <path>      Write machine-readable series summary
  --markdown-out <path>  Write Markdown series summary
  -h, --help            Show this help
`);
}

function parseArgs(argv) {
  const args = {
    runDirs: [],
    jsonOut: null,
    markdownOut: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }

    if (arg === '--json-out') {
      args.jsonOut = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--markdown-out') {
      args.markdownOut = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    args.runDirs.push(arg);
  }

  if (args.runDirs.length === 0) {
    usage();
    throw new Error('At least one run directory is required.');
  }

  if (args.jsonOut === undefined || args.markdownOut === undefined) {
    throw new Error('Missing output path after option.');
  }

  return args;
}

function readMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const metadata = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    metadata[line.slice(0, separator)] = line.slice(separator + 1);
  }

  return metadata;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseIntegerOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function metric(summary, name) {
  return summary?.metrics?.[name] ?? null;
}

function metricCount(summary, name) {
  return numberOrNull(metric(summary, name)?.count);
}

function metricRate(summary, name) {
  const item = metric(summary, name);
  if (!item) {
    return null;
  }

  if (numberOrNull(item.value) !== null) {
    return item.value;
  }

  if (numberOrNull(item.rate) !== null) {
    return item.rate;
  }

  if (numberOrNull(item.passes) !== null && numberOrNull(item.fails) !== null) {
    const total = item.passes + item.fails;
    return total > 0 ? item.passes / total : null;
  }

  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fallbackTrendStatFromLog(runDir, metricName, statName) {
  const logPath = path.join(runDir, 'k6-output.log');
  if (!fs.existsSync(logPath)) {
    return null;
  }

  const log = fs.readFileSync(logPath, 'utf8');
  const marker = `\n    ${metricName}\n`;
  const markerIndex = log.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const blockEnd = log.indexOf('\n\n', markerIndex + marker.length);
  const block = log.slice(markerIndex, blockEnd === -1 ? undefined : blockEnd);
  const match = block.match(new RegExp(`${escapeRegExp(statName)}=([0-9.]+)`));
  return match ? Number(match[1]) : null;
}

function trendStat(summary, runDir, metricName, statName) {
  const value = numberOrNull(metric(summary, metricName)?.[statName]);
  if (value !== null) {
    return value;
  }

  return fallbackTrendStatFromLog(runDir, metricName, statName);
}

function firstNonNull(values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function readRun(runDir) {
  const summaryPath = path.join(runDir, 'k6-summary.json');
  const metadataPath = path.join(runDir, 'run-metadata.env');
  const metadata = readMetadata(metadataPath);
  const runName = metadata.RUN_LABEL || path.basename(runDir);
  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : null;
  const k6ExitCode = parseIntegerOrNull(metadata.K6_EXIT_CODE);
  const reasons = [];

  if (!summary) {
    reasons.push('missing k6-summary.json');
  }

  const failureRate = firstNonNull([
    metricRate(summary, 'http_req_failed{phase:run}'),
    metricRate(summary, 'http_req_failed'),
  ]);
  const droppedIterations = metricCount(summary, 'dropped_iterations');
  const droppedIterationsRun = metricCount(summary, 'dropped_iterations{phase:run}');
  const redirectSuccessRate = metricRate(summary, 'redirect_success_rate');
  const shortenSuccessRate = metricRate(summary, 'shorten_success_rate');

  if (k6ExitCode !== null && k6ExitCode !== 0) {
    reasons.push(`K6_EXIT_CODE=${k6ExitCode}`);
  }

  if (droppedIterations !== null && droppedIterations !== 0) {
    reasons.push(`dropped_iterations=${droppedIterations}`);
  }

  if (failureRate !== null && failureRate >= FAILURE_RATE_LIMIT) {
    reasons.push(`http_req_failed=${formatPercent(failureRate)}`);
  }

  if (redirectSuccessRate !== null && redirectSuccessRate <= 0.99) {
    reasons.push(`redirect_success_rate=${formatPercent(redirectSuccessRate)}`);
  }

  if (shortenSuccessRate !== null && shortenSuccessRate <= 0.99) {
    reasons.push(`shorten_success_rate=${formatPercent(shortenSuccessRate)}`);
  }

  const row = {
    run: runName,
    dir: runDir,
    gitSha: metadata.GIT_SHA || null,
    startedAtUtc: metadata.STARTED_AT_UTC || null,
    target: metadata.TARGET || null,
    mode: metadata.MODE || null,
    baseRps: parseIntegerOrNull(metadata.BASE_RPS),
    expectedUrlCount: parseIntegerOrNull(metadata.EXPECTED_URL_COUNT),
    seedCodeCount: parseIntegerOrNull(metadata.SEED_CODE_COUNT),
    k6ExitCode,
    achievedRps: numberOrNull(metric(summary, 'http_reqs')?.rate),
    requestCount: metricCount(summary, 'http_reqs'),
    httpReqFailedRate: failureRate,
    droppedIterations,
    droppedIterationsRun,
    redirectSuccessRate,
    shortenSuccessRate,
    redirectP95Ms: trendStat(summary, runDir, 'redirect_duration_ms', 'p(95)'),
    redirectP99Ms: trendStat(summary, runDir, 'redirect_duration_ms', 'p(99)'),
    shortenP95Ms: trendStat(summary, runDir, 'shorten_duration_ms', 'p(95)'),
    shortenP99Ms: trendStat(summary, runDir, 'shorten_duration_ms', 'p(99)'),
    allP95Ms: trendStat(summary, runDir, 'http_req_duration', 'p(95)'),
    allP99Ms: trendStat(summary, runDir, 'http_req_duration', 'p(99)'),
    exclusionReasons: reasons,
  };

  row.validForAggregate = reasons.length === 0;
  return row;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function stats(values) {
  const cleanValues = values.filter((value) => numberOrNull(value) !== null);
  const sortedValues = [...cleanValues].sort((a, b) => a - b);
  const count = cleanValues.length;

  if (count === 0) {
    return null;
  }

  const mean = cleanValues.reduce((sum, value) => sum + value, 0) / count;
  const sampleVariance =
    count > 1
      ? cleanValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)
      : 0;
  const sd = Math.sqrt(sampleVariance);
  const median = percentile(sortedValues, 0.5);
  const q1 = percentile(sortedValues, 0.25);
  const q3 = percentile(sortedValues, 0.75);

  return {
    n: count,
    mean,
    sd,
    median,
    q1,
    q3,
    iqr: q3 - q1,
    min: sortedValues[0],
    max: sortedValues[sortedValues.length - 1],
    cv: mean === 0 ? null : sd / Math.abs(mean),
  };
}

const aggregateFields = [
  ['achievedRps', 'achieved req/s', 'number'],
  ['httpReqFailedRate', 'HTTP failure rate', 'percent'],
  ['redirectSuccessRate', 'redirect success rate', 'percent'],
  ['shortenSuccessRate', 'shorten success rate', 'percent'],
  ['droppedIterations', 'dropped iterations', 'integer'],
  ['redirectP95Ms', 'redirect p95 ms', 'ms'],
  ['redirectP99Ms', 'redirect p99 ms', 'ms'],
  ['shortenP95Ms', 'shorten p95 ms', 'ms'],
  ['shortenP99Ms', 'shorten p99 ms', 'ms'],
  ['allP95Ms', 'overall p95 ms', 'ms'],
  ['allP99Ms', 'overall p99 ms', 'ms'],
];

function buildSummary(runs) {
  const validRuns = runs.filter((run) => run.validForAggregate);
  const aggregateRuns = validRuns.length > 0 ? validRuns : runs;
  const aggregateUsesAllRuns = validRuns.length === 0;
  const aggregates = {};

  for (const [key, label, type] of aggregateFields) {
    aggregates[key] = {
      label,
      type,
      stats: stats(aggregateRuns.map((run) => run[key])),
    };
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    failureRateLimit: FAILURE_RATE_LIMIT,
    totalRuns: runs.length,
    validRuns: validRuns.length,
    excludedRuns: runs.length - validRuns.length,
    aggregateUsesAllRuns,
    runs,
    aggregates,
  };
}

function formatNumber(value, digits = 2) {
  return numberOrNull(value) === null ? '' : value.toFixed(digits);
}

function formatInteger(value) {
  return numberOrNull(value) === null ? '' : String(Math.round(value));
}

function formatPercent(value) {
  return numberOrNull(value) === null ? '' : `${(value * 100).toFixed(2)}%`;
}

function formatValue(value, type) {
  if (type === 'percent') {
    return formatPercent(value);
  }

  if (type === 'integer') {
    return formatInteger(value);
  }

  return formatNumber(value, 2);
}

function formatCv(value) {
  return numberOrNull(value) === null ? '' : `${(value * 100).toFixed(1)}%`;
}

function markdownEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function renderMarkdown(summary) {
  const lines = [];
  const validCriteria =
    'K6_EXIT_CODE is 0 when present, global dropped_iterations is 0, http_req_failed is below 1%, and endpoint success rates are above 99%.';

  lines.push('# Benchmark Series Summary');
  lines.push('');
  lines.push(`Generated UTC: ${summary.generatedAtUtc}`);
  lines.push(
    `Runs: ${summary.totalRuns} total, ${summary.validRuns} valid for aggregate, ${summary.excludedRuns} excluded.`,
  );
  lines.push(`Valid aggregate criteria: ${validCriteria}`);

  if (summary.aggregateUsesAllRuns) {
    lines.push('No valid runs were found; aggregate values below use all runs for diagnostics only.');
  }

  lines.push('');
  lines.push('## Run-Level Results');
  lines.push('');
  lines.push(
    '| run | exit | req/s | requests | fail rate | drops | redirect p95 | redirect p99 | shorten p95 | shorten p99 | aggregate | notes |',
  );
  lines.push(
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  );

  for (const run of summary.runs) {
    lines.push(
      [
        markdownEscape(run.run),
        run.k6ExitCode === null ? '' : String(run.k6ExitCode),
        formatNumber(run.achievedRps, 2),
        formatInteger(run.requestCount),
        formatPercent(run.httpReqFailedRate),
        formatInteger(run.droppedIterations),
        formatNumber(run.redirectP95Ms, 2),
        formatNumber(run.redirectP99Ms, 2),
        formatNumber(run.shortenP95Ms, 2),
        formatNumber(run.shortenP99Ms, 2),
        run.validForAggregate ? 'yes' : 'no',
        markdownEscape(run.exclusionReasons.join(', ')),
      ].join(' | ').replace(/^/, '| ') + ' |',
    );
  }

  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push('| metric | n | mean | sd | median | IQR | min | max | CV |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const [key] of aggregateFields) {
    const aggregate = summary.aggregates[key];
    if (!aggregate.stats) {
      continue;
    }

    lines.push(
      [
        aggregate.label,
        String(aggregate.stats.n),
        formatValue(aggregate.stats.mean, aggregate.type),
        formatValue(aggregate.stats.sd, aggregate.type),
        formatValue(aggregate.stats.median, aggregate.type),
        formatValue(aggregate.stats.iqr, aggregate.type),
        formatValue(aggregate.stats.min, aggregate.type),
        formatValue(aggregate.stats.max, aggregate.type),
        formatCv(aggregate.stats.cv),
      ].join(' | ').replace(/^/, '| ') + ' |',
    );
  }

  lines.push('');
  lines.push('Report published results from the aggregate table, and keep the run-level table with raw artifacts.');
  return lines.join('\n');
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = args.runDirs.map((runDir) => readRun(runDir));
  const summary = buildSummary(runs);
  const markdown = renderMarkdown(summary);

  if (args.jsonOut) {
    writeFile(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  }

  if (args.markdownOut) {
    writeFile(args.markdownOut, `${markdown}\n`);
  }

  process.stdout.write(`${markdown}\n`);
}

try {
  main();
} catch (error) {
  console.error(`[benchmark-summary] ${error.message}`);
  process.exit(1);
}
