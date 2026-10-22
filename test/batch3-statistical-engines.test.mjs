import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  evaluateGuardBandDecision,
  calculateImrChart,
  calculateGaugeRrAnova,
  fitLinearCalibration,
  reviewCalibrationInterval,
  calculateAcceptanceSamplingOc,
  runNativeToolDefinition,
} from '../src/native-tools.js';

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('guard-band evaluation applies an explicitly selected guarded-acceptance rule', () => {
  const result = evaluateGuardBandDecision({ lsl: 9.5, usl: 10.5, measured: 10.42, guard: 0.1, rule: 'guarded-acceptance' });
  close(result.acceptanceLower, 9.6);
  close(result.acceptanceUpper, 10.4);
  assert.equal(result.status, 'outside acceptance; inside tolerance');
  assert.equal(result.rule, 'guarded-acceptance');
  assert.equal(result.metadata.boundaries, 'inclusive');
  assert.match(result.warnings.join(' '), /contract|agreed/i);
});

test('guard-band evaluation handles inclusive boundaries and rejects omitted, malformed and non-finite inputs', () => {
  assert.equal(evaluateGuardBandDecision({ lsl: 0, usl: 10, measured: 9, guard: 1, rule: 'guarded-acceptance' }).status, 'accepted');
  assert.equal(evaluateGuardBandDecision({ lsl: 0, usl: 10, measured: 0, guard: 1, rule: 'plain-tolerance' }).status, 'accepted');
  assert.throws(() => evaluateGuardBandDecision({ lsl: 0, usl: 10, measured: 5, guard: 1 }), /rule/i);
  assert.throws(() => evaluateGuardBandDecision({ lsl: 0, usl: 10, measured: Infinity, guard: 1, rule: 'guarded-acceptance' }), /finite/i);
  assert.throws(() => evaluateGuardBandDecision({ lsl: 10, usl: 0, measured: 5, guard: 1, rule: 'guarded-acceptance' }), /USL/i);
  assert.throws(() => evaluateGuardBandDecision({ lsl: 0, usl: 10, measured: 5, guard: 5, rule: 'guarded-acceptance' }), /guard/i);
});

test('I-MR chart uses moving ranges of two with d2 and D4 reference constants', () => {
  const result = calculateImrChart([10, 11, 9, 10]);
  assert.equal(result.mean, 10);
  assert.deepEqual(result.movingRanges, [1, 2, 1]);
  close(result.mrBar, 4 / 3);
  close(result.estimatedSigma, (4 / 3) / 1.128);
  close(result.individualLimits.lower, 6.453900709219858);
  close(result.individualLimits.upper, 13.546099290780141);
  close(result.movingRangeLimits.upper, 4.356);
  assert.deepEqual(result.signals, []);
  assert.deepEqual(result.metadata.constants, { movingRangeLength: 2, d2: 1.128, D3: 0, D4: 3.267 });
  assert.match(result.warnings.join(' '), /not specification limits/i);
});

test('I-MR chart flags points beyond three-sigma limits and validates time-ordered finite observations', () => {
  const result = calculateImrChart([0, 0, 0, 0, 10]);
  assert.deepEqual(result.signals.map(({ chart, index }) => [chart, index]), [['individual', 4], ['moving-range', 4]]);
  assert.equal(calculateImrChart([4, 4]).estimatedSigma, 0);
  assert.throws(() => calculateImrChart([1]), /at least two/i);
  assert.throws(() => calculateImrChart('1,2'), /array/i);
  assert.throws(() => calculateImrChart([1, NaN]), /finite/i);
});

const balancedGaugeData = [
  ['P1', 'O1', 1, 1], ['P1', 'O1', 2, 3],
  ['P1', 'O2', 1, 3], ['P1', 'O2', 2, 5],
  ['P2', 'O1', 1, 5], ['P2', 'O1', 2, 7],
  ['P2', 'O2', 1, 11], ['P2', 'O2', 2, 13],
].map(([part, operator, repeat, value]) => ({ part, operator, repeat, value }));

