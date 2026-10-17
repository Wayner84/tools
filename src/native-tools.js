function requireFinite(values) {
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError('All inputs must be finite numbers');
}

function requireFiniteResult(value, label, { nonZero = false } = {}) {
  if (!Number.isFinite(value)) throw new RangeError(`${label} exceeds the supported finite numeric range`);
  if (nonZero && value === 0) throw new RangeError(`${label} underflowed to zero outside the supported numeric range`);
  return value;
}

function requireNonzeroArithmetic(value, label, operands) {
  return requireFiniteResult(value, label, { nonZero: operands.every((operand) => operand !== 0) });
}

function squareContribution(value, label) {
  return requireNonzeroArithmetic(value ** 2, label, [value]);
}

function requireFiniteResults(value, label) {
  const visit = (candidate, path) => {
    if (typeof candidate === 'number') requireFiniteResult(candidate, path);
    else if (Array.isArray(candidate)) candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (candidate && typeof candidate === 'object') Object.entries(candidate).forEach(([key, item]) => visit(item, `${path}.${key}`));
  };
  visit(value, label);
  return value;
}

function requireFiniteOutput(value, label = 'Output') {
  return requireFiniteResults(value, label);
}

export function evaluateGuardBandDecision({ lsl, usl, measured, guard, rule }) {
  requireFinite([lsl, usl, measured, guard]);
  if (usl <= lsl) throw new RangeError('USL must be greater than LSL');
  if (!['plain-tolerance', 'guarded-acceptance'].includes(rule)) throw new RangeError('An explicit decision rule is required');
  if (guard < 0) throw new RangeError('Guard must not be negative');
  const acceptanceLower = rule === 'guarded-acceptance' ? lsl + guard : lsl;
  const acceptanceUpper = rule === 'guarded-acceptance' ? usl - guard : usl;
  if (acceptanceLower >= acceptanceUpper) throw new RangeError('Guard must leave a positive acceptance interval');
  const insideTolerance = measured >= lsl && measured <= usl;
  const insideAcceptance = measured >= acceptanceLower && measured <= acceptanceUpper;
  const status = insideAcceptance ? 'accepted' : insideTolerance ? 'outside acceptance; inside tolerance' : 'outside tolerance';
  return {
    acceptanceLower, acceptanceUpper, insideTolerance, insideAcceptance, status, rule,
    metadata: { boundaries: 'inclusive', contractualRuleSelectedByUser: true },
    warnings: ['This calculation evaluates the user-selected rule; confirm the agreed contractual decision rule before use.'],
  };
}

export function parseSpcObservationsCsv({ csv, column = 'value', maxCharacters = 200000, maxRows = 10000 }) {
  if (typeof column !== 'string' || !column.trim() || column.length > 80) throw new RangeError('Measurement column must be 1 to 80 characters');
  const parsed = parseBoundedCsv(csv, { maxCharacters, maxRows });
  const headerless = parsed.headers.length === 1 && parsed.headers[0] !== '' && Number.isFinite(Number(parsed.headers[0]));
  let values;
  let selectedColumn;
  if (headerless) {
    selectedColumn = null;
    values = [parsed.headers[0], ...parsed.rows.map((row) => row[0])];
  } else {
    const columnName = column.trim();
    const columnIndex = parsed.headers.indexOf(columnName);
    if (columnIndex < 0) throw new RangeError(`Measurement column “${columnName}” was not found in the CSV header`);
    selectedColumn = columnName;
    values = parsed.rows.map((row) => row[columnIndex]);
  }
  const numericValues = values.map((raw, index) => {
    const text = String(raw).trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) throw new RangeError(`Observation row ${index + 1} must contain a finite number`);
    return value;
  });
  if (numericValues.length < 2) throw new RangeError('At least two observations are required');
  return {
    values: numericValues,
    headers: headerless ? [] : parsed.headers,
    column: selectedColumn,
    headerMode: headerless ? 'headerless-single-column' : 'named-header',
  };
}

export function parseSpcCsvWithWorker(csv, column = 'value', {
  WorkerClass = globalThis.Worker,
  workerUrl = new URL('./csv-parser-worker.js', import.meta.url),
  timeoutMs = 5000,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new RangeError('Worker timeout must be from 1 to 60,000 milliseconds');
  if (typeof WorkerClass !== 'function') return Promise.resolve(parseSpcObservationsCsv({ csv, column }));
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new WorkerClass(workerUrl, { type: 'module', name: 'spc-csv-parser' });
    } catch {
      resolve(parseSpcObservationsCsv({ csv, column }));
      return;
    }
    let settled = false; let timer;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate(); callback(value); };
    worker.onmessage = ({ data }) => {
      if (data?.ok) finish(resolve, data.result);
      else finish(reject, new RangeError(data?.error || 'Unable to parse SPC CSV'));
    };
    worker.onerror = () => {
      try { finish(resolve, parseSpcObservationsCsv({ csv, column })); }
      catch (error) { finish(reject, error); }
    };
    timer = setTimeout(() => finish(reject, new RangeError(`SPC CSV worker timed out after ${timeoutMs.toLocaleString('en-GB')} milliseconds`)), timeoutMs);
    try {
      worker.postMessage({ csv, column });
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function calculateImrChart(values) {
  if (!Array.isArray(values)) throw new RangeError('Observations must be an array in time order');
  if (values.length < 2) throw new RangeError('At least two observations are required');
  if (values.length > 10000) throw new RangeError('I-MR input is limited to 10,000 observations');
  requireFinite(values);
  const constants = { movingRangeLength: 2, d2: 1.128, D3: 0, D4: 3.267 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const movingRanges = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  const mrBar = movingRanges.reduce((sum, value) => sum + value, 0) / movingRanges.length;
  const estimatedSigma = mrBar / constants.d2;
  const individualLimits = { lower: mean - 3 * estimatedSigma, centre: mean, upper: mean + 3 * estimatedSigma };
  const movingRangeLimits = { lower: constants.D3 * mrBar, centre: mrBar, upper: constants.D4 * mrBar };
  const signals = [];
  values.forEach((value, index) => {
    if (value < individualLimits.lower || value > individualLimits.upper) signals.push({ chart: 'individual', index, value, rule: 'beyond 3-sigma control limit' });
  });
  movingRanges.forEach((value, index) => {
    if (value < movingRangeLimits.lower || value > movingRangeLimits.upper) signals.push({ chart: 'moving-range', index: index + 1, value, rule: 'beyond D3/D4 control limit' });
  });
  return requireFiniteResults({
    mean, movingRanges, mrBar, estimatedSigma, individualLimits, movingRangeLimits, signals,
    metadata: { method: 'Individuals and moving range of two; sigma estimated as MR-bar/d2', constants, signalIndexes: 'zero-based observation indexes' },
    warnings: ['Control limits describe process behaviour under this stated method; they are not specification limits or automatic disposition rules.'],
  }, 'I-MR result');
}

export function calculateGaugeRrAnova(measurements) {
  if (!Array.isArray(measurements) || measurements.length === 0) throw new RangeError('Provide balanced crossed Gauge R&R measurements');
  if (measurements.length > 10000) throw new RangeError('Gauge R&R input is limited to 10,000 measurements');
  const levelKey = (value, label) => {
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && value.trim() === '') || (typeof value === 'number' && !Number.isFinite(value))) throw new RangeError(`${label} identifiers must be non-empty strings or finite numbers`);
    return JSON.stringify([typeof value, value]);
  };
  const rows = measurements.map((row, index) => {
    if (!row || typeof row !== 'object') throw new RangeError(`Measurement ${index + 1} must be an object`);
    const part = levelKey(row.part, 'Part'); const operator = levelKey(row.operator, 'Operator'); const repeat = levelKey(row.repeat, 'Repeat');
    requireFinite([row.value]);
    return { part, operator, repeat, value: row.value };
  });
  const parts = [...new Set(rows.map((row) => row.part))];
  const operators = [...new Set(rows.map((row) => row.operator))];
  const repeats = [...new Set(rows.map((row) => row.repeat))];
  if (parts.length < 2 || operators.length < 2 || repeats.length < 2) throw new RangeError('Balanced crossed design requires at least two parts, operators and repeats');
  const cells = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.part, row.operator]);
    if (!cells.has(key)) cells.set(key, new Map());
    const cell = cells.get(key);
    if (cell.has(row.repeat)) throw new RangeError('Duplicate part/operator/repeat measurement');
    cell.set(row.repeat, row.value);
  }
  const expectedCount = parts.length * operators.length * repeats.length;
  if (rows.length !== expectedCount) throw new RangeError('Missing or unbalanced measurements; no values were imputed');
  for (const part of parts) for (const operator of operators) {
    const cell = cells.get(JSON.stringify([part, operator]));
    if (!cell || repeats.some((repeat) => !cell.has(repeat))) throw new RangeError('Missing or unbalanced measurements; no values were imputed');
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const allValues = rows.map((row) => row.value); const grandMean = mean(allValues);
  const partMeans = new Map(parts.map((part) => [part, mean(rows.filter((row) => row.part === part).map((row) => row.value))]));
  const operatorMeans = new Map(operators.map((operator) => [operator, mean(rows.filter((row) => row.operator === operator).map((row) => row.value))]));
  const cellMeans = new Map([...cells].map(([key, cell]) => [key, mean([...cell.values()])]));
  const a = parts.length; const b = operators.length; const n = repeats.length;
  const ssPart = b * n * parts.reduce((sum, part) => sum + squareContribution(partMeans.get(part) - grandMean, 'Gauge R&R part sum-of-squares contribution'), 0);
  const ssOperator = a * n * operators.reduce((sum, operator) => sum + squareContribution(operatorMeans.get(operator) - grandMean, 'Gauge R&R operator sum-of-squares contribution'), 0);
  let ssInteraction = 0; let ssRepeatability = 0;
  for (const part of parts) for (const operator of operators) {
    const key = JSON.stringify([part, operator]); const cellMean = cellMeans.get(key);
    const interactionDeviation = cellMean - partMeans.get(part) - operatorMeans.get(operator) + grandMean;
    ssInteraction += n * squareContribution(interactionDeviation, 'Gauge R&R interaction sum-of-squares contribution');
    for (const value of cells.get(key).values()) ssRepeatability += squareContribution(value - cellMean, 'Gauge R&R repeatability sum-of-squares contribution');
  }
  if (!allValues.every((value) => Object.is(value, allValues[0])) && [ssPart, ssOperator, ssInteraction, ssRepeatability].every((value) => value === 0)) {
    throw new RangeError('Gauge R&R sums of squares underflowed to zero outside the supported numeric range');
  }
  const term = (ss, df, label) => ({ ss, df, ms: requireNonzeroArithmetic(ss / df, `${label} mean square`, [ss, df]) });
  const anova = {
    part: term(ssPart, a - 1, 'Gauge R&R part'), operator: term(ssOperator, b - 1, 'Gauge R&R operator'),
    interaction: term(ssInteraction, (a - 1) * (b - 1), 'Gauge R&R interaction'), repeatability: term(ssRepeatability, a * b * (n - 1), 'Gauge R&R repeatability'),
  };
  const nonNegativeComponent = (numerator, divisor, label) => numerator <= 0 ? 0 : requireNonzeroArithmetic(numerator / divisor, label, [numerator, divisor]);
  const repeatability = anova.repeatability.ms;
  const interaction = nonNegativeComponent(anova.interaction.ms - anova.repeatability.ms, n, 'Gauge R&R interaction variance');
  const operator = nonNegativeComponent(anova.operator.ms - anova.interaction.ms, a * n, 'Gauge R&R operator variance');
  const partToPart = nonNegativeComponent(anova.part.ms - anova.interaction.ms, b * n, 'Gauge R&R part-to-part variance');
  const reproducibility = operator + interaction; const gaugeRr = repeatability + reproducibility; const total = gaugeRr + partToPart;
  const varianceComponents = { repeatability, operator, interaction, reproducibility, gaugeRr, partToPart, total };
  return requireFiniteResults({
    design: { parts: a, operators: b, repeats: n, observations: rows.length, balanced: true, crossed: true }, grandMean, anova, varianceComponents,
    standardDeviations: Object.fromEntries(Object.entries(varianceComponents).map(([key, value]) => [key, Math.sqrt(value)])),
    metadata: { method: 'random-effects two-way ANOVA with part-by-operator interaction', negativeVariancePolicy: 'truncate each estimated variance component at zero' },
    warnings: ['Only a complete balanced crossed design is analysed; results must not be used for unsupported certification or staff ranking.'],
  }, 'Gauge R&R result');
}

export function fitLinearCalibration({ reference, response, predictAt, allowExtrapolation = false }) {
  if (!Array.isArray(reference) || !Array.isArray(response)) throw new RangeError('Reference and response must be arrays');
  if (reference.length !== response.length) throw new RangeError('Reference and response arrays must have the same length');
  if (reference.length < 2 || reference.length > 10000) throw new RangeError('Provide 2 to 10,000 calibration pairs');
  requireFinite([...reference, ...response]);
  if (typeof allowExtrapolation !== 'boolean') throw new RangeError('allowExtrapolation must be boolean');
  const xMean = reference.reduce((sum, value) => sum + value, 0) / reference.length;
  const yMean = response.reduce((sum, value) => sum + value, 0) / response.length;
  const sxx = reference.reduce((sum, value) => sum + squareContribution(value - xMean, 'Calibration reference sum-of-squares contribution'), 0);
  if (sxx === 0) throw new RangeError('Reference values must vary to fit a calibration line');
  const sxy = reference.reduce((sum, value, index) => {
    const xDeviation = value - xMean; const yDeviation = response[index] - yMean;
    return sum + requireNonzeroArithmetic(xDeviation * yDeviation, 'Calibration cross-product contribution', [xDeviation, yDeviation]);
  }, 0);
  const slope = requireNonzeroArithmetic(sxy / sxx, 'Calibration slope', [sxy, sxx]); const intercept = yMean - slope * xMean;
  const fitted = reference.map((value) => intercept + slope * value);
  const residuals = response.map((value, index) => value - fitted[index]);
  const residualSumSquares = residuals.reduce((sum, value) => sum + squareContribution(value, 'Calibration residual sum-of-squares contribution'), 0);
  const totalSumSquares = response.reduce((sum, value) => sum + squareContribution(value - yMean, 'Calibration total sum-of-squares contribution'), 0);
  const referenceRange = [Math.min(...reference), Math.max(...reference)];
  let prediction = null;
  const warnings = ['Unweighted linear fitting alone does not establish traceability, uncertainty, instrument suitability or calibration validity.'];
  if (predictAt !== undefined) {
    requireFinite([predictAt]);
    const withinRange = predictAt >= referenceRange[0] && predictAt <= referenceRange[1];
    if (!withinRange && !allowExtrapolation) throw new RangeError('Prediction is outside the calibrated reference range; extrapolation is disabled by default');
    if (!withinRange) warnings.push('Extrapolation was explicitly enabled; predictions outside the input range may be unreliable.');
    prediction = { reference: predictAt, response: intercept + slope * predictAt, withinRange };
  }
  if (totalSumSquares === 0) warnings.push('All response values are equal, so R-squared is undefined.');
  return requireFiniteResults({
    intercept, slope, fitted, residuals, residualSumSquares,
    residualStandardDeviation: reference.length > 2 ? Math.sqrt(residualSumSquares / (reference.length - 2)) : null,
    rSquared: totalSumSquares === 0 ? null : 1 - residualSumSquares / totalSumSquares,
    referenceRange, prediction,
    metadata: { method: 'unweighted ordinary least squares: response = intercept + slope × reference', extrapolationDefault: 'blocked', weighting: 'none' }, warnings,
  }, 'Calibration result');
}

