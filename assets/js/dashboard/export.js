/* Export: one row per set.
 *
 * EACH ROW KEEPS THE UNIT IT WAS LOGGED IN (D47). Nothing is converted on the
 * way out, so a log that mixes kg and lb exports exactly what was entered and
 * the `unit` column says which is which. Left and right stay in separate
 * columns rather than being averaged into a number nobody lifted.
 *
 * Export is NEVER gated by subscription status: it works the same whether an
 * entitlement is active, lapsed or gone (D38, the no-hostage valve).
 */

import { fromMilli, countsInTotals } from './domain.js';

export const COLUMNS = [
  'Date',
  'Workout',
  'Exercise',
  'Set',
  'Type',
  'Weight',
  'Reps',
  'Unit',
  'Left weight',
  'Left reps',
  'Right weight',
  'Right reps',
];

function isoDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Flatten the model into export rows, oldest first.
 *
 * A per-side exercise logs one row per side sharing an ordinal (D13), so those
 * two collapse into one export row with the sides in their own columns and the
 * shared weight/reps columns left blank: there is no single number that is
 * honestly "the" weight for a set worked at two.
 */
export function buildRows(model, { from = null, to = null } = {}) {
  const rows = [];
  const sessions = [...model.sessions].sort((a, b) => a.startedAt - b.startedAt);

  for (const session of sessions) {
    if (from != null && session.startedAt < from) continue;
    if (to != null && session.startedAt > to) continue;
    const date = isoDate(session.startedAt);

    for (const entry of session.entries) {
      const unit = entry.exercise.unit || 'kg';
      const byOrdinal = new Map();
      for (const set of entry.sets) {
        if (!countsInTotals(set.setType)) continue;
        const held = byOrdinal.get(set.orderIndex) || { sides: [] };
        held.sides.push(set);
        byOrdinal.set(set.orderIndex, held);
      }

      [...byOrdinal.entries()]
        .sort((a, b) => a[0] - b[0])
        .forEach(([ordinal, held], index) => {
          const left = held.sides.find((s) => s.side === 'left');
          const right = held.sides.find((s) => s.side === 'right');
          const both = held.sides.find((s) => s.side === 'both') || held.sides[0];
          const perSide = !!(left || right);

          rows.push([
            date,
            session.title,
            entry.exercise.name,
            index + 1,
            both.setType,
            perSide || both.weightMilli == null ? '' : fromMilli(both.weightMilli),
            perSide ? '' : both.reps,
            unit,
            left && left.weightMilli != null ? fromMilli(left.weightMilli) : '',
            left ? left.reps : '',
            right && right.weightMilli != null ? fromMilli(right.weightMilli) : '',
            right ? right.reps : '',
          ]);
        });
    }
  }
  return rows;
}

/* ---------------------------------------------------------------------- CSV */

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  const lines = [COLUMNS, ...rows].map((row) => row.map(csvCell).join(','));
  // A BOM so a spreadsheet opens the file as UTF-8 rather than guessing.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* --------------------------------------------------------------------- XLSX */

/* A real .xlsx, written here rather than pulled from a library: the file is a
 * ZIP of four small XML parts, and a store-only ZIP (no compression) needs
 * nothing but a CRC32. Keeping it in the page means the export works with no
 * third-party script on the site at all. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML 1.0 and would break the file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function columnName(index) {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const body = [COLUMNS, ...rows]
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === '' || value == null) return '';
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

const PARTS = (rows) => [
  [
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
  ],
  [
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  ],
  [
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sets" sheetId="1" r:id="rId1"/></sheets></workbook>',
  ],
  [
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
  ],
  ['xl/worksheets/sheet1.xml', sheetXml(rows)],
];

export function toXlsx(rows) {
  const encoder = new TextEncoder();
  const files = PARTS(rows).map(([name, xml]) => ({
    name: encoder.encode(name),
    data: encoder.encode(xml),
  }));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const crc = crc32(file.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored, no compression
    local.setUint32(14, crc, true);
    local.setUint32(18, file.data.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, file.name.length, true);
    chunks.push(new Uint8Array(local.buffer), file.name, file.data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // central directory header
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, file.data.length, true);
    entry.setUint32(24, file.data.length, true);
    entry.setUint16(28, file.name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), file.name);

    offset += 30 + file.name.length + file.data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Hand the file to the browser. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
