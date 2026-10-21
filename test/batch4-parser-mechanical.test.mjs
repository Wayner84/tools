import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  parseGcodePreflight,
  inspectStepPart21,
  calculateSpurGear,
  calculateBeamDeflection,
  runNativeToolDefinition,
} from '../src/native-tools.js';

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('G-code preflight reports explicit modal state, linear extents and bounded preview segments', () => {
  const result = parseGcodePreflight('G21\nG90\nG0 X0 Y0\nG1 X10 Y-2 F100\nG1 X5 Y7');
  assert.equal(result.units, 'mm');
  assert.equal(result.distanceMode, 'absolute');
  assert.deepEqual(result.extents, { xMin: 0, xMax: 10, yMin: -2, yMax: 7 });
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments[1].motion, 'G1');
  assert.equal(result.segments[1].feed, 100);
  assert.match(result.dialect, /G0.*G1.*G2.*G3/i);
  assert.match(result.warnings.join(' '), /collision|machine|execution/i);
});

test('G-code preflight includes XY arc extrema and supports incremental moves', () => {
  const arc = parseGcodePreflight('G21 G90 G17\nG0 X0 Y0\nG2 X10 Y0 I5 J0 F100');
  close(arc.extents.xMin, 0);
  close(arc.extents.xMax, 10);
  close(arc.extents.yMin, 0);
  close(arc.extents.yMax, 5);
  assert.equal(arc.segments[1].motion, 'G2');
  const incremental = parseGcodePreflight('G20 G91\nG0 X1 Y2\nG1 X2 Y-1 F3');
  assert.deepEqual(incremental.extents, { xMin: 0, xMax: 3, yMin: 0, yMax: 2 });
  assert.equal(incremental.units, 'in');
});

test('G-code preflight visibly stops on unsupported, ambiguous, malformed and oversized programs', () => {
  assert.throws(() => parseGcodePreflight('G21 G90\nG81 X1 Y1'), /line 2.*unsupported.*G81/i);
  assert.throws(() => parseGcodePreflight('G21 G90\n#1=2\nG1 X#1 F10'), /line 2.*macro|unsupported/i);
  assert.throws(() => parseGcodePreflight('G21 G90\nG2 X1 Y1 F10'), /line 2.*I.*J|arc centre/i);
  assert.throws(() => parseGcodePreflight('G90\nG1 X1 F10'), /units.*before motion/i);
  assert.throws(() => parseGcodePreflight('G21\nG1 X1 F10'), /distance mode.*before motion/i);
  assert.throws(() => parseGcodePreflight(`G21 G90\n${'G1 X1 F1\n'.repeat(5001)}`), /5,000.*lines/i);
  assert.throws(() => parseGcodePreflight('G21 G90\nG1 X1 Q2 F10'), /unsupported.*Q/i);
});

test('G-code preflight fails closed when units change after motion', () => {
  const mixedUnits = 'G21 G90\nG1 X25.4 F100\nG20\nG1 X2 F10';
  assert.throws(() => parseGcodePreflight(mixedUnits), /line 3.*unit.*change.*after motion/i);
});

test('G-code preflight rejects coordinate arithmetic overflow from finite words', () => {
  const huge = `1${'0'.repeat(308)}`;
  assert.throws(
    () => parseGcodePreflight(`G21 G91\nG1 X${huge} F1\nG1 X${huge}`),
    /line 3.*coordinate.*finite|numeric range|overflow/i,
  );
});