export function reviewCalibrationInterval({ lastCalibrationDate, approvedIntervalDays, reviewDate, history = [] }) {
  const parseDate = (value, label) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError(`${label} must be a valid YYYY-MM-DD date`);
    const [year, month, day] = value.split('-').map(Number);
    const time = Date.UTC(year, month - 1, day);
    const date = new Date(time);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError(`${label} must be a valid calendar date`);
    return time;
  };
  if (!Number.isInteger(approvedIntervalDays) || approvedIntervalDays <= 0 || approvedIntervalDays > 36500) throw new RangeError('User-approved interval must be a whole number from 1 to 36,500 days');
  if (!Array.isArray(history) || history.length > 1000) throw new RangeError('History must be an array of at most 1,000 records');
  const lastTime = parseDate(lastCalibrationDate, 'Last calibration date');
  const reviewTime = parseDate(reviewDate, 'Review date');
  if (reviewTime < lastTime) throw new RangeError('Review date cannot be before the last calibration date');
  const dayMilliseconds = 86400000;
  const dueTime = lastTime + approvedIntervalDays * dayMilliseconds;
  const dueDate = new Date(dueTime);
  if (!Number.isFinite(dueTime) || dueDate.getUTCFullYear() < 0 || dueDate.getUTCFullYear() > 9999) {
    throw new RangeError('User-approved due date must remain within the supported four-digit YYYY-MM-DD range');
  }
  const counts = { pass: 0, fail: 0, adjusted: 0 }; const drifts = []; let latestRecordDate = null;
  history.forEach((record, index) => {
    if (!record || typeof record !== 'object') throw new RangeError(`History record ${index + 1} must be an object`);
    const eventTime = parseDate(record.date, `History record ${index + 1} date`);
    if (eventTime > reviewTime) throw new RangeError(`History record ${index + 1} date cannot be after the review date`);
    if (!['pass', 'fail', 'adjusted'].includes(record.outcome)) throw new RangeError(`History record ${index + 1} outcome must be pass, fail or adjusted`);
    counts[record.outcome] += 1;
    if (record.drift !== undefined) { requireFinite([record.drift]); drifts.push(Math.abs(record.drift)); }
    if (latestRecordDate === null || record.date > latestRecordDate) latestRecordDate = record.date;
  });
  const elapsedDays = (reviewTime - lastTime) / dayMilliseconds;
  const daysUntilDue = (dueTime - reviewTime) / dayMilliseconds;
  const status = daysUntilDue > 0 ? 'within-user-approved-interval' : daysUntilDue === 0 ? 'due-today' : 'past-user-approved-due-date';
  return {
    lastCalibrationDate, reviewDate, approvedIntervalDays,
    approvedDueDate: dueDate.toISOString().slice(0, 10), elapsedDays, daysUntilDue, status,
    historySummary: { records: history.length, ...counts, maximumAbsoluteDrift: drifts.length ? Math.max(...drifts) : null, latestRecordDate },
    ownerDecisionRequired: true,
    metadata: { dateBasis: 'UTC calendar days', intervalSource: 'user-approved input', prescribedIntervalDays: null, automaticApproval: false },
    warnings: ['This summary reports against the user-approved interval and history; it does not approve, extend or prescribe an interval. The asset owner must record the decision and rationale.'],
  };
}

export function calculateAcceptanceSamplingOc({ sampleSize, acceptanceNumber, defectProbability, aql, lq, curveProbabilities = [] }) {
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 10000) throw new RangeError('Sample size must be a whole number from 1 to 10,000');
  if (!Number.isInteger(acceptanceNumber) || acceptanceNumber < 0 || acceptanceNumber > sampleSize) throw new RangeError('Acceptance number must be a whole number from zero to sample size');
  const validateProbability = (value, label) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be a finite probability from zero to one`);
  };
  validateProbability(defectProbability, 'Defect probability');
  validateProbability(aql, 'AQL');
  validateProbability(lq, 'LQ');
  if (aql >= lq) throw new RangeError('AQL must be less than LQ');
  if (!Array.isArray(curveProbabilities) || curveProbabilities.length > 1001) throw new RangeError('Curve probabilities must be an array of at most 1,001 values');
  curveProbabilities.forEach((value) => validateProbability(value, 'Curve probability'));
  const probabilityRange = (p, start, end, label) => {
    const logarithms = []; let logCombination = 0;
    for (let k = 0; k <= end; k += 1) {
      if (k > 0) logCombination += Math.log(sampleSize - k + 1) - Math.log(k);
      if (k >= start) logarithms.push(logCombination + k * Math.log(p) + (sampleSize - k) * Math.log1p(-p));
    }
    const maximumLog = Math.max(...logarithms);
    const logTotal = maximumLog + Math.log(logarithms.reduce((sum, value) => sum + Math.exp(value - maximumLog), 0));
    const total = Math.exp(logTotal);
    if (total === 0) throw new RangeError(`${label} underflowed to zero outside the supported numeric range`);
    return Math.min(1, Math.max(0, total));
  };
  const probability = (p) => {
    if (acceptanceNumber === sampleSize || p === 0) return 1;
    if (p === 1) return 0;
    return probabilityRange(p, 0, acceptanceNumber, 'Acceptance probability');
  };
  const producerRisk = (p) => {
    if (acceptanceNumber === sampleSize || p === 0) return 0;
    if (p === 1) return 1;
    return probabilityRange(p, acceptanceNumber + 1, sampleSize, 'Producer risk');
  };
  const acceptanceProbability = probability(defectProbability);
  return {
    sampleSize, acceptanceNumber, defectProbability, acceptanceProbability,
    qualityPoints: { aql, lq },
    producerRiskAlpha: producerRisk(aql), consumerRiskBeta: probability(lq),
    ocCurve: curveProbabilities.map((p) => ({ defectProbability: p, acceptanceProbability: probability(p) })),
    metadata: {
      method: 'binomial approximation: P(accept) = Σ from k=0 to c of C(n,k)p^k(1-p)^(n-k)',
      replacementAssumption: 'independent Bernoulli trials / effectively infinite lot',
      riskDefinitions: 'Producer risk alpha = 1 - Pa(AQL); consumer risk beta = Pa(LQ). AQL and LQ are separately supplied quality points.',
    },
    warnings: ['Binomial sampling is an infinite-lot approximation and omits finite-lot correction. No licensed sampling tables are reproduced; the customer contract determines the accepted plan and lot disposition.'],
  };
}

export function parseGcodePreflight(text, { maxCharacters = 200000, maxLines = 5000, maxSegments = 5000 } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new RangeError('G-code text is required');
  if (text.length > maxCharacters) throw new RangeError(`G-code is limited to ${maxCharacters.toLocaleString('en-GB')} characters`);
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) throw new RangeError(`G-code is limited to ${maxLines.toLocaleString('en-GB')} lines`);
  const supportedG = new Set([0, 1, 2, 3, 17, 20, 21, 90, 91]);
  const supportedM = new Set([2, 30]);
  const wordPattern = /([A-Za-z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
  let units = null; let distanceMode = null; let plane = 'G17'; let motion = null; let feed = null; let programEnd = null;
  let x = 0; let y = 0; const segments = []; const hazards = [];
  const extents = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
  const includePoint = (px, py, label) => {
    requireFiniteResult(px, `${label} X coordinate`); requireFiniteResult(py, `${label} Y coordinate`);
    extents.xMin = Math.min(extents.xMin, px); extents.xMax = Math.max(extents.xMax, px);
    extents.yMin = Math.min(extents.yMin, py); extents.yMax = Math.max(extents.yMax, py);
  };
  const normalise = (angle) => { const tau = 2 * Math.PI; return ((angle % tau) + tau) % tau; };
  const onSweep = (angle, start, end, clockwise) => {
    const tau = 2 * Math.PI; const a = normalise(angle); const s = normalise(start); const e = normalise(end);
    const sweep = clockwise ? (s - e + tau) % tau : (e - s + tau) % tau;
    if (sweep < 1e-12) return true;
    const travelled = clockwise ? (s - a + tau) % tau : (a - s + tau) % tau;
    return travelled <= sweep + 1e-12;
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    let line = lines[lineIndex]; let commentDepth = 0; let code = '';
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === ';' && commentDepth === 0) break;
      if (character === '(') { if (commentDepth) throw new RangeError(`Line ${lineNumber}: nested comments are unsupported`); commentDepth = 1; continue; }
      if (character === ')') { if (!commentDepth) throw new RangeError(`Line ${lineNumber}: unmatched comment close`); commentDepth = 0; continue; }
      if (!commentDepth) code += character;
    }
    if (commentDepth) throw new RangeError(`Line ${lineNumber}: unterminated comment`);
    code = code.trim();
    if (!code || code === '%') continue;
    if (programEnd) throw new RangeError(`Line ${lineNumber}: executable content after program end ${programEnd} is unsupported; analysis stopped`);
    if (/[#\[\]<>]/.test(code)) throw new RangeError(`Line ${lineNumber}: macro or expression syntax is unsupported; analysis stopped`);
    const words = []; let match;
    wordPattern.lastIndex = 0;
    while ((match = wordPattern.exec(code))) words.push({ letter: match[1].toUpperCase(), value: Number(match[2]), raw: `${match[1].toUpperCase()}${match[2]}` });
    const remainder = code.replace(wordPattern, '').replace(/\s+/g, '');
    if (remainder) throw new RangeError(`Line ${lineNumber}: unsupported or malformed syntax "${remainder}"; analysis stopped`);
    const seen = new Set(); const modalGroups = new Map(); let blockEndCode = null;
    for (const word of words) {
      if (!Number.isFinite(word.value)) throw new RangeError(`Line ${lineNumber}: all word values must be finite`);
      if (!'GMNXYIJF'.includes(word.letter)) throw new RangeError(`Line ${lineNumber}: unsupported word ${word.letter}; analysis stopped`);
      if (word.letter !== 'G' && seen.has(word.letter)) throw new RangeError(`Line ${lineNumber}: duplicate ${word.letter} word is ambiguous`);
      seen.add(word.letter);
      if (word.letter === 'G') {
        if (!Number.isInteger(word.value) || !supportedG.has(word.value)) throw new RangeError(`Line ${lineNumber}: unsupported code G${word.value}; analysis stopped`);
        const group = word.value <= 3 ? 'motion' : word.value === 17 ? 'plane' : word.value <= 21 ? 'units' : 'distance mode';
        if (modalGroups.has(group)) throw new RangeError(`Line ${lineNumber}: competing ${group} codes G${modalGroups.get(group)} and G${word.value} are ambiguous`);
        modalGroups.set(group, word.value);
        if (word.value <= 3) motion = `G${word.value}`;
        else if (word.value === 17) plane = 'G17';
        else if (word.value === 20 || word.value === 21) {
          const requestedUnits = word.value === 20 ? 'in' : 'mm';
          if (segments.length && units && requestedUnits !== units) throw new RangeError(`Line ${lineNumber}: unit change from ${units} to ${requestedUnits} after motion is unsupported; analysis stopped`);
          units = requestedUnits;
        }
        else if (word.value === 90) distanceMode = 'absolute';
        else if (word.value === 91) distanceMode = 'incremental';
      } else if (word.letter === 'M' && (!Number.isInteger(word.value) || !supportedM.has(word.value))) {
        throw new RangeError(`Line ${lineNumber}: unsupported code M${word.value}; analysis stopped`);
      } else if (word.letter === 'M') {
        blockEndCode = `M${word.value}`;
      }
    }
    const byLetter = Object.fromEntries(words.filter((word) => !['G', 'M', 'N'].includes(word.letter)).map((word) => [word.letter, word.value]));
    if (byLetter.F !== undefined) {
      if (byLetter.F <= 0) throw new RangeError(`Line ${lineNumber}: feed must be greater than zero`);
      feed = byLetter.F;
    }
    const hasCoordinates = ['X', 'Y', 'I', 'J'].some((letter) => byLetter[letter] !== undefined);
    if ((byLetter.I !== undefined || byLetter.J !== undefined) && motion !== 'G2' && motion !== 'G3') throw new RangeError(`Line ${lineNumber}: I/J arc centre offsets require G2 or G3 arc motion; analysis stopped`);
    if (!hasCoordinates) { if (blockEndCode) programEnd = blockEndCode; continue; }
    if (!motion) throw new RangeError(`Line ${lineNumber}: select G0, G1, G2 or G3 before motion`);
    if (!units) throw new RangeError(`Line ${lineNumber}: select G20 or G21 units before motion`);
    if (!distanceMode) throw new RangeError(`Line ${lineNumber}: select G90 or G91 distance mode before motion`);
    if (segments.length >= maxSegments) throw new RangeError(`G-code preview is limited to ${maxSegments.toLocaleString('en-GB')} motion segments`);
    if (motion !== 'G0' && feed === null) throw new RangeError(`Line ${lineNumber}: ${motion} requires a positive modal feed F before motion`);
    const targetX = requireFiniteResult(byLetter.X === undefined ? x : distanceMode === 'absolute' ? byLetter.X : x + byLetter.X, `Line ${lineNumber}: target X coordinate`);
    const targetY = requireFiniteResult(byLetter.Y === undefined ? y : distanceMode === 'absolute' ? byLetter.Y : y + byLetter.Y, `Line ${lineNumber}: target Y coordinate`);
    const segment = { line: lineNumber, motion, from: { x, y }, to: { x: targetX, y: targetY }, feed: motion === 'G0' ? null : feed };
    if (motion === 'G2' || motion === 'G3') {
      if (plane !== 'G17' || byLetter.I === undefined || byLetter.J === undefined) throw new RangeError(`Line ${lineNumber}: G2/G3 requires G17 and I/J arc centre offsets; analysis stopped`);
      const centre = {
        x: requireFiniteResult(x + byLetter.I, `Line ${lineNumber}: arc centre X coordinate`),
        y: requireFiniteResult(y + byLetter.J, `Line ${lineNumber}: arc centre Y coordinate`),
      };
      const radius = requireFiniteResult(Math.hypot(x - centre.x, y - centre.y), `Line ${lineNumber}: arc radius`);
      if (radius === 0) throw new RangeError(`Line ${lineNumber}: arc centre must differ from the start point`);
      const endRadius = requireFiniteResult(Math.hypot(targetX - centre.x, targetY - centre.y), `Line ${lineNumber}: arc end radius`);
      const radiusDifference = requireFiniteResult(Math.abs(endRadius - radius), `Line ${lineNumber}: arc radius comparison`);
      if (radiusDifference > Math.max(1e-9, radius * 1e-6)) throw new RangeError(`Line ${lineNumber}: arc start and end radii do not match`);
      segment.centre = centre; segment.radius = radius;
      const startAngle = Math.atan2(y - centre.y, x - centre.x); const endAngle = Math.atan2(targetY - centre.y, targetX - centre.x);
      for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) if (onSweep(angle, startAngle, endAngle, motion === 'G2')) includePoint(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle), `Line ${lineNumber}: arc extent`);
    }
    includePoint(x, y, `Line ${lineNumber}: start`); includePoint(targetX, targetY, `Line ${lineNumber}: target`); segments.push(segment); x = targetX; y = targetY;
    if (blockEndCode) programEnd = blockEndCode;
  }
  if (!segments.length) hazards.push('No supported XY motion was found.');
  if (segments.some((segment) => segment.motion === 'G0')) hazards.push('Rapid moves are shown geometrically only; fixtures, stock, tools, Z motion and machine kinematics are unknown.');
  return {
    units, distanceMode, plane, extents, segments, hazards,
    dialect: 'Bounded XY subset: G0, G1, G2/G3 with G17 I/J centres, G20/G21, G90/G91, F, M2/M30',
    warnings: ['Preview only: this is not collision proof, machine compatibility verification or executable machine control. Never send code to machinery from this worksheet.', ...hazards],
  };
}

function stepStrings(text) {
  const values = []; const pattern = /'((?:''|[^'])*)'/g; let match;
  while ((match = pattern.exec(text))) values.push(match[1].replaceAll("''", "'"));
  return values;
}

export function inspectStepPart21(text, { maxCharacters = 500000, maxEntities = 20000, maxNesting = 64 } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new RangeError('STEP Part 21 text is required');
  if (text.length > maxCharacters) throw new RangeError(`STEP input is limited to ${maxCharacters.toLocaleString('en-GB')} characters`);
  let cleaned = ''; let masked = ''; let inString = false; let comment = false; let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]; const next = text[index + 1];
    if (comment) {
      if (current === '*' && next === '/') { comment = false; index += 1; cleaned += '  '; masked += '  '; }
      else { cleaned += ' '; masked += ' '; }
      continue;
    }
    if (!inString && current === '/' && next === '*') { comment = true; index += 1; cleaned += '  '; masked += '  '; continue; }
    cleaned += current;
    if (current === "'") {
      masked += ' ';
      if (inString && next === "'") { cleaned += next; masked += ' '; index += 1; continue; }
      inString = !inString; continue;
    }
    masked += inString ? ' ' : current;
    if (!inString && current === '(') { depth += 1; if (depth > maxNesting) throw new RangeError(`STEP nesting is limited to ${maxNesting} levels`); }
    if (!inString && current === ')') { depth -= 1; if (depth < 0) throw new RangeError('Malformed STEP: unmatched closing parenthesis'); }
  }
  if (comment) throw new RangeError('Malformed STEP: unterminated comment');
  if (inString) throw new RangeError('Malformed STEP: unterminated string');
  if (depth !== 0) throw new RangeError('Malformed STEP: unbalanced parentheses');
  if (!/^\s*ISO-10303-21\s*;/i.test(masked) || !/END-ISO-10303-21\s*;\s*$/i.test(masked)) throw new RangeError('STEP Part 21 ISO-10303-21 envelope is required');

  const findSection = (openingPattern, startIndex) => {
    openingPattern.lastIndex = startIndex;
    const opening = openingPattern.exec(masked);
    if (!opening) return null;
    const endingPattern = /\bENDSEC\s*;/gi; endingPattern.lastIndex = opening.index + opening[0].length;
    const ending = endingPattern.exec(masked);
    if (!ending) return null;
    const contentStart = opening.index + opening[0].length;
    return { start: opening.index, end: ending.index + ending[0].length, source: cleaned.slice(contentStart, ending.index), mask: masked.slice(contentStart, ending.index) };
  };
  const header = findSection(/\bHEADER\s*;/gi, 0);
  const data = header && findSection(/\bDATA(?:\s*\([^;]*\))?\s*;/gi, header.end);
  if (!header || !data || header.start > data.start) throw new RangeError('STEP Part 21 requires bounded HEADER and DATA sections in order');
  const envelopePrefix = masked.slice(0, header.start);
  const betweenSections = masked.slice(header.end, data.start);
  const envelopeSuffix = masked.slice(data.end);
  if (!/^\s*ISO-10303-21\s*;\s*$/i.test(envelopePrefix) || betweenSections.trim() || !/^\s*END-ISO-10303-21\s*;\s*$/i.test(envelopeSuffix)) {
    throw new RangeError('Unsupported additional section or trailing content in STEP Part 21 envelope');
  }

  const statementArguments = (section, name) => {
    const match = new RegExp(`\\b${name}\\s*\\(([^;]*)\\)\\s*;`, 'i').exec(section.mask);
    if (!match) return null;
    const argumentsStart = match.index + match[0].indexOf(match[1]);
    return section.source.slice(argumentsStart, argumentsStart + match[1].length);
  };
  const schemaArguments = statementArguments(header, 'FILE_SCHEMA');
  if (schemaArguments === null) throw new RangeError('STEP HEADER requires FILE_SCHEMA');
  const schemas = stepStrings(schemaArguments);
  if (!schemas.length) throw new RangeError('FILE_SCHEMA must declare at least one schema');
  const fileNameArguments = statementArguments(header, 'FILE_NAME');
  const provenance = { name: null, timestamp: null, authors: [], organisations: [] };
  if (fileNameArguments !== null) {
    const fields = fileNameArguments.match(/^\s*('(?:''|[^'])*')\s*,\s*('(?:''|[^'])*')\s*,\s*(\((?:'(?:(?:'')|[^'])*'\s*,?\s*)*\))\s*,\s*(\((?:'(?:(?:'')|[^'])*'\s*,?\s*)*\))/);
    if (!fields) throw new RangeError('Malformed FILE_NAME provenance fields');
    provenance.name = stepStrings(fields[1])[0]; provenance.timestamp = stepStrings(fields[2])[0];
    provenance.authors = stepStrings(fields[3]); provenance.organisations = stepStrings(fields[4]);
  }

  const statements = []; let statementStart = 0;
  for (let index = 0; index < data.mask.length; index += 1) {
    if (data.mask[index] !== ';') continue;
    statements.push({ source: data.source.slice(statementStart, index), mask: data.mask.slice(statementStart, index) });
    statementStart = index + 1;
  }
  if (data.mask.slice(statementStart).trim()) throw new RangeError('Malformed STEP DATA statement termination');

  const entityCounts = {}; const ids = new Set(); let totalEntities = 0; const declaredUnits = [];
  for (const statement of statements) {
    if (!statement.mask.trim()) continue;
    if (!/#\d+\s*=/.test(statement.mask)) throw new RangeError('Unsupported STEP DATA statement; only simple entity assignments are accepted');
    const entityMatch = /^\s*#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\s*\(/i.exec(statement.mask);
    if (!entityMatch) throw new RangeError('Malformed or unsupported complex STEP entity assignment');
    const openingIndex = entityMatch.index + entityMatch[0].lastIndexOf('('); let entityDepth = 0; let closingIndex = -1;
    for (let index = openingIndex; index < statement.mask.length; index += 1) {
      if (statement.mask[index] === '(') entityDepth += 1;
      else if (statement.mask[index] === ')' && --entityDepth === 0) { closingIndex = index; break; }
    }
    if (closingIndex < 0 || statement.mask.slice(closingIndex + 1).trim()) throw new RangeError('Malformed or unsupported complex STEP entity assignment');
    const id = `#${entityMatch[1]}`; const type = entityMatch[2].toUpperCase();
    if (ids.has(id)) throw new RangeError(`Duplicate STEP entity identifier ${id}`);
    ids.add(id); totalEntities += 1;
    if (totalEntities > maxEntities) throw new RangeError(`STEP input is limited to ${maxEntities.toLocaleString('en-GB')} entities`);
    entityCounts[type] = (entityCounts[type] || 0) + 1;
    for (const match of statement.mask.matchAll(/SI_UNIT\s*\(\s*(\$|\.[A-Z]+\.)\s*,\s*\.([A-Z]+)\.\s*\)/gi)) {
      const prefix = match[1].toUpperCase(); const base = match[2].toLowerCase();
      const names = { '.MILLI.': 'milli', '.CENTI.': 'centi', '.KILO.': 'kilo', '$': '' };
      declaredUnits.push(`${names[prefix] ?? prefix.toLowerCase()}${base}`);
    }
    for (const match of statement.mask.matchAll(/CONVERSION_BASED_UNIT\s*\(/gi)) {
      const name = stepStrings(statement.source.slice(match.index + match[0].length))[0];
      if (name !== undefined) declaredUnits.push(name);
    }
  }
  return {
    schemas, provenance, entityCounts, totalEntities, declaredUnits: [...new Set(declaredUnits)],
    diagnostics: [`Parsed ${totalEntities.toLocaleString('en-GB')} simple entity assignments locally.`],
    limitations: ['Header/entity diagnostics only: complex entity instances are rejected; this is not full STEP conformance, geometry, topology or PMI validation and is not NIST analyser equivalence.'],
  };
}