test('Gauge R&R computes transparent balanced crossed two-way ANOVA with interaction', () => {
  const result = calculateGaugeRrAnova(balancedGaugeData);
  assert.deepEqual(result.design, { parts: 2, operators: 2, repeats: 2, observations: 8, balanced: true, crossed: true });
  assert.deepEqual(result.anova.part, { ss: 72, df: 1, ms: 72 });
  assert.deepEqual(result.anova.operator, { ss: 32, df: 1, ms: 32 });
  assert.deepEqual(result.anova.interaction, { ss: 8, df: 1, ms: 8 });
  assert.deepEqual(result.anova.repeatability, { ss: 8, df: 4, ms: 2 });
  assert.deepEqual(result.varianceComponents, { repeatability: 2, operator: 6, interaction: 3, reproducibility: 9, gaugeRr: 11, partToPart: 16, total: 27 });
  close(result.standardDeviations.gaugeRr, Math.sqrt(11));
  assert.equal(result.metadata.negativeVariancePolicy, 'truncate each estimated variance component at zero');
  assert.match(result.warnings.join(' '), /balanced crossed|staff ranking/i);
});

test('Gauge R&R rejects incomplete, unbalanced, duplicate and non-finite designs rather than imputing', () => {
  assert.throws(() => calculateGaugeRrAnova(balancedGaugeData.slice(0, -1)), /balanced|missing/i);
  assert.throws(() => calculateGaugeRrAnova([...balancedGaugeData, balancedGaugeData[0]]), /duplicate/i);
  assert.throws(() => calculateGaugeRrAnova(balancedGaugeData.map((row, index) => index ? row : { ...row, value: Infinity })), /finite/i);
  assert.throws(() => calculateGaugeRrAnova(balancedGaugeData.map((row) => ({ ...row, repeat: 1 }))), /duplicate|repeat/i);
  assert.throws(() => calculateGaugeRrAnova([]), /measurement/i);
});

test('linear calibration fits least squares, reports residuals and predicts within the input range', () => {
  const result = fitLinearCalibration({ reference: [0, 1, 2], response: [1, 3, 5], predictAt: 1.5 });
  assert.equal(result.intercept, 1);
  assert.equal(result.slope, 2);
  assert.deepEqual(result.fitted, [1, 3, 5]);
  assert.deepEqual(result.residuals, [0, 0, 0]);
  assert.equal(result.prediction.reference, 1.5);
  assert.equal(result.prediction.response, 4);
  assert.equal(result.prediction.withinRange, true);
  assert.deepEqual(result.referenceRange, [0, 2]);
  assert.equal(result.metadata.method, 'unweighted ordinary least squares: response = intercept + slope × reference');
  assert.match(result.warnings.join(' '), /traceability|suitability|uncertainty/i);
});

test('linear calibration accepts range endpoints and blocks extrapolation by default', () => {
  assert.equal(fitLinearCalibration({ reference: [0, 2], response: [1, 5], predictAt: 2 }).prediction.response, 5);
  assert.throws(() => fitLinearCalibration({ reference: [0, 2], response: [1, 5], predictAt: 3 }), /outside.*range|extrapolation/i);
  const extrapolated = fitLinearCalibration({ reference: [0, 2], response: [1, 5], predictAt: 3, allowExtrapolation: true });
  assert.equal(extrapolated.prediction.withinRange, false);
  assert.match(extrapolated.warnings.join(' '), /extrapolat/i);
  assert.throws(() => fitLinearCalibration({ reference: [1, 1], response: [2, 3] }), /reference.*vary/i);
  assert.throws(() => fitLinearCalibration({ reference: [0, 1], response: [1] }), /same length/i);
  assert.throws(() => fitLinearCalibration({ reference: [0, NaN], response: [1, 2] }), /finite/i);
  assert.throws(() => fitLinearCalibration({ reference: '0,1', response: [1, 2] }), /array/i);
});

test('calibration interval review reports against user-approved dates and summarises history', () => {
  const result = reviewCalibrationInterval({
    lastCalibrationDate: '2024-01-31', approvedIntervalDays: 30, reviewDate: '2024-02-29',
    history: [
      { date: '2024-02-07', outcome: 'pass', drift: 0.01 },
      { date: '2024-02-21', outcome: 'fail', drift: -0.03 },
      { date: '2024-02-28', outcome: 'adjusted', drift: 0.005 },
    ],
  });
  assert.equal(result.approvedDueDate, '2024-03-01');
  assert.equal(result.elapsedDays, 29);
  assert.equal(result.daysUntilDue, 1);
  assert.equal(result.status, 'within-user-approved-interval');
  assert.deepEqual(result.historySummary, { records: 3, pass: 1, fail: 1, adjusted: 1, maximumAbsoluteDrift: 0.03, latestRecordDate: '2024-02-28' });
  assert.equal(result.ownerDecisionRequired, true);
  assert.equal(result.metadata.prescribedIntervalDays, null);
  assert.equal(result.metadata.automaticApproval, false);
  assert.match(result.warnings.join(' '), /owner|user-approved|does not approve/i);
});

