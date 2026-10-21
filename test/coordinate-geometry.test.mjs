import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { validateCatalogue } from '../src/app.js';
import { calculateCircleGeometry, calculateLineAngles } from '../src/native-tools.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('coordinate-geometry circle calculates centre radius and diameter', () => {
  const result = calculateCircleGeometry([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }]);
  close(result.centre.x, 5); close(result.centre.y, 0); close(result.radius, 5); close(result.diameter, 10);
});

test('coordinate-geometry circle rejects collinear and non-finite points', () => {
  assert.throws(() => calculateCircleGeometry([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), /collinear|straight line/i);
  assert.throws(() => calculateCircleGeometry([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]), /finite/i);
});

test('coordinate-geometry line mode calculates stable angles and lengths', () => {
  const result = calculateLineAngles([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 }]);
  close(result.smallerDegrees, 45); close(result.supplementaryDegrees, 135); close(result.directedDegrees, 45);
  close(result.firstDirectionDegrees, 0); close(result.secondDirectionDegrees, 45);
  close(result.firstLength, 10); close(result.secondLength, Math.sqrt(200));
  close(calculateLineAngles([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 7, y: 7 }, { x: 5, y: 5 }]).smallerDegrees, 0);
});

test('coordinate-geometry line mode rejects zero-length input', () => {
  assert.throws(() => calculateLineAngles([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }]), /different points|zero length/i);
});

test('coordinate-geometry catalogue entry is native and credits its dedicated source repository', async () => {
  const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
  const tool = catalogue.find((entry) => entry.slug === 'coordinate-geometry');
  assert.ok(tool);
  assert.equal(tool.implementation, 'native');
  assert.equal(tool.launchUrl, 'https://wayner84.github.io/tools/coordinate-geometry/');
  assert.equal(tool.sourceUrl, 'https://github.com/Wayner84/coordinate-geometry-calculator');
  assert.doesNotThrow(() => validateCatalogue(catalogue));
});

test('coordinate-geometry circle result includes an equal-scale visual preview with measured points', async () => {
  const { runNativeToolDefinition } = await import('../src/native-tools.js');
  const result = runNativeToolDefinition('coordinate-geometry', {
    mode: 'circle', x1: '0', y1: '0', x2: '10', y2: '0', x3: '5', y3: '5', x4: '10', y4: '10',
  });
  assert.equal(result.charts.length, 1);
  const [chart] = result.charts;
  assert.equal(chart.title, 'Circle preview');
  assert.deepEqual(chart.series.find((series) => series.label === 'Measured points').points.map(({ x, y }) => [x, y]), [[0, 0], [10, 0], [5, 5]]);
  assert.ok(chart.series.find((series) => series.label === 'Calculated circle').points.length >= 65);
  const plotAspect = (720 - 78 - 28) / (360 - 24 - 58);
  const xSpan = chart.xDomain[1] - chart.xDomain[0];
  const ySpan = chart.yDomain[1] - chart.yDomain[0];
  assert.ok(Math.abs(xSpan / ySpan - plotAspect) < 1e-10, 'preview must preserve equal X/Y scale');
});

test('coordinate-geometry line result includes both measured lines in its preview', async () => {
  const { runNativeToolDefinition } = await import('../src/native-tools.js');
  const result = runNativeToolDefinition('coordinate-geometry', {
    mode: 'lines', x1: '0', y1: '0', x2: '10', y2: '0', x3: '0', y3: '0', x4: '10', y4: '10',
  });
  const [chart] = result.charts;
  assert.equal(chart.title, 'Line-angle preview');
  assert.deepEqual(chart.series.map((series) => series.label), ['Line 1 · A→B', 'Line 2 · C→D']);
  assert.ok(chart.series.every((series) => series.kind === 'line-points'));
});

test('coordinate-geometry route builds tabs, a live preview layout and Townsend logo', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const route = await readFile('dist/coordinate-geometry/index.html', 'utf8');
  const source = await readFile('src/native-tools.js', 'utf8');
  const css = await readFile('src/native-tool.css', 'utf8');
  assert.match(route, /class="tool-logo"/);
  assert.match(route, /assets\/tpl-logo-pink\.png/);
  await access('dist/assets/tpl-logo-pink.png');
  assert.match(source, /role['"],['"]tablist/);
  assert.match(source, /Three-point circle/);
  assert.match(source, /Line angle/);
  assert.match(source, /coordinate-workspace/);
  assert.match(css, /\.coordinate-tabs/);
  assert.match(css, /\.coordinate-workspace/);
  assert.match(css, /\.tool-logo/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
});