export function calculateSpurGear({ module, teeth1, teeth2, pressureAngleDeg }) {
  requireFinite([module, teeth1, teeth2, pressureAngleDeg]);
  if (module <= 0) throw new RangeError('Module must be greater than zero');
  if (!Number.isInteger(teeth1) || !Number.isInteger(teeth2) || teeth1 < 6 || teeth2 < 6) throw new RangeError('Each tooth count must be a whole number of at least 6 teeth');
  if (pressureAngleDeg <= 0 || pressureAngleDeg >= 45) throw new RangeError('Pressure angle must be greater than 0 and less than 45 degrees');
  const pressureAngleRad = pressureAngleDeg * Math.PI / 180;
  const gear = (teeth) => ({
    teeth, pitchDiameter: module * teeth, outsideDiameter: module * (teeth + 2), rootDiameter: module * (teeth - 2.5),
    baseDiameter: module * teeth * Math.cos(pressureAngleRad), addendum: module, dedendum: 1.25 * module,
  });
  const gear1 = gear(teeth1); const gear2 = gear(teeth2);
  const warnings = ['Geometry only: this worksheet does not validate tooth strength, interference, undercut, backlash, wear, noise, lubrication or load capacity.'];
  if (teeth1 < 17 || teeth2 < 17) warnings.push('A low tooth count may be susceptible to undercut or interference; verify with an appropriate gear standard and design method.');
  return requireFiniteResults({
    gear1, gear2, centreDistance: module * (teeth1 + teeth2) / 2, circularPitch: Math.PI * module, standardToothThickness: Math.PI * module / 2,
    pressureAngleDeg,
    assumptions: ['Standard unshifted external spur gears with full-depth teeth: addendum = module and dedendum = 1.25 × module.', 'Both gears use the same module and declared pressure angle; helix angle and profile shift are zero.'], warnings,
  }, 'Spur gear result');
}

export function calculateBeamDeflection({ loadN, lengthM, elasticModulusPa, secondMomentM4 }) {
  requireFinite([loadN, lengthM, elasticModulusPa, secondMomentM4]);
  if (loadN <= 0) throw new RangeError('Load must be greater than zero');
  if (lengthM <= 0) throw new RangeError('Length must be greater than zero');
  if (elasticModulusPa <= 0) throw new RangeError('Elastic modulus must be greater than zero');
  if (secondMomentM4 <= 0) throw new RangeError('Second moment of area must be greater than zero');
  const stiffness = requireFiniteResult(elasticModulusPa * secondMomentM4, 'Flexural rigidity', { nonZero: true });
  const cubic = requireFiniteResult(loadN * lengthM ** 3, 'Beam deflection numerator', { nonZero: true });
  const simplySupportedDeflection = requireFiniteResult(cubic / (48 * stiffness), 'Simply supported beam deflection', { nonZero: true });
  const cantileverDeflection = requireFiniteResult(cubic / (3 * stiffness), 'Cantilever beam deflection', { nonZero: true });
  const simplySupportedMoment = requireFiniteResult(loadN * lengthM / 4, 'Simply supported beam moment', { nonZero: true });
  const cantileverMoment = requireFiniteResult(loadN * lengthM, 'Cantilever beam moment', { nonZero: true });
  return {
    simplySupportedCentre: { deflectionM: simplySupportedDeflection, maximumMomentNm: simplySupportedMoment },
    cantileverEnd: { deflectionM: cantileverDeflection, maximumMomentNm: cantileverMoment },
    flexuralRigidityNm2: stiffness,
    assumptions: ['Euler–Bernoulli small-deflection linear elastic beam behaviour.', 'Constant user-supplied elastic modulus E and second moment of area I; prismatic beam, static point load and ideal supports.', 'Simply supported case places the point load at midspan; cantilever case places it at the free end.'],
    warnings: ['Educational preliminary comparison only; do not use this worksheet for lifting, safety-critical approval or structural sign-off. Shear deformation, self-weight, stress concentrations, buckling and connection flexibility are excluded.'],
  };
}

export function calculateMachining({ mode, surfaceSpeed, diameter, teeth, feedPerTooth, cutLength }) {
  requireFinite([surfaceSpeed, diameter, teeth, feedPerTooth, cutLength]);
  if (!['metric', 'imperial'].includes(mode)) throw new RangeError('Mode must be metric or imperial');
  if (surfaceSpeed <= 0) throw new RangeError('Surface speed must be greater than zero');
  if (diameter <= 0) throw new RangeError('Diameter must be greater than zero');
  if (!Number.isInteger(teeth) || teeth <= 0) throw new RangeError('Teeth must be a positive whole number');
  if (feedPerTooth <= 0) throw new RangeError('Feed per tooth must be greater than zero');
  if (cutLength <= 0) throw new RangeError('Cut length must be greater than zero');
  const circumference = requireFiniteResult(Math.PI * diameter, 'Tool circumference', { nonZero: true });
  const rpm = requireFiniteResult((mode === 'metric' ? 1000 : 12) * surfaceSpeed / circumference, 'Spindle speed', { nonZero: true });
  const feedRate = requireFiniteResult(rpm * teeth * feedPerTooth, 'Feed rate', { nonZero: true });
  const idealCutMinutes = requireFiniteResult(cutLength / feedRate, 'Ideal cutting time', { nonZero: true });
  return { rpm, feedRate, idealCutMinutes };
}

export function selectGaugeBlockStack({ target, inventory, maxBlocks = 4 }) {
  if (!Array.isArray(inventory) || inventory.length === 0) throw new RangeError('Inventory must contain decimal block sizes');
  if (inventory.length > 60) throw new RangeError('Inventory is limited to 60 blocks');
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 6) throw new RangeError('Maximum blocks must be a whole number from 1 to 6');
  const inputs = [String(target), ...inventory.map(String)];
  const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
  if (inputs.some((value) => !decimalPattern.test(value) || Number(value) <= 0)) throw new RangeError('Target and inventory must be positive decimals with at most 6 places');
  const scalePlaces = Math.max(...inputs.map((value) => (value.split('.')[1] || '').length));
  const scale = 10n ** BigInt(scalePlaces);
  const toInteger = (value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * scale + BigInt((fraction + '0'.repeat(scalePlaces)).slice(0, scalePlaces) || '0');
  };
  const targetInteger = toInteger(inputs[0]);
  const blocks = inventory.map((raw) => ({ raw: String(raw), value: toInteger(String(raw)) }));
  let best = null; let combinations = 0;
  const consider = (chosen, sum) => {
    const residual = targetInteger - sum;
    const error = residual < 0n ? -residual : residual;
    if (!best || error < best.error || (error === best.error && chosen.length < best.chosen.length)) best = { chosen: [...chosen], sum, residual, error };
  };
  const visit = (start, chosen, sum) => {
    if (chosen.length) consider(chosen, sum);
    if (chosen.length === maxBlocks) return;
    for (let index = start; index < blocks.length; index += 1) {
      combinations += 1;
      if (combinations > 250000) throw new RangeError('Gauge-block search exceeds the 250,000-combination safety limit');
      chosen.push(index); visit(index + 1, chosen, sum + blocks[index].value); chosen.pop();
    }
  };
  visit(0, [], 0n);
  const fixed = (value) => {
    const negative = value < 0n; const magnitude = negative ? -value : value;
    const whole = magnitude / scale; const fraction = scalePlaces ? `.${String(magnitude % scale).padStart(scalePlaces, '0')}` : '';
    return `${negative ? '-' : ''}${whole}${fraction}`;
  };
  return { blocks: best.chosen.map((index) => blocks[index].raw), sum: fixed(best.sum), residual: fixed(best.residual), combinations };
}

export function calculateToleranceChain(components) {
  if (!Array.isArray(components) || components.length === 0 || components.length > 100) throw new RangeError('Provide 1 to 100 components');
  let nominal = 0; let minimum = 0; let maximum = 0; let rssSquared = 0;
  for (const component of components) {
    const { nominal: value, plus, minus, sign } = component;
    requireFinite([value, plus, minus, sign]);
    if (![1, -1].includes(sign)) throw new RangeError('Each component sign must be +1 or -1');
    if (minus > plus) throw new RangeError('Component minus limit must not exceed plus limit');
    nominal += sign * value;
    minimum += sign === 1 ? value + minus : -(value + plus);
    maximum += sign === 1 ? value + plus : -(value + minus);
    const tolerance = Math.max(Math.abs(minus), Math.abs(plus));
    rssSquared += squareContribution(tolerance, 'Tolerance-chain RSS contribution');
  }
  return requireFiniteResults({ nominal, minimum, maximum, rssSymmetric: Math.sqrt(rssSquared) }, 'Tolerance-chain result');
}

export function calculateUncertaintyBudget({ components, coverageFactor = 2, correlations }) {
  if (!Array.isArray(components) || components.length === 0 || components.length > 100) throw new RangeError('Provide 1 to 100 uncertainty components');
  if (correlations != null && (!Array.isArray(correlations) || correlations.length > 0)) throw new RangeError('Correlations are not supported in this release; do not silently omit them');
  requireFinite([coverageFactor]);
  if (coverageFactor <= 0) throw new RangeError('Coverage factor must be greater than zero');
  const divisors = { standard: 1, normal: 1, rectangular: Math.sqrt(3), triangular: Math.sqrt(6), 'u-shaped': Math.sqrt(2) };
  const converted = components.map(({ magnitude, distribution, sensitivity }) => {
    requireFinite([magnitude, sensitivity]);
    if (magnitude < 0) throw new RangeError('Uncertainty magnitudes cannot be negative');
    if (!(distribution in divisors)) throw new RangeError(`Unsupported distribution: ${distribution}`);
    const standardUncertainty = requireNonzeroArithmetic(magnitude / divisors[distribution], 'Standard uncertainty', [magnitude]);
    const contribution = requireNonzeroArithmetic(sensitivity * standardUncertainty, 'Uncertainty contribution', [sensitivity, standardUncertainty]);
    return requireFiniteResults({ magnitude, distribution, sensitivity, standardUncertainty, contribution }, 'Uncertainty component result');
  });
  const combined = Math.hypot(...converted.map(({ contribution }) => contribution));
  const hasContribution = converted.some(({ contribution }) => contribution !== 0);
  requireFiniteResult(combined, 'Combined standard uncertainty', { nonZero: hasContribution });
  const expanded = requireNonzeroArithmetic(coverageFactor * combined, 'Expanded uncertainty', [coverageFactor, combined]);
  return requireFiniteResults({ components: converted, combined, coverageFactor, expanded }, 'Uncertainty-budget result');
}

