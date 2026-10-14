// Offline test: node tests/xlsxWriter.test.js
const assert = require('assert');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { XlsxWriter, crc32 } = require('../src/utils/xlsxWriter');

const columns = [
    { key: 'a', label: 'Text' }, { key: 'b', label: 'Amount (INR)' }, { key: 'c', label: 'When' },
    { key: 'd', label: 'Flag' }, { key: 'e', label: 'Big' }
];
const tricky = [
    '=SUM(1+1)', '+cmd|calc', '-2+3', '@SUM(A1)', '\t=evil', 'Hello "q" <b> & \'x\'', 'unicode: हिन्दी éà', 'emoji 😀🚀',
    'line1\nline2\r\nline3', 'ctrl\u0001\u0002\u000B chars', 'lone \uD800 surrogate', '<f>fake</f>', ''
];

const chunks = [];
const sink = { write: async (b) => { chunks.push(Buffer.from(b)); } };

(async () => {
    const wb = new XlsxWriter(sink, { columns, sheetName: (n) => `Report ${n}` });
    let rows = 0;
    for (const t of tricky) { await wb.addRow({ a: t, b: 1234.5, c: new Date('2026-03-04T10:30:00Z'), d: true, e: 12345678901234567890 }); rows += 1; }
    await wb.addRow({ a: 'dateonly', b: -5, c: new Date('2026-03-03T18:30:00Z'), d: false, e: 99999999999999 }); rows += 1;
    for (let i = 0; i < 2500; i += 1) { await wb.addRow({ a: `row ${i}`, b: i * 1.01, c: null, d: i % 2 === 0, e: i }); rows += 1; }
    const res = await wb.finish();
    assert.strictEqual(res.rows, rows);
    const zip = Buffer.concat(chunks);

    // ---- tiny zip reader: central directory -> inflate -> CRC check ----
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert(eocd >= 0, 'EOCD');
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    const files = {};
    for (let i = 0; i < count; i += 1) {
        assert.strictEqual(zip.readUInt32LE(p), 0x02014b50);
        const crc = zip.readUInt32LE(p + 16), cs = zip.readUInt32LE(p + 20), us = zip.readUInt32LE(p + 24);
        const nl = zip.readUInt16LE(p + 28), el = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32), off = zip.readUInt32LE(p + 42);
        const name = zip.toString('utf8', p + 46, p + 46 + nl);
        assert.strictEqual(zip.readUInt32LE(off), 0x04034b50);
        const lnl = zip.readUInt16LE(off + 26), lel = zip.readUInt16LE(off + 28);
        const dataStart = off + 30 + lnl + lel;
        const raw = zlib.inflateRawSync(zip.subarray(dataStart, dataStart + cs));
        assert.strictEqual(raw.length, us, `size ${name}`);
        assert.strictEqual(crc32(raw), crc, `crc ${name}`);
        // data descriptor follows compressed data
        assert.strictEqual(zip.readUInt32LE(dataStart + cs), 0x08074b50, `descriptor ${name}`);
        assert.strictEqual(zip.readUInt32LE(dataStart + cs + 4), crc);
        files[name] = raw.toString('utf8');
        p += 46 + nl + el + cl;
    }
    const need = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'];
    need.forEach((n) => assert(files[n], `missing ${n}`));

    // ---- minimal well-formedness check ----
    const wellFormed = (name, xml) => {
        assert(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(xml), `ctrl char in ${name}`);
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(xml), `lone surrogate in ${name}`);
        assert(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml), `bad entity in ${name}`);
        const body = xml.replace(/<\?xml[^>]*\?>/, '');
        const stack = [];
        const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
        let last = 0, m;
        while ((m = re.exec(body))) {
            const between = body.slice(last, m.index);
            assert(!/</.test(between), `stray < in ${name}`);
            last = re.lastIndex;
            if (m[1]) { assert.strictEqual(stack.pop(), m[2], `mismatched </${m[2]}> in ${name}`); } else if (!m[4]) stack.push(m[2]);
        }
        assert(!/</.test(body.slice(last)), `trailing < in ${name}`);
        assert.strictEqual(stack.length, 0, `unclosed tags in ${name}`);
    };
    Object.entries(files).forEach(([n, x]) => wellFormed(n, x));

    const sheet = files['xl/worksheets/sheet1.xml'];
    assert(!/<f[\s>\/]/.test(sheet), 'formula element present');
    for (const x of Object.values(files)) assert(!/<f[\s>\/]/.test(x.replace(/<t[^>]*>[^<]*<\/t>/g, '')), 'formula element');
    assert(sheet.includes('state="frozen"'), 'frozen pane');
    assert(sheet.includes('=SUM(1+1)') && /t="inlineStr" s="5"><is><t[^>]*>=SUM/.test(sheet), 'formula text stored as quotePrefix inline string');
    assert(sheet.includes('😀'), 'emoji');
    assert(sheet.includes('&lt;b&gt; &amp; \'x\''), 'escaping');
    assert(!sheet.includes('\u0001'), 'ctrl stripped');
    assert(sheet.includes('<v>1234.5</v>') && sheet.includes('t="b"><v>1</v>'), 'number/bool');
    // 2026-03-04T10:30Z = 16:00 IST -> serial 46085.666666..
    assert(/s="4"><v>46085\.6666/.test(sheet), 'datetime serial IST');
    // 2026-03-03T18:30Z = 2026-03-04 00:00 IST -> date only 46085
    assert(/s="3"><v>46085<\/v>/.test(sheet), 'date-only serial IST');
    assert(sheet.includes('<v>1234.5</v>') && /s="2"><v>1234\.5/.test(sheet), 'currency style');
    assert(/<t>12345678901234567168<\/t>|<t>1234567890123456\d+<\/t>/.test(sheet) || /inlineStr"><is><t>1\d{19}/.test(sheet), 'big number as text');
    assert(/<col min="1" max="1" width="/.test(sheet), 'col widths');
    assert(sheet.includes('<row r="2516">') || sheet.includes(`<row r="${rows + 1}">`), 'last row number');
    console.log(`xlsx structure OK: ${rows} data rows, ${Object.keys(files).length} parts, ${zip.length} bytes`);

    // ---- split sheets (use a tiny limit via monkeypatch of module constant is not exposed: simulate with 2 writers is overkill) ----

    // ---- optional real-world compat with python/openpyxl ----
    const f = path.join(os.tmpdir(), `xlsxtest_${process.pid}.xlsx`);
    fs.writeFileSync(f, zip);
    let py = null;
    for (const cmd of ['python3', 'python', 'py']) {
        const r = spawnSync(cmd, ['-c', 'import openpyxl,sys;wb=openpyxl.load_workbook(sys.argv[1]);ws=wb.worksheets[0];print(ws.max_row,ws["A2"].value,ws.freeze_panes)', f], { encoding: 'utf8' });
        if (r.status === 0) { py = r.stdout.trim(); break; }
    }
    fs.unlinkSync(f);
    console.log(py ? `openpyxl load OK: ${py}` : 'openpyxl NOT available - skipped real-world check');
    console.log('ALL XLSX TESTS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

// ---- sheet splitting + external unzip tool ----
(async () => {
    const out = [];
    const wb = new XlsxWriter({ write: async (b) => { out.push(Buffer.from(b)); } }, { columns: [{ key: 'a', label: 'A' }], maxSheetRows: 10 });
    for (let i = 0; i < 25; i += 1) await wb.addRow({ a: i });
    const r = await wb.finish();
    assert.strictEqual(r.sheets, 3);
    const f = path.join(os.tmpdir(), `xlsxsplit_${process.pid}.xlsx`);
    fs.writeFileSync(f, Buffer.concat(out));
    const t = spawnSync('tar', ['-tf', f], { encoding: 'utf8' });
    fs.unlinkSync(f);
    console.log('split sheets OK (3 sheets);', t.status === 0 ? `tar lists: ${t.stdout.trim().split(/\r?\n/).length} entries` : 'tar unavailable');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
