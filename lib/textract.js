'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/* Page markers are kept in the text so every extracted fact can point back at
   a page number. That is what makes the output reviewable instead of a
   black box — your engineer verifies in seconds instead of re-reading. */
const PAGE = n => `\n<<<PAGE ${n}>>>\n`;

async function fromPdf(buf) {
  const mod = require('pdf-parse');

  /* pdf-parse v2 exports a PDFParse class and returns a per-page array.
     v1 exported a callable function and needed a pagerender hook to keep
     page boundaries. Support both, so this keeps working either way. */
  if (mod && typeof mod.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: buf });
    try {
      const r = await parser.getText();
      const pages = Array.isArray(r.pages) ? r.pages : [];
      if (pages.length) {
        const text = pages
          .map(p => PAGE(p.num ?? 0) + (p.text || ''))
          .join('');
        return { text, pages: r.total || pages.length };
      }
      return { text: r.text || '', pages: r.total || 0 };
    } finally {
      try { await parser.destroy(); } catch { /* nothing useful to do */ }
    }
  }

  /* v1 fallback */
  const pdfParse = typeof mod === 'function' ? mod : mod.default;
  if (typeof pdfParse !== 'function') {
    throw new Error('pdf-parse is installed but exports neither PDFParse nor a callable — check the installed version.');
  }
  let page = 0;
  const data = await pdfParse(buf, {
    pagerender: async (pageData) => {
      page++;
      const tc = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      let last = -1, out = '';
      for (const item of tc.items) {
        if (last !== -1 && Math.abs(last - item.transform[5]) > 3) out += '\n';
        out += item.str + ' ';
        last = item.transform[5];
      }
      return PAGE(page) + out;
    }
  });
  return { text: data.text || '', pages: data.numpages || page };
}

async function fromDocx(buf) {
  const mammoth = require('mammoth');
  const r = await mammoth.extractRawText({ buffer: buf });
  return { text: r.value || '', pages: 0 };
}

function fromSpreadsheet(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  let text = '', n = 0;
  for (const name of wb.SheetNames) {
    n++;
    text += PAGE(n) + `SHEET: ${name}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
  }
  return { text, pages: n };
}

async function extractText(filePath, originalName) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(originalName || filePath).toLowerCase();
  let res;
  if (ext === '.pdf') res = await fromPdf(buf);
  else if (ext === '.docx' || ext === '.doc') res = await fromDocx(buf);
  else if (['.xlsx', '.xls', '.csv'].includes(ext)) res = fromSpreadsheet(buf);
  else res = { text: buf.toString('utf8'), pages: 0 };

  const text = (res.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const perPage = res.pages ? text.length / res.pages : text.length;
  return {
    text,
    pages: res.pages,
    chars: text.length,
    /* A scanned tender comes back nearly empty. Say so plainly instead of
       running an extraction over nothing. */
    needsOcr: res.pages > 2 && perPage < 120
  };
}

module.exports = { extractText };
