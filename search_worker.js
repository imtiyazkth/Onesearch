/**
 * OneSearch v3 — search.worker.js
 * Runs entirely off the main thread.
 *
 * Features:
 *   • BM25 ranking (k1=1.5, b=0.75)
 *   • Exact phrase search (quoted strings)
 *   • Prefix match
 *   • Substring match (3+ char tokens)
 *   • Fuzzy search via Levenshtein edit distance
 *   • Live suggestions with category grouping
 *   • Typo correction ("did you mean?")
 *   • Field-weighted scoring: name > subject > sender > folder > body
 *
 * Message protocol (main → worker):
 *   { type:'BUILD',       docs:[...] }
 *   { type:'ADD',         doc:{...}  }
 *   { type:'REMOVE',      id:'...'   }
 *   { type:'SEARCH',      id, query, filters, page, pageSize }
 *   { type:'SUGGEST',     id, query, limit }
 *
 * Message protocol (worker → main):
 *   { type:'READY'                                              }
 *   { type:'BUILD_DONE',   size                                }
 *   { type:'SEARCH_DONE',  id, results, total, page, totalPages, elapsed, correction }
 *   { type:'SUGGEST_DONE', id, suggestions                     }
 *   { type:'ERROR',        message                             }
 */

'use strict';

/* ─── Index data structures ──────────────────────────────────── */
const docs       = new Map();   // id → document
const index      = new Map();   // token → Map<id, tf>
const fieldCache = new Map();   // id → { tokens, len, name, subject, sender, folder }

/* ─── BM25 constants ─────────────────────────────────────────── */
const K1 = 1.5;
const B  = 0.75;

const DEFAULT_PAGE = 20;

/* ═══════════════════════════════════════════════════════════════
   MESSAGE HANDLER
   ═══════════════════════════════════════════════════════════════ */
