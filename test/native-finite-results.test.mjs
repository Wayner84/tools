import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpcCsvWithWorker,
  calculateImrChart,
  fitLinearCalibration,
  calculateSpurGear,
  calculateBoltCircle,
  calculateThermalCorrection,
  calculateOee,
  calculateTaktCapacity,
  calculateToleranceChain,
  calculateUncertaintyBudget,
  transformPointListCsv,
  generateInspectionReportFromCsv,
} from '../src/native-tools.js';

const maximum = Number.MAX_VALUE;
const finiteResultError = /finite numeric range|numeric range|overflow|finite result/i;

const inspectionMapping = {
  id: 'feature',
  nominal: 'nominal',
  measured: 'measured',
  lowerTolerance: 'lower',
  upperTolerance: 'upper',
};

test('I-MR rejects moving-range overflow from finite observations', () => {
  assert.throws(() => calculateImrChart([maximum, -maximum]), finiteResultError);
});

test('linear calibration rejects indeterminate regression results from finite pairs', () => {
  assert.throws(() => fitLinearCalibration({ reference: [-maximum, maximum], response: [-maximum, maximum] }), finiteResultError);
});

test('spur gear rejects diameter overflow from finite geometry inputs', () => {
  assert.throws(() => calculateSpurGear({ module: maximum, teeth1: 6, teeth2: 6, pressureAngleDeg: 20 }), finiteResultError);
});

test('bolt circle rejects non-finite coordinates from finite geometry inputs', () => {
  assert.throws(() => calculateBoltCircle({ diameter: maximum, holes: 2, startAngle: 0, originX: maximum, originY: 0, direction: 'ccw' }), finiteResultError);
});

test('thermal correction rejects overflow from finite metrology inputs', () => {
  assert.throws(() => calculateThermalCorrection({
    measuredLength: maximum,
    measuredTemp: 2,
    referenceTemp: 1,
    alpha: maximum,
    lengthUncertainty: 0,
    tempUncertainty: 0,
    alphaUncertainty: 0,
  }), finiteResultError);
});

test('OEE rejects performance overflow from finite production inputs', () => {
  assert.throws(() => calculateOee({
    plannedTime: 1,
    runTime: Number.MIN_VALUE,
    idealCycleTime: maximum,
    totalCount: Number.MAX_SAFE_INTEGER,
    goodCount: Number.MAX_SAFE_INTEGER,
  }), finiteResultError);
});

test('takt and capacity rejects capacity overflow from finite production inputs', () => {
  assert.throws(() => calculateTaktCapacity({
    shiftMinutes: maximum,
    breakMinutes: 0,
    demand: 1,
    cycleMinutes: 1,
    parallelStations: Number.MAX_SAFE_INTEGER,
  }), finiteResultError);
});

test('tolerance chain rejects accumulated overflow from finite components', () => {
  assert.throws(() => calculateToleranceChain([
    { nominal: maximum, plus: 0, minus: 0, sign: 1 },
    { nominal: maximum, plus: 0, minus: 0, sign: 1 },
  ]), finiteResultError);
});

test('uncertainty budget rejects contribution overflow from finite components', () => {
  assert.throws(() => calculateUncertaintyBudget({
    components: [{ magnitude: maximum, distribution: 'standard', sensitivity: maximum }],
    coverageFactor: 2,
  }), finiteResultError);
});

test('coordinate transformation rejects overflow and never exports non-finite coordinates', () => {
  const input = `id,x,y,z\nP1,${maximum},0,0`;
  assert.throws(() => transformPointListCsv({
    csv: input,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    translationX: maximum,
    translationY: 0,
    translationZ: 0,
    inverse: false,
    unit: 'mm',
  }), finiteResultError);

  const ordinary = transformPointListCsv({
    csv: 'id,x,y,z\nP1,1,2,3',
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    translationX: 1,
    translationY: 1,
    translationZ: 1,
    inverse: false,
    unit: 'mm',
  });
  assert.doesNotMatch(ordinary.csv, /(?:^|,)(?:NaN|[-+]?Infinity)(?:,|\r?$)/m);
});

test('inspection reporting rejects limit overflow and never exports non-finite calculations', () => {
  assert.throws(() => generateInspectionReportFromCsv({
    csv: `feature,nominal,measured,lower,upper\nA,${maximum},${maximum},0,${maximum}`,
    mapping: inspectionMapping,
    unit: 'mm',
  }), finiteResultError);

  const ordinary = generateInspectionReportFromCsv({
    csv: 'feature,nominal,measured,lower,upper\nA,10,10.1,-0.2,0.2',
    mapping: inspectionMapping,
    unit: 'mm',
  });
  assert.doesNotMatch(ordinary.csv, /(?:^|,)(?:NaN|[-+]?Infinity)(?:,|\r?$)/m);
});

test('SPC worker cleans up immediately when postMessage throws synchronously', async () => {
  let terminated = 0;
  class ThrowingWorker {
    postMessage() { throw new Error('synchronous post failure'); }
    terminate() { terminated += 1; }
  }

  await assert.rejects(
    parseSpcCsvWithWorker('value\n1\n2', 'value', { WorkerClass: ThrowingWorker, workerUrl: 'local-worker.js', timeoutMs: 1000 }),
    /synchronous post failure/,
  );
  assert.equal(terminated, 1);
});