function parseBoundedCsv(csv, { maxCharacters = 200000, maxRows = 5000 } = {}) {
  if (typeof csv !== 'string' || csv.length === 0) throw new RangeError('CSV text is required');
  if (csv.length > maxCharacters) throw new RangeError(`CSV is limited to ${maxCharacters.toLocaleString('en-GB')} characters`);
  const rows = []; let row = []; let cell = ''; let quoted = false; let afterClosingQuote = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') { quoted = false; afterClosingQuote = true; }
      else cell += character;
    } else if (afterClosingQuote && character !== ',' && character !== '\n' && character.charCodeAt(0) !== 13) {
      throw new RangeError(`Malformed CSV at character ${index + 1}: only a delimiter or line ending may follow a closing quote`);
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === '"') throw new RangeError(`Malformed CSV at character ${index + 1}: quote inside an unquoted field`);
    else if (character === ',') { row.push(cell); cell = ''; afterClosingQuote = false; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      row.push(cell); cell = ''; afterClosingQuote = false;
      rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw new RangeError(`CSV is limited to ${maxRows.toLocaleString('en-GB')} data rows`);
    } else cell += character;
  }
  if (quoted) throw new RangeError('Malformed CSV: unterminated quoted field');
  row.push(cell); if (row.some((value) => value !== '')) rows.push(row);
  if (rows.length < 2) throw new RangeError('CSV must contain a header and data rows');
  if (rows.length - 1 > maxRows) throw new RangeError(`CSV is limited to ${maxRows.toLocaleString('en-GB')} data rows`);
  const headers = rows[0].map((value) => value.trim());
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length) throw new RangeError('CSV headers must be non-empty and unique');
  for (let index = 1; index < rows.length; index += 1) if (rows[index].length !== headers.length) throw new RangeError(`Malformed CSV at row ${index + 1}: expected ${headers.length} columns`);
  return { headers, rows: rows.slice(1) };
}

export function calculateProcessCapabilityFromCsv({ csv, column, lsl, usl }) {
  requireFinite([lsl, usl]);
  if (usl <= lsl) throw new RangeError('USL must be greater than LSL');
  const parsed = parseBoundedCsv(csv);
  const columnIndex = parsed.headers.indexOf(column);
  if (columnIndex < 0) throw new RangeError(`Column "${column}" was not found`);
  const values = parsed.rows.map((row, index) => {
    const raw = row[columnIndex].trim(); const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) throw new RangeError(`Row ${index + 2} in ${column} must be a finite number`);
    return value;
  });
  if (values.length < 2) throw new RangeError('At least two observations are required');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sampleSd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  if (sampleSd === 0) throw new RangeError('Overall performance is undefined for zero variance');
  const pp = (usl - lsl) / (6 * sampleSd);
  const ppk = Math.min((usl - mean) / (3 * sampleSd), (mean - lsl) / (3 * sampleSd));
  const warnings = ['Pp/Ppk are overall-performance estimates using the overall sample standard deviation; they are not within-process capability indices. Normality and process stability are not tested.'];
  if (values.length < 30) warnings.push('Small sample: estimates are especially uncertain (n < 30).');
  if (values.some((value) => Math.abs(value - mean) > 3 * sampleSd)) warnings.push('Potential outlier beyond three sample standard deviations; investigate rather than deleting automatically.');
  return requireFiniteResults({ n: values.length, mean, sampleSd, pp, ppk, lsl, usl, minimum: Math.min(...values), maximum: Math.max(...values), metadata: { sigmaEstimate: 'overall sample standard deviation across all observations', interpretation: 'overall process performance, not within-process capability' }, warnings }, 'Process-performance result');
}

