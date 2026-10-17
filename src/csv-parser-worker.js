import { parseSpcObservationsCsv } from './native-tools.js';

self.addEventListener('message', ({ data }) => {
  try {
    const result = parseSpcObservationsCsv({ csv: data?.csv, column: data?.column });
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Unable to parse SPC CSV' });
  }
});
