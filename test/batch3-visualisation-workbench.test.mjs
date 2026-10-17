import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  parseSpcObservationsCsv,
  parseSpcCsvWithWorker,
  renderAccessibleChart,
  runNativeToolDefinition,
} from '../src/native-tools.js';

test('SPC CSV parser selects a named numeric column while preserving time order', () => {
  const parsed = parseSpcObservationsCsv({
    csv: 'timestamp,value,note\n2026-09-10T09:00,10.1,start\n2026-09-10T09:01,9.9,repeat\n',
    column: 'value',
  });
  assert.deepEqual(parsed.values, [10.1, 9.9]);
  assert.deepEqual(parsed.headers, ['timestamp', 'value', 'note']);
  assert.equal(parsed.column, 'value');
  assert.equal(parsed.headerMode, 'named-header');
});

test('SPC browser parser uses a worker and terminates it after a bounded local parse', async () => {
  const calls = [];
  class FakeWorker {
    constructor(url, options) { calls.push(['construct', String(url), options]); }
    postMessage(message) {
      calls.push(['post', message]);
      queueMicrotask(() => this.onmessage({ data: { ok: true, result: { values: [3, 4], headers: ['reading'], column: 'reading', headerMode: 'named-header' } } }));
    }
    terminate() { calls.push(['terminate']); }
  }
  const parsed = await parseSpcCsvWithWorker('reading\n3\n4', 'reading', { WorkerClass: FakeWorker, workerUrl: 'local-worker.js' });
  assert.deepEqual(parsed.values, [3, 4]);
  assert.deepEqual(calls, [
    ['construct', 'local-worker.js', { type: 'module', name: 'spc-csv-parser' }],
    ['post', { csv: 'reading\n3\n4', column: 'reading' }],
    ['terminate'],
  ]);
});

test('SPC browser parser rejects and terminates a worker that exceeds its timeout', async () => {
  let terminated = false;
  class HangingWorker {
    postMessage() {}
    terminate() { terminated = true; }
  }
  await assert.rejects(
    parseSpcCsvWithWorker('reading\n3\n4', 'reading', { WorkerClass: HangingWorker, workerUrl: 'local-worker.js', timeoutMs: 5 }),
    /timed out|timeout/i,
  );
  assert.equal(terminated, true);
});

test('SPC CSV parser inherits strict quoted-field grammar', () => {
  assert.throws(() => parseSpcObservationsCsv({ csv: 'value\n"1"e2\n2' }), /malformed CSV|closing quote/i);
  assert.throws(() => parseSpcObservationsCsv({ csv: 'value\n1"2\n2' }), /malformed CSV|quote.*unquoted/i);
});

test('SPC CSV parser rejects blank observations instead of dropping or coercing them to zero', () => {
  for (const csv of ['value\n10\n   \n20', 'value\n10\n""\n20', 'value\n10\n\n20']) {
    assert.throws(
      () => parseSpcObservationsCsv({ csv }),
      /observation row 2.*finite number|blank/i,
    );
  }
});

