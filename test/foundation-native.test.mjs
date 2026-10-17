import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { validateCatalogue } from '../src/app.js';
import { calculateBoltCircle, calculateOee, calculateSineBar, calculateTaktCapacity, calculateThermalCorrection } from '../src/native-tools.js';

const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
const nativeBase = {
  slug: 'native-example', name: 'Native example', description: 'Example.', category: 'Engineering',
  hosting: 'wayne-hosted', license: 'MIT', launchUrl: 'https://wayner84.github.io/tools/native-example/',
  sourceUrl: 'https://github.com/Wayner84/tools', destinationType: 'worksheet', operator: 'Wayne',
  dataBoundary: 'Local only.', functionalCheck: 'Numerically tested.', aliases: [], implementation: 'native',
};

test('catalogue validation accepts only the supported native implementation contract', () => {
  assert.equal(validateCatalogue([nativeBase])[0].implementation, 'native');
  assert.throws(() => validateCatalogue([{ ...nativeBase, hosting: 'external-service' }]), /native.*wayne-hosted/i);
  assert.throws(() => validateCatalogue([{ ...nativeBase, sourceUrl: 'https://example.test/source' }]), /native.*sourceUrl/i);
  assert.throws(() => validateCatalogue([{ ...nativeBase, implementation: 'server' }]), /implementation/i);
});

test('bolt-circle worksheet calculates equal-spaced coordinates with origin and direction', () => {
  const ccw = calculateBoltCircle({ diameter: 100, holes: 4, startAngle: 0, originX: 10, originY: -5, direction: 'ccw' });
  assert.deepEqual(ccw.map(({ x, y }) => [Math.round(x), Math.round(y)]), [[60, -5], [10, 45], [-40, -5], [10, -55]]);
  const cw = calculateBoltCircle({ diameter: 100, holes: 4, startAngle: 0, originX: 10, originY: -5, direction: 'cw' });
  assert.equal(Math.round(cw[1].y), -55);
});

test('bolt-circle worksheet rejects invalid and non-finite geometry', () => {
  assert.throws(() => calculateBoltCircle({ diameter: 0, holes: 4, startAngle: 0, originX: 0, originY: 0, direction: 'ccw' }), /diameter/i);
  assert.throws(() => calculateBoltCircle({ diameter: 100, holes: 2.5, startAngle: 0, originX: 0, originY: 0, direction: 'ccw' }), /holes/i);
  assert.throws(() => calculateBoltCircle({ diameter: 100, holes: 4, startAngle: Infinity, originX: 0, originY: 0, direction: 'ccw' }), /finite/i);
});

test('thermal worksheet applies the stated linear correction and uncertainty propagation', () => {
  const result = calculateThermalCorrection({ measuredLength: 100, measuredTemp: 30, referenceTemp: 20, alpha: 0.00001, lengthUncertainty: 0.002, tempUncertainty: 0.2, alphaUncertainty: 0 });
  assert.ok(Math.abs(result.referenceLength - 99.99) < 1e-12);
  assert.ok(Math.abs(result.correction + 0.01) < 1e-12);
  assert.ok(result.combinedUncertainty > 0.002 && result.combinedUncertainty < 0.00201);
});

test('thermal worksheet rejects invalid, negative-uncertainty and non-finite inputs', () => {
  const valid = { measuredLength: 100, measuredTemp: 30, referenceTemp: 20, alpha: 0.00001, lengthUncertainty: 0.002, tempUncertainty: 0.2, alphaUncertainty: 0 };
  assert.throws(() => calculateThermalCorrection({ ...valid, measuredLength: 0 }), /length/i);
  assert.throws(() => calculateThermalCorrection({ ...valid, tempUncertainty: -1 }), /uncertainty/i);
  assert.throws(() => calculateThermalCorrection({ ...valid, alpha: NaN }), /finite/i);
});