test('G-code preflight rejects competing modal codes, stray arc offsets and content after program end', () => {
  assert.throws(() => parseGcodePreflight('G21 G90\nG1 G2 X10 Y0 I5 J0 F100'), /line 2.*competing.*motion|ambiguous/i);
  assert.throws(() => parseGcodePreflight('G20 G21 G90\nG1 X1 F10'), /line 1.*competing.*unit|ambiguous/i);
  assert.throws(() => parseGcodePreflight('G21 G90\nG1 I5 J0 F100'), /line 2.*I.*J.*arc/i);
  assert.throws(() => parseGcodePreflight('G21 G90\nG1 X1 F100\nM30\nG1 X2'), /line 4.*after.*M30|program end/i);
  assert.throws(() => parseGcodePreflight('G21 G90\nM2\nN20'), /line 3.*after.*M2|program end/i);
  assert.doesNotThrow(() => parseGcodePreflight('G21 G90\nG1 X1 F100\nM30\n; trailing comment\n(blank comment)'));
});

test('STEP Part 21 inspector extracts schema and bounded entity counts', () => {
  const text = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('demo'),'2;1');\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;";
  const result = inspectStepPart21(text);
  assert.deepEqual(result.schemas, ['AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF']);
  assert.deepEqual(result.entityCounts, { CARTESIAN_POINT: 1 });
  assert.equal(result.totalEntities, 1);
  assert.match(result.limitations.join(' '), /not.*conformance|PMI|geometry/i);
});

test('STEP Part 21 inspector reports provenance and declared unit entities without executing data', () => {
  const text = "ISO-10303-21;HEADER;FILE_DESCRIPTION(('demo'),'2;1');FILE_NAME('part.step','2026-09-10T00:00:00',('A. Author'),('Example Org'),'prep','origin','auth');FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=SI_UNIT(.MILLI.,.METRE.);#2=PLANE_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.RADIAN.);ENDSEC;END-ISO-10303-21;";
  assert.throws(() => inspectStepPart21(text), /complex STEP entity assignment/i);
});

test('STEP Part 21 inspector handles legal semicolons, escaped apostrophes and delimiter text in strings', () => {
  const text = "ISO-10303-21;HEADER;FILE_DESCRIPTION(('literal ENDSEC; DATA; FILE_NAME(''fake.step'',''bad'',(),()); FILE_SCHEMA((''FAKE''));'),'2;1');FILE_NAME('a;b''s.step','2026-09-10T00:00:00',('A; Author'),('Example Org'),'prep','origin','auth');FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=SI_UNIT(.MILLI.,.METRE.);ENDSEC;END-ISO-10303-21;";
  const result = inspectStepPart21(text);
  assert.equal(result.provenance.name, "a;b's.step");
  assert.deepEqual(result.provenance.authors, ['A; Author']);
  assert.deepEqual(result.schemas, ['AP242']);
  assert.deepEqual(result.entityCounts, { SI_UNIT: 1 });
  assert.deepEqual(result.declaredUnits, ['millimetre']);
});

test('STEP Part 21 inspector never extracts entities, assignments or units from quoted data', () => {
  const text = "ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=DESCRIPTIVE_REPRESENTATION_ITEM('literal #999=FAKE(1); SI_UNIT(.KILO.,.METRE.); ENDSEC; DATA; it''s text','value');#2=SI_UNIT($,.METRE.);ENDSEC;END-ISO-10303-21;";
  const result = inspectStepPart21(text);
  assert.equal(result.totalEntities, 2);
  assert.deepEqual(result.entityCounts, { DESCRIPTIVE_REPRESENTATION_ITEM: 1, SI_UNIT: 1 });
  assert.deepEqual(result.declaredUnits, ['metre']);
});

test('STEP Part 21 inspector rejects complex entity instances as a published limitation', () => {
  const text = "ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=PLANE_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.RADIAN.);ENDSEC;END-ISO-10303-21;";
  assert.throws(() => inspectStepPart21(text), /unsupported complex STEP entity assignment/i);
});

