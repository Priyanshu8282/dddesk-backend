/**
 * Dependency-free streaming .xlsx (Office Open XML) writer.
 *
 * - ZIP container built by hand: deflateRaw entries written with the data-descriptor method
 *   (general purpose bit 3) so sizes / CRC are not needed up front. Worksheets are streamed first,
 *   then workbook.xml / rels / styles / content types are written once the sheet count is known.
 * - Cells: numbers as numbers, booleans as t="b", dates as Excel serials (IST), strings as
 *   inline strings (t="inlineStr"). No formula (<f>) element is ever emitted; strings starting with
 *   = + - @ TAB CR carry the quotePrefix style (Excel's leading-apostrophe) so they never evaluate.
 * - Backpressure: every write to the sink is awaited (sink.write(buf) -> Promise).
 */
const zlib = require('zlib');

const MAX_SHEET_ROWS = 1000000; // Excel limit is 1,048,576 including the header
const CHUNK_BYTES = 64 * 1024;
const WIDTH_SAMPLE_ROWS = 100;
const IST_OFFSET_MS = 330 * 60 * 1000;
const EXCEL_EPOCH_DAYS = 25569; // 1970-01-01 as an Excel serial

// ---- CRC32 ----
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
const crc32 = (buf, prev = 0) => {
    let c = (prev ^ 0xffffffff) >>> 0;
    for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

// ---- XML helpers ----
// Strip chars that are illegal in XML 1.0 (control chars, lone surrogates, U+FFFE/FFFF) then escape.
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const xmlText = (s) => String(s).replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = (i) => { // 0 -> A
    let n = i + 1;
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
};

// style ids (see STYLES_XML cellXfs order)
const S = { DEFAULT: 0, HEADER: 1, CURRENCY: 2, DATE: 3, DATETIME: 4, QUOTE: 5 };

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="3">'
    + '<numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00"/>'
    + '<numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy"/>'
    + '<numFmt numFmtId="166" formatCode="dd\\-mmm\\-yyyy\\ hh:mm"/>'
    + '</numFmts>'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="6">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" quotePrefix="1"/>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const FORMULA_START = /^[=+\-@\t\r]/;

/** Convert a Date to an Excel serial number in IST. */
const excelSerialIST = (d) => (d.getTime() + IST_OFFSET_MS) / 86400000 + EXCEL_EPOCH_DAYS;

/**
 * Render a cell. `kind` is the column hint ('currency' | undefined).
 * Returns '' for empty values (cell skipped).
 */
const cellXml = (ref, v, kind, headerStyle) => {
    if (v === null || v === undefined || v === '') return headerStyle ? `<c r="${ref}" s="${headerStyle}"/>` : '';
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) return '';
        const serial = excelSerialIST(v);
        const dateOnly = Math.abs(serial - Math.round(serial)) < 1e-9;
        return `<c r="${ref}" s="${dateOnly ? S.DATE : S.DATETIME}"><v>${Math.round(serial * 1e8) / 1e8}</v></c>`;
    }
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (typeof v === 'bigint') v = v.toString();
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '';
        // beyond 15 significant digits Excel would silently lose precision: keep as text
        if (Math.abs(v) >= 1e15 && Number.isInteger(v)) return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(BigInt(v).toString())}</t></is></c>`;
        const st = kind === 'currency' ? S.CURRENCY : S.DEFAULT;
        return `<c r="${ref}"${st ? ` s="${st}"` : ''}><v>${v}</v></c>`;
    }
    const str = typeof v === 'string' ? v : String(v);
    const st = headerStyle || (FORMULA_START.test(str) ? S.QUOTE : 0);
    return `<c r="${ref}" t="inlineStr"${st ? ` s="${st}"` : ''}><is><t xml:space="preserve">${xmlText(str)}</t></is></c>`;
};

const displayLen = (v) => {
    if (v === null || v === undefined) return 0;
    if (v instanceof Date) return 18;
    if (typeof v === 'number') return String(v).length + 3;
    const s = String(v);
    return Math.max(...s.split(/\r?\n/).map((l) => l.length), 0);
};

// ---- ZIP writer (streaming, data descriptors) ----
class ZipStream {
    constructor(sink) {
        this.sink = sink; // { write(buf) -> Promise }
        this.offset = 0;
        this.entries = [];
    }

    async _write(buf) {
        if (!buf.length) return;
        this.offset += buf.length;
        await this.sink.write(buf);
    }

    /** Begin a streamed entry. Returns { write(str|Buffer), end() }. */
    async startEntry(name) {
        const nameBuf = Buffer.from(name, 'utf8');
        const entry = { name: nameBuf, offset: this.offset, crc: 0, csize: 0, usize: 0 };
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4); // version needed
        h.writeUInt16LE(0x0808, 6); // bit 3 (data descriptor) + bit 11 (utf-8 names)
        h.writeUInt16LE(8, 8); // deflate
        h.writeUInt16LE(0, 10); // mod time
        h.writeUInt16LE(0x21, 12); // mod date 1980-01-01
        // crc / sizes zero (in data descriptor)
        h.writeUInt16LE(nameBuf.length, 26);
        await this._write(Buffer.concat([h, nameBuf]));

        const deflate = zlib.createDeflateRaw({ level: 6 });
        const out = [];
        let failed = null;
        deflate.on('data', (c) => { out.push(c); });
        deflate.on('error', (e) => { failed = e; });
        const self = this;
        const drainOut = async () => {
            if (failed) throw failed;
            while (out.length) {
                const c = out.shift();
                entry.csize += c.length;
                if (entry.csize > 0xffffffff) throw new Error('xlsx entry exceeds 4GB (ZIP64 not supported)');
                await self._write(c);
            }
        };
        return {
            write: async (data) => {
                const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
                if (!b.length) return;
                entry.crc = crc32(b, entry.crc);
                entry.usize += b.length;
                if (entry.usize > 0xffffffff) throw new Error('xlsx entry exceeds 4GB (ZIP64 not supported)');
                await new Promise((resolve, reject) => { deflate.write(b, (e) => (e ? reject(e) : resolve())); });
                await drainOut();
            },
            end: async () => {
                await new Promise((resolve, reject) => {
                    deflate.once('end', resolve);
                    deflate.once('error', reject);
                    deflate.end();
                    deflate.resume();
                });
                await drainOut();
                const d = Buffer.alloc(16);
                d.writeUInt32LE(0x08074b50, 0);
                d.writeUInt32LE(entry.crc, 4);
                d.writeUInt32LE(entry.csize, 8);
                d.writeUInt32LE(entry.usize, 12);
                await self._write(d);
                self.entries.push(entry);
            }
        };
    }

    async addSmall(name, text) {
        const e = await this.startEntry(name);
        await e.write(text);
        await e.end();
    }

    async finish() {
        const start = this.offset;
        const parts = [];
        for (const e of this.entries) {
            const c = Buffer.alloc(46);
            c.writeUInt32LE(0x02014b50, 0);
            c.writeUInt16LE(20, 4); // version made by
            c.writeUInt16LE(20, 6); // version needed
            c.writeUInt16LE(0x0808, 8);
            c.writeUInt16LE(8, 10);
            c.writeUInt16LE(0, 12);
            c.writeUInt16LE(0x21, 14);
            c.writeUInt32LE(e.crc, 16);
            c.writeUInt32LE(e.csize, 20);
            c.writeUInt32LE(e.usize, 24);
            c.writeUInt16LE(e.name.length, 28);
            c.writeUInt32LE(e.offset, 42);
            parts.push(c, e.name);
        }
        const dir = Buffer.concat(parts);
        await this._write(dir);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(dir.length, 12);
        end.writeUInt32LE(start, 16);
        await this._write(end);
    }
}

/**
 * Streaming workbook.
 *   const wb = new XlsxWriter(sink, { columns: [{ key, label, type }], sheetName: n => `Report ${n}` });
 *   await wb.addRow(valuesArray); ... await wb.finish();
 * `sink` is { write(buf) -> Promise }.
 */
class XlsxWriter {
    constructor(sink, { columns, sheetName, maxSheetRows } = {}) {
        this.maxSheetRows = maxSheetRows || MAX_SHEET_ROWS;
        this.zip = new ZipStream(sink);
        this.columns = columns || [];
        this.sheetName = sheetName || ((n) => `Sheet${n}`);
        this.sheets = 0;
        this.rowsInSheet = 0; // data rows in the current sheet
        this.totalRows = 0;
        this.entry = null;
        this.buf = '';
        this.sample = []; // rows held until column widths are known
        this.widthsDone = false;
        this.widths = [];
    }

    async _openSheet() {
        this.sheets += 1;
        this.rowsInSheet = 0;
        this.sample = [];
        this.widthsDone = false;
        this.widths = this.columns.map((c) => Math.min(60, Math.max(8, displayLen(c.label) + 4)));
        this.entry = await this.zip.startEntry(`xl/worksheets/sheet${this.sheets}.xml`);
        this.buf = '';
    }

    _rowXml(rowNo, values, header) {
        let cells = '';
        for (let i = 0; i < this.columns.length; i += 1) {
            const col = this.columns[i];
            cells += cellXml(`${colName(i)}${rowNo}`, values[i], col.type || (/\(INR\)/.test(col.label || '') ? 'currency' : undefined), header ? S.HEADER : 0);
        }
        return `<row r="${rowNo}">${cells}</row>`;
    }

    async _push(s) {
        this.buf += s;
        if (this.buf.length >= CHUNK_BYTES) await this._flush();
    }

    async _flush() {
        if (!this.buf) return;
        const b = this.buf;
        this.buf = '';
        await this.entry.write(b);
    }

    async _writeHead() {
        const lastCol = colName(Math.max(0, this.columns.length - 1));
        let head = `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
            + `<dimension ref="A1:${lastCol}1"/>`
            + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
            + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
            + '<sheetFormatPr defaultRowHeight="15"/><cols>';
        this.widths.forEach((w, i) => { head += `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`; });
        head += '</cols><sheetData>';
        head += this._rowXml(1, this.columns.map((c) => c.label), true);
        await this._push(head);
    }

    async _releaseSample() {
        this.widthsDone = true;
        await this._writeHead();
        for (const r of this.sample) await this._push(r.xml);
        this.sample = [];
    }

    async _closeSheet() {
        if (!this.widthsDone) await this._releaseSample();
        await this._push('</sheetData></worksheet>');
        await this._flush();
        await this.entry.end();
        this.entry = null;
    }

    /** values: array aligned with columns (or object keyed by column.key). */
    async addRow(row) {
        if (!this.entry) await this._openSheet();
        else if (this.rowsInSheet >= this.maxSheetRows) { await this._closeSheet(); await this._openSheet(); }
        const values = Array.isArray(row) ? row : this.columns.map((c) => row[c.key]);
        const rowNo = this.rowsInSheet + 2; // header is row 1
        const xml = this._rowXml(rowNo, values, false);
        this.rowsInSheet += 1;
        this.totalRows += 1;
        if (!this.widthsDone) {
            values.forEach((v, i) => { if (i < this.widths.length) this.widths[i] = Math.min(60, Math.max(this.widths[i], displayLen(v) + 2)); });
            this.sample.push({ xml });
            if (this.sample.length >= WIDTH_SAMPLE_ROWS) await this._releaseSample();
        } else {
            await this._push(xml);
        }
    }

    async finish() {
        if (!this.entry) await this._openSheet(); // header-only workbook
        await this._closeSheet();
        const n = this.sheets;
        const names = Array.from({ length: n }, (_, i) => xmlText(this.sheetName(i + 1)).slice(0, 31));
        let ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + '<Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
        for (let i = 1; i <= n; i += 1) ct += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
        ct += '</Types>';
        await this.zip.addSmall('[Content_Types].xml', ct);
        await this.zip.addSmall('_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
            + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
        let wb = `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>`;
        names.forEach((nm, i) => { wb += `<sheet name="${nm}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`; });
        wb += '</sheets></workbook>';
        await this.zip.addSmall('xl/workbook.xml', wb);
        let rels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;
        for (let i = 1; i <= n; i += 1) rels += `<Relationship Id="rId${i}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
        rels += `<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
        await this.zip.addSmall('xl/_rels/workbook.xml.rels', rels);
        await this.zip.addSmall('xl/styles.xml', STYLES_XML);
        await this.zip.finish();
        return { rows: this.totalRows, sheets: n };
    }
}

module.exports = { XlsxWriter, ZipStream, crc32, xmlText, colName, excelSerialIST, MAX_SHEET_ROWS };