test('OEE worksheet calculates availability, performance, quality and transparent losses', () => {
  const result = calculateOee({ plannedTime: 480, runTime: 400, idealCycleTime: 0.5, totalCount: 720, goodCount: 700 });
  assert.ok(Math.abs(result.availability - 5 / 6) < 1e-12);
  assert.equal(result.performance, 0.9);
  assert.ok(Math.abs(result.quality - 700 / 720) < 1e-12);
  assert.ok(Math.abs(result.oee - 0.7291666666666666) < 1e-12);
  assert.deepEqual(result.losses, { downtime: 80, speedTime: 40, rejectCount: 20 });
});

test('OEE worksheet rejects zero denominators and inconsistent counts, and flags suspect performance', () => {
  const valid = { plannedTime: 480, runTime: 400, idealCycleTime: 0.5, totalCount: 720, goodCount: 700 };
  assert.throws(() => calculateOee({ ...valid, runTime: 0 }), /run time/i);
  assert.throws(() => calculateOee({ ...valid, goodCount: 721 }), /good count/i);
  assert.throws(() => calculateOee({ ...valid, plannedTime: Infinity }), /finite/i);
  assert.match(calculateOee({ ...valid, idealCycleTime: 1 }).warnings.join(' '), /100%/);
});

test('takt worksheet separates demand takt, observed cycle and parallel capacity', () => {
  const result = calculateTaktCapacity({ shiftMinutes: 480, breakMinutes: 60, demand: 140, cycleMinutes: 4, parallelStations: 2 });
  assert.equal(result.availableMinutes, 420);
  assert.equal(result.taktMinutes, 3);
  assert.equal(result.capacity, 210);
  assert.equal(result.requiredStations, 2);
  assert.ok(Math.abs(result.load - 2 / 3) < 1e-12);
});

test('takt worksheet rejects non-finite, negative and zero-denominator inputs', () => {
  const valid = { shiftMinutes: 480, breakMinutes: 60, demand: 140, cycleMinutes: 4, parallelStations: 2 };
  assert.throws(() => calculateTaktCapacity({ ...valid, demand: 0 }), /demand/i);
  assert.throws(() => calculateTaktCapacity({ ...valid, breakMinutes: 480 }), /available/i);
  assert.throws(() => calculateTaktCapacity({ ...valid, parallelStations: 0 }), /stations/i);
  assert.throws(() => calculateTaktCapacity({ ...valid, cycleMinutes: NaN }), /finite/i);
});

test('sine-bar worksheet calculates height, inferred angle and first-order sensitivity', () => {
  const result = calculateSineBar({ centreDistance: 100, angleDegrees: 30, stackHeight: 50, centreUncertainty: 0.01, heightUncertainty: 0.005 });
  assert.ok(Math.abs(result.requiredHeight - 50) < 1e-12);
  assert.ok(Math.abs(result.inferredAngleDegrees - 30) < 1e-12);
  assert.ok(result.angleUncertaintyDegrees > 0);
});

test('sine-bar worksheet rejects impossible and non-finite geometry', () => {
  const valid = { centreDistance: 100, angleDegrees: 30, stackHeight: 50, centreUncertainty: 0.01, heightUncertainty: 0.005 };
  assert.throws(() => calculateSineBar({ ...valid, centreDistance: 0 }), /centre/i);
  assert.throws(() => calculateSineBar({ ...valid, stackHeight: 101 }), /stack/i);
  assert.throws(() => calculateSineBar({ ...valid, angleDegrees: 90 }), /angle/i);
  assert.throws(() => calculateSineBar({ ...valid, stackHeight: NaN }), /finite/i);
});

test('build emits shared client-side assets and native pages instead of external interstitials', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  await access('dist/native-tools.js');
  await access('dist/native-tool.css');
  const route = await readFile('dist/bolt-circle/index.html', 'utf8');
  assert.match(route, /<form\b/);
  assert.match(route, /native-tools\.js/);
  assert.doesNotMatch(route, /This destination is outside Tool Deck/);
});

test('native worksheet panels and long technical text can shrink to a phone viewport', async () => {
  const css = await readFile('src/native-tool.css', 'utf8');
  assert.match(css, /\.panel\{[^}]*min-width:\s*0/);
  assert.match(css, /\.formula\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.fields\{[^}]*min-width:\s*0/);
});
