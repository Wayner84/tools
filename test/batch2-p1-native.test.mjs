import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { calculateMachining, selectGaugeBlockStack, calculateToleranceChain, calculateUncertaintyBudget, calculateProcessCapabilityFromCsv, transformPointListCsv, generateInspectionReportFromCsv, runNativeToolDefinition } from '../src/native-tools.js';

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('machining worksheet calculates metric spindle, feed and ideal cutting time', () => {
  const result = calculateMachining({ mode: 'metric', surfaceSpeed: 100, diameter: 10, teeth: 4, feedPerTooth: 0.05, cutLength: 100 });
  close(result.rpm, 3183.098861837907);
  close(result.feedRate, 636.6197723675814);
  close(result.idealCutMinutes, 0.15707963267948966);
});

test('machining worksheet supports imperial units and rejects zero or non-finite inputs', () => {
  const result = calculateMachining({ mode: 'imperial', surfaceSpeed: 300, diameter: 0.5, teeth: 2, feedPerTooth: 0.002, cutLength: 3 });
  close(result.rpm, 12 * 300 / (Math.PI * 0.5));
  assert.throws(() => calculateMachining({ mode: 'metric', surfaceSpeed: 100, diameter: 0, teeth: 4, feedPerTooth: 0.05, cutLength: 100 }), /diameter/i);
  assert.throws(() => calculateMachining({ mode: 'metric', surfaceSpeed: Infinity, diameter: 10, teeth: 4, feedPerTooth: 0.05, cutLength: 100 }), /finite/i);
});

test('machining worksheet rejects feed, speed and time overflow or rate underflow from finite inputs', () => {
  const base = { mode: 'metric', surfaceSpeed: 100, diameter: 10, teeth: 4, feedPerTooth: 0.05, cutLength: 100 };
  assert.throws(() => calculateMachining({ ...base, surfaceSpeed: 1e305, teeth: 100, feedPerTooth: 100 }), /feed rate|numeric range|overflow/i);
  assert.throws(() => calculateMachining({ ...base, surfaceSpeed: Number.MIN_VALUE, diameter: Number.MAX_VALUE }), /spindle speed.*zero|underflow|numeric range/i);
  assert.throws(() => calculateMachining({ ...base, surfaceSpeed: 1e300, diameter: 1, teeth: 1, feedPerTooth: 1, cutLength: Number.MIN_VALUE }), /cutting time.*zero|underflow|numeric range/i);
});


test('gauge-block selector uses exact decimal inventory and minimises block count', () => {
  const result = selectGaugeBlockStack({ target: '3.05', inventory: ['1.0','1.01','1.02','1.03','1.04','1.05','1.1','2.0'], maxBlocks: 4 });
  assert.deepEqual(result.blocks, ['1.05', '2.0']);
  assert.equal(result.sum, '3.05');
  assert.equal(result.residual, '0.00');
});

test('gauge-block selector reports nearest residual and bounds malformed or excessive searches', () => {
  const nearest = selectGaugeBlockStack({ target: '3.04', inventory: ['1.01','2.02'], maxBlocks: 2 });
  assert.equal(nearest.residual, '0.01');
  assert.throws(() => selectGaugeBlockStack({ target: '3.0', inventory: ['1','bad'], maxBlocks: 2 }), /decimal/i);
  assert.throws(() => selectGaugeBlockStack({ target: '3.0', inventory: Array(61).fill('1'), maxBlocks: 4 }), /60/);
});


test('tolerance chain calculates signed worst-case limits and separately labelled RSS estimate', () => {
  const result = calculateToleranceChain([
    { nominal: 10, plus: 0.1, minus: -0.1, sign: 1 },
    { nominal: 4, plus: 0.05, minus: -0.05, sign: -1 },
  ]);
  assert.equal(result.nominal, 6); close(result.minimum, 5.85); close(result.maximum, 6.15);
  close(result.rssSymmetric, Math.sqrt(0.1 ** 2 + 0.05 ** 2));
});