test('calibration interval review handles due-date boundaries and rejects malformed history or dates', () => {
  assert.equal(reviewCalibrationInterval({ lastCalibrationDate: '2024-01-01', approvedIntervalDays: 30, reviewDate: '2024-01-31', history: [] }).status, 'due-today');
  assert.equal(reviewCalibrationInterval({ lastCalibrationDate: '2024-01-01', approvedIntervalDays: 30, reviewDate: '2024-02-01', history: [] }).status, 'past-user-approved-due-date');
  assert.throws(() => reviewCalibrationInterval({ lastCalibrationDate: '2024-02-30', approvedIntervalDays: 30, reviewDate: '2024-03-01', history: [] }), /date/i);
  assert.throws(() => reviewCalibrationInterval({ lastCalibrationDate: '2024-01-02', approvedIntervalDays: 30, reviewDate: '2024-01-01', history: [] }), /before/i);
  assert.throws(() => reviewCalibrationInterval({ lastCalibrationDate: '2024-01-01', approvedIntervalDays: Infinity, reviewDate: '2024-02-01', history: [] }), /interval/i);
  assert.throws(() => reviewCalibrationInterval({ lastCalibrationDate: '2024-01-01', approvedIntervalDays: 30, reviewDate: '2024-02-01', history: [{ date: '2024-01-15', outcome: 'pass', drift: NaN }] }), /finite/i);
  assert.throws(() => reviewCalibrationInterval({ lastCalibrationDate: '2024-01-01', approvedIntervalDays: 30, reviewDate: '2024-02-01', history: [{ date: '2024-01-15', outcome: 'unknown' }] }), /outcome/i);
  assert.throws(
    () => reviewCalibrationInterval({ lastCalibrationDate: '9999-12-31', approvedIntervalDays: 36500, reviewDate: '9999-12-31', history: [] }),
    /due date.*YYYY-MM-DD|four-digit|supported.*date/i,
  );
});

test('acceptance-sampling OC engine calculates the stated binomial acceptance probability and curve', () => {
  const result = calculateAcceptanceSamplingOc({ sampleSize: 10, acceptanceNumber: 1, defectProbability: 0.1, aql: 0.01, lq: 0.1, curveProbabilities: [0, 0.1, 1] });
  close(result.acceptanceProbability, 0.7360989291000002);
  close(result.producerRiskAlpha, 1 - (0.99 ** 10 + 10 * 0.01 * 0.99 ** 9));
  close(result.consumerRiskBeta, 0.7360989291000002);
  assert.deepEqual(result.qualityPoints, { aql: 0.01, lq: 0.1 });
  assert.deepEqual(result.ocCurve.map((point) => point.defectProbability), [0, 0.1, 1]);
  assert.equal(result.ocCurve[0].acceptanceProbability, 1);
  assert.equal(result.ocCurve[2].acceptanceProbability, 0);
  assert.equal(result.metadata.method, 'binomial approximation: P(accept) = Σ from k=0 to c of C(n,k)p^k(1-p)^(n-k)');
  assert.match(result.metadata.riskDefinitions, /alpha.*AQL.*beta.*LQ/i);
  assert.match(result.warnings.join(' '), /finite lot|licensed|contract/i);
});

test('acceptance-sampling OC engine handles probability boundaries and rejects malformed plans or quality points', () => {
  assert.equal(calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 5, defectProbability: 1, aql: 0, lq: 1 }).acceptanceProbability, 1);
  assert.equal(calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 0, defectProbability: 0, aql: 0, lq: 1 }).acceptanceProbability, 1);
  close(calculateAcceptanceSamplingOc({ sampleSize: 3, acceptanceNumber: 0, defectProbability: 0.2, aql: 0.1, lq: 0.2 }).acceptanceProbability, 0.8 ** 3);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 0, acceptanceNumber: 0, defectProbability: 0.1 }), /sample size/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 6, defectProbability: 0.1 }), /acceptance number/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1.5, defectProbability: 0.1 }), /acceptance number/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1, defectProbability: Infinity }), /probability/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1, defectProbability: 0.1, aql: 0.01, lq: 0.1, curveProbabilities: [0.2, -0.1] }), /curve probability/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1, defectProbability: 0.1 }), /AQL/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1, defectProbability: 0.1, aql: 0.1, lq: 0.1 }), /AQL.*less than.*LQ/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1, defectProbability: 0.1, aql: -0.1, lq: 0.1 }), /AQL/i);
  assert.throws(() => calculateAcceptanceSamplingOc({ sampleSize: 5, acceptanceNumber: 1, defectProbability: 0.1, aql: 0.1, lq: 1.1 }), /LQ/i);
});