function safeCsvCell(value) {
  if (typeof value === 'number') requireFiniteResult(value, 'CSV calculated value');
  let text = String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function transformPointListCsv({ csv, rotationX, rotationY, rotationZ, translationX, translationY, translationZ, inverse = false, unit }) {
  requireFinite([rotationX, rotationY, rotationZ, translationX, translationY, translationZ]);
  if (typeof unit !== 'string' || !/^[A-Za-zµμ]{1,12}$/.test(unit)) throw new RangeError('Unit must be a short unit label');
  const parsed = parseBoundedCsv(csv);
  const find = (axis) => parsed.headers.findIndex((header) => header.toLowerCase() === axis || header.toLowerCase() === `${axis}_${unit.toLowerCase()}`);
  const indexes = { id: parsed.headers.findIndex((header) => header.toLowerCase() === 'id'), x: find('x'), y: find('y'), z: find('z') };
  if (Object.values(indexes).some((index) => index < 0)) throw new RangeError('CSV requires id, x, y and z columns (optionally unit-suffixed)');
  const radians = [rotationX, rotationY, rotationZ].map((angle) => angle * Math.PI / 180);
  const rotateX = ([x, y, z], angle) => [x, y * Math.cos(angle) - z * Math.sin(angle), y * Math.sin(angle) + z * Math.cos(angle)];
  const rotateY = ([x, y, z], angle) => [x * Math.cos(angle) + z * Math.sin(angle), y, -x * Math.sin(angle) + z * Math.cos(angle)];
  const rotateZ = ([x, y, z], angle) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
  const points = parsed.rows.map((row, rowIndex) => {
    const coordinateTexts = ['x', 'y', 'z'].map((axis) => row[indexes[axis]].trim());
    const coordinates = coordinateTexts.map(Number);
    if (coordinateTexts.some((value) => value === '') || coordinates.some((value) => !Number.isFinite(value))) throw new RangeError(`Row ${rowIndex + 2} coordinates must be finite numbers`);
    let result;
    if (inverse) {
      result = [coordinates[0] - translationX, coordinates[1] - translationY, coordinates[2] - translationZ];
      result = rotateZ(result, -radians[2]); result = rotateY(result, -radians[1]); result = rotateX(result, -radians[0]);
    } else {
      result = rotateX(coordinates, radians[0]); result = rotateY(result, radians[1]); result = rotateZ(result, radians[2]);
      result = [result[0] + translationX, result[1] + translationY, result[2] + translationZ];
    }
    return requireFiniteResults({ rawId: row[indexes.id], x: result[0], y: result[1], z: result[2] }, `Coordinate-transform result row ${rowIndex + 2}`);
  });
  const output = [`id,x_${unit},y_${unit},z_${unit}`, ...points.map((point) => [safeCsvCell(point.rawId), point.x, point.y, point.z].join(','))].join('\n') + '\n';
  return { points, csv: output, direction: inverse ? 'destination to source' : 'source to destination', order: inverse ? 'subtract translation, then inverse Z-Y-X rotations' : 'right-handed X-Y-Z rotations, then translation' };
}

export function generateInspectionReportFromCsv({ csv, mapping, unit }) {
  if (typeof unit !== 'string' || !/^[A-Za-zµμ]{1,12}$/.test(unit)) throw new RangeError('Unit must be a short unit label');
  const parsed = parseBoundedCsv(csv);
  const keys = ['id', 'nominal', 'measured', 'lowerTolerance', 'upperTolerance'];
  if (!mapping || keys.some((key) => typeof mapping[key] !== 'string')) throw new RangeError('A complete column mapping is required');
  const indexes = Object.fromEntries(keys.map((key) => [key, parsed.headers.indexOf(mapping[key])]));
  if (Object.values(indexes).some((index) => index < 0)) throw new RangeError('Every mapped column must exist in the CSV header');
  const rows = parsed.rows.map((source, rowIndex) => {
    const raw = Object.fromEntries(keys.map((key) => [key, source[indexes[key]]]));
    const numeric = {};
    for (const key of ['nominal', 'measured', 'lowerTolerance', 'upperTolerance']) {
      numeric[key] = Number(raw[key].trim());
      if (raw[key].trim() === '' || !Number.isFinite(numeric[key])) throw new RangeError(`Row ${rowIndex + 2} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()} must be a finite number`);
    }
    if (numeric.lowerTolerance > numeric.upperTolerance) throw new RangeError(`Row ${rowIndex + 2} lower tolerance must not exceed upper tolerance`);
    const lowerLimit = numeric.nominal + numeric.lowerTolerance;
    const upperLimit = numeric.nominal + numeric.upperTolerance;
    const deviation = numeric.measured - numeric.nominal;
    return requireFiniteResults({ id: raw.id, ...numeric, deviation, lowerLimit, upperLimit, status: numeric.measured >= lowerLimit && numeric.measured <= upperLimit ? 'within' : 'outside', raw }, `Inspection result row ${rowIndex + 2}`);
  });
  const headings = ['feature_raw', 'nominal_raw', 'measured_raw', 'lower_tolerance_raw', 'upper_tolerance_raw', `deviation_${unit}`, `lower_limit_${unit}`, `upper_limit_${unit}`, 'plain_limit_status'];
  const outputRows = rows.map((row) => [row.raw.id, row.raw.nominal, row.raw.measured, row.raw.lowerTolerance, row.raw.upperTolerance, row.deviation, row.lowerLimit, row.upperLimit, row.status].map(safeCsvCell).join(','));
  return { rows, csv: [headings.join(','), ...outputRows].join('\n') + '\n', rawInput: csv, unit, decisionRule: 'Plain inclusive comparison to nominal plus stated lower/upper tolerances; measurement uncertainty is not included.' };
}

export function calculateBoltCircle({ diameter, holes, startAngle, originX, originY, direction }) {
  requireFinite([diameter, holes, startAngle, originX, originY]);
  if (diameter <= 0) throw new RangeError('Diameter must be greater than zero');
  if (!Number.isInteger(holes) || holes < 2 || holes > 360) throw new RangeError('Holes must be a whole number from 2 to 360');
  if (!['cw', 'ccw'].includes(direction)) throw new RangeError('Direction must be cw or ccw');
  const radius = requireNonzeroArithmetic(diameter / 2, 'Bolt-circle radius', [diameter, 2]);
  const sign = direction === 'cw' ? -1 : 1;
  return requireFiniteResults(Array.from({ length: holes }, (_, index) => {
    const angle = startAngle + sign * index * 360 / holes;
    const radians = angle * Math.PI / 180;
    return { hole: index + 1, angle, x: originX + radius * Math.cos(radians), y: originY + radius * Math.sin(radians) };
  }), 'Bolt-circle result');
}

export function calculateThermalCorrection({ measuredLength, measuredTemp, referenceTemp, alpha, lengthUncertainty, tempUncertainty, alphaUncertainty }) {
  requireFinite([measuredLength, measuredTemp, referenceTemp, alpha, lengthUncertainty, tempUncertainty, alphaUncertainty]);
  if (measuredLength <= 0) throw new RangeError('Measured length must be greater than zero');
  if ([lengthUncertainty, tempUncertainty, alphaUncertainty].some((value) => value < 0)) throw new RangeError('Uncertainty inputs cannot be negative');
  const deltaTemperature = measuredTemp - referenceTemp;
  const referenceLength = measuredLength * (1 - alpha * deltaTemperature);
  const lengthSensitivity = 1 - alpha * deltaTemperature;
  const lengthContribution = requireNonzeroArithmetic(lengthSensitivity * lengthUncertainty, 'Thermal length-uncertainty contribution', [lengthSensitivity, lengthUncertainty]);
  const temperatureScale = requireNonzeroArithmetic(measuredLength * alpha, 'Thermal temperature-uncertainty scale', [measuredLength, alpha]);
  const temperatureContribution = requireNonzeroArithmetic(temperatureScale * tempUncertainty, 'Thermal temperature-uncertainty contribution', [temperatureScale, tempUncertainty]);
  const alphaScale = requireNonzeroArithmetic(measuredLength * deltaTemperature, 'Thermal expansion-uncertainty scale', [measuredLength, deltaTemperature]);
  const alphaContribution = requireNonzeroArithmetic(alphaScale * alphaUncertainty, 'Thermal expansion-uncertainty contribution', [alphaScale, alphaUncertainty]);
  const contributions = [lengthContribution, temperatureContribution, alphaContribution];
  const combinedUncertainty = Math.hypot(...contributions);
  requireFiniteResult(combinedUncertainty, 'Thermal combined uncertainty', { nonZero: contributions.some((value) => value !== 0) });
  return requireFiniteResults({ referenceLength, correction: referenceLength - measuredLength, combinedUncertainty, deltaTemperature }, 'Thermal-correction result');
}

export function calculateOee({ plannedTime, runTime, idealCycleTime, totalCount, goodCount }) {
  requireFinite([plannedTime, runTime, idealCycleTime, totalCount, goodCount]);
  if (plannedTime <= 0) throw new RangeError('Planned time must be greater than zero');
  if (runTime <= 0) throw new RangeError('Run time must be greater than zero');
  if (idealCycleTime <= 0) throw new RangeError('Ideal cycle time must be greater than zero');
  if (!Number.isInteger(totalCount) || totalCount <= 0) throw new RangeError('Total count must be a positive whole number');
  if (!Number.isInteger(goodCount) || goodCount < 0 || goodCount > totalCount) throw new RangeError('Good count must be from zero to total count');
  const availability = requireNonzeroArithmetic(runTime / plannedTime, 'OEE availability rate', [runTime, plannedTime]);
  const idealProductionTime = requireNonzeroArithmetic(idealCycleTime * totalCount, 'OEE ideal production time', [idealCycleTime, totalCount]);
  const performance = requireNonzeroArithmetic(idealProductionTime / runTime, 'OEE performance rate', [idealProductionTime, runTime]);
  const quality = requireNonzeroArithmetic(goodCount / totalCount, 'OEE quality rate', [goodCount, totalCount]);
  const availabilityPerformance = requireNonzeroArithmetic(availability * performance, 'OEE availability/performance product', [availability, performance]);
  const oee = requireNonzeroArithmetic(availabilityPerformance * quality, 'OEE combined rate', [availabilityPerformance, quality]);
  const warnings = [];
  if (runTime > plannedTime) warnings.push('Run time exceeds planned time; check the time basis.');
  if (performance > 1) warnings.push('Performance is over 100%; check ideal cycle time, counts and units.');
  return requireFiniteResults({
    availability, performance, quality, oee,
    losses: { downtime: plannedTime - runTime, speedTime: runTime - idealProductionTime, rejectCount: totalCount - goodCount },
    warnings,
  }, 'OEE result');
}

export function calculateTaktCapacity({ shiftMinutes, breakMinutes, demand, cycleMinutes, parallelStations }) {
  requireFinite([shiftMinutes, breakMinutes, demand, cycleMinutes, parallelStations]);
  if (shiftMinutes <= 0) throw new RangeError('Shift time must be greater than zero');
  if (breakMinutes < 0) throw new RangeError('Break time cannot be negative');
  const availableMinutes = shiftMinutes - breakMinutes;
  if (availableMinutes <= 0) throw new RangeError('Available production time must be greater than zero');
  if (demand <= 0) throw new RangeError('Demand must be greater than zero');
  if (cycleMinutes <= 0) throw new RangeError('Cycle time must be greater than zero');
  if (!Number.isInteger(parallelStations) || parallelStations <= 0) throw new RangeError('Parallel stations must be a positive whole number');
  const taktMinutes = availableMinutes / demand;
  return requireFiniteResults({
    availableMinutes,
    taktMinutes,
    capacity: Math.floor(availableMinutes * parallelStations / cycleMinutes),
    requiredStations: Math.ceil(cycleMinutes / taktMinutes),
    load: cycleMinutes / (taktMinutes * parallelStations),
  }, 'Takt/capacity result');
}

export function calculateSineBar({ centreDistance, angleDegrees, stackHeight, centreUncertainty, heightUncertainty }) {
  requireFinite([centreDistance, angleDegrees, stackHeight, centreUncertainty, heightUncertainty]);
  if (centreDistance <= 0) throw new RangeError('Centre distance must be greater than zero');
  if (angleDegrees < 0 || angleDegrees >= 90) throw new RangeError('Angle must be from 0 up to, but not including, 90 degrees');
  if (stackHeight < 0 || stackHeight >= centreDistance) throw new RangeError('Stack height must be from zero to less than the centre distance');
  if (centreUncertainty < 0 || heightUncertainty < 0) throw new RangeError('Uncertainty inputs cannot be negative');
  const angleRadians = angleDegrees * Math.PI / 180;
  const requiredHeight = centreDistance * Math.sin(angleRadians);
  const inferredRadians = Math.asin(stackHeight / centreDistance);
  const cosine = Math.cos(inferredRadians);
  const heightDenominator = requireNonzeroArithmetic(centreDistance * cosine, 'Sine-bar height-sensitivity denominator', [centreDistance, cosine]);
  const heightContribution = requireNonzeroArithmetic(heightUncertainty / heightDenominator, 'Sine-bar height-uncertainty contribution', [heightUncertainty, heightDenominator]);
  const centreSquared = requireNonzeroArithmetic(centreDistance ** 2, 'Sine-bar centre-distance square', [centreDistance]);
  const centreDenominator = requireNonzeroArithmetic(centreSquared * cosine, 'Sine-bar centre-sensitivity denominator', [centreSquared, cosine]);
  const centreNumerator = requireNonzeroArithmetic(stackHeight * centreUncertainty, 'Sine-bar centre-uncertainty numerator', [stackHeight, centreUncertainty]);
  const centreContribution = requireNonzeroArithmetic(centreNumerator / centreDenominator, 'Sine-bar centre-uncertainty contribution', [centreNumerator, centreDenominator]);
  const angleUncertaintyRadians = Math.hypot(heightContribution, centreContribution);
  requireFiniteResult(angleUncertaintyRadians, 'Sine-bar angle uncertainty', { nonZero: heightContribution !== 0 || centreContribution !== 0 });
  const angleUncertaintyDegrees = requireNonzeroArithmetic(angleUncertaintyRadians * 180 / Math.PI, 'Sine-bar angle uncertainty in degrees', [angleUncertaintyRadians]);
  return requireFiniteResults({
    requiredHeight,
    inferredAngleDegrees: inferredRadians * 180 / Math.PI,
    angleUncertaintyDegrees,
  }, 'Sine-bar result');
}

export const NATIVE_TOOL_DEFINITIONS = {
  'gcode-preflight': {
    formula: 'Bounded XY modal preview: G0/G1 endpoints and G2/G3 G17 arcs with I/J centre offsets; G20/G21 set units and G90/G91 set absolute/incremental distance mode.',
    assumptions: ['The program explicitly sets units and distance mode before its first motion.', 'Initial preview position is X0 Y0; only the documented XY subset is interpreted.', 'Arc I/J values are incremental offsets from the arc start in the G17 XY plane.'],
    limitations: ['Limited to 200,000 characters, 5,000 lines and 5,000 motion segments; changing units after motion stops analysis.', 'Macros, variables, canned cycles, subroutines, compensation, Z/rotary axes, other planes and unsupported words stop analysis visibly.', 'Preview is not collision proof, machine compatibility, safe execution or a connection to machinery.'],
    clearFields: ['gcode'],
    fields: [['gcode','G-code program — documented bounded XY subset','G21\nG90\nG0 X0 Y0\nG1 X10 Y-2 F100\nG1 X5 Y7',{type:'textarea',rows:16,maxLength:200000}]],
    run(values) {
      const r=parseGcodePreflight(values.gcode); const shown=r.segments.slice(0,200);
      return { lines:[['Supported dialect',r.dialect],['Units',r.units||'Not selected'],['Distance mode',r.distanceMode||'Not selected'],['Motion segments',String(r.segments.length)],[`X extent (${r.units||'unit not selected'})`,`${format(r.extents.xMin)} to ${format(r.extents.xMax)}`],[`Y extent (${r.units||'unit not selected'})`,`${format(r.extents.yMin)} to ${format(r.extents.yMax)}`]], headings:['Source line','Motion','From X,Y','To X,Y','Feed'], rows:shown.map((segment)=>[segment.line,segment.motion,`${format(segment.from.x)}, ${format(segment.from.y)}`,`${format(segment.to.x)}, ${format(segment.to.y)}`,segment.feed===null?'Rapid / modal machine value not interpreted':format(segment.feed)]), warnings:[...r.warnings,...(r.segments.length>shown.length?[`Preview table shows the first ${shown.length} of ${r.segments.length} segments.`]:[])] };
    },
  },
  'step-part21-inspector': {
    formula: 'Bounded ISO 10303-21 text diagnostics: read FILE_SCHEMA/FILE_NAME strings, count simple #id=ENTITY(...) assignments, and list explicit SI_UNIT or conversion-based unit declarations.',
    assumptions: ['Input is a text STEP Part 21 exchange structure with HEADER before DATA.', 'Entity counts are lexical diagnostics, not proof that references, geometry or schema constraints are valid.', 'Author and organisation fields may be sensitive and remain only in this browser tab.'],
    limitations: ['Limited to 500,000 characters, 20,000 simple entity assignments and 64 parenthesis levels.', 'Complex entity instances are rejected; full schema validation is not implemented.', 'This is not full STEP conformance, geometry/topology/PMI validation or NIST analyser equivalence.'],
    clearFields: ['step'],
    fields: [['step','STEP Part 21 text',"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('demo'),'2;1');\nFILE_NAME('demo.step','2026-09-10T00:00:00',('Example Author'),('Example Organisation'),'','','');\nFILE_SCHEMA(('AP242'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=SI_UNIT(.MILLI.,.METRE.);\nENDSEC;\nEND-ISO-10303-21;",{type:'textarea',rows:18,maxLength:500000}]],
    run(values) {
      const r=inspectStepPart21(values.step); const rows=Object.entries(r.entityCounts).sort(([a],[b])=>a.localeCompare(b));
      return { lines:[['Schemas',r.schemas.join(', ')],['Entity assignments',String(r.totalEntities)],['File name',r.provenance.name||'Not declared'],['Timestamp',r.provenance.timestamp||'Not declared'],['Authors',r.provenance.authors.join(', ')||'Not declared'],['Organisations',r.provenance.organisations.join(', ')||'Not declared'],['Declared unit entities',r.declaredUnits.join(', ')||'None detected']], headings:['Entity type','Count'], rows:rows.map(([name,count])=>[name,count]), warnings:r.limitations };
    },
  },
  'spur-gear-geometry': {
    formula: 'Standard full-depth unshifted external spur gears: d = m·z; da = m(z+2); df = m(z−2.5); db = d·cos α; centre distance a = m(z₁+z₂)/2; circular pitch p = πm.',
    assumptions: ['Standard unshifted external spur gears with common module and declared pressure angle.', 'Full-depth proportions use addendum = m and dedendum = 1.25m.', 'Entered module and every displayed diameter/centre distance use the selected unit.'],
    limitations: ['No helical geometry, profile shift, internal gearing, backlash or manufacturing tolerance.', 'Geometry is not tooth-strength, interference, wear, noise, lubrication or load-capacity validation.'],
    fields: [['unit','Module and length unit','mm',[['mm','millimetres'],['in','inches']]],["module",'Module m',2,'any'],['teeth1','Gear 1 teeth z₁',20,'1'],['teeth2','Gear 2 teeth z₂',40,'1'],['pressureAngleDeg','Pressure angle α (degrees)',20,'any']],
    run(values) {
      const r=calculateSpurGear(numberValues(values,['module','teeth1','teeth2','pressureAngleDeg']));
      return { lines:[[`Centre distance (${values.unit})`,format(r.centreDistance)],[`Circular pitch (${values.unit})`,format(r.circularPitch)],[`Standard tooth thickness at pitch circle (${values.unit})`,format(r.standardToothThickness)]], headings:['Gear','Teeth',`Pitch diameter (${values.unit})`,`Outside diameter (${values.unit})`,`Root diameter (${values.unit})`,`Base diameter (${values.unit})`], rows:[[1,r.gear1.teeth,format(r.gear1.pitchDiameter),format(r.gear1.outsideDiameter),format(r.gear1.rootDiameter),format(r.gear1.baseDiameter)],[2,r.gear2.teeth,format(r.gear2.pitchDiameter),format(r.gear2.outsideDiameter),format(r.gear2.rootDiameter),format(r.gear2.baseDiameter)]], warnings:r.warnings };
    },
  },
  'beam-deflection': {
    formula: 'Centre point load, simply supported: δmax = PL³/(48EI), Mmax = PL/4. End point load, cantilever: δmax = PL³/(3EI), Mmax = PL.',
    assumptions: ['Boundary cases: simply supported ▲────↓────▲; cantilever ╞────────↓ (load at free end).', 'Euler–Bernoulli small-deflection linear elastic behaviour with constant user-supplied E and I.', 'SI inputs are P in N, L in m, E in Pa and I in m⁴; outputs are m, N·m and N·m².'],
    limitations: ['Ideal static point loads/supports only; shear deformation, self-weight, stress concentrations, buckling and connection flexibility are excluded.', 'Educational preliminary comparison only; not for lifting, safety-critical approval or structural sign-off.'],
    fields: [['loadN','Point load P (N)',1000,'any'],['lengthM','Beam length L (m)',1,'any'],['elasticModulusPa','Elastic modulus E (Pa)',200000000000,'any'],['secondMomentM4','Second moment of area I (m⁴)',0.00000001,'any']],
    run(values) {
      const r=calculateBeamDeflection(numberValues(values,['loadN','lengthM','elasticModulusPa','secondMomentM4']));
      return { lines:[['Flexural rigidity EI (N·m²)',format(r.flexuralRigidityNm2)],['Simply supported centre-load max deflection (m)',format(r.simplySupportedCentre.deflectionM)],['Simply supported max moment (N·m)',format(r.simplySupportedCentre.maximumMomentNm)],['Cantilever end-load max deflection (m)',format(r.cantileverEnd.deflectionM)],['Cantilever max moment (N·m)',format(r.cantileverEnd.maximumMomentNm)],['Cantilever / simply-supported deflection ratio',format(r.cantileverEnd.deflectionM/r.simplySupportedCentre.deflectionM)]], warnings:r.warnings };
    },
  },
  'guard-band-decision-rule': {
    formula: 'Plain acceptance uses LSL ≤ measured ≤ USL. Guarded acceptance uses LSL + guard ≤ measured ≤ USL − guard; all boundaries are inclusive.',
    assumptions: ['The user explicitly selects the applicable decision rule; the worksheet does not choose one.', 'Limits, measured value and guard use the same selected unit.', 'The guard is a user-supplied absolute amount, not an uncertainty value calculated by this worksheet.'],
    limitations: ['This comparison does not establish contractual agreement, ILAC compliance or measurement traceability.', 'No uncertainty distribution, false-accept/false-reject probability, rounding rule or certificate is calculated.'],
    fields: [
      ['unit','Measurement unit','mm',{type:'text',maxLength:12}],['lsl','Lower specification limit',9.5,'any'],['usl','Upper specification limit',10.5,'any'],
      ['measured','Measured value',10.42,'any'],['guard','Guard amount',0.1,'any'],
      ['rule','Decision rule','guarded-acceptance',[['plain-tolerance','Plain tolerance'],['guarded-acceptance','Guarded acceptance']]],
    ],
    run(values) {
      const r=evaluateGuardBandDecision({...numberValues(values,['lsl','usl','measured','guard']),rule:values.rule});
      return { lines:[['Selected rule',r.rule],[`Tolerance interval (${values.unit})`,`${format(values.lsl)} to ${format(values.usl)}`],[`Acceptance lower limit (${values.unit})`,format(r.acceptanceLower)],[`Acceptance upper limit (${values.unit})`,format(r.acceptanceUpper)],['Decision',r.status],['Inside tolerance',r.insideTolerance?'Yes':'No'],['Inside acceptance region',r.insideAcceptance?'Yes':'No']], warnings:r.warnings };
    },
  },
  'spc-imr-chart': {
    formula: 'Individuals centre = mean; estimated σ = MR̄ ÷ d₂ with moving ranges of 2 and d₂ = 1.128; I limits = mean ± 3σ; MR limits use D₃ = 0 and D₄ = 3.267.',
    assumptions: ['CSV rows remain in file/input order. A unique header and named measurement column are used; a headerless single numeric column is also accepted.', 'Only the stated Individuals and moving-range-of-two method is applied.', 'Chart x-axis positions are one-based observation numbers; signal-table indexes remain zero-based as labelled.'],
    limitations: ['Local CSV is bounded to 10,000 data rows and 200,000 characters; browser calculation uses a local module worker where supported and a bounded same-thread fallback otherwise.', 'Only beyond-limit signals are flagged; no run, trend, subgroup or automatic disposition rules are applied.', 'Control limits describe process behaviour and are not specification limits.'],
    fields: [
      ['unit','Measurement unit','mm',{type:'text',maxLength:12}],
      ['column','Measurement column header','value',{type:'text',maxLength:80}],
      ['csv','Time-ordered CSV (named header, or one numeric value per row)','value\n10\n11\n9\n10',{type:'textarea',rows:12,maxLength:200000}],
      ['csvFile','Optional local CSV file (replaces text above)','',{type:'file',accept:'.csv,text/csv',required:false}],
    ],
    run(values) {
      const legacyObservations = values.csv === undefined ? values.observations : undefined;
      const parsed = values.parsedObservations || parseSpcObservationsCsv({ csv: values.csv ?? legacyObservations, column: values.column });
      const observations = parsed.values;
      const r=calculateImrChart(observations);
      const individualSignals=r.signals.filter((signal)=>signal.chart==='individual');
      const movingRangeSignals=r.signals.filter((signal)=>signal.chart==='moving-range');
      const referenceLines=(limits)=>[
        {label:'UCL',value:limits.upper,className:'limit'},
        {label:'Centre',value:limits.centre,className:'centre'},
        {label:'LCL',value:limits.lower,className:'limit'},
      ];
      const charts=[
        {
          title:'Individuals chart',
          summary:`${observations.length} observations in time order; ${individualSignals.length} beyond-limit signal${individualSignals.length===1?'':'s'}.`,
          xLabel:'Observation number',yLabel:`Individual value (${values.unit})`,
          series:[
            {label:'Observations',kind:'line-points',className:'observations',points:observations.map((y,index)=>({x:index+1,y}))},
            {label:'Beyond-limit signals',kind:'points',className:'signal',points:individualSignals.map((signal)=>({x:signal.index+1,y:signal.value,label:signal.rule}))},
          ],
          referenceLines:referenceLines(r.individualLimits),
        },
        {
          title:'Moving-range chart',
          summary:`${r.movingRanges.length} moving ranges of two; ${movingRangeSignals.length} beyond-limit signal${movingRangeSignals.length===1?'':'s'}.`,
          xLabel:'Observation number',yLabel:`Moving range (${values.unit})`,
          series:[
            {label:'Moving ranges',kind:'line-points',className:'observations',points:r.movingRanges.map((y,index)=>({x:index+2,y}))},
            {label:'Beyond-limit signals',kind:'points',className:'signal',points:movingRangeSignals.map((signal)=>({x:signal.index+1,y:signal.value,label:signal.rule}))},
          ],
          referenceLines:referenceLines(r.movingRangeLimits),
        },
      ];
      return { lines:[['CSV handling',parsed.headerMode==='named-header'?`Named column: ${parsed.column}`:'Headerless single numeric column'],['Observations',String(observations.length)],[`Individuals centre (${values.unit})`,format(r.mean)],[`Estimated sigma (${values.unit})`,format(r.estimatedSigma)],[`Individuals LCL (${values.unit})`,format(r.individualLimits.lower)],[`Individuals UCL (${values.unit})`,format(r.individualLimits.upper)],[`MR centre (${values.unit})`,format(r.mrBar)],[`MR UCL (${values.unit})`,format(r.movingRangeLimits.upper)],['Beyond-limit signals',String(r.signals.length)]], headings:['Chart','Zero-based observation index','Value','Rule'], rows:r.signals.map((signal)=>[signal.chart,signal.index,format(signal.value),signal.rule]), charts, warnings:r.warnings };
    },
  },
  'gauge-rr-anova': {
    formula: 'Balanced crossed random-effects two-way ANOVA with part × operator interaction; negative estimated variance components are truncated to zero.',
    assumptions: ['Rows are pseudonymous part ID, pseudonymous operator ID, repeat ID and measured value.', 'Every part/operator cell contains each repeat exactly once; at least two levels of each factor are required.', 'The measurement unit and study conditions are common across all rows.'],
    limitations: ['Only a complete balanced crossed design is accepted; no values are imputed and no other Gauge R&R model is substituted.', 'Input is bounded to 100 rows and 12,000 characters in this interface.', 'Results do not certify the measurement system and must not be used to rank staff.'],
    fields: [
      ['unit','Measurement unit','mm',{type:'text',maxLength:12}],
      ['measurements','Measurements — part, operator, repeat, value','P1,O1,1,1\nP1,O1,2,3\nP1,O2,1,3\nP1,O2,2,5\nP2,O1,1,5\nP2,O1,2,7\nP2,O2,1,11\nP2,O2,2,13',{type:'textarea',rows:12,maxLength:12000}],
    ],
    run(values) {
      const measurements=parseStructuredLines(values.measurements,['part','operator','repeat','value'],'measurement').map((row)=>({...row,value:Number(row.value)}));
      const r=calculateGaugeRrAnova(measurements); const v=r.varianceComponents;
      return { lines:[['Design',`${r.design.parts} parts × ${r.design.operators} operators × ${r.design.repeats} repeats`],['Observations',String(r.design.observations)],[`Grand mean (${values.unit})`,format(r.grandMean)],[`Gauge R&R variance (${values.unit}²)`,format(v.gaugeRr)],[`Gauge R&R standard deviation (${values.unit})`,format(r.standardDeviations.gaugeRr)],[`Part-to-part variance (${values.unit}²)`,format(v.partToPart)]], headings:['ANOVA source','SS','df','MS'], rows:Object.entries(r.anova).map(([name,term])=>[name,format(term.ss),term.df,format(term.ms)]), warnings:r.warnings };
    },
  },
  'calibration-curve': {
    formula: 'Unweighted ordinary least squares fits response = intercept + slope × reference; residual = observed response − fitted response.',
    assumptions: ['Rows are reference value, response value and use the selected common unit labels.', 'All points receive equal weight; reference-axis uncertainty is not modelled.', 'Prediction is response at the entered reference value.'],
    limitations: ['Input is bounded to 100 pairs and 12,000 characters in this interface.', 'Extrapolation is blocked unless explicitly enabled and remains potentially unreliable.', 'A fitted line alone does not establish traceability, uncertainty, instrument suitability or calibration validity.'],
    fields: [
      ['referenceUnit','Reference unit','mm',{type:'text',maxLength:12}],['responseUnit','Response unit','V',{type:'text',maxLength:12}],
      ['predictAt','Predict at reference value',1.5,'any'],['allowExtrapolation','Extrapolation','false',[['false','Block outside input range'],['true','Explicitly allow']]],
      ['pairs','Calibration pairs — reference, response','0,1\n1,3\n2,5',{type:'textarea',rows:10,maxLength:12000}],
    ],
    run(values) {
      const pairs=parseStructuredLines(values.pairs,['reference','response'],'calibration pair').map((row)=>[Number(row.reference),Number(row.response)]);
      const r=fitLinearCalibration({reference:pairs.map((row)=>row[0]),response:pairs.map((row)=>row[1]),predictAt:Number(values.predictAt),allowExtrapolation:values.allowExtrapolation==='true'});
      const fittedPoints=pairs.map((pair,index)=>({x:pair[0],y:r.fitted[index]})).sort((a,b)=>a.x-b.x);
      const charts=[
        {
          title:'Calibration fit',
          summary:`${pairs.length} calibration points; fitted response = ${format(r.intercept)} + ${format(r.slope)} × reference. Calibrated reference range ${format(r.referenceRange[0])} to ${format(r.referenceRange[1])} ${values.referenceUnit}.`,
          xLabel:`Reference (${values.referenceUnit})`,yLabel:`Response (${values.responseUnit})`,
          series:[
            {label:'Calibration points',kind:'points',className:'observations',points:pairs.map(([x,y])=>({x,y}))},
            {label:'Fitted line',kind:'line',className:'fit',points:fittedPoints},
          ],referenceLines:[],
        },
        {
          title:'Calibration residuals',
          summary:`Residuals are observed minus fitted response for ${pairs.length} points; residual standard deviation is ${r.residualStandardDeviation===null?'not available with two pairs':`${format(r.residualStandardDeviation)} ${values.responseUnit}`}.`,
          xLabel:`Reference (${values.referenceUnit})`,yLabel:`Residual (${values.responseUnit})`,
          series:[{label:'Residuals',kind:'points',className:'residuals',points:pairs.map((pair,index)=>({x:pair[0],y:r.residuals[index]}))}],
          referenceLines:[{label:'Zero residual',value:0,className:'centre'}],
        },
      ];
      return { lines:[['Model',r.metadata.method],['Intercept',format(r.intercept)],['Slope',format(r.slope)],['R-squared',r.rSquared===null?'Undefined':format(r.rSquared)],[`Residual standard deviation (${values.responseUnit})`,r.residualStandardDeviation===null?'Not available with two pairs':format(r.residualStandardDeviation)],[`Predicted response (${values.responseUnit})`,format(r.prediction.response)],['Prediction within input range',r.prediction.withinRange?'Yes':'No']], headings:[`Reference (${values.referenceUnit})`,`Observed response (${values.responseUnit})`,`Fitted response (${values.responseUnit})`,`Residual (${values.responseUnit})`], rows:pairs.map((pair,index)=>[format(pair[0]),format(pair[1]),format(r.fitted[index]),format(r.residuals[index])]), charts, warnings:r.warnings };
    },
  },
  'calibration-interval-review': {
    formula: 'Approved due date = last calibration date + the user-approved interval in UTC calendar days; history is summarised without prescribing or approving an interval.',
    assumptions: ['Dates use YYYY-MM-DD and elapsed time uses UTC calendar days.', 'History rows are date, outcome and optional absolute/signed drift; outcomes are pass, fail or adjusted.', 'The entered interval is already user-approved and is not generated by this worksheet.'],
    limitations: ['History is bounded to 1,000 rows and 120,000 characters; identifiers and rationale are not stored or exported here.', 'The worksheet does not approve, extend or prescribe an interval, provide reminders or imply regulatory approval.', 'The asset owner must record the final decision and rationale in the controlled asset record.'],
    fields: [
      ['lastCalibrationDate','Last calibration date (YYYY-MM-DD)','2024-01-31',{type:'text',maxLength:10}],['approvedIntervalDays','User-approved interval (days)',30,'1'],['reviewDate','Review date (YYYY-MM-DD)','2024-02-29',{type:'text',maxLength:10}],
      ['history','History — date, outcome, optional drift','2024-02-07,pass,0.01\n2024-02-21,fail,-0.03\n2024-02-28,adjusted,0.005',{type:'textarea',rows:10,maxLength:120000}],
    ],
    run(values) {
      const history=parseOptionalStructuredLines(values.history,['date','outcome','drift'],'history record',1000).map((row)=>({date:row.date,outcome:row.outcome.trim().toLowerCase(),...(row.drift.trim()===''?{}:{drift:Number(row.drift)})}));
      const r=reviewCalibrationInterval({lastCalibrationDate:values.lastCalibrationDate.trim(),approvedIntervalDays:Number(values.approvedIntervalDays),reviewDate:values.reviewDate.trim(),history}); const h=r.historySummary;
      return { lines:[['Status',r.status],['User-approved due date',r.approvedDueDate],['Elapsed days',format(r.elapsedDays)],['Days until due',format(r.daysUntilDue)],['History records',String(h.records)],['Pass / fail / adjusted',`${h.pass} / ${h.fail} / ${h.adjusted}`],['Maximum absolute drift',h.maximumAbsoluteDrift===null?'Not supplied':format(h.maximumAbsoluteDrift)],['Owner decision required',r.ownerDecisionRequired?'Yes':'No']], warnings:r.warnings };
    },
  },
  'acceptance-sampling-oc': {
    formula: 'Binomial approximation: Pa(p) = Σ from k = 0 to c of C(n,k)·pᵏ·(1−p)ⁿ⁻ᵏ; producer risk α = 1−Pa(AQL); consumer risk β = Pa(LQ).',
    assumptions: ['The plan uses independent Bernoulli trials and an effectively infinite lot.', 'Defect probabilities are decimal values with 0 ≤ AQL < LQ ≤ 1; acceptance number c is from 0 to sample size n.', 'AQL and LQ / LTPD are separately identified quality points; the selected p is only a general OC-curve point.'],
    limitations: ['No finite-lot correction or licensed standard sampling table is included.', 'The OC preview is bounded to 1,001 probability points and 20,000 input characters.', 'This is educational planning output; the customer contract determines the accepted plan and lot disposition.'],
    fields: [
      ['sampleSize','Sample size n',10,'1'],['acceptanceNumber','Acceptance number c',1,'1'],['defectProbability','Selected defect probability p',0.05,'any'],['aql','AQL defect probability',0.01,'any'],['lq','LQ / LTPD defect probability',0.1,'any'],
      ['curveProbabilities','OC curve probabilities — one per line','0\n0.02\n0.05\n0.1\n0.2\n0.5\n1',{type:'textarea',rows:10,maxLength:20000}],
    ],
    run(values) {
      const probabilities=parseFiniteLines(values.curveProbabilities,'curve probability',1001,20000);
      const r=calculateAcceptanceSamplingOc({sampleSize:Number(values.sampleSize),acceptanceNumber:Number(values.acceptanceNumber),defectProbability:Number(values.defectProbability),aql:Number(values.aql),lq:Number(values.lq),curveProbabilities:probabilities});
      const charts=[{
        title:'Operating characteristic curve',
        summary:`Acceptance probability versus defect probability for n = ${r.sampleSize}, c = ${r.acceptanceNumber}. Producer risk at AQL is ${percent(r.producerRiskAlpha)}; consumer risk at LQ is ${percent(r.consumerRiskBeta)}.`,
        xLabel:'Defect probability',yLabel:'Acceptance probability',xDomain:[0,1],yDomain:[0,1],
        series:[
          {label:'OC curve',kind:'line-points',className:'oc-curve',points:r.ocCurve.map((point)=>({x:point.defectProbability,y:point.acceptanceProbability}))},
          {label:'AQL',kind:'points',className:'aql',points:[{x:r.qualityPoints.aql,y:1-r.producerRiskAlpha,label:`AQL; producer risk ${percent(r.producerRiskAlpha)}`}]},
          {label:'LQ / LTPD',kind:'points',className:'lq',points:[{x:r.qualityPoints.lq,y:r.consumerRiskBeta,label:`LQ / LTPD; consumer risk ${percent(r.consumerRiskBeta)}`}]},
        ],referenceLines:[],
      }];
      return { lines:[['Sample plan',`n = ${r.sampleSize}, c = ${r.acceptanceNumber}`],['Selected defect probability',percent(r.defectProbability)],['Acceptance probability at selected p',percent(r.acceptanceProbability)],['AQL',percent(r.qualityPoints.aql)],['Producer risk α = 1 − Pa(AQL)',percent(r.producerRiskAlpha)],['LQ / LTPD',percent(r.qualityPoints.lq)],['Consumer risk β = Pa(LQ)',percent(r.consumerRiskBeta)]], headings:['Defect probability','Acceptance probability'], rows:r.ocCurve.map((point)=>[percent(point.defectProbability),percent(point.acceptanceProbability)]), charts, warnings:r.warnings };
    },
  },
  'machining-feeds-speeds': {
    formula: 'RPM = K·surface speed ÷ (π·diameter); feed rate = RPM·teeth·feed per tooth; ideal cut time = cut length ÷ feed rate, where K = 1000 metric or 12 imperial.',
    assumptions: ['Metric inputs use m/min, mm and mm/tooth; imperial inputs use ft/min, inches and in/tooth.', 'Feed per tooth is constant and every tooth cuts equally.', 'Cut length excludes approach, acceleration, tool changes and non-cutting motion.'],
    limitations: ['Starting values only: confirm tool, workpiece, rigidity, power and manufacturer guidance.', 'The worksheet does not calculate chip thinning, torque, power, wear, deflection or safe machine limits.'],
    fields: [
      ['mode','Unit system','metric',[['metric','Metric (m/min, mm)'],['imperial','Imperial (ft/min, in)']]],
      ['surfaceSpeed','Surface speed (m/min or ft/min)',100,'any'],['diameter','Tool diameter (mm or in)',10,'any'],['teeth','Cutting teeth/flutes',4,'1'],
      ['feedPerTooth','Feed per tooth (mm/tooth or in/tooth)',0.05,'any'],['cutLength','Cut length (mm or in)',100,'any'],
    ],
    run(values) {
      const r=calculateMachining({mode:values.mode,...numberValues(values,['surfaceSpeed','diameter','teeth','feedPerTooth','cutLength'])});
      const lengthUnit=values.mode==='metric'?'mm':'in';
      return { lines:[['Spindle speed (RPM)',format(r.rpm)],[`Feed rate (${lengthUnit}/min)`,format(r.feedRate)],['Ideal cutting time (min)',format(r.idealCutMinutes)],['Ideal cutting time (s)',format(r.idealCutMinutes*60)]], warnings:['Verify the calculated speed and feed against tool, material and machine limits before use.'] };
    },
  },
  'gauge-block-stack': {
    formula: 'Choose a subset of the entered inventory that minimises |target − stack sum|; exact base-10 integers are used, then fewer blocks break equal-error ties.',
    assumptions: ['Target and inventory use one common unit selected below.', 'Each listed block is a distinct available block and may be selected at most once.', 'Decimal values are positive and have no more than six places.'],
    limitations: ['Search is bounded to 60 inventory entries, six selected blocks and 250,000 candidate combinations.', 'The result does not account for wear, wringing film, thermal correction, calibration uncertainty or stack stability.'],
    fields: [
      ['target','Target stack size','3.05',{type:'text',maxLength:32}],['unit','Length unit','mm',[['mm','millimetres'],['in','inches']]],['maxBlocks','Maximum blocks',4,'1'],
      ['inventory','Available blocks — one decimal per line','1.0\n1.01\n1.02\n1.03\n1.04\n1.05\n1.1\n2.0',{type:'textarea',rows:10,maxLength:4000}],
    ],
    run(values) {
      const inventory=parseListLines(values.inventory,'inventory');
      const r=selectGaugeBlockStack({target:values.target.trim(),inventory,maxBlocks:Number(values.maxBlocks)});
      return { lines:[[`Selected stack (${values.unit})`,r.blocks.join(' + ')],[`Stack sum (${values.unit})`,r.sum],[`Target minus stack (${values.unit})`,r.residual],['Blocks used',String(r.blocks.length)],['Combinations examined',format(r.combinations)]], warnings:r.residual==='0'||/^0\.0*$/.test(r.residual)?[]:['No exact stack was found within the selected block-count limit; review the residual.'] };
    },
  },
  'tolerance-chain': {
    formula: 'Nominal = Σ(sign·nominal); worst-case limits sum each signed component endpoint; labelled symmetric RSS estimate = √Σ[max(|minus|,|plus|)²].',
    assumptions: ['Each row is nominal, minus deviation, plus deviation, sign; sign is +1 or -1.', 'All dimensions and deviations use the selected common unit.', 'Worst-case endpoints are arithmetic limits; RSS is a separately labelled statistical estimate.'],
    limitations: ['RSS assumes independent, centred contributors and uses a symmetric envelope; it is not a guaranteed tolerance.', 'No geometric effects, correlations, datum shifts, distribution validation or process capability are modelled.'],
    fields: [
      ['unit','Length unit','mm',[['mm','millimetres'],['in','inches']]],
      ['components','Components — nominal, minus, plus, sign','10,-0.1,0.1,1\n4,-0.05,0.05,-1',{type:'textarea',rows:7,maxLength:12000}],
    ],
    run(values) {
      const components=parseStructuredLines(values.components,['nominal','minus','plus','sign'],'component').map((row)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)])));
      const r=calculateToleranceChain(components);
      return { lines:[[`Nominal result (${values.unit})`,format(r.nominal)],[`Worst-case minimum (${values.unit})`,format(r.minimum)],[`Worst-case maximum (${values.unit})`,format(r.maximum)],[`Worst-case span (${values.unit})`,format(r.maximum-r.minimum)],[`Symmetric RSS estimate (±${values.unit})`,format(r.rssSymmetric)]], headings:['Component','Nominal','Minus','Plus','Sign'], rows:components.map((item,index)=>[index+1,format(item.nominal),format(item.minus),format(item.plus),item.sign]) };
    },
  },
  'measurement-uncertainty': {
    formula: 'uᵢ = magnitude ÷ distribution divisor; contribution = sensitivity·uᵢ; combined u = √Σ(contribution²); expanded U = k·combined u.',
    assumptions: ['Rows are magnitude, distribution, sensitivity; distributions: standard, normal, rectangular, triangular or u-shaped.', 'Magnitudes represent standard uncertainty already, or half-width/scale appropriate to the chosen distribution.', 'Components are independent because correlations are not supported in this release.'],
    limitations: ['A valid uncertainty budget requires traceable evidence, justified distributions, sensitivities and correlation review.', 'Expanded uncertainty is not automatically a confidence interval or a conformity decision.'],
    fields: [
      ['unit','Reported unit','mm',{type:'text',maxLength:12}],['coverageFactor','Coverage factor k',2,'any'],
      ['components','Components — magnitude, distribution, sensitivity','0.01,standard,1\n0.02,rectangular,2',{type:'textarea',rows:7,maxLength:12000}],
    ],
    run(values) {
      const components=parseStructuredLines(values.components,['magnitude','distribution','sensitivity'],'uncertainty component').map((row)=>({magnitude:Number(row.magnitude),distribution:row.distribution.trim().toLowerCase(),sensitivity:Number(row.sensitivity)}));
      const r=calculateUncertaintyBudget({components,coverageFactor:Number(values.coverageFactor)});
      return { lines:[[`Combined standard uncertainty (${values.unit})`,format(r.combined)],[`Expanded uncertainty U, k=${format(r.coverageFactor)} (${values.unit})`,format(r.expanded)]], headings:['Component','Distribution','Standard uncertainty','Sensitivity','Contribution'], rows:r.components.map((item,index)=>[index+1,item.distribution,format(item.standardUncertainty),format(item.sensitivity),format(item.contribution)]), warnings:['Correlations are not included; review whether independence is defensible before using this budget.'] };
    },
  },
  'process-capability': {
    formula: 'Overall s = √[Σ(x−x̄)²/(n−1)]; Pp = (USL−LSL)/(6s); Ppk = min[(USL−x̄)/(3s), (x̄−LSL)/(3s)].',
    assumptions: ['CSV has a unique header row and one finite numeric observation per subsequent row in the named column.', 'LSL, USL and observations use the same selected unit.', 'Pp/Ppk are overall-performance estimates and interpretation assumes an approximately normal, stable process.'],
    limitations: ['Limited to 5,000 data rows and 200,000 CSV characters in this browser tab.', 'No rational subgroups or within-process sigma estimate is supplied, so Cp/Cpk capability indices are not calculated.', 'No control-chart, subgroup, measurement-system, autocorrelation or normality analysis is performed.'],
    fields: [
      ['column','Measurement column','value',{type:'text',maxLength:80}],['unit','Measurement unit','mm',{type:'text',maxLength:12}],['lsl','Lower specification limit',9.5,'any'],['usl','Upper specification limit',10.5,'any'],
      ['csv','CSV observations','value\n9.8\n10.1\n10.0\n10.2\n9.9',{type:'textarea',rows:10,maxLength:200000}],
    ],
    run(values) {
      const r=calculateProcessCapabilityFromCsv({csv:values.csv,column:values.column.trim(),lsl:Number(values.lsl),usl:Number(values.usl)});
      return { lines:[['Observations (n)',String(r.n)],[`Mean (${values.unit})`,format(r.mean)],[`Overall sample standard deviation (${values.unit})`,format(r.sampleSd)],['Pp estimate (overall performance)',format(r.pp)],['Ppk estimate (overall performance)',format(r.ppk)],[`Observed minimum (${values.unit})`,format(r.minimum)],[`Observed maximum (${values.unit})`,format(r.maximum)]], warnings:r.warnings };
    },
  },
  'coordinate-transformer': {
    formula: 'Forward: p′ = Rz·Ry·Rx·p + t using right-handed degree rotations. Inverse: p = Rx⁻¹·Ry⁻¹·Rz⁻¹·(p′−t).',
    assumptions: ['CSV contains unique id, x, y and z headers; axis headers may carry the selected unit suffix.', 'Rotations are right-handed degrees about X, then Y, then Z; translations use the selected coordinate unit.', 'Every row belongs to the same Cartesian frame and unit system.'],
    limitations: ['This is a rigid 3D transform only; no scaling, skew, datum fitting or uncertainty propagation is provided.', 'Limited to 5,000 rows and 200,000 CSV characters; verify frame convention and rotation order independently.'],
    fields: [
      ['unit','Coordinate unit','mm',{type:'text',maxLength:12}],['inverse','Direction','false',[['false','Forward: source to destination'],['true','Inverse: destination to source']]],
      ['rotationX','Rotation X (degrees)',0,'any'],['rotationY','Rotation Y (degrees)',0,'any'],['rotationZ','Rotation Z (degrees)',90,'any'],
      ['translationX','Translation X',10,'any'],['translationY','Translation Y',20,'any'],['translationZ','Translation Z',3,'any'],
      ['csv','Point-list CSV','id,x,y,z\nP1,1,0,2\nP2,0,1,0',{type:'textarea',rows:10,maxLength:200000}],
    ],
    run(values) {
      const r=transformPointListCsv({csv:values.csv,...numberValues(values,['rotationX','rotationY','rotationZ','translationX','translationY','translationZ']),inverse:values.inverse==='true',unit:values.unit.trim()});
      const shown=r.points.slice(0,200);
      return { lines:[['Direction',r.direction],['Operation order',r.order],['Points transformed',String(r.points.length)]], headings:['ID',`X (${values.unit})`,`Y (${values.unit})`,`Z (${values.unit})`], rows:shown.map((point)=>[point.rawId,format(point.x),format(point.y),format(point.z)]), warnings:r.points.length>shown.length?[`Preview shows the first ${shown.length} points; the download contains all ${r.points.length}.`]:[], downloads:[['Download transformed CSV','transformed-points.csv','text/csv',r.csv]] };
    },
  },
  'inspection-csv-report': {
    formula: 'Deviation = measured − nominal; limits = nominal + lower/upper tolerance; status is “within” when lower limit ≤ measured ≤ upper limit.',
    assumptions: ['CSV has unique headers mapped below; numeric fields use one selected unit.', 'Lower and upper entries are signed deviations from nominal, not absolute limits.', 'The stated plain-limit decision rule treats exact boundary values as within.'],
    limitations: ['Measurement uncertainty, guard bands, rounding rules, GD&T and feature relationships are not included.', 'Limited to 5,000 rows and 200,000 CSV characters; this output is not an accredited inspection certificate.'],
    fields: [
      ['unit','Measurement unit','mm',{type:'text',maxLength:12}],['idColumn','Feature ID column','feature',{type:'text',maxLength:80}],['nominalColumn','Nominal column','nom',{type:'text',maxLength:80}],
      ['measuredColumn','Measured column','actual',{type:'text',maxLength:80}],['lowerColumn','Lower tolerance column','lo',{type:'text',maxLength:80}],['upperColumn','Upper tolerance column','hi',{type:'text',maxLength:80}],
      ['csv','Inspection CSV','feature,nom,actual,lo,hi\nBore A,10,10.08,-0.1,0.1\nBore B,8,8.15,-0.1,0.1',{type:'textarea',rows:10,maxLength:200000}],
    ],
    run(values) {
      const mapping={id:values.idColumn.trim(),nominal:values.nominalColumn.trim(),measured:values.measuredColumn.trim(),lowerTolerance:values.lowerColumn.trim(),upperTolerance:values.upperColumn.trim()};
      const r=generateInspectionReportFromCsv({csv:values.csv,mapping,unit:values.unit.trim()}); const shown=r.rows.slice(0,200); const outside=r.rows.filter((row)=>row.status==='outside').length;
      return { lines:[['Decision rule',r.decisionRule],['Features reported',String(r.rows.length)],['Within plain limits',String(r.rows.length-outside)],['Outside plain limits',String(outside)]], headings:['Feature',`Nominal (${r.unit})`,`Measured (${r.unit})`,`Deviation (${r.unit})`,`Lower limit (${r.unit})`,`Upper limit (${r.unit})`,'Status'], rows:shown.map((row)=>[row.id,format(row.nominal),format(row.measured),format(row.deviation),format(row.lowerLimit),format(row.upperLimit),row.status]), warnings:[...(outside?[`${outside} feature${outside===1?' is':'s are'} outside the entered plain limits.`]:[]),...(r.rows.length>shown.length?[`Preview shows the first ${shown.length} rows; the download contains all ${r.rows.length}.`]:[])], downloads:[['Download inspection report CSV','inspection-report.csv','text/csv',r.csv]] };
    },
  },
  'bolt-circle': {
    formula: 'θᵢ = θ₀ ± i·360°/n; x = x₀ + (D/2)·cos θᵢ; y = y₀ + (D/2)·sin θᵢ',
    assumptions: ['Equal spacing in one 2D plane.', 'Angles are degrees; positive X is the zero-angle axis.', 'Coordinates are planning data, not executable machine code.'],
    fields: [
      ['diameter', 'Pitch-circle diameter', 100, 'any'], ['holes', 'Number of holes', 6, '1'],
      ['startAngle', 'Start angle (degrees)', 0, 'any'], ['originX', 'Origin X', 0, 'any'], ['originY', 'Origin Y', 0, 'any'],
      ['direction', 'Rotation direction', 'ccw', [['ccw', 'Counter-clockwise'], ['cw', 'Clockwise']]],
      ['unit', 'Length unit', 'mm', [['mm', 'millimetres'], ['in', 'inches']]],
    ],
    run(values) {
      const points = calculateBoltCircle({ diameter: +values.diameter, holes: +values.holes, startAngle: +values.startAngle, originX: +values.originX, originY: +values.originY, direction: values.direction });
      const rows = points.map((point) => [point.hole, format(point.angle), format(point.x), format(point.y)]);
      const csv = `Hole,Angle_deg,X_${values.unit},Y_${values.unit}\n${rows.map((row) => row.join(',')).join('\n')}\n`;
      const minX = Math.min(...points.map((point) => point.x)); const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y)); const maxY = Math.max(...points.map((point) => point.y));
      const pad = Math.max(maxX - minX, maxY - minY) * 0.1 || 1;
      const svgGeometry = requireFiniteOutput({ x: minX-pad, y: -(maxY+pad), width: maxX-minX+2*pad, height: maxY-minY+2*pad, radius: Math.max(pad/5,0.2), fontSize: Math.max(pad/2,0.5) }, 'Bolt-circle SVG geometry');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${svgGeometry.x} ${svgGeometry.y} ${svgGeometry.width} ${svgGeometry.height}">${points.map((point) => `<circle cx="${point.x}" cy="${-point.y}" r="${svgGeometry.radius}" fill="none" stroke="black"/><text x="${point.x}" y="${-point.y}" font-size="${svgGeometry.fontSize}">${point.hole}</text>`).join('')}</svg>`;
      return { headings: ['Hole', 'Angle (°)', `X (${values.unit})`, `Y (${values.unit})`], rows, downloads: [['Download labelled CSV', 'bolt-circle.csv', 'text/csv', csv], ['Download SVG preview', 'bolt-circle.svg', 'image/svg+xml', svg]] };
    },
  },
  'thermal-length-correction': {
    formula: 'Lref ≈ Lmeasured · [1 − α · (Tmeasured − Tref)]',
    assumptions: ['First-order linear expansion only; temperature gradients and non-equilibrium are excluded.', 'Enter a traceable coefficient for the actual material; the illustrative default is not a recommendation.', 'Displayed uncertainty is first-order sensitivity propagation, not a calibration certificate.'],
    fields: [
      ['measuredLength', 'Measured length', 100, 'any'], ['measuredTemp', 'Measured temperature (°C)', 30, 'any'], ['referenceTemp', 'Reference temperature (°C)', 20, 'any'],
      ['alpha', 'Expansion coefficient (/°C)', 0.00001, 'any'], ['lengthUncertainty', 'Standard length uncertainty', 0.002, 'any'], ['tempUncertainty', 'Standard temperature uncertainty (°C)', 0.2, 'any'], ['alphaUncertainty', 'Coefficient standard uncertainty (/°C)', 0, 'any'],
      ['unit', 'Length unit', 'mm', [['mm', 'millimetres'], ['in', 'inches']]],
    ],
    run(values) { const r = calculateThermalCorrection(numberValues(values, ['measuredLength','measuredTemp','referenceTemp','alpha','lengthUncertainty','tempUncertainty','alphaUncertainty'])); return { lines: [[`Reference length (${values.unit})`, format(r.referenceLength)], [`Correction (${values.unit})`, format(r.correction)], [`Combined standard uncertainty (${values.unit})`, format(r.combinedUncertainty)], ['Temperature difference (°C)', format(r.deltaTemperature)]] }; },
  },
  'oee-loss': {
    formula: 'OEE = Availability × Performance × Quality',
    assumptions: ['All time inputs use the same unit; the example uses minutes.', 'Ideal cycle time must describe the same count basis as total count.', 'This transparent worksheet does not establish a universal benchmark or disposition production.'],
    fields: [['plannedTime','Planned production time (min)',480,'any'],['runTime','Run time (min)',400,'any'],['idealCycleTime','Ideal cycle time (min/unit)',0.5,'any'],['totalCount','Total count',720,'1'],['goodCount','Good count',700,'1']],
    run(values) { const r=calculateOee(numberValues(values,['plannedTime','runTime','idealCycleTime','totalCount','goodCount'])); return { lines:[['Availability',percent(r.availability)],['Performance',percent(r.performance)],['Quality',percent(r.quality)],['OEE',percent(r.oee)],['Downtime (min)',format(r.losses.downtime)],['Speed loss (min)',format(r.losses.speedTime)],['Rejected units',format(r.losses.rejectCount)]], warnings:r.warnings }; },
  },
  'takt-capacity': {
    formula: 'Takt = available production time ÷ demand; capacity = available time × stations ÷ observed cycle time',
    assumptions: ['Breaks are removed from the stated shift before calculating takt.', 'Cycle time, takt, availability, lead time and delivery commitment are different concepts.', 'Output is a planning comparison—not a customer delivery promise.'],
    fields: [['shiftMinutes','Shift length (min)',480,'any'],['breakMinutes','Breaks/planned stops (min)',60,'any'],['demand','Demand per shift',140,'any'],['cycleMinutes','Observed cycle time (min/unit)',4,'any'],['parallelStations','Parallel stations',2,'1']],
    run(values) { const r=calculateTaktCapacity(numberValues(values,['shiftMinutes','breakMinutes','demand','cycleMinutes','parallelStations'])); return { lines:[['Available time (min)',format(r.availableMinutes)],['Takt (min/unit)',format(r.taktMinutes)],['Calculated whole-unit capacity',format(r.capacity)],['Minimum parallel stations at this cycle time',format(r.requiredStations)],['Station load against takt',percent(r.load)]] }; },
  },
  'sine-bar': {
    formula: 'Required height h = L·sin θ; inferred angle θ = asin(h/L)',
    assumptions: ['Centre distance and stack height must use the same unit.', 'Sensitivity is first-order propagation of user-supplied standard uncertainties.', 'The calculation cannot validate alignment, wringing, flatness, calibration or the physical setup.'],
    fields: [['centreDistance','Sine-bar centre distance',100,'any'],['angleDegrees','Target angle (degrees)',30,'any'],['stackHeight','Actual stack height',50,'any'],['centreUncertainty','Centre-distance standard uncertainty',0.01,'any'],['heightUncertainty','Stack-height standard uncertainty',0.005,'any'],['unit','Length unit','mm',[['mm','millimetres'],['in','inches']]]],
    run(values) { const r=calculateSineBar(numberValues(values,['centreDistance','angleDegrees','stackHeight','centreUncertainty','heightUncertainty'])); return { lines:[[`Required stack (${values.unit})`,format(r.requiredHeight)],['Inferred angle (degrees)',format(r.inferredAngleDegrees)],['Angle standard uncertainty (degrees)',format(r.angleUncertaintyDegrees)]], warnings:r.inferredAngleDegrees>75?['Sensitivity rises steeply near 90°; review the physical method and uncertainty model.']:[] }; },
  },
};