self.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'BUILD':   handleBuild(msg.docs ?? []);  break;
      case 'ADD':     if (msg.doc) addDoc(msg.doc); break;
      case 'REMOVE':  if (msg.id)  removeDoc(msg.id); break;
      case 'SEARCH':  handleSearch(msg); break;
      case 'SUGGEST': handleSuggest(msg); break;
      default:
        self.postMessage({ type:'ERROR', message:`Unknown type: ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ type:'ERROR', message: err.message });
  }
};

/* ═══════════════════════════════════════════════════════════════
   BUILD
   ═══════════════════════════════════════════════════════════════ */
function handleBuild(docArray) {
  docs.clear();
  index.clear();
  fieldCache.clear();
  for (const doc of docArray) _indexDoc(doc);
  self.postMessage({ type:'BUILD_DONE', size: docs.size });
}

function addDoc(doc) {
  if (docs.has(doc.id)) removeDoc(doc.id);
  _indexDoc(doc);
}

function removeDoc(id) {
  const cache = fieldCache.get(id);
  if (cache) {
    for (const token of cache.tokens) {
      const p = index.get(token);
      if (p) { p.delete(id); if (!p.size) index.delete(token); }
    }
  }
  docs.delete(id);
  fieldCache.delete(id);
}

function _indexDoc(doc) {
  docs.set(doc.id, doc);
  const text   = extractText(doc);
  const tokens = tokenise(text);
  const tset   = new Set(tokens);

  fieldCache.set(doc.id, {
    tokens:  tset,
    len:     tokens.length,
    name:    (doc.name    ?? '').toLowerCase(),
    subject: (doc.subject ?? '').toLowerCase(),
    sender:  (doc.sender  ?? '').toLowerCase(),
    folder:  (doc.folder  ?? '').toLowerCase(),
    account: (doc.account ?? '').toLowerCase(),
  });

  for (const token of tokens) {
    if (!index.has(token)) index.set(token, new Map());
    const p = index.get(token);
    p.set(doc.id, (p.get(doc.id) ?? 0) + 1);
  }
}

/* ═══════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════ */
function handleSearch({ id, query, filters = {}, page = 1, pageSize = DEFAULT_PAGE }) {
  const t0 = performance.now();
  const q  = (query ?? '').trim();

  let candidates;
  let correction = null;

  if (!q) {
    candidates = [...docs.values()].map(doc => ({ doc, score: 1 }));
  } else {
    candidates = scoreDocs(q);

    // Typo correction: if few results, suggest correction
    if (candidates.length < 3 && q.length >= 4) {
      const corrected = typoCorrect(q);
      if (corrected && corrected !== q) {
        const altCandidates = scoreDocs(corrected);
        if (altCandidates.length > candidates.length) {
          correction = corrected;
          // Merge — corrected results go after exact
          const existingIds = new Set(candidates.map(c => c.doc.id));
          for (const c of altCandidates) {
            if (!existingIds.has(c.doc.id)) candidates.push({ ...c, score: c.score * 0.85 });
          }
        }
      }
    }
  }

  candidates = applyFilters(candidates, filters);
  candidates = sortResults(candidates, filters.sort ?? 'relevance', !!q);

  const total      = candidates.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage   = Math.max(1, Math.min(page, totalPages));
  const start      = (safePage - 1) * pageSize;
  const results    = candidates.slice(start, start + pageSize).map(c => c.doc);
  const elapsed    = Math.round(performance.now() - t0);

  self.postMessage({ type:'SEARCH_DONE', id, results, total, page: safePage, totalPages, elapsed, correction });
}

/* ─── Scoring ────────────────────────────────────────────────── */
function scoreDocs(query) {
  const isExact = query.startsWith('"') && query.endsWith('"');
  const cleanQ  = isExact ? query.slice(1, -1).toLowerCase() : query.toLowerCase();
  const qTokens = tokenise(cleanQ);
  if (!qTokens.length) return [];

  const N    = docs.size;
  const avgL = avgDocLen();

  // Collect candidates
  const candidateIds = new Set();
  for (const token of qTokens) {
    // Exact token
    index.get(token)?.forEach((_, id) => candidateIds.add(id));

    if (!isExact) {
      for (const [iToken, posting] of index) {
        if (iToken === token) continue;
        if (iToken.startsWith(token) || (token.length >= 3 && iToken.includes(token))) {
          posting.forEach((_, id) => candidateIds.add(id));
        }
        // Fuzzy match for longer tokens
        if (token.length >= 4 && levenshtein(token, iToken) <= 1) {
          posting.forEach((_, id) => candidateIds.add(id));
        }
      }
    }
  }

  const scored = [];

  for (const id of candidateIds) {
    const doc   = docs.get(id);
    if (!doc) continue;
    const cache = fieldCache.get(id);
    const docL  = cache?.len ?? 1;

    if (isExact) {
      const full = extractText(doc).toLowerCase();
      if (!full.includes(cleanQ)) continue;
      scored.push({ doc, score: 1000 + (cache?.name.includes(cleanQ) ? 500 : 0) });
      continue;
    }

    let score = 0;

    // BM25
    for (const token of qTokens) {
      const posting = index.get(token);
      const df  = posting?.size ?? 0;
      if (!df) continue;
      const tf    = posting.get(id) ?? 0;
      const idf   = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const tfNrm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docL / avgL)));
      score += idf * tfNrm;
    }

    // Field boosts
    if (cache) {
      for (const token of qTokens) {
        if (cache.name.includes(token))    score += 15;
        if (cache.subject.includes(token)) score += 12;
        if (cache.sender.includes(token))  score += 8;
        if (cache.folder.includes(token))  score += 5;
      }
      if (cache.name.includes(cleanQ))    score *= 4;
      if (cache.subject.includes(cleanQ)) score *= 3;
    }

    if (score > 0) scored.push({ doc, score });
  }

  return scored;
}

/* ─── Filters ────────────────────────────────────────────────── */
function applyFilters(candidates, { source, account, type, dateFrom, dateTo }) {
  return candidates.filter(({ doc }) => {
    if (source  && source  !== 'all' && doc.source  !== source)  return false;
    if (account && account !== 'all' && doc.account !== account) return false;
    if (type    && type    !== 'all' && doc.type    !== type)     return false;
    if (dateFrom && new Date(doc.modified ?? 0) < new Date(dateFrom)) return false;
    if (dateTo   && new Date(doc.modified ?? 0) > new Date(dateTo + 'T23:59:59')) return false;
    return true;
  });
}

/* ─── Sort ───────────────────────────────────────────────────── */
function sortResults(candidates, sortKey, hasQuery) {
  return candidates.sort((a, b) => {
    switch (sortKey) {
      case 'date-desc': return new Date(b.doc.modified ?? 0) - new Date(a.doc.modified ?? 0);
      case 'date-asc':  return new Date(a.doc.modified ?? 0) - new Date(b.doc.modified ?? 0);
      case 'name-asc':  return (a.doc.name ?? '').localeCompare(b.doc.name ?? '');
      case 'name-desc': return (b.doc.name ?? '').localeCompare(a.doc.name ?? '');
      case 'size-desc': return (b.doc.size ?? 0) - (a.doc.size ?? 0);
      default:
        if (hasQuery && b.score !== a.score) return b.score - a.score;
        return new Date(b.doc.modified ?? 0) - new Date(a.doc.modified ?? 0);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   SUGGESTIONS
   ═══════════════════════════════════════════════════════════════ */
function handleSuggest({ id, query, limit = 8 }) {
  const q = (query ?? '').trim().toLowerCase();
  if (q.length < 2) {
    self.postMessage({ type:'SUGGEST_DONE', id, suggestions: [] });
    return;
  }

  const seen       = new Set();
  const suggestions = [];

  // Category prefix commands
  const prefixMap = {
    'gmail:':  'gmail',
    'drive:':  'drive',
    'photos:': 'photos',
    'sheet:':  'sheets',
    'local:':  'local',
  };

  let filterSource = null;
  let cleanQuery   = q;
  for (const [prefix, src] of Object.entries(prefixMap)) {
    if (q.startsWith(prefix)) {
      filterSource = src;
      cleanQuery   = q.slice(prefix.length);
      break;
    }
  }

  const tokens = tokenise(cleanQuery);
  if (!tokens.length) {
    self.postMessage({ type:'SUGGEST_DONE', id, suggestions: [] });
    return;
  }

  // Score all docs for suggestion
  const candidateIds = new Set();
  for (const token of tokens) {
    for (const [iToken, posting] of index) {
      if (iToken.startsWith(token) || iToken.includes(token)) {
        posting.forEach((_, docId) => candidateIds.add(docId));
      }
    }
  }

  const scored = [];
  for (const docId of candidateIds) {
    const doc = docs.get(docId);
    if (!doc) continue;
    if (filterSource && doc.source !== filterSource) continue;
    const cache = fieldCache.get(docId);
    let score = 0;
    for (const token of tokens) {
      if (cache?.name.includes(token))    score += 10;
      if (cache?.subject.includes(token)) score += 8;
      if (cache?.folder.includes(token))  score += 4;
    }
    if (score > 0) scored.push({ doc, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const sourceIcons = { drive:'📄', photos:'🖼', gmail:'📧', sheets:'📊', local:'💾' };
  const sourceLabels = { drive:'Drive', photos:'Photos', gmail:'Gmail', sheets:'Sheets', local:'Local' };

  for (const { doc } of scored) {
    if (suggestions.length >= limit) break;

    const key = `${doc.source}::${doc.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    suggestions.push({
      id:      doc.id,
      text:    doc.name ?? doc.subject ?? 'Untitled',
      sub:     doc.subject && doc.source === 'gmail' ? doc.sender : (doc.folder ?? doc.account ?? ''),
      source:  doc.source,
      type:    doc.type,
      icon:    sourceIcons[doc.source] ?? '📄',
      label:   sourceLabels[doc.source] ?? doc.source,
      account: doc.account,
    });
  }

  // Typo correction suggestion
  if (suggestions.length === 0 && cleanQuery.length >= 4) {
    const corrected = typoCorrect(cleanQuery);
    if (corrected && corrected !== cleanQuery) {
      suggestions.push({
        id:         '__correction__',
        text:       corrected,
        sub:        'Did you mean?',
        source:     'correction',
        type:       'correction',
        icon:       '🔍',
        label:      'Suggestion',
        correction: true,
      });
    }
  }

  self.postMessage({ type:'SUGGEST_DONE', id, suggestions });
}

/* ═══════════════════════════════════════════════════════════════
   FUZZY / TYPO CORRECTION
   ═══════════════════════════════════════════════════════════════ */

/**
 * Levenshtein edit distance between two strings.
 * Capped at maxDist for performance.
 */
function levenshtein(a, b, maxDist = 2) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

/**
 * Finds the closest indexed token to the given query token.
 * Returns a corrected full query string or null.
 */
function typoCorrect(query) {
  const tokens     = tokenise(query);
  const corrected  = [];
  let   anyChange  = false;

  for (const token of tokens) {
    if (token.length < 4) { corrected.push(token); continue; }
    if (index.has(token)) { corrected.push(token); continue; }

    let bestToken = null;
    let bestDist  = 2; // max edit distance

    for (const iToken of index.keys()) {
      if (Math.abs(iToken.length - token.length) > 2) continue;
      const d = levenshtein(token, iToken, bestDist);
      if (d < bestDist || (d === bestDist && iToken.length > (bestToken?.length ?? 0))) {
        bestDist  = d;
        bestToken = iToken;
      }
    }

    if (bestToken && bestToken !== token) {
      corrected.push(bestToken);
      anyChange = true;
    } else {
      corrected.push(token);
    }
  }

  return anyChange ? corrected.join(' ') : null;
}

/* ═══════════════════════════════════════════════════════════════
   TEXT EXTRACTION & TOKENISATION
   ═══════════════════════════════════════════════════════════════ */
function extractText(doc) {
  return [
    doc.name ?? '', doc.name ?? '', doc.name ?? '',       // 3× for name boost
    doc.subject ?? '', doc.subject ?? '',
    doc.sender  ?? '', doc.sender  ?? '',
    doc.folder  ?? '',
    doc.description ?? '',
    doc.body    ?? '',
    doc.location ?? '',
    doc.owner   ?? '',
    doc.account ?? '',
    ...(doc.labels      ?? []),
    ...(doc.attachments ?? []),
    ...(doc.cellValues  ?? []),
    ...(doc.albums      ?? []),
    ...(doc.ocrText     ?? []),
  ].join(' ');
}

function tokenise(text) {
  return (text ?? '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
}

function avgDocLen() {
  if (!docs.size) return 1;
  let total = 0;
  for (const [id] of docs) total += fieldCache.get(id)?.len ?? 0;
  return total / docs.size;
}

/* ─── Ready ──────────────────────────────────────────────────── */
self.postMessage({ type:'READY' });
