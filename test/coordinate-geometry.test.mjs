import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { validateCatalogue } from '../src/app.js';
import { calculateCircleGeometry, calculateLineAngles, fitCircleGeometry, fitLineGeometry, calculateBestFitLineAngle } from '../src/native-tools.js';

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

test('coordinate-geometry fits a circle from 3 to 50 measured points with shared-centre envelopes', () => {
  const result = fitCircleGeometry([{x:0,y:5.1},{x:5,y:0},{x:0,y:-4.9},{x:-5,y:0}]);
  close(result.centre.x, 0);
  assert.ok(Math.abs(result.centre.y - 0.09999) < 1e-5);
  assert.ok(result.minDiameter < result.averageDiameter);
  assert.ok(result.maxDiameter > result.averageDiameter);
  assert.equal(result.radii.length, 4);
  assert.throws(() => fitCircleGeometry([{x:0,y:0},{x:1,y:1}]), /3.*50|points/i);
});

test('coordinate-geometry fits orthogonal lines from independent point sets', () => {
  const first = fitLineGeometry([{x:-2,y:-4.1},{x:-1,y:-2.1},{x:0,y:0.2},{x:1,y:1.9},{x:2,y:4.1}]);
  assert.ok(Math.abs(first.directionDegrees - Math.atan2(2,1)*180/Math.PI) < 2);
  const result = calculateBestFitLineAngle([{x:0,y:0},{x:5,y:.1},{x:10,y:0}], [{x:0,y:0},{x:5,y:5.1},{x:10,y:10}]);
  assert.ok(Math.abs(result.smallerDegrees - 45) < 1);
  assert.equal(result.lines.length, 2);
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

test('coordinate-geometry circle result includes three shared-centre envelopes and all measured points', async () => {
  const { runNativeToolDefinition } = await import('../src/native-tools.js');
  const result = runNativeToolDefinition('coordinate-geometry', {
    mode: 'circle', circleCount: '4', circleX1: '0', circleY1: '5.1', circleX2: '5', circleY2: '0', circleX3: '0', circleY3: '-4.9', circleX4: '-5', circleY4: '0',
  });
  assert.equal(result.charts.length, 1);
  const [chart] = result.charts;
  assert.equal(chart.title, 'Circle preview');
  assert.deepEqual(chart.series.map((series) => series.label), ['Average / best-fit circle', 'Maximum inscribed circle', 'Minimum circumscribed circle', 'Measured points']);
  assert.equal(chart.series.find((series) => series.label === 'Measured points').points.length, 4);
  assert.match(result.lines.map(([label]) => label).join('|'), /Average \/ best-fit Ø|Maximum inscribed Ø|Minimum circumscribed Ø/);
  const plotAspect = (720 - 78 - 28) / (360 - 24 - 58);
  const xSpan = chart.xDomain[1] - chart.xDomain[0];
  const ySpan = chart.yDomain[1] - chart.yDomain[0];
  assert.ok(Math.abs(xSpan / ySpan - plotAspect) < 1e-10, 'preview must preserve equal X/Y scale');
});

test('coordinate-geometry line result fits and previews every point in both measured sets', async () => {
  const { runNativeToolDefinition } = await import('../src/native-tools.js');
  const result = runNativeToolDefinition('coordinate-geometry', {
    mode: 'lines', line1Count: '3', line1X1: '0', line1Y1: '0', line1X2: '5', line1Y2: '.1', line1X3: '10', line1Y3: '0', line2Count: '3', line2X1: '0', line2Y1: '0', line2X2: '5', line2Y2: '5.1', line2X3: '10', line2Y3: '10',
  });
  const [chart] = result.charts;
  assert.equal(chart.title, 'Line-angle preview');
  assert.deepEqual(chart.series.map((series) => series.label), ['Line 1 best fit', 'Line 2 best fit', 'Line 1 measured points', 'Line 2 measured points']);
  assert.equal(chart.series.find((series) => series.label === 'Line 1 measured points').points.length, 3);
  assert.equal(chart.series.find((series) => series.label === 'Line 2 measured points').points.length, 3);
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
  assert.match(source, /Circle mode/);
  assert.match(source, /Line mode/);
  assert.match(source, /circleCount/);
  assert.match(source, /line1Count/);
  assert.match(source, /coordinate-workspace/);
  assert.match(css, /\.coordinate-tabs/);
  assert.match(css, /\.coordinate-workspace/);
  assert.match(css, /\.tool-logo/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
});