export function runNativeToolDefinition(slug, values) {
  const definition=NATIVE_TOOL_DEFINITIONS[slug];
  if (!definition) throw new RangeError(`Unknown native tool: ${slug}`);
  return requireFiniteOutput(definition.run(values), `${slug} output`);
}

function numberValues(values, names) { return Object.fromEntries(names.map((name) => [name, Number(values[name])])); }
function parseListLines(text, label) {
  if (typeof text !== 'string' || text.length > 12000) throw new RangeError(`${label} text is too long`);
  const values=text.split(/\r?\n/).map((value)=>value.trim()).filter(Boolean);
  if (!values.length) throw new RangeError(`Provide at least one ${label} value`);
  return values;
}
function parseFiniteLines(text, label, maxRows, maxLength = 200000) {
  if (typeof text !== 'string' || text.length > maxLength) throw new RangeError(`${label} text is limited to ${maxLength.toLocaleString('en-GB')} characters`);
  const lines=text.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
  if (!lines.length) throw new RangeError(`Provide at least one ${label}`);
  if (lines.length > maxRows) throw new RangeError(`${label} input is limited to ${maxRows.toLocaleString('en-GB')} rows`);
  return lines.map((line,index)=>{const value=Number(line);if(!Number.isFinite(value))throw new RangeError(`${label} row ${index+1} must be a finite number`);return value;});
}
function parseStructuredLines(text, columns, label) {
  if (typeof text !== 'string' || text.length > 12000) throw new RangeError(`${label} text is too long`);
  const lines=text.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
  if (!lines.length) throw new RangeError(`Provide at least one ${label} row`);
  if (lines.length > 100) throw new RangeError(`${label} input is limited to 100 rows`);
  return lines.map((line,index)=>{
    const cells=line.split(',').map((cell)=>cell.trim());
    if(cells.length!==columns.length||cells.some((cell)=>cell==='')) throw new RangeError(`${label} row ${index+1} must contain ${columns.join(', ')}`);
    return Object.fromEntries(columns.map((column,columnIndex)=>[column,cells[columnIndex]]));
  });
}
function parseOptionalStructuredLines(text, columns, label, maxRows) {
  if (typeof text !== 'string' || text.length > 120000) throw new RangeError(`${label} text is too long`);
  const lines=text.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean);
  if (lines.length > maxRows) throw new RangeError(`${label} input is limited to ${maxRows.toLocaleString('en-GB')} rows`);
  return lines.map((line,index)=>{
    const cells=line.split(',').map((cell)=>cell.trim());
    if(cells.length!==columns.length||cells.slice(0,-1).some((cell)=>cell==='')) throw new RangeError(`${label} row ${index+1} must contain ${columns.join(', ')}`);
    return Object.fromEntries(columns.map((column,columnIndex)=>[column,cells[columnIndex]]));
  });
}
function format(value) {
  const numeric = requireFiniteOutput(Number(value), 'Displayed numeric result');
  if (numeric !== 0 && Math.abs(numeric) < 1e-8) return numeric.toExponential(8);
  return numeric.toLocaleString('en-GB', { maximumFractionDigits: 8 });
}
function percent(value) {
  const scaled = requireNonzeroArithmetic(value * 100, 'Displayed percentage', [value]);
  return `${format(scaled)}%`;
}
function addTextElement(documentRef, parent, tag, text, className) { const node=documentRef.createElement(tag); node.textContent=text; if(className) node.className=className; parent.append(node); return node; }

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 720;
const CHART_HEIGHT = 360;
const CHART_MARGIN = { top: 24, right: 28, bottom: 58, left: 78 };