test('STEP Part 21 inspector rejects malformed, deeply nested and oversized exchange structures', () => {
  assert.throws(() => inspectStepPart21('HEADER;DATA;#1=POINT();ENDSEC;'), /ISO-10303-21|envelope/i);
  assert.throws(() => inspectStepPart21("ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=POINT();#1=OTHER();ENDSEC;END-ISO-10303-21;"), /duplicate.*#1/i);
  const nested = `${'('.repeat(65)}0${')'.repeat(65)}`;
  assert.throws(() => inspectStepPart21(`ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=CARTESIAN_POINT('',${nested});ENDSEC;END-ISO-10303-21;`), /nesting.*64/i);
  assert.throws(() => inspectStepPart21(`ISO-10303-21;${' '.repeat(500001)}`), /500,000.*characters/i);
});

test('STEP Part 21 inspector rejects additional sections and unsupported trailing envelope content', () => {
  assert.throws(() => inspectStepPart21("ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=POINT();ENDSEC;DATA;#2=POINT();ENDSEC;END-ISO-10303-21;"), /additional|multiple|trailing|unsupported/i);
  assert.throws(() => inspectStepPart21("ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;#1=POINT();ENDSEC;UNSUPPORTED;END-ISO-10303-21;"), /trailing|unsupported|envelope/i);
});

test('STEP Part 21 inspector rejects unsupported statements inside DATA instead of silently skipping them', () => {
  assert.throws(
    () => inspectStepPart21("ISO-10303-21;HEADER;FILE_SCHEMA(('AP242'));ENDSEC;DATA;UNSUPPORTED_TOKEN();ENDSEC;END-ISO-10303-21;"),
    /unsupported.*DATA statement|entity assignment/i,
  );
});

test('standard unshifted external spur-gear worksheet matches the reference geometry', () => {
  const result = calculateSpurGear({ module: 2, teeth1: 20, teeth2: 40, pressureAngleDeg: 20 });
  assert.equal(result.gear1.pitchDiameter, 40);
  assert.equal(result.gear2.pitchDiameter, 80);
  assert.equal(result.gear1.outsideDiameter, 44);
  assert.equal(result.gear2.outsideDiameter, 84);
  assert.equal(result.gear1.rootDiameter, 35);
  assert.equal(result.gear2.rootDiameter, 75);
  assert.equal(result.centreDistance, 60);
  close(result.gear1.baseDiameter, 40 * Math.cos(20 * Math.PI / 180));
  close(result.circularPitch, 2 * Math.PI);
  assert.match(result.assumptions.join(' '), /unshifted|external|full-depth/i);
});

test('spur-gear worksheet validates finite positive module, whole tooth counts and pressure angle', () => {
  const base = { module: 2, teeth1: 20, teeth2: 40, pressureAngleDeg: 20 };
  assert.throws(() => calculateSpurGear({ ...base, module: 0 }), /module/i);
  assert.throws(() => calculateSpurGear({ ...base, teeth1: 20.5 }), /whole.*teeth|tooth count/i);
  assert.throws(() => calculateSpurGear({ ...base, teeth2: 2 }), /teeth|tooth/i);
  assert.throws(() => calculateSpurGear({ ...base, pressureAngleDeg: 90 }), /pressure angle/i);
  assert.throws(() => calculateSpurGear({ ...base, module: Infinity }), /finite/i);
});

test('small-deflection beam worksheet matches simply-supported centre and cantilever end-load references', () => {
  const result = calculateBeamDeflection({ loadN: 1000, lengthM: 1, elasticModulusPa: 200_000_000_000, secondMomentM4: 1e-8 });
  close(result.simplySupportedCentre.deflectionM, 0.010416666666666666);
  close(result.cantileverEnd.deflectionM, 0.16666666666666666);
  close(result.simplySupportedCentre.maximumMomentNm, 250);
  close(result.cantileverEnd.maximumMomentNm, 1000);
  assert.match(result.assumptions.join(' '), /small deflection|linear elastic|Euler.Bernoulli/i);
  assert.match(result.warnings.join(' '), /lifting|safety|approval/i);
});

test('beam worksheet rejects non-finite and non-positive stiffness inputs', () => {
  const base = { loadN: 1000, lengthM: 1, elasticModulusPa: 200_000_000_000, secondMomentM4: 1e-8 };
  assert.throws(() => calculateBeamDeflection({ ...base, loadN: 0 }), /load/i);
  assert.throws(() => calculateBeamDeflection({ ...base, lengthM: -1 }), /length/i);
  assert.throws(() => calculateBeamDeflection({ ...base, elasticModulusPa: 0 }), /modulus/i);
  assert.throws(() => calculateBeamDeflection({ ...base, secondMomentM4: NaN }), /finite/i);
});

test('beam worksheet rejects finite inputs whose stiffness or results leave the finite numeric range', () => {
  const base = { loadN: 1000, lengthM: 1, elasticModulusPa: 200_000_000_000, secondMomentM4: 1e-8 };
  assert.throws(() => calculateBeamDeflection({ ...base, elasticModulusPa: Number.MIN_VALUE, secondMomentM4: Number.MIN_VALUE }), /flexural rigidity.*zero|underflow|numeric range/i);
  assert.throws(() => calculateBeamDeflection({ ...base, loadN: Number.MAX_VALUE, lengthM: 2 }), /deflection|moment|numeric range|overflow/i);
});

const batch4Slugs = ['gcode-preflight', 'step-part21-inspector', 'spur-gear-geometry', 'beam-deflection'];

test('catalogue contains 51 records and 23 Wayne-hosted native records after coordinate geometry', async () => {
  const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
  assert.equal(catalogue.length, 51);
  assert.equal(new Set(catalogue.map((tool) => tool.slug)).size, 51);
  assert.equal(catalogue.filter((tool) => tool.implementation === 'native').length, 23);
  const records = catalogue.filter((tool) => batch4Slugs.includes(tool.slug));
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.implementation, 'native');
    assert.equal(record.hosting, 'wayne-hosted');
    assert.equal(record.license, 'MIT');
    assert.equal(record.sourceUrl, 'https://github.com/Wayner84/tools');
    assert.match(record.dataBoundary, /local|browser tab|memory/i);
    assert.match(record.functionalCheck, /automated|numerical|parser/i);
  }
});