test('dedicated SPC worker delegates only to the bounded pure parser', async () => {
  const source = await readFile('src/csv-parser-worker.js', 'utf8');
  assert.match(source, /parseSpcObservationsCsv/);
  assert.match(source, /postMessage/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|innerHTML|eval\s*\(/);
});

test('SPC workbench returns complete accessible I and MR chart contracts with rule flags', () => {
  const result = runNativeToolDefinition('spc-imr-chart', {
    unit: 'mm', column: 'value', csv: 'value\n0\n0\n0\n0\n10',
  });
  assert.equal(result.charts.length, 2);
  const [individuals, movingRange] = result.charts;
  assert.equal(individuals.title, 'Individuals chart');
  assert.match(individuals.summary, /5 observations.*1 beyond-limit signal/i);
  assert.deepEqual(individuals.series[0].points.map(({ x, y }) => [x, y]), [[1, 0], [2, 0], [3, 0], [4, 0], [5, 10]]);
  assert.deepEqual(individuals.referenceLines.map(({ label }) => label), ['UCL', 'Centre', 'LCL']);
  assert.deepEqual(individuals.series[1].points.map(({ x }) => x), [5]);
  assert.equal(movingRange.title, 'Moving-range chart');
  assert.equal(movingRange.series[0].points.length, 4);
  assert.deepEqual(movingRange.referenceLines.map(({ label }) => label), ['UCL', 'Centre', 'LCL']);
  assert.deepEqual(movingRange.series[1].points.map(({ x }) => x), [5]);
  assert.ok(result.rows.length >= 1, 'text signal table must remain available');
});

test('calibration workbench returns fitted-line and residual chart contracts while retaining its table', () => {
  const result = runNativeToolDefinition('calibration-curve', {
    referenceUnit: 'mm', responseUnit: 'V', predictAt: '1.5', allowExtrapolation: 'false',
    pairs: '0,1\n1,3.2\n2,5',
  });
  assert.equal(result.charts.length, 2);
  const [fit, residuals] = result.charts;
  assert.equal(fit.title, 'Calibration fit');
  assert.deepEqual(fit.series.map(({ label }) => label), ['Calibration points', 'Fitted line']);
  assert.deepEqual(fit.series[0].points.map(({ x, y }) => [x, y]), [[0, 1], [1, 3.2], [2, 5]]);
  assert.equal(fit.series[1].points.length, 3);
  assert.equal(residuals.title, 'Calibration residuals');
  assert.deepEqual(residuals.referenceLines, [{ label: 'Zero residual', value: 0, className: 'centre' }]);
  assert.equal(residuals.series[0].points.length, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.lines.at(-1)[0], 'Prediction within input range');
  assert.equal(result.lines.at(-1)[1], 'Yes');
});

test('OC workbench returns a curve with separately marked AQL and LQ points and retains numerical rows', () => {
  const result = runNativeToolDefinition('acceptance-sampling-oc', {
    sampleSize: '10', acceptanceNumber: '1', defectProbability: '0.05', aql: '0.01', lq: '0.1',
    curveProbabilities: '0\n0.05\n0.2\n1',
  });
  assert.equal(result.charts.length, 1);
  const chart = result.charts[0];
  assert.equal(chart.title, 'Operating characteristic curve');
  assert.deepEqual(chart.series[0].points.map(({ x }) => x), [0, 0.05, 0.2, 1]);
  assert.deepEqual(chart.series.slice(1).map(({ label, points }) => [label, points[0].x]), [['AQL', 0.01], ['LQ / LTPD', 0.1]]);
  assert.match(chart.summary, /producer risk.*AQL.*consumer risk.*LQ/i);
  assert.equal(result.rows.length, 4);
});

class FakeNode {
  constructor(tagName, namespace = null) { this.tagName = tagName; this.namespace = namespace; this.children = []; this.attributes = {}; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  query(tagName) {
    if (this.tagName === tagName) return this;
    for (const child of this.children) { const match = child.query?.(tagName); if (match) return match; }
    return null;
  }
}

class SafeFakeDocument {
  constructor() { this.created = []; }
  createElement(tagName) { const node = new FakeNode(tagName); this.created.push(node); return node; }
  createElementNS(namespace, tagName) { const node = new FakeNode(tagName, namespace); this.created.push(node); return node; }
}

test('accessible renderer creates a responsive titled SVG and textual figure summary without unsafe HTML', () => {
  const documentRef = new SafeFakeDocument();
  const parent = new FakeNode('section');
  const chart = runNativeToolDefinition('acceptance-sampling-oc', {
    sampleSize: '10', acceptanceNumber: '1', defectProbability: '0.05', aql: '0.01', lq: '0.1', curveProbabilities: '0\n0.1\n1',
  }).charts[0];
  const figure = renderAccessibleChart(documentRef, parent, chart, 0);
  const svg = figure.query('svg');
  assert.equal(parent.children[0], figure);
  assert.equal(figure.tagName, 'figure');
  assert.equal(figure.attributes['aria-labelledby'], 'chart-title-0 chart-summary-0');
  assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.viewBox, '0 0 720 360');
  assert.equal(svg.attributes.role, 'img');
  assert.equal(svg.query('title').textContent, chart.title);
  assert.match(figure.query('figcaption').textContent, /producer risk.*consumer risk/i);
  assert.ok(documentRef.created.every((node) => !Object.hasOwn(node, 'innerHTML')));
});

test('chart renderer fails closed on unbounded or non-finite chart data', () => {
  const documentRef = new SafeFakeDocument();
  const parent = new FakeNode('section');
  const base = { title: 'Bad', summary: 'Bad data', xLabel: 'x', yLabel: 'y', referenceLines: [], series: [{ label: 'bad', kind: 'line', className: 'fit', points: [{ x: 0, y: NaN }] }] };
  assert.throws(() => renderAccessibleChart(documentRef, parent, base, 1), /finite/i);
  const points = Array.from({ length: 10002 }, (_, index) => ({ x: index, y: index }));
  assert.throws(() => renderAccessibleChart(documentRef, parent, { ...base, series: [{ ...base.series[0], points }] }, 1), /10,001|bounded/i);
});

test('chart renderer preserves tiny nonzero tick labels and rejects non-finite derived geometry', () => {
  const tinyDocument = new SafeFakeDocument();
  const tinyChart = runNativeToolDefinition('calibration-curve', {
    referenceUnit: 'mm', responseUnit: 'V', predictAt: '1.5', allowExtrapolation: 'false',
    pairs: '0,1e-9\n1,1.5e-9\n2,2e-9',
  }).charts[0];
  renderAccessibleChart(tinyDocument, new FakeNode('section'), tinyChart, 2);
  const yTicks = tinyDocument.created.filter((node) => node.tagName === 'text' && node.attributes['text-anchor'] === 'end').map((node) => node.textContent);
  assert.equal(yTicks.length, 5);
  assert.ok(yTicks.some((value) => value !== '0'));
  assert.ok(yTicks.every((value) => value === '0' || /[1-9]/.test(value)), `tiny ticks were rounded to false zero: ${yTicks}`);

  const badGeometry = {
    title: 'Bad geometry', summary: 'Finite inputs with unsafe derived geometry', xLabel: 'x', yLabel: 'y',
    xDomain: [0, 1], yDomain: [0, 1], referenceLines: [],
    series: [{ label: 'bad', kind: 'line-points', className: 'fit', points: [{ x: 0, y: 0 }, { x: Number.MAX_VALUE, y: Number.MAX_VALUE }] }],
  };
  assert.throws(() => renderAccessibleChart(new SafeFakeDocument(), new FakeNode('section'), badGeometry, 3), /geometry|finite numeric range|bounded/i);
});

test('generated result tables include a caption and scoped column headers', async () => {
  const source = await readFile('src/native-tools.js', 'utf8');
  assert.match(source, /createElement\(['"]caption['"]\)/);
  assert.match(source, /setAttribute\(['"]scope['"],\s*['"]col['"]\)/);
});