test('acceptance-sampling UI identifies selected probability separately from AQL/LQ risks', () => {
  const rendered = runNativeToolDefinition('acceptance-sampling-oc', { sampleSize: '10', acceptanceNumber: '1', defectProbability: '0.05', aql: '0.01', lq: '0.1', curveProbabilities: '0\n0.05\n0.1\n1' });
  assert.deepEqual(rendered.lines.slice(2, 7).map(([label]) => label), ['Acceptance probability at selected p', 'AQL', 'Producer risk α = 1 − Pa(AQL)', 'LQ / LTPD', 'Consumer risk β = Pa(LQ)']);
});

const batch3Slugs = [
  'guard-band-decision-rule',
  'spc-imr-chart',
  'gauge-rr-anova',
  'calibration-curve',
  'calibration-interval-review',
  'acceptance-sampling-oc',
];

test('batch 3 integrates exactly six Wayne-hosted native catalogue records', async () => {
  const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
  assert.equal(catalogue.length, 52);
  assert.equal(catalogue.filter((tool) => tool.implementation === 'native').length, 23);
  const records = catalogue.filter((tool) => batch3Slugs.includes(tool.slug));
  assert.equal(records.length, 6);
  for (const record of records) {
    assert.equal(record.implementation, 'native');
    assert.equal(record.hosting, 'wayne-hosted');
    assert.equal(record.license, 'MIT');
    assert.equal(record.sourceUrl, 'https://github.com/Wayner84/tools');
    assert.match(record.dataBoundary, /local|browser tab/i);
    assert.match(record.functionalCheck, /numerical|automated/i);
  }
});

test('all six batch 3 UI definitions parse their displayed example inputs and return renderable output', () => {
  const examples = {
    'guard-band-decision-rule': { unit: 'mm', lsl: '9.5', usl: '10.5', measured: '10.42', guard: '0.1', rule: 'guarded-acceptance' },
    'spc-imr-chart': { unit: 'mm', observations: '10\n11\n9\n10' },
    'gauge-rr-anova': { unit: 'mm', measurements: 'P1,O1,1,1\nP1,O1,2,3\nP1,O2,1,3\nP1,O2,2,5\nP2,O1,1,5\nP2,O1,2,7\nP2,O2,1,11\nP2,O2,2,13' },
    'calibration-curve': { referenceUnit: 'mm', responseUnit: 'V', predictAt: '1.5', allowExtrapolation: 'false', pairs: '0,1\n1,3\n2,5' },
    'calibration-interval-review': { lastCalibrationDate: '2024-01-31', approvedIntervalDays: '30', reviewDate: '2024-02-29', history: '2024-02-07,pass,0.01\n2024-02-21,fail,-0.03\n2024-02-28,adjusted,0.005' },
    'acceptance-sampling-oc': { sampleSize: '10', acceptanceNumber: '1', defectProbability: '0.1', aql: '0.01', lq: '0.1', curveProbabilities: '0\n0.1\n1' },
  };
  for (const [slug, values] of Object.entries(examples)) {
    const result = runNativeToolDefinition(slug, values);
    assert.ok(result.lines?.length || result.rows?.length, `${slug} returned no renderable output`);
    assert.ok((result.warnings || []).every((warning) => typeof warning === 'string'));
  }
});

test('build emits all six batch 3 worksheets with local assets and matching UI definitions', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const source = await readFile('src/native-tools.js', 'utf8');
  assert.doesNotMatch(source, /innerHTML/);
  for (const slug of batch3Slugs) {
    await access(`dist/${slug}/index.html`);
    const html = await readFile(`dist/${slug}/index.html`, 'utf8');
    assert.match(html, new RegExp(`data-tool=\"${slug}\"`));
    assert.match(html, /native-tools\.js/);
    assert.match(html, /Inputs and calculations stay in this browser tab/);
    assert.match(source, new RegExp(`['\"]${slug}['\"]\\s*:`));
  }
});
