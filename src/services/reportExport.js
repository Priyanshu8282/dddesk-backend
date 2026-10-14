// Streaming CSV / SpreadsheetML (Excel 2003 XML, opens in Excel as .xls) writers. No extra dependencies.
const { once } = require('events');
const { istDateKey } = require('../utils/time');
const { iterateDataset, getColumns, resolveName } = require('./reportDatasets');
const { XlsxWriter } = require('../utils/xlsxWriter');

const SHEET_ROWS = 500000;
const FLUSH_BYTES = 64 * 1024;

// Spreadsheet formula injection guard: text cells starting with = + - @ (or control chars) get a leading apostrophe
const guard = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const csvCell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(guard(v)).replace(/\r\n|\r|\n/g, ' ');
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const xml = (s) => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xlCell = (v, style) => {
    const st = style ? ` ss:StyleID="${style}"` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<Cell${st}><Data ss:Type="Number">${v}</Data></Cell>`;
    if (v === null || v === undefined || v === '') return `<Cell${st}/>`;
    return `<Cell${st}><Data ss:Type="String">${xml(guard(v))}</Data></Cell>`;
};

const sheetName = (n) => `Report ${n}`.slice(0, 31);

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

const makeSink = (res) => {
    let buf = '';
    let closed = false;
    res.on('close', () => { closed = true; });
    const flush = async (force) => {
        if (closed) return;
        if (buf.length >= FLUSH_BYTES || (force && buf.length)) {
            const chunk = buf;
            buf = '';
            if (!res.write(chunk)) await once(res, 'drain').catch(() => {});
        }
    };
    return { push: async (s) => { buf += s; await flush(false); }, end: async () => { await flush(true); }, isClosed: () => closed };
};

/**
 * Stream the full filtered dataset. Returns { rows, truncated }.
 * Headers are set here; call before anything is written to res.
 */
exports.streamExport = async (res, { type, format, L, q }) => {
    const key = resolveName(type);
    const columns = getColumns(key);
    const stamp = istDateKey(new Date());
    const base = `${safeName(key)}_report_${stamp}`;
    const sink = makeSink(res);
    let rows = 0;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (format === 'xlsx') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
        const wb = new XlsxWriter({
            write: async (buf) => {
                if (sink.isClosed()) throw new Error('client closed connection');
                if (!res.write(buf)) await once(res, 'drain').catch(() => {});
            }
        }, { columns, sheetName: (n) => sheetName(n) });
        try {
            for await (const row of iterateDataset(key, L, q)) {
                if (sink.isClosed()) break;
                await wb.addRow(row);
                rows += 1;
            }
            if (sink.isClosed()) return { rows };
            await wb.finish();
        } catch (err) {
            if (sink.isClosed()) return { rows };
            throw err;
        }
        res.end();
        return { rows };
    }

    if (format === 'xls') {
        res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.xls"`);
        await sink.push('<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n'
            + '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" '
            + 'xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
            + '<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#E5E7EB" ss:Pattern="Solid"/></Style></Styles>');
        let sheet = 0;
        const open = async () => {
            sheet += 1;
            await sink.push(`<Worksheet ss:Name="${sheetName(sheet)}"><Table>`
                + `<Row>${columns.map((c) => xlCell(c.label, 'h')).join('')}</Row>`);
        };
        await open();
        for await (const row of iterateDataset(key, L, q)) {
            if (sink.isClosed()) break;
            if (rows > 0 && rows % SHEET_ROWS === 0) { await sink.push('</Table></Worksheet>'); await open(); }
            await sink.push(`<Row>${columns.map((c) => xlCell(row[c.key])).join('')}</Row>`);
            rows += 1;
        }
        await sink.push('</Table></Worksheet></Workbook>');
    } else {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
        await sink.push('﻿' + columns.map((c) => csvCell(c.label)).join(',') + '\r\n');
        for await (const row of iterateDataset(key, L, q)) {
            if (sink.isClosed()) break;
            await sink.push(columns.map((c) => csvCell(row[c.key])).join(',') + '\r\n');
            rows += 1;
        }
    }
    await sink.end();
    res.end();
    return { rows };
};

exports.csvCell = csvCell;
exports.guard = guard;