function validateChartText(value, label, maximumLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) throw new RangeError(`${label} must be non-empty bounded text`);
  return value;
}

function validateChartContract(chart) {
  if (!chart || typeof chart !== 'object') throw new RangeError('Chart data must be an object');
  for (const [name, maximum] of [['title', 200], ['summary', 1000], ['xLabel', 200], ['yLabel', 200]]) validateChartText(chart[name], `Chart ${name}`, maximum);
  if (!Array.isArray(chart.series) || chart.series.length < 1 || chart.series.length > 20) throw new RangeError('Chart must contain 1 to 20 bounded series');
  if (!Array.isArray(chart.referenceLines) || chart.referenceLines.length > 50) throw new RangeError('Chart reference lines must be a bounded array');
  let pointCount = 0;
  for (const series of chart.series) {
    validateChartText(series?.label, 'Series label', 200);
    if (!['line', 'points', 'line-points'].includes(series.kind)) throw new RangeError('Chart series kind is unsupported');
    if (series.className !== undefined && (typeof series.className !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/i.test(series.className))) throw new RangeError('Chart series class must be a bounded CSS identifier');
    if (!Array.isArray(series.points)) throw new RangeError('Chart series points must be an array');
    pointCount += series.points.length;
    if (pointCount > 10001) throw new RangeError('Chart data is bounded to 10,001 points');
    for (const point of series.points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Chart point coordinates must be finite numbers');
      if (point.label !== undefined && (typeof point.label !== 'string' || point.label.length > 500)) throw new RangeError('Chart point labels must be bounded text');
    }
  }
  if (pointCount === 0) throw new RangeError('Chart must contain at least one point');
  for (const line of chart.referenceLines) {
    validateChartText(line?.label, 'Reference-line label', 200);
    if (!Number.isFinite(line.value)) throw new RangeError('Reference-line values must be finite numbers');
    if (line.className !== undefined && (typeof line.className !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/i.test(line.className))) throw new RangeError('Reference-line class must be a bounded CSS identifier');
  }
  for (const axis of ['xDomain', 'yDomain']) {
    const domain = chart[axis];
    if (domain !== undefined && (!Array.isArray(domain) || domain.length !== 2 || !domain.every(Number.isFinite) || domain[0] >= domain[1] || !Number.isFinite(domain[1] - domain[0]))) throw new RangeError(`${axis} must contain two increasing finite bounds`);
  }
  return chart;
}