test('tolerance chain validates component limits, signs and finite values', () => {
  assert.throws(() => calculateToleranceChain([]), /component/i);
  assert.throws(() => calculateToleranceChain([{ nominal: 1, plus: -0.1, minus: 0.1, sign: 1 }]), /minus.*plus/i);
  assert.throws(() => calculateToleranceChain([{ nominal: Infinity, plus: 0.1, minus: -0.1, sign: 1 }]), /finite/i);
  assert.throws(() => calculateToleranceChain([{ nominal: 1, plus: 0.1, minus: -0.1, sign: 0 }]), /sign/i);
});


test('uncertainty budget converts distributions and combines sensitivity-weighted components', () => {
  const standard = calculateUncertaintyBudget({ components: [{ magnitude: 0.01, distribution: 'standard', sensitivity: 1 }, { magnitude: 0.02, distribution: 'standard', sensitivity: 2 }], coverageFactor: 2 });
  close(standard.combined, 0.04123105625617661); close(standard.expanded, 0.08246211251235322);
  const converted = calculateUncertaintyBudget({ components: [{ magnitude: Math.sqrt(3), distribution: 'rectangular', sensitivity: 2 }, { magnitude: Math.sqrt(6), distribution: 'triangular', sensitivity: 1 }], coverageFactor: 2 });
  close(converted.combined, Math.sqrt(5));
});

test('uncertainty budget rejects unsupported correlations, invalid distributions and zero coverage', () => {
  const base = { components: [{ magnitude: 1, distribution: 'standard', sensitivity: 1 }], coverageFactor: 2 };
  assert.throws(() => calculateUncertaintyBudget({ ...base, correlations: [[1]] }), /correlation/i);
  assert.throws(() => calculateUncertaintyBudget({ ...base, components: [{ magnitude: 1, distribution: 'mystery', sensitivity: 1 }] }), /distribution/i);
  assert.throws(() => calculateUncertaintyBudget({ ...base, coverageFactor: 0 }), /coverage/i);
  assert.throws(() => calculateUncertaintyBudget({ ...base, components: [{ magnitude: NaN, distribution: 'standard', sensitivity: 1 }] }), /finite/i);
});


test('process performance CSV explorer uses overall sample standard deviation and labels Pp/Ppk estimates', () => {
  const result = calculateProcessCapabilityFromCsv({ csv: 'value\n9.8\n10.1\n10.0\n10.2\n9.9', column: 'value', lsl: 9.5, usl: 10.5 });
  assert.equal(result.n, 5); close(result.mean, 10); close(result.sampleSd, 0.15811388300841842);
  close(result.pp, 1.0540925533894636); close(result.ppk, 1.0540925533894636);
  assert.equal('cp' in result, false); assert.equal('cpk' in result, false);
  assert.match(result.metadata.sigmaEstimate, /overall sample standard deviation/i);
  assert.match(result.warnings.join(' '), /overall performance|not.*within-process capability/i);
});

test('process performance UI and catalogue do not present overall estimates as Cp/Cpk capability', async () => {
  const rendered = runNativeToolDefinition('process-capability', { column: 'value', unit: 'mm', lsl: '9.5', usl: '10.5', csv: 'value\n9.8\n10.1\n10.0\n10.2\n9.9' });
  assert.deepEqual(rendered.lines.slice(3, 5).map(([label]) => label), ['Pp estimate (overall performance)', 'Ppk estimate (overall performance)']);
  const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
  const record = catalogue.find((tool) => tool.slug === 'process-capability');
  assert.match(`${record.name} ${record.description} ${record.aliases.join(' ')}`, /Pp|Ppk/);
  assert.doesNotMatch(`${record.name} ${record.description} ${record.aliases.join(' ')}`, /\bCp(?:k)?\b/);
});

