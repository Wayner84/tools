import test from 'node:test';
import assert from 'node:assert/strict';
import * as nativeTools from '../src/native-tools.js';

const maximum = Number.MAX_VALUE;
const finiteResultError = /finite numeric range|numeric range|overflow|underflow|finite result/i;
const nonFiniteToken = /(?:^|[^A-Za-z])(?:NaN|[-+]?Infinity|∞)(?:$|[^A-Za-z])/;

const balancedGaugeData = [
  ['P1', 'O1', 1, 1], ['P1', 'O1', 2, 3],
  ['P1', 'O2', 1, 3], ['P1', 'O2', 2, 5],
  ['P2', 'O1', 1, 5], ['P2', 'O1', 2, 7],
  ['P2', 'O2', 1, 11], ['P2', 'O2', 2, 13],
].map(([part, operator, repeat, value]) => ({ part, operator, repeat, value }));

function assertFiniteTree(value, path = 'result') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is non-finite: ${value}`);
  else if (Array.isArray(value)) value.forEach((item, index) => assertFiniteTree(item, `${path}[${index}]`));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => assertFiniteTree(item, `${path}.${key}`));
}

function assertSafePayload(value, label) {
  assertFiniteTree(value, label);
  assert.doesNotMatch(JSON.stringify(value), nonFiniteToken, `${label} contains a non-finite display/export token`);
}

test('Gauge R&R rejects finite observations whose ANOVA results overflow', () => {
  const values = [maximum, maximum, -maximum, -maximum, maximum, maximum, -maximum, -maximum];
  const measurements = balancedGaugeData.map((row, index) => ({ ...row, value: values[index] }));
  assert.throws(() => nativeTools.calculateGaugeRrAnova(measurements), finiteResultError);
});

test('process performance rejects finite observations whose statistics overflow', () => {
  assert.throws(() => nativeTools.calculateProcessCapabilityFromCsv({
    csv: `value\n${maximum}\n${maximum / 2}`,
    column: 'value',
    lsl: 0,
    usl: maximum,
  }), finiteResultError);
});

test('sine-bar rejects finite inputs whose propagated angle uncertainty overflows', () => {
  assert.throws(() => nativeTools.calculateSineBar({
    centreDistance: Number.MIN_VALUE,
    angleDegrees: 30,
    stackHeight: 0,
    centreUncertainty: 0,
    heightUncertainty: maximum,
  }), finiteResultError);
});

test('positive uncertainty and tolerance contributions reject underflow to zero without rejecting exact zero', () => {
  const sineBar = {
    centreDistance: 100, angleDegrees: 30, stackHeight: 50,
    centreUncertainty: 0, heightUncertainty: Number.MIN_VALUE,
  };
  assert.throws(() => nativeTools.calculateSineBar(sineBar), finiteResultError);
  assert.equal(nativeTools.calculateSineBar({ ...sineBar, heightUncertainty: 0 }).angleUncertaintyDegrees, 0);

  assert.throws(() => nativeTools.calculateToleranceChain([
    { nominal: 0, minus: -Number.MIN_VALUE, plus: Number.MIN_VALUE, sign: 1 },
  ]), finiteResultError);
  assert.equal(nativeTools.calculateToleranceChain([
    { nominal: 0, minus: 0, plus: 0, sign: 1 },
  ]).rssSymmetric, 0);

  assert.throws(() => nativeTools.calculateUncertaintyBudget({
    components: [{ magnitude: Number.MIN_VALUE, distribution: 'standard', sensitivity: Number.MIN_VALUE }],
    coverageFactor: 2,
  }), finiteResultError);
  assert.equal(nativeTools.calculateUncertaintyBudget({
    components: [{ magnitude: Number.MIN_VALUE, distribution: 'standard', sensitivity: 0 }],
    coverageFactor: 2,
  }).combined, 0);
});

test('Gauge R&R rejects nonconstant subnormal data whose sums of squares underflow', () => {
  const measurements = balancedGaugeData.map((row, index) => ({
    ...row,
    value: index === balancedGaugeData.length - 1 ? Number.MIN_VALUE : 0,
  }));
  assert.throws(() => nativeTools.calculateGaugeRrAnova(measurements), finiteResultError);
  const constant = nativeTools.calculateGaugeRrAnova(measurements.map((row) => ({ ...row, value: 0 })));
  assert.equal(constant.varianceComponents.total, 0);
});

test('OEE rejects positive rate and product underflow while preserving semantic zero quality', () => {
  assert.throws(() => nativeTools.calculateOee({
    plannedTime: Number.MAX_VALUE, runTime: Number.MIN_VALUE,
    idealCycleTime: Number.MIN_VALUE, totalCount: 1, goodCount: 1,
  }), finiteResultError);
  assert.throws(() => nativeTools.calculateOee({
    plannedTime: Number.MAX_VALUE, runTime: Number.MAX_VALUE,
    idealCycleTime: Number.MIN_VALUE, totalCount: 1, goodCount: 1,
  }), finiteResultError);
  assert.throws(() => nativeTools.calculateOee({
    plannedTime: Number.MAX_VALUE, runTime: 1,
    idealCycleTime: Number.MIN_VALUE, totalCount: 1, goodCount: 1,
  }), finiteResultError);
  const zeroQuality = nativeTools.calculateOee({
    plannedTime: 1, runTime: 1, idealCycleTime: 1, totalCount: 1, goodCount: 0,
  });
  assert.equal(zeroQuality.quality, 0);
  assert.equal(zeroQuality.oee, 0);
});

test('statistical variance and thermal uncertainty paths reject underflow but preserve exact zeros', () => {
  assert.throws(() => nativeTools.calculateProcessCapabilityFromCsv({
    csv: `value\n0\n${Number.MIN_VALUE}`,
    column: 'value', lsl: -1, usl: 1,
  }), /zero variance|finite numeric range|numeric range|underflow/i);
  assert.throws(() => nativeTools.fitLinearCalibration({
    reference: [0, 1, 2], response: [0, 0, Number.MIN_VALUE],
  }), finiteResultError);
  assert.throws(() => nativeTools.calculateThermalCorrection({
    measuredLength: Number.MIN_VALUE, measuredTemp: 1, referenceTemp: 0,
    alpha: Number.MIN_VALUE, lengthUncertainty: 0, tempUncertainty: Number.MIN_VALUE, alphaUncertainty: 0,
  }), finiteResultError);
  assert.equal(nativeTools.calculateThermalCorrection({
    measuredLength: 1, measuredTemp: 0, referenceTemp: 0,
    alpha: 0, lengthUncertainty: 0, tempUncertainty: 0, alphaUncertainty: 0,
  }).combinedUncertainty, 0);
});

test('native definitions fail closed on underflow and do not visually round representable tiny values to zero', () => {
  assert.throws(() => nativeTools.runNativeToolDefinition('sine-bar', {
    centreDistance: '100', angleDegrees: '30', stackHeight: '50',
    centreUncertainty: '0', heightUncertainty: String(Number.MIN_VALUE), unit: 'mm',
  }), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('tolerance-chain', {
    components: `0,${-Number.MIN_VALUE},${Number.MIN_VALUE},1`, unit: 'mm',
  }), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('oee-loss', {
    plannedTime: String(Number.MAX_VALUE), runTime: String(Number.MIN_VALUE),
    idealCycleTime: String(Number.MIN_VALUE), totalCount: '1', goodCount: '1',
  }), finiteResultError);

  const tiny = nativeTools.runNativeToolDefinition('oee-loss', {
    plannedTime: String(Number.MAX_VALUE), runTime: '1',
    idealCycleTime: '1', totalCount: '1', goodCount: '1',
  });
  assert.notEqual(tiny.lines.find(([label]) => label === 'Availability')[1], '0%');
  assert.notEqual(tiny.lines.find(([label]) => label === 'OEE')[1], '0%');
});

test('native presentation boundaries reject overflow before formatting or export', () => {
  assert.throws(() => nativeTools.runNativeToolDefinition('machining-feeds-speeds', {
    mode: 'metric', surfaceSpeed: '1', diameter: String(1000 / Math.PI), teeth: '1', feedPerTooth: '1', cutLength: '1e307',
  }), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('oee-loss', {
    plannedTime: '1', runTime: '1', idealCycleTime: '1e291', totalCount: String(Number.MAX_SAFE_INTEGER), goodCount: String(Number.MAX_SAFE_INTEGER),
  }), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('takt-capacity', {
    shiftMinutes: '1', breakMinutes: '0', demand: '1e307', cycleMinutes: '1', parallelStations: '1',
  }), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('bolt-circle', {
    diameter: String(maximum), holes: '2', startAngle: '0', originX: '0', originY: '0', direction: 'ccw', unit: 'mm',
  }), finiteResultError);
});

test('bolt-circle rejects a positive diameter whose radius underflows to zero', () => {
  const input = { diameter: Number.MIN_VALUE, holes: 2, startAngle: 0, originX: 0, originY: 0, direction: 'ccw' };
  assert.throws(() => nativeTools.calculateBoltCircle(input), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('bolt-circle', {
    ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)])), unit: 'mm',
  }), finiteResultError);
});

test('acceptance sampling rejects mathematically positive probabilities that underflow to zero', () => {
  const input = { sampleSize: 10000, acceptanceNumber: 0, defectProbability: 0.1, aql: 0.01, lq: 0.1, curveProbabilities: [0.1] };
  assert.throws(() => nativeTools.calculateAcceptanceSamplingOc(input), finiteResultError);
  assert.throws(() => nativeTools.runNativeToolDefinition('acceptance-sampling-oc', {
    sampleSize: '10000', acceptanceNumber: '0', defectProbability: '0.1', aql: '0.01', lq: '0.1', curveProbabilities: '0.1',
  }), finiteResultError);
  assert.equal(nativeTools.calculateAcceptanceSamplingOc({ ...input, defectProbability: 1, lq: 1, curveProbabilities: [1] }).acceptanceProbability, 0);
});

test('acceptance sampling preserves representable producer risk instead of cancelling it to zero', () => {
  const input = { sampleSize: 1, acceptanceNumber: 0, defectProbability: 0.1, aql: Number.MIN_VALUE, lq: 0.1, curveProbabilities: [0.1] };
  const result = nativeTools.calculateAcceptanceSamplingOc(input);
  assert.equal(result.producerRiskAlpha, Number.MIN_VALUE);
  const native = nativeTools.runNativeToolDefinition('acceptance-sampling-oc', {
    sampleSize: '1', acceptanceNumber: '0', defectProbability: '0.1', aql: String(Number.MIN_VALUE), lq: '0.1', curveProbabilities: '0.1',
  });
  assert.notEqual(native.lines.find(([label]) => label.startsWith('Producer risk'))[1], '0%');
});

const calculatorCases = {
  calculateAcceptanceSamplingOc: () => nativeTools.calculateAcceptanceSamplingOc({ sampleSize: 10, acceptanceNumber: 1, defectProbability: 0.05, aql: 0.01, lq: 0.1, curveProbabilities: [0, 0.05, 0.1, 1] }),
  calculateBeamDeflection: () => nativeTools.calculateBeamDeflection({ loadN: 1000, lengthM: 1, elasticModulusPa: 200e9, secondMomentM4: 1e-8 }),
  calculateBoltCircle: () => nativeTools.calculateBoltCircle({ diameter: 100, holes: 6, startAngle: 0, originX: 0, originY: 0, direction: 'ccw' }),
  calculateGaugeRrAnova: () => nativeTools.calculateGaugeRrAnova(balancedGaugeData),
  calculateImrChart: () => nativeTools.calculateImrChart([10, 11, 9, 10]),
  calculateMachining: () => nativeTools.calculateMachining({ mode: 'metric', surfaceSpeed: 100, diameter: 10, teeth: 4, feedPerTooth: 0.05, cutLength: 100 }),
  calculateOee: () => nativeTools.calculateOee({ plannedTime: 480, runTime: 400, idealCycleTime: 0.5, totalCount: 720, goodCount: 700 }),
  calculateProcessCapabilityFromCsv: () => nativeTools.calculateProcessCapabilityFromCsv({ csv: 'value\n9.8\n10.1\n10.0\n10.2\n9.9', column: 'value', lsl: 9.5, usl: 10.5 }),
  calculateSineBar: () => nativeTools.calculateSineBar({ centreDistance: 100, angleDegrees: 30, stackHeight: 50, centreUncertainty: 0.01, heightUncertainty: 0.005 }),
  calculateSpurGear: () => nativeTools.calculateSpurGear({ module: 2, teeth1: 20, teeth2: 40, pressureAngleDeg: 20 }),
  calculateTaktCapacity: () => nativeTools.calculateTaktCapacity({ shiftMinutes: 480, breakMinutes: 60, demand: 140, cycleMinutes: 4, parallelStations: 2 }),
  calculateThermalCorrection: () => nativeTools.calculateThermalCorrection({ measuredLength: 100, measuredTemp: 30, referenceTemp: 20, alpha: 0.00001, lengthUncertainty: 0.002, tempUncertainty: 0.2, alphaUncertainty: 0 }),
  calculateToleranceChain: () => nativeTools.calculateToleranceChain([{ nominal: 10, plus: 0.1, minus: -0.1, sign: 1 }, { nominal: 4, plus: 0.05, minus: -0.05, sign: -1 }]),
  calculateUncertaintyBudget: () => nativeTools.calculateUncertaintyBudget({ components: [{ magnitude: 0.01, distribution: 'standard', sensitivity: 1 }], coverageFactor: 2 }),
  evaluateGuardBandDecision: () => nativeTools.evaluateGuardBandDecision({ lsl: 9.5, usl: 10.5, measured: 10.42, guard: 0.1, rule: 'guarded-acceptance' }),
  fitLinearCalibration: () => nativeTools.fitLinearCalibration({ reference: [0, 1, 2], response: [1, 3, 5], predictAt: 1.5 }),
  generateInspectionReportFromCsv: () => nativeTools.generateInspectionReportFromCsv({ csv: 'feature,nominal,measured,lower,upper\nA,10,10.1,-0.2,0.2', mapping: { id: 'feature', nominal: 'nominal', measured: 'measured', lowerTolerance: 'lower', upperTolerance: 'upper' }, unit: 'mm' }),
  inspectStepPart21: () => nativeTools.inspectStepPart21("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('demo'),'2;1');\nFILE_NAME('demo.step','2026-09-10T00:00:00',('Author'),('Org'),'','','');\nFILE_SCHEMA(('AP242'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;"),
  parseGcodePreflight: () => nativeTools.parseGcodePreflight('G21\nG90\nG0 X0 Y0\nG1 X10 Y-2 F100'),
  parseSpcObservationsCsv: () => nativeTools.parseSpcObservationsCsv({ csv: 'value\n10\n11\n9\n10', column: 'value' }),
  reviewCalibrationInterval: () => nativeTools.reviewCalibrationInterval({ lastCalibrationDate: '2024-01-31', approvedIntervalDays: 30, reviewDate: '2024-02-29', history: [{ date: '2024-02-07', outcome: 'pass', drift: 0.01 }] }),
  selectGaugeBlockStack: () => nativeTools.selectGaugeBlockStack({ target: '3.05', inventory: ['1.0', '1.05', '2.0'], maxBlocks: 3 }),
  transformPointListCsv: () => nativeTools.transformPointListCsv({ csv: 'id,x,y,z\nP1,1,2,3', rotationX: 0, rotationY: 0, rotationZ: 90, translationX: 1, translationY: 2, translationZ: 3, inverse: false, unit: 'mm' }),
};

test('inventory executes every exported ordinary calculator with finite result trees and safe payloads', () => {
  const exportedCalculators = Object.keys(nativeTools).filter((name) => /^(?:calculate|evaluate|fit|generate|inspect|parseGcode|parseSpcObservations|review|select|transform)/.test(name)).sort();
  assert.deepEqual(exportedCalculators, Object.keys(calculatorCases).sort(), 'calculator inventory must be updated when an export is added');
  for (const [name, execute] of Object.entries(calculatorCases)) assertSafePayload(execute(), name);
});

test('inventory executes every native definition default and keeps display, chart, table and download payloads finite-safe', () => {
  assert.ok(nativeTools.NATIVE_TOOL_DEFINITIONS && typeof nativeTools.NATIVE_TOOL_DEFINITIONS === 'object');
  for (const [slug, definition] of Object.entries(nativeTools.NATIVE_TOOL_DEFINITIONS)) {
    const values = Object.fromEntries(definition.fields.map(([name, , value]) => [name, String(value)]));
    const result = nativeTools.runNativeToolDefinition(slug, values);
    assertSafePayload(result, slug);
  }
});