function chartDomain(values, requestedDomain) {
  if (requestedDomain) return requestedDomain;
  let lower = Math.min(...values); let upper = Math.max(...values);
  if (lower === upper) {
    const padding = Math.max(1, Math.abs(lower) * 0.05);
    lower -= padding; upper += padding;
  } else {
    const span = upper - lower;
    if (!Number.isFinite(span)) throw new RangeError('Chart domain must have a finite bounded span');
    const padding = span * 0.05;
    lower -= padding; upper += padding;
  }
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(upper - lower)) throw new RangeError('Chart domain must have finite bounded values');
  return [lower, upper];
}

function addSvgElement(documentRef, parent, tag, attributes = {}, text) {
  const node = documentRef.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

function chartTick(value) {
  const rounded = Number(value.toPrecision(6));
  if (rounded !== 0 && Math.abs(rounded) < 1e-6) return rounded.toExponential(5);
  return rounded.toLocaleString('en-GB', { maximumFractionDigits: 6 });
}

export function renderAccessibleChart(documentRef, parent, candidate, index) {
  const chart = validateChartContract(candidate);
  if (!documentRef?.createElement || !documentRef?.createElementNS || !parent?.append) throw new RangeError('A DOM document and parent are required to render a chart');
  if (!Number.isInteger(index) || index < 0 || index > 9999) throw new RangeError('Chart index must be a bounded non-negative integer');

  const allPoints = chart.series.flatMap((series) => series.points);
  const xDomain = chartDomain(allPoints.map((point) => point.x), chart.xDomain);
  const yDomain = chartDomain([...allPoints.map((point) => point.y), ...chart.referenceLines.map((line) => line.value)], chart.yDomain);
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const xPosition = (value) => requireFiniteResult(CHART_MARGIN.left + ((value - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotWidth, 'Chart X geometry');
  const yPosition = (value) => requireFiniteResult(CHART_MARGIN.top + (1 - ((value - yDomain[0]) / (yDomain[1] - yDomain[0]))) * plotHeight, 'Chart Y geometry');
  for (const point of allPoints) { xPosition(point.x); yPosition(point.y); }
  for (const line of chart.referenceLines) yPosition(line.value);

  const figure = documentRef.createElement('figure');
  figure.className = 'chart';
  const titleId = `chart-title-${index}`; const summaryId = `chart-summary-${index}`;
  figure.setAttribute('aria-labelledby', `${titleId} ${summaryId}`);
  const heading = addTextElement(documentRef, figure, 'h3', chart.title);
  heading.setAttribute('id', titleId);

  const svg = addSvgElement(documentRef, figure, 'svg', { viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`, role: 'img', 'aria-labelledby': `chart-svg-title-${index} chart-svg-description-${index}`, preserveAspectRatio: 'xMidYMid meet' });
  addSvgElement(documentRef, svg, 'title', { id: `chart-svg-title-${index}` }, chart.title);
  addSvgElement(documentRef, svg, 'desc', { id: `chart-svg-description-${index}` }, chart.summary);
  const definitions = addSvgElement(documentRef, svg, 'defs');
  const clip = addSvgElement(documentRef, definitions, 'clipPath', { id: `chart-clip-${index}` });
  addSvgElement(documentRef, clip, 'rect', { x: CHART_MARGIN.left, y: CHART_MARGIN.top, width: plotWidth, height: plotHeight });
  const grid = addSvgElement(documentRef, svg, 'g', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (let tick = 0; tick <= 4; tick += 1) {
    const fraction = tick / 4;
    const x = CHART_MARGIN.left + fraction * plotWidth; const y = CHART_MARGIN.top + (1 - fraction) * plotHeight;
    addSvgElement(documentRef, grid, 'line', { x1: x, y1: CHART_MARGIN.top, x2: x, y2: CHART_MARGIN.top + plotHeight });
    addSvgElement(documentRef, grid, 'line', { x1: CHART_MARGIN.left, y1: y, x2: CHART_MARGIN.left + plotWidth, y2: y });
    addSvgElement(documentRef, svg, 'text', { x, y: CHART_MARGIN.top + plotHeight + 22, class: 'chart-tick', 'text-anchor': 'middle' }, chartTick(xDomain[0] + fraction * (xDomain[1] - xDomain[0])));
    addSvgElement(documentRef, svg, 'text', { x: CHART_MARGIN.left - 10, y: y + 4, class: 'chart-tick', 'text-anchor': 'end' }, chartTick(yDomain[0] + fraction * (yDomain[1] - yDomain[0])));
  }
  addSvgElement(documentRef, svg, 'line', { x1: CHART_MARGIN.left, y1: CHART_MARGIN.top + plotHeight, x2: CHART_MARGIN.left + plotWidth, y2: CHART_MARGIN.top + plotHeight, class: 'chart-axis' });
  addSvgElement(documentRef, svg, 'line', { x1: CHART_MARGIN.left, y1: CHART_MARGIN.top, x2: CHART_MARGIN.left, y2: CHART_MARGIN.top + plotHeight, class: 'chart-axis' });
  addSvgElement(documentRef, svg, 'text', { x: CHART_MARGIN.left + plotWidth / 2, y: CHART_HEIGHT - 10, class: 'chart-axis-label', 'text-anchor': 'middle' }, chart.xLabel);
  addSvgElement(documentRef, svg, 'text', { x: 18, y: CHART_MARGIN.top + plotHeight / 2, class: 'chart-axis-label', 'text-anchor': 'middle', transform: `rotate(-90 18 ${CHART_MARGIN.top + plotHeight / 2})` }, chart.yLabel);

  const marks = addSvgElement(documentRef, svg, 'g', { 'clip-path': `url(#chart-clip-${index})` });
  for (const line of chart.referenceLines) {
    const y = yPosition(line.value);
    addSvgElement(documentRef, marks, 'line', { x1: CHART_MARGIN.left, y1: y, x2: CHART_MARGIN.left + plotWidth, y2: y, class: `chart-reference ${line.className || 'reference'}` });
    addSvgElement(documentRef, marks, 'text', { x: CHART_MARGIN.left + 5, y: y - 5, class: 'chart-reference-label' }, `${line.label}: ${chartTick(line.value)}`);
  }
  for (const series of chart.series) {
    const group = addSvgElement(documentRef, marks, 'g', { class: `chart-series ${series.className || 'series'}`, 'aria-label': series.label });
    if ((series.kind === 'line' || series.kind === 'line-points') && series.points.length > 1) addSvgElement(documentRef, group, 'polyline', { points: series.points.map((point) => `${xPosition(point.x)},${yPosition(point.y)}`).join(' '), class: 'chart-line' });
    if (series.kind === 'points' || series.kind === 'line-points') for (const point of series.points) {
      const marker = addSvgElement(documentRef, group, 'circle', { cx: xPosition(point.x), cy: yPosition(point.y), r: 4, class: 'chart-point' });
      if (point.label) addSvgElement(documentRef, marker, 'title', {}, point.label);
    }
  }
  const caption = addTextElement(documentRef, figure, 'figcaption', chart.summary);
  caption.setAttribute('id', summaryId);
  parent.append(figure);
  return figure;
}

function renderNativeResult(documentRef, output, result) {
  output.replaceChildren();
  addTextElement(documentRef, output, 'h2', 'Results');
  if (result.lines) { const list=documentRef.createElement('dl'); for(const [label,value] of result.lines){addTextElement(documentRef,list,'dt',label);addTextElement(documentRef,list,'dd',value);} output.append(list); }
  if (result.charts) { const charts=documentRef.createElement('section'); charts.className='charts'; charts.setAttribute('aria-label','Charts'); result.charts.forEach((chart,index)=>renderAccessibleChart(documentRef,charts,chart,index)); output.append(charts); }
  if (result.rows) { const table=documentRef.createElement('table'); const caption=documentRef.createElement('caption'); caption.textContent=result.tableCaption||'Detailed calculation results'; table.append(caption); const head=documentRef.createElement('thead'); const headRow=documentRef.createElement('tr'); for(const label of result.headings){const header=addTextElement(documentRef,headRow,'th',label);header.setAttribute('scope','col');} head.append(headRow); table.append(head); const body=documentRef.createElement('tbody'); for(const row of result.rows){const tr=documentRef.createElement('tr'); for(const value of row)addTextElement(documentRef,tr,'td',String(value)); body.append(tr);} table.append(body); output.append(table); }
  for(const warning of result.warnings||[]) addTextElement(documentRef,output,'p',warning,'warning');
  if(result.downloads){const actions=documentRef.createElement('div');actions.className='downloads';for(const [label,filename,mime,content] of result.downloads){const link=documentRef.createElement('a');link.textContent=label;link.download=filename;link.href=`data:${mime};charset=utf-8,${encodeURIComponent(content)}`;actions.append(link);}output.append(actions);}
}

export function initialiseNativeTool(documentRef = globalThis.document) {
  const form = documentRef.querySelector('#native-tool');
  if (!form) return;
  const definition=NATIVE_TOOL_DEFINITIONS[form.dataset.tool];
  if(!definition){ form.replaceChildren(); addTextElement(documentRef,form,'p','This worksheet definition is unavailable.','error'); return; }
  const intro=documentRef.createElement('section');intro.className='panel';addTextElement(documentRef,intro,'h2','Method');addTextElement(documentRef,intro,'p',definition.formula,'formula');addTextElement(documentRef,intro,'h3','Assumptions');const assumptions=documentRef.createElement('ul');for(const item of definition.assumptions)addTextElement(documentRef,assumptions,'li',item);intro.append(assumptions);if(definition.limitations){addTextElement(documentRef,intro,'h3','Limitations');const limitations=documentRef.createElement('ul');for(const item of definition.limitations)addTextElement(documentRef,limitations,'li',item);intro.append(limitations);}form.append(intro);
  const panel=documentRef.createElement('section');panel.className='panel';addTextElement(documentRef,panel,'h2','Inputs');const fields=documentRef.createElement('div');fields.className='fields';
  for(const [name,labelText,value,kind] of definition.fields){
    const label=documentRef.createElement('label');addTextElement(documentRef,label,'span',labelText);let control;
    if(Array.isArray(kind)){
      control=documentRef.createElement('select');
      for(const [optionValue,optionLabel] of kind){const option=documentRef.createElement('option');option.value=optionValue;option.textContent=optionLabel;option.selected=optionValue===value;control.append(option);}
    }else if(kind&&typeof kind==='object'){
      control=documentRef.createElement(kind.type==='textarea'?'textarea':'input');
      if(kind.type!=='textarea') control.type=kind.type || 'number';
      if(kind.rows) control.rows=kind.rows;
      if(kind.maxLength) control.maxLength=kind.maxLength;
      if(kind.accept) control.accept=kind.accept;
      control.required=kind.required!==false;
      if(kind.type!=='file') control.value=String(value);
      if(kind.type==='textarea'||kind.type==='file') label.className='wide-field';
    }else{
      control=documentRef.createElement('input');control.type='number';control.step=kind;control.required=true;control.value=String(value);
    }
    control.name=name;label.append(control);fields.append(label);
  }
  panel.append(fields);const button=documentRef.createElement('button');button.type='submit';button.textContent='Calculate';panel.append(button);if(definition.clearFields){const clear=documentRef.createElement('button');clear.type='button';clear.textContent='Clear local input';clear.addEventListener('click',()=>{for(const name of definition.clearFields){const control=form.elements.namedItem(name);if(control)control.value='';}output.replaceChildren();addTextElement(documentRef,output,'h2','Local input cleared');addTextElement(documentRef,output,'p','The entered text and rendered results have been removed from this browser tab.');});panel.append(clear);}form.append(panel);
  const output=documentRef.createElement('section');output.className='panel result';output.tabIndex=0;output.setAttribute('role','status');output.setAttribute('aria-live','polite');form.append(output);addTextElement(documentRef,form,'p','Planning and educational aid only. Independently verify inputs, assumptions, units and results before engineering, inspection or production use.','warning');
  const calculate=async()=>{
    button.disabled=true;
    try{
      const values=Object.fromEntries(new FormData(form));
      if(form.dataset.tool==='spc-imr-chart'){
        const file=form.elements.namedItem('csvFile')?.files?.[0];
        if(file?.size>200000) throw new RangeError('CSV is limited to 200,000 characters');
        const csv=file?await file.text():values.csv;
        values.parsedObservations=await parseSpcCsvWithWorker(csv, values.column);
      }
      renderNativeResult(documentRef,output,runNativeToolDefinition(form.dataset.tool,values));
    }catch(error){
      output.replaceChildren();addTextElement(documentRef,output,'h2','Check the inputs');addTextElement(documentRef,output,'p',error instanceof Error?error.message:'Unable to calculate.','error');
    }finally{button.disabled=false;}
  };
  form.addEventListener('submit',(event)=>{event.preventDefault();void calculate();});void calculate();
}