test('process capability CSV explorer rejects malformed, oversized and zero-variance data', () => {
  const base = { column: 'value', lsl: 9.5, usl: 10.5 };
  assert.throws(() => calculateProcessCapabilityFromCsv({ ...base, csv: 'value\n10\n10' }), /zero variance/i);
  assert.throws(() => calculateProcessCapabilityFromCsv({ ...base, csv: 'other\n10\n11' }), /column/i);
  assert.throws(() => calculateProcessCapabilityFromCsv({ ...base, csv: 'value\n10\nnot-a-number' }), /row 3/i);
  assert.throws(() => calculateProcessCapabilityFromCsv({ ...base, csv: `value\n${'1\n'.repeat(5001)}` }), /5,000/i);
  assert.throws(() => calculateProcessCapabilityFromCsv({ ...base, csv: 'value\n10\n11', lsl: 10, usl: 10 }), /greater/i);
});

test('all shared CSV consumers reject characters after closing quotes and quotes inside unquoted fields', () => {
  const processBase = { column: 'value', lsl: 0, usl: 10 };
  assert.throws(() => calculateProcessCapabilityFromCsv({ ...processBase, csv: 'value\n"1"e2\n2' }), /malformed CSV|closing quote/i);

  const transformBase = { rotationX: 0, rotationY: 0, rotationZ: 0, translationX: 0, translationY: 0, translationZ: 0, inverse: false, unit: 'mm' };
  assert.throws(() => transformPointListCsv({ ...transformBase, csv: 'id,x,y,z\nP1,1"2,2,3' }), /malformed CSV|quote.*unquoted/i);

  const mapping = { id: 'feature', nominal: 'nom', measured: 'actual', lowerTolerance: 'lo', upperTolerance: 'hi' };
  assert.throws(() => generateInspectionReportFromCsv({ csv: 'feature,nom,actual,lo,hi\n"A"junk,10,10,-0.1,0.1', mapping, unit: 'mm' }), /malformed CSV|closing quote/i);
});


test('coordinate transformer applies right-handed rotate-then-translate and supports inverse round trips', () => {
  const forward = transformPointListCsv({ csv: 'id,x,y,z\nP1,1,0,2', rotationX: 0, rotationY: 0, rotationZ: 90, translationX: 10, translationY: 20, translationZ: 3, inverse: false, unit: 'mm' });
  close(forward.points[0].x, 10); close(forward.points[0].y, 21); close(forward.points[0].z, 5);
  const inverse = transformPointListCsv({ csv: forward.csv, rotationX: 0, rotationY: 0, rotationZ: 90, translationX: 10, translationY: 20, translationZ: 3, inverse: true, unit: 'mm' });
  close(inverse.points[0].x, 1, 1e-10); close(inverse.points[0].y, 0, 1e-10); close(inverse.points[0].z, 2, 1e-10);
});

