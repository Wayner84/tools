import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