test('all four batch 4 UI examples execute through native dispatch and return renderable output', () => {
  const examples = {
    'gcode-preflight': { gcode: 'G21\nG90\nG0 X0 Y0\nG1 X10 Y-2 F100\nG1 X5 Y7' },
    'step-part21-inspector': { step: "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('demo'),'2;1');\nFILE_SCHEMA(('AP242'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;" },
    'spur-gear-geometry': { unit: 'mm', module: '2', teeth1: '20', teeth2: '40', pressureAngleDeg: '20' },
    'beam-deflection': { loadN: '1000', lengthM: '1', elasticModulusPa: '200000000000', secondMomentM4: '0.00000001' },
  };
  for (const [slug, values] of Object.entries(examples)) {
    const result = runNativeToolDefinition(slug, values);
    assert.ok(result.lines?.length || result.rows?.length, `${slug} returned no renderable output`);
    assert.ok((result.warnings || []).every((warning) => typeof warning === 'string'));
  }
});

test('build emits exactly 51 routes and all batch 4 worksheets use local assets and native definitions', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const source = await readFile('src/native-tools.js', 'utf8');
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /Clear local input/);
  const catalogue = JSON.parse(await readFile('data/tools.json', 'utf8'));
  assert.equal(catalogue.length, 51);
  for (const slug of batch4Slugs) {
    await access(`dist/${slug}/index.html`);
    const html = await readFile(`dist/${slug}/index.html`, 'utf8');
    assert.match(html, new RegExp(`data-tool=\\"${slug}\\"`));
    assert.match(html, /native-tools\.js/);
    assert.match(html, /native-tool\.css/);
    assert.match(html, /Inputs and calculations stay in this browser tab/);
    assert.doesNotMatch(html, /Continue to .* ↗/);
    assert.match(source, new RegExp(`['\\"]${slug}['\\"]\\s*:`));
  }
});