test('coordinate transformer validates rows and finite transforms and neutralises labels in CSV export', () => {
  const safe = transformPointListCsv({ csv: 'id,x,y,z\n=CMD,1,2,3', rotationX: 0, rotationY: 0, rotationZ: 0, translationX: 0, translationY: 0, translationZ: 0, inverse: false, unit: 'mm' });
  assert.match(safe.csv, /'=CMD/); assert.equal(safe.points[0].rawId, '=CMD');
  const base = { csv: 'id,x,y,z\nP1,1,2,3', rotationX: 0, rotationY: 0, rotationZ: 0, translationX: 0, translationY: 0, translationZ: 0, inverse: false, unit: 'mm' };
  assert.throws(() => transformPointListCsv({ ...base, csv: 'id,x,y,z\nP1,no,2,3' }), /row 2/i);
  assert.throws(() => transformPointListCsv({ ...base, rotationZ: Infinity }), /finite/i);
  assert.throws(() => transformPointListCsv({ ...base, unit: '' }), /unit/i);
});

test('coordinate transformer rejects blank coordinates instead of coercing them to zero', () => {
  const base = { rotationX: 0, rotationY: 0, rotationZ: 0, translationX: 0, translationY: 0, translationZ: 0, inverse: false, unit: 'mm' };
  assert.throws(
    () => transformPointListCsv({ ...base, csv: 'id,x,y,z\nP1,,2,3' }),
    /row 2.*coordinates.*finite|blank/i,
  );
});


test('inspection CSV report maps columns and calculates deviation, limits and plain-limit status', () => {
  const result = generateInspectionReportFromCsv({ csv: 'feature,nom,actual,lo,hi\nBore A,10,10.08,-0.1,0.1', mapping: { id: 'feature', nominal: 'nom', measured: 'actual', lowerTolerance: 'lo', upperTolerance: 'hi' }, unit: 'mm' });
  const row = result.rows[0]; close(row.deviation, 0.08); close(row.lowerLimit, 9.9); close(row.upperLimit, 10.1); assert.equal(row.status, 'within');
  assert.equal(row.raw.measured, '10.08'); assert.equal(result.rawInput, 'feature,nom,actual,lo,hi\nBore A,10,10.08,-0.1,0.1');
});

test('inspection CSV report validates mapped rows and neutralises spreadsheet formulas on export', () => {
  const mapping = { id: 'feature', nominal: 'nom', measured: 'actual', lowerTolerance: 'lo', upperTolerance: 'hi' };
  const safe = generateInspectionReportFromCsv({ csv: 'feature,nom,actual,lo,hi\n=CMD,10,10.2,-0.1,0.1', mapping, unit: 'mm' });
  assert.equal(safe.rows[0].status, 'outside'); assert.match(safe.csv, /'=CMD/);
  assert.throws(() => generateInspectionReportFromCsv({ csv: 'feature,nom,actual,lo,hi\nA,10,bad,-0.1,0.1', mapping, unit: 'mm' }), /row 2.*measured/i);
  assert.throws(() => generateInspectionReportFromCsv({ csv: 'feature,nom,actual,lo,hi\nA,10,10,0.1,-0.1', mapping, unit: 'mm' }), /lower.*upper/i);
  assert.throws(() => generateInspectionReportFromCsv({ csv: 'feature,nom,actual,lo,hi\nA,10,10,-0.1,0.1', mapping: { ...mapping, measured: 'missing' }, unit: 'mm' }), /mapped column/i);
});


const batch2Slugs = ['machining-feeds-speeds','gauge-block-stack','tolerance-chain','measurement-uncertainty','process-capability','coordinate-transformer','inspection-csv-report'];

test('batch 2 adds exactly seven Wayne-hosted native catalogue records', async () => {
  const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
  assert.equal(catalogue.length, 52);
  const records = catalogue.filter((tool) => batch2Slugs.includes(tool.slug));
  assert.equal(records.length, 7);
  for (const record of records) {
    assert.equal(record.implementation, 'native'); assert.equal(record.hosting, 'wayne-hosted'); assert.equal(record.license, 'MIT');
    assert.equal(record.sourceUrl, 'https://github.com/Wayner84/tools'); assert.match(record.dataBoundary, /local|browser tab/i);
  }
});

test('build emits all seven functional native routes with local worksheet assets', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  for (const slug of batch2Slugs) {
    await access(`dist/${slug}/index.html`);
    const html = await readFile(`dist/${slug}/index.html`, 'utf8');
    assert.match(html, new RegExp(`data-tool=\"${slug}\"`)); assert.match(html, /native-tools\.js/); assert.match(html, /Inputs and calculations stay in this browser tab/);
  }
  const source = await readFile('src/native-tools.js', 'utf8');
  for (const slug of batch2Slugs) assert.match(source, new RegExp(`['\"]${slug}['\"]\s*:`));
  assert.match(source, /textarea/); assert.match(source, /Download transformed CSV/); assert.match(source, /Download inspection report CSV/);
});
