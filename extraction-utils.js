/* Shared, dependency-free extraction rules. Works in a browser and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExtractionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cleanText(text) {
    // Keep digits, punctuation, spelling, tabs and paragraph breaks as recognized.
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
      .replace(/[ \t]+$/gm, '').trim();
  }

  function readableText(text) {
    const value = cleanText(text);
    if (!/[\p{L}\p{N}]/u.test(value)) return false;
    const bad = value.match(/[\uFFFD\uE000-\uF8FF\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || [];
    return bad.length / Math.max(1, value.length) < 0.02;
  }

  function transformPoint(matrix, x, y) {
    return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
  }

  function textFromPage(items, viewportMatrix = [1, 0, 0, -1, 0, 0]) {
    const positioned = items.filter(item => typeof item.str === 'string' && item.str && item.transform?.length === 6).map(item => {
      const t = item.transform;
      const start = transformPoint(viewportMatrix, t[4], t[5]);
      const magnitude = Math.hypot(t[0], t[1]) || 1;
      const end = transformPoint(viewportMatrix, t[4] + (item.width || 0) * t[0] / magnitude, t[5] + (item.width || 0) * t[1] / magnitude);
      const top = transformPoint(viewportMatrix, t[4] + t[2], t[5] + t[3]);
      return { text: item.str, x: Math.min(start.x, end.x), right: Math.max(start.x, end.x), y: start.y,
        height: Math.max(1, Math.hypot(top.x - start.x, top.y - start.y)), dir: item.dir };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const item of positioned) {
      let row = rows[rows.length - 1];
      if (!row || Math.abs(row.y - item.y) > Math.max(2, Math.min(row.height, item.height) * 0.4)) {
        row = { y: item.y, height: item.height, items: [] };
        rows.push(row);
      }
      row.items.push(item);
      row.height = Math.max(row.height, item.height);
    }
    let result = '';
    let previousRow = null;
    for (const row of rows) {
      const rtl = row.items.filter(item => item.dir === 'rtl').length > row.items.length / 2;
      row.items.sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
      let line = '';
      let previous = null;
      for (const item of row.items) {
        const gap = previous ? (rtl ? previous.x - item.right : item.x - previous.right) : 0;
        // Adjacent PDF glyphs stay adjacent; distant cells retain a tab separator.
        if (previous && !/\s$/u.test(line) && !/^\s/u.test(item.text)) {
          if (gap > Math.max(previous.height, item.height) * 3) line += '\t';
          else if (gap > Math.min(previous.height, item.height) * 0.15) line += ' ';
        }
        line += item.text;
        previous = item;
      }
      if (previousRow) result += row.y - previousRow.y > Math.max(row.height, previousRow.height) * 1.8 ? '\n\n' : '\n';
      result += line;
      previousRow = row;
    }
    return cleanText(result).replace(/[\uFB00-\uFB06]/g, glyph => ['ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st'][glyph.charCodeAt(0) - 0xFB00]);
  }

  function analyzeOCR(data) {
    const words = [];
    for (const block of data.blocks || []) for (const paragraph of block.paragraphs || [])
      for (const line of paragraph.lines || []) for (const word of line.words || []) {
        if (word.text?.trim()) words.push({ text: word.text, confidence: Number.isFinite(word.confidence) ? word.confidence : 0 });
      }
    const total = words.reduce((sum, word) => sum + word.text.length, 0);
    const confidence = total ? words.reduce((sum, word) => sum + word.confidence * word.text.length, 0) / total
      : (Number.isFinite(data.confidence) ? data.confidence : 0);
    return { text: cleanText(data.text), confidence, words, uncertain: words.filter(word => word.confidence < 80) };
  }

  function candidateScore(candidate) {
    if (!readableText(candidate.text)) return -Infinity;
    const chars = (candidate.text.match(/[\p{L}\p{N}]/gu) || []).length;
    return candidate.confidence - 12 * candidate.uncertain.length / Math.max(1, candidate.words.length)
      + Math.min(8, Math.log2(chars + 1));
  }

  function chooseCandidate(candidates) {
    const viable = candidates.filter(candidate => readableText(candidate.text));
    if (!viable.length) return candidates[0] || analyzeOCR({});
    let best = viable.reduce((a, b) => candidateScore(b) > candidateScore(a) ? b : a);
    // Do not trade a whole paragraph for a short, confident fragment.
    for (const candidate of viable) {
      if (candidate.text.length > best.text.length * 1.5 && candidate.confidence >= best.confidence - 10 && candidate.confidence >= 70) best = candidate;
    }
    return best;
  }

  function normalized(text) {
    return cleanText(text).normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  function similarity(left, right) {
    const a = normalized(left), b = normalized(right);
    if (a === b) return 1;
    if (a.length < 3 || b.length < 3) return 0;
    const counts = new Map();
    for (let i = 0; i < a.length - 1; i++) { const key = a.slice(i, i + 2); counts.set(key, (counts.get(key) || 0) + 1); }
    let common = 0;
    for (let i = 0; i < b.length - 1; i++) { const key = b.slice(i, i + 2); if (counts.get(key) > 0) { common++; counts.set(key, counts.get(key) - 1); } }
    return 2 * common / (a.length + b.length - 2);
  }

  function mergeHybrid(nativeText, ocrText) {
    const lines = cleanText(ocrText).split('\n');
    const missing = [];
    const replaced = new Set();
    for (const nativeLine of cleanText(nativeText).split('\n').filter(line => line.trim())) {
      // Printed labels can share a line with handwritten values. Never replace
      // that whole OCR line with the shorter selectable label.
      let contained = false;
      const needle = normalized(nativeLine);
      for (let i = 0; i < lines.length; i++) {
        if (normalized(lines[i]).includes(needle)) { contained = true; break; }
      }
      if (contained) continue;
      let bestIndex = -1, bestScore = 0;
      for (let i = 0; i < lines.length; i++) {
        if (replaced.has(i)) continue;
        const score = similarity(nativeLine, lines[i]);
        if (score > bestScore) { bestIndex = i; bestScore = score; }
      }
      const matched = bestIndex >= 0 ? normalized(lines[bestIndex]) : '';
      const sameNumbers = (matched.match(/\p{N}+/gu) || []).join('|') === (needle.match(/\p{N}+/gu) || []).join('|');
      if (bestScore >= 0.78 && matched.length <= needle.length && matched.split(' ').length <= needle.split(' ').length && sameNumbers) {
        lines[bestIndex] = nativeLine; replaced.add(bestIndex);
      }
      else missing.push(nativeLine);
    }
    const text = cleanText(lines.join('\n'));
    return { text: missing.length ? `${text}${text ? '\n\n' : ''}[Additional selectable text]\n${missing.join('\n')}` : text, missing: missing.length };
  }

  function formatBatch(documents) {
    return documents.map((document, index) => {
      const pages = [];
      for (let page = 1; page <= Math.max(document.pageCount || 1, document.reports.length); page++) {
        const report = document.reports.find(report => report.page === page);
        const text = report?.edited ? report.text : report?.text || (report?.failed ? '[This page could not be read]'
          : report ? '[No text found on this page]'
          : document.error ? `[${document.error}]` : '[Not extracted yet]');
        pages.push(`— Page ${page} —\n${text}`);
      }
      return `=== File ${index + 1}: ${document.file.name} ===\n${pages.join('\n\n')}`;
    }).join('\n\n\n');
  }

  /* ---- Invoice fields, product list and price verification ---- */

  const NOT_FOUND = 'Not found';
  const NAME_COLUMNS = ['product name', 'product', 'item name', 'item', 'description', 'particulars', 'particular', 'goods', 'medicine', 'material', 'commodity', 'sku', 'brand', 'name'];
  const PRICE_COLUMNS = ['selling price', 'unit price', 'sale price', 'rate', 'price', 'mrp', 'amount', 'value', 'cost'];
  const AUTO_MATCH = 0.9;
  const SUGGEST_MATCH = 0.62;

  function isNotFound(value) {
    if (value === null || value === undefined) return true;
    const text = String(value).trim().toLocaleLowerCase();
    return !text || ['not found', 'n/a', 'na', 'nil', 'none', '-', '—'].includes(text);
  }

  function valueOrNotFound(value) {
    return isNotFound(value) ? NOT_FOUND : String(value).trim();
  }

  function parseAmount(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value === null || value === undefined) return null;
    let text = String(value).trim();
    if (isNotFound(text)) return null;
    text = text.replace(/[^\d.,-]/g, '');
    if (!text) return null;
    const lastDot = text.lastIndexOf('.'), lastComma = text.lastIndexOf(',');
    const decimal = lastDot > lastComma ? '.' : lastComma > lastDot ? ',' : '';
    if (decimal) {
      const integer = text.slice(0, text.lastIndexOf(decimal)).replace(/[.,]/g, '');
      const fraction = text.slice(text.lastIndexOf(decimal) + 1).replace(/[.,]/g, '');
      text = `${integer}.${fraction}`;
    } else text = text.replace(/[.,]/g, '');
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function parseDelimitedRows(text, delimiter) {
    const input = String(text ?? '').replace(/\r\n?/g, '\n');
    if (!input.trim()) return [];
    let separator = delimiter;
    if (!separator) {
      const line = input.split('\n', 1)[0];
      const counts = [',', '\t', ';', '|'].map(candidate => ({ candidate, count: line.split(candidate).length - 1 }));
      separator = counts.reduce((a, b) => b.count > a.count ? b : a).candidate;
    }
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (quoted) {
        if (char === '"') {
          if (input[index + 1] === '"') { field += '"'; index++; }
          else quoted = false;
        } else field += char;
      } else if (char === '"' && !field) quoted = true;
      else if (char === separator) { row.push(field); field = ''; }
      else if (char === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else field += char;
    }
    row.push(field);
    rows.push(row);
    return rows.filter(cells => cells.some(cell => String(cell).trim()));
  }

  function detectCatalogColumns(headers) {
    const cells = (Array.isArray(headers) ? headers : []).map(normalizeName);
    const pick = (words, exclude) => {
      let bestIndex = -1, bestRank = Infinity;
      cells.forEach((cell, index) => {
        if (!cell || index === exclude) return;
        const rank = words.findIndex(word => cell === word || cell.includes(word));
        if (rank >= 0 && rank < bestRank) { bestRank = rank; bestIndex = index; }
      });
      return bestIndex;
    };
    const nameColumn = pick(NAME_COLUMNS);
    const priceColumn = pick(PRICE_COLUMNS, nameColumn);
    return { nameColumn, priceColumn };
  }

  function detectCatalogTable(matrix) {
    const rows = (Array.isArray(matrix) ? matrix : []).filter(Array.isArray);
    for (let index = 0; index < Math.min(rows.length, 5); index++) {
      const columns = detectCatalogColumns(rows[index]);
      if (columns.nameColumn >= 0 || columns.priceColumn >= 0) {
        return { headerRow: index, headers: rows[index].map(cell => String(cell ?? '')), nameColumn: columns.nameColumn, priceColumn: columns.priceColumn };
      }
    }
    return { headerRow: -1, headers: [], nameColumn: -1, priceColumn: -1 };
  }

  function catalogFromMatrix(matrix, { headerRow = 0, nameColumn = 0, priceColumn = -1 } = {}) {
    const rows = Array.isArray(matrix) ? matrix : [];
    const products = [];
    if (nameColumn < 0) return products;
    for (let index = Math.max(0, headerRow) + 1; index < rows.length; index++) {
      const row = rows[index];
      if (!Array.isArray(row)) continue;
      const name = String(row[nameColumn] ?? '').trim();
      if (!name || name.length > 200) continue;
      products.push({ name, price: priceColumn >= 0 ? parseAmount(row[priceColumn]) : null });
      if (products.length >= 20000) break;
    }
    return products;
  }

  function normalizeName(text) {
    return String(text ?? '').normalize('NFKD').replace(/\p{M}+/gu, '')
      .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }

  function confusionKey(text) {
    return String(text ?? '')
      .replace(/[oO0]/g, '0').replace(/[iIlL1]/g, '1')
      .replace(/[sS5]/g, '5').replace(/[bB8]/g, '8');
  }

  function levenshtein(left, right) {
    if (left === right) return 0;
    const width = right.length + 1;
    let previous = Array.from({ length: width }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
      const current = [i];
      for (let j = 1; j <= right.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return previous[right.length];
  }

  function rawEditSimilarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const longest = Math.max(left.length, right.length);
    if (longest < 3) return 0;
    return Math.max(0, 1 - levenshtein(left, right) / longest);
  }

  function editSimilarity(left, right) {
    return rawEditSimilarity(normalizeName(left), normalizeName(right));
  }

  function productKey(name) {
    const norm = normalizeName(name);
    const tokens = norm.split(' ').filter(Boolean);
    return { norm, confused: confusionKey(norm), tokens, alphaTokens: tokens.filter(token => token.length >= 3 && /[^\d]/.test(confusionKey(token))) };
  }

  function scoreKeys(a, b) {
    if (!a.norm || !b.norm) return 0;
    let score = Math.max(
      similarity(a.norm, b.norm),
      rawEditSimilarity(a.norm, b.norm),
      similarity(a.confused, b.confused),
      rawEditSimilarity(a.confused, b.confused)
    );
    if (a.alphaTokens.length) {
      let total = 0;
      for (const token of a.alphaTokens) {
        let best = 0;
        for (const other of b.tokens) {
          const value = Math.max(similarity(token, other), rawEditSimilarity(token, other),
            rawEditSimilarity(confusionKey(token), confusionKey(other)));
          if (value > best) best = value;
        }
        total += best;
      }
      const coverage = total / a.alphaTokens.length;
      const tokenScore = coverage >= 0.9 ? 0.9 + 0.1 * coverage : coverage * 0.9;
      score = Math.max(score, tokenScore);
    }
    return Math.min(1, score);
  }

  function catalogScore(scannedName, productName) {
    return scoreKeys(productKey(scannedName), productKey(productName));
  }

  function prepareCatalog(products) {
    return (Array.isArray(products) ? products : []).map(product => ({
      name: String(product?.name ?? '').trim(),
      price: typeof product?.price === 'number' && Number.isFinite(product.price) ? product.price : parseAmount(product?.price),
      key: productKey(product?.name)
    })).filter(product => product.name && product.key.norm);
  }

  function appendNote(existing, extra) {
    return existing ? `${existing} ${extra}` : extra;
  }

  function parsedRate(rate, amount, quantity) {
    const rateValue = parseAmount(rate);
    if (rateValue !== null) return rateValue;
    const amountValue = parseAmount(amount);
    if (amountValue === null) return null;
    const quantityValue = parseAmount(quantity);
    return quantityValue !== null && quantityValue > 1 ? amountValue / quantityValue : amountValue;
  }

  function matchLineGst(item) {
    const rate = valueOrNotFound(item?.gst_rate);
    const amount = valueOrNotFound(item?.gst_amount);
    if (!isNotFound(rate) && !isNotFound(amount)) return `${rate} (${amount})`;
    if (!isNotFound(rate)) return rate;
    return amount;
  }

  function matchItem(item, prepared, priceTolerance) {
    const description = valueOrNotFound(item?.description);
    const result = {
      description,
      quantity: valueOrNotFound(item?.quantity),
      rate: valueOrNotFound(item?.rate),
      amount: valueOrNotFound(item?.amount),
      gst: matchLineGst(item),
      matchedName: '',
      matchScore: 0,
      matchStatus: 'no-list',
      note: ''
    };
    if (!prepared.length) return result;
    if (isNotFound(description)) {
      result.matchStatus = 'verify';
      result.note = 'Product name not found on the invoice — check the scan.';
      return result;
    }
    const key = productKey(description);
    let best = null;
    for (const product of prepared) {
      const score = scoreKeys(key, product.key);
      if (!best || score > best.score) best = { product, score };
    }
    result.matchScore = best.score;
    if (best.score >= AUTO_MATCH) {
      result.matchedName = best.product.name;
      result.matchStatus = 'matched';
    } else if (best.score >= SUGGEST_MATCH) {
      result.matchedName = best.product.name;
      result.matchStatus = 'verify';
      result.note = `Closest match: “${best.product.name}” (${Math.round(best.score * 100)}% similar) — check.`;
    } else {
      result.matchedName = NOT_FOUND;
      result.matchStatus = 'not-matched';
      result.note = 'Not found in your product list.';
      return result;
    }
    if (!Number.isFinite(best.product.price)) {
      result.matchStatus = 'verify';
      result.note = appendNote(result.note, 'No price for this product in your list.');
      return result;
    }
    const rateValue = parsedRate(result.rate, result.amount, result.quantity);
    if (rateValue === null) {
      result.matchStatus = 'verify';
      result.note = appendNote(result.note, 'Rate not found on the invoice.');
    } else {
      const difference = Math.abs(rateValue - best.product.price);
      if (Math.round(rateValue * 100) !== Math.round(best.product.price * 100) && difference > priceTolerance) {
        result.matchStatus = 'price-mismatch';
        result.note = appendNote(result.note, `Rate ₹${rateValue.toFixed(2)} differs from your list price ₹${best.product.price.toFixed(2)}.`);
      }
    }
    return result;
  }

  function matchInvoice(invoice, catalog, options = {}) {
    const prepared = prepareCatalog(catalog);
    const priceTolerance = Number.isFinite(options.priceTolerance) ? options.priceTolerance : 0;
    const items = Array.isArray(invoice?.items) ? invoice.items : [];
    const results = items.map(item => matchItem(item, prepared, priceTolerance));
    const flagged = results.filter(result => !['matched', 'no-list'].includes(result.matchStatus));
    return {
      items: results,
      hasCatalog: prepared.length > 0,
      total: results.length,
      matched: results.filter(result => result.matchStatus === 'matched').length,
      flagged: flagged.length,
      verified: prepared.length > 0 && results.length > 0 && flagged.length === 0
    };
  }

  function invoiceGstSummary(gst) {
    if (!gst) return NOT_FOUND;
    const parts = [];
    if (!isNotFound(gst.rate)) parts.push(String(gst.rate).trim());
    if (!isNotFound(gst.cgst)) parts.push(`CGST ${valueOrNotFound(gst.cgst)}`);
    if (!isNotFound(gst.sgst)) parts.push(`SGST ${valueOrNotFound(gst.sgst)}`);
    if (!isNotFound(gst.igst)) parts.push(`IGST ${valueOrNotFound(gst.igst)}`);
    if (!isNotFound(gst.amount)) parts.push(`Total ${valueOrNotFound(gst.amount)}`);
    return parts.length ? parts.join(' | ') : NOT_FOUND;
  }

  function invoiceExportHeaders() {
    return ['Store Name', 'Address', 'State', 'Invoice No', 'Customer Name', 'Mobile',
      'Product Name / Description', 'Quantity', 'Rate / Total', 'GST',
      'Payable Amount', 'Payable Account', 'Match Status', 'Needs Manual Verification'];
  }

  function invoiceExportRow(invoice, match) {
    const store = invoice?.store || {};
    const invoiceInfo = invoice?.invoice || {};
    const customer = invoice?.customer || {};
    const payable = invoice?.payable || {};
    const results = Array.isArray(match?.items) ? match.items : [];
    const products = [], quantities = [], rates = [], taxes = [];
    for (const item of results) {
      products.push(isNotFound(item.matchedName) ? item.description : item.matchedName);
      quantities.push(item.quantity);
      rates.push(isNotFound(item.rate) ? item.amount : item.rate);
      taxes.push(item.gst);
    }
    if (!products.length) {
      products.push(NOT_FOUND); quantities.push(NOT_FOUND); rates.push(NOT_FOUND);
    }
    const taxCell = taxes.some(value => !isNotFound(value)) ? taxes.join('\n') : invoiceGstSummary(invoice?.gst);
    const flagged = results.filter(item => ['verify', 'price-mismatch', 'not-matched'].includes(item.matchStatus));
    const verificationCell = !match?.hasCatalog
      ? 'Upload a product list to verify'
      : flagged.length
        ? flagged.map(item => `• ${isNotFound(item.description) ? NOT_FOUND : item.description}: ${item.note || 'check manually'}`).join('\n')
        : 'None';
    const statusCell = !match?.hasCatalog ? 'No product list — not verified'
      : flagged.length ? `${flagged.length} of ${match.total} need manual check`
        : 'All verified';
    return [
      valueOrNotFound(store.name),
      valueOrNotFound(store.address),
      valueOrNotFound(store.state),
      valueOrNotFound(invoiceInfo.number),
      valueOrNotFound(customer.name),
      valueOrNotFound(customer.mobile),
      products.join('\n'),
      quantities.join('\n'),
      rates.join('\n'),
      isNotFound(taxCell) ? NOT_FOUND : taxCell,
      valueOrNotFound(payable.amount),
      valueOrNotFound(payable.account),
      statusCell,
      verificationCell
    ];
  }

  return { cleanText, readableText, textFromPage, analyzeOCR, candidateScore, chooseCandidate, similarity, mergeHybrid, formatBatch, isNotFound, valueOrNotFound, parseAmount, parseDelimitedRows, detectCatalogColumns, detectCatalogTable, catalogFromMatrix, normalizeName, confusionKey, editSimilarity, catalogScore, prepareCatalog, matchInvoice, invoiceExportHeaders, invoiceExportRow };
});
