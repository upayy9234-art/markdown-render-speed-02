// parse.js — CommonMark 0.31.2 + GFM renderer, output matching marked 18.1.3.
// Pure stdlib, no dependencies. Written fresh in this session.
'use strict';

// ---------------------------------------------------------------- helpers
function isLocalChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-';
}
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isAsciiPunct(c) { return c !== undefined && c.length === 1 && ASCII_PUNCT.indexOf(c) >= 0; }
function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'; }
function isUnicodeWs(c) {
  if (c === undefined || c === '') return true; // start/end of line counts as whitespace
  return /\s/.test(c);
}
function isPunct(c) {
  if (c === undefined || c === '') return false;
  return /[\p{P}\p{S}]/u.test(c);
}

// Escape HTML. encode=true escapes every &; encode=false leaves & alone when it
// starts a valid entity pattern (#digits; / #x hex; / word;).
const NEED_ESCAPE = /[&<>"']/;
function isHexChar(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
// Does s starting at i look like a valid entity body: #digits; / #x hex; /
// word; ? (Manual scan, no slice/regex.)
function entityLooksValid(s, i) {
  const n = s.length;
  if (s[i] === '#') {
    let j = i + 1;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      let k = j;
      while (k < n && isHexChar(s[k])) k++;
      return k - j >= 1 && k - j <= 6 && s[k] === ';';
    }
    let k = j;
    while (k < n && s[k] >= '0' && s[k] <= '9') k++;
    return k - j >= 1 && k - j <= 7 && s[k] === ';';
  }
  let k = i;
  while (k < n) {
    const c = s[k];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') k++;
    else break;
  }
  return k > i && s[k] === ';';
}
function escapeHtml(s, encode) {
  // Fast path: most text has no escapable char at all.
  if (!NEED_ESCAPE.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      if (encode || !entityLooksValid(s, i + 1)) out += '&amp;';
      else out += '&';
    } else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

// cleanUrl: encodeURI then restore %25 (so an already-encoded % stays %).
function cleanUrl(u) {
  try { return encodeURI(u).replace(/%25/g, '%'); } catch (e) { return u; }
}

// ---------------------------------------------------------------- entities
// Match an entity starting at s[i] where s[i] === '&'.
// Returns {len, text} (text already escaped for output) or null.
function matchEntity(s, i) {
  const rest = s.slice(i + 1);
  let m = /^#(\d{1,7});/.exec(rest);
  if (m) {
    const cp = parseInt(m[1], 10);
    const ch = (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) ? '\uFFFD' : String.fromCodePoint(cp);
    return { len: m[0].length + 1, text: escapeHtml(ch, true) };
  }
  m = /^#[xX]([0-9A-Fa-f]{1,6});/.exec(rest);
  if (m) {
    const cp = parseInt(m[1], 16);
    const ch = (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) ? '\uFFFD' : String.fromCodePoint(cp);
    return { len: m[0].length + 1, text: escapeHtml(ch, true) };
  }
  m = /^([A-Za-z0-9_]+);/.exec(rest);
  if (m) return { len: m[0].length + 1, text: '&' + m[1] + ';' };
  return null;
}

// ---------------------------------------------------------------- case fold (link labels)
// Full Unicode case fold: special mappings beyond toLowerCase().
const FOLD_MAP = {
  '\u00B5': '\u03BC', '\u017F': 's', '\u03C2': '\u03C3',
  '\u00DF': 'ss', '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl',
  '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
  '\uFB13': '\u0574\u0576', '\uFB14': '\u0574\u0565', '\uFB15': '\u0574\u056B',
  '\uFB16': '\u057E\u0576', '\uFB17': '\u0574\u056D', '\u0130': 'i\u0307',
  '\u212A': 'k', '\u1E9E': 'ss'
};
function foldLabel(raw) {
  // collapse whitespace runs (space/tab/newline) to a single space, trim ends
  let s = raw.replace(/[ \t\n\r\f\v]+/g, ' ').replace(/^ | $/g, '');
  let out = '';
  for (const ch of s) out += FOLD_MAP[ch] !== undefined ? FOLD_MAP[ch] : ch;
  return out.toLowerCase();
}
function hasUnescapedOpenBracket(label) {
  // a label must not contain an unescaped '[' (escaped '\[' is fine)
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '[') return true;
  }
  return false;
}

// ---------------------------------------------------------------- flanking (emphasis)
function flanking(c, prev, next) {
  const prevWs = isUnicodeWs(prev);
  const nextWs = isUnicodeWs(next);
  const prevPunct = isPunct(prev);
  const nextPunct = isPunct(next);
  const leftFlank = !nextWs && (!nextPunct || (prevWs || prevPunct));
  const rightFlank = !prevWs && (!prevPunct || (nextWs || nextPunct));
  let canOpen, canClose;
  if (c === '_') {
    canOpen = leftFlank && (!rightFlank || prevPunct);
    canClose = rightFlank && (!leftFlank || nextPunct);
  } else {
    canOpen = leftFlank;
    canClose = rightFlank;
  }
  return [canOpen, canClose];
}

// ---------------------------------------------------------------- inline HTML tag
function tryHtmlTag(s, i) {
  // s[i] === '<'
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { text: '<!-->', end: i + 5 };
    if (s.startsWith('<!--->', i)) return { text: '<!--->', end: i + 6 };
    // a comment ends at the first -->; `--` inside is allowed (cm-625)
    const close = s.indexOf('-->', i + 4);
    if (close < 0) return null;
    return { text: s.slice(i, close + 3), end: close + 3 };
  }
  if (s.startsWith('<?', i)) {
    const close = s.indexOf('?>', i + 2);
    if (close < 0) return null;
    return { text: s.slice(i, close + 2), end: close + 2 };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const close = s.indexOf(']]>', i + 9);
    if (close < 0) return null;
    return { text: s.slice(i, close + 3), end: close + 3 };
  }
  if (s.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
    const close = s.indexOf('>', i + 2);
    if (close < 0) return null;
    return { text: s.slice(i, close + 1), end: close + 1 };
  }
  // close tag: </name ...>
  if (s.startsWith('</', i)) {
    let j = i + 2;
    if (j >= n || !/[A-Za-z]/.test(s[j])) return null;
    while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '>') return { text: s.slice(i, j + 1), end: j + 1 };
    return null;
  }
  // open tag: <name attrs>
  if (i + 1 < n && /[A-Za-z]/.test(s[i + 1])) {
    let j = i + 1;
    while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
    while (true) {
      let k = j;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      if (k < n && s[k] === '>') return { text: s.slice(i, k + 1), end: k + 1 };
      if (k < n && s[k] === '/' && k + 1 < n && s[k + 1] === '>') return { text: s.slice(i, k + 2), end: k + 2 };
      if (k === j) return null; // no whitespace before attribute -> invalid
      j = k;
      if (j >= n || !/[A-Za-z_:]/.test(s[j])) return null;
      while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
      let m = j;
      while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
      if (m < n && s[m] === '=') {
        m++;
        while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
        if (m >= n) return null;
        if (s[m] === '"') {
          const close = s.indexOf('"', m + 1);
          if (close < 0) return null;
          j = close + 1;
        } else if (s[m] === "'") {
          const close = s.indexOf("'", m + 1);
          if (close < 0) return null;
          j = close + 1;
        } else {
          let v = m;
          while (v < n && !/[\s"'=<>`]/.test(s[v])) v++;
          if (v === m) return null;
          j = v;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- angle autolink <...>
function matchEmailAt(s, i) {
  // returns the email string starting at i, or null. Manual scan (no
  // slice/regex): the local part, `@`, then dot-separated ASCII labels
  // [A-Za-z0-9_-]*[A-Za-z0-9], at least one dot. A label is the maximal
  // run of [A-Za-z0-9_-] truncated to its last alnum (the regex
  // [A-Za-z0-9_-]*[A-Za-z0-9] backtracks past trailing `-`/`_`).
  const n = s.length;
  let j = i;
  while (j < n && isLocalChar(s[j])) j++;
  if (j === i || s[j] !== '@') return null;
  j++;
  let labels = 0;
  while (true) {
    // scan one label: run of [A-Za-z0-9_-], keep position after last alnum
    let k = j, lastAlnum = -1;
    while (k < n) {
      const c = s[k];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) { lastAlnum = k; k++; }
      else if (c === '_' || c === '-') k++;
      else break;
    }
    if (lastAlnum < 0) return null; // empty label (no alnum at all)
    j = lastAlnum + 1;
    labels++;
    if (s[j] === '.') {
      // peek the next label; if it has no alnum, the email ends before '.'
      let m = j + 1, la2 = -1;
      while (m < n) {
        const c = s[m];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) { la2 = m; m++; }
        else if (c === '_' || c === '-') m++;
        else break;
      }
      if (la2 < 0) break;
      j++;
      continue;
    }
    break;
  }
  if (labels < 2) return null; // need at least one dot
  return s.slice(i, j);
}
function tryAngleAutolink(s, i) {
  // s[i] === '<'
  const close = s.indexOf('>', i + 1);
  if (close < 0) return null;
  const inner = s.slice(i + 1, close);
  if (inner.indexOf(' ') >= 0 || inner.indexOf('\n') >= 0 || inner.indexOf('<') >= 0) return null;
  if (inner.length === 0) return null;
  const sm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):(.+)$/.exec(inner);
  if (sm) {
    const href = cleanUrl(inner);
    return { href: escapeHtml(href, true), text: escapeHtml(inner, true), end: close + 1 };
  }
  const em = matchEmailAt(s, i + 1);
  if (em && i + 1 + em.length === close) {
    const href = 'mailto:' + em;
    return { href: escapeHtml(href, true), text: escapeHtml(em, true), end: close + 1 };
  }
  return null;
}

// ---------------------------------------------------------------- extended autolinks (www / scheme / email)
// Domain regex for www and scheme autolinks: first char letter/number/hyphen,
// then letters/numbers/_/-/dots. (No dot required; empty middle labels allowed.)
const DOMAIN_RE = /^[\p{L}\p{N}-][\p{L}\p{N}_.-]*/u;
function scanUrl(s, i) {
  // maximal run of non-space, non-'<' chars; trailing punctuation and
  // unbalanced parens are removed by trimAutolinkUrl
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '<') break;
    j++;
  }
  return s.slice(i, j);
}
const TRIM_PUNCT = '?!.,:;*_~\'"';
function trimAutolinkUrl(u) {
  let cur = u;
  while (true) {
    let changed = false;
    if (cur.endsWith(';')) {
      const amp = cur.lastIndexOf('&');
      if (amp >= 0) {
        const tail = cur.slice(amp);
        if (/^&(?:#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|\w+);$/.test(tail)) {
          cur = cur.slice(0, amp);
          changed = true;
        }
      }
    }
    while (cur.length > 0 && TRIM_PUNCT.indexOf(cur[cur.length - 1]) >= 0) {
      cur = cur.slice(0, -1);
      changed = true;
    }
    // a trailing ')' is dropped while the parens are unbalanced (more ')'
    // than '('); a trailing '(' is handled by the unmatched-'(' rule below
    if (cur.endsWith(')')) {
      let open = 0, close = 0;
      for (let k = 0; k < cur.length; k++) {
        if (cur[k] === '(') open++;
        else if (cur[k] === ')') close++;
      }
      if (close > open) {
        cur = cur.slice(0, -1);
        changed = true;
      }
    }
    let stack = [];
    for (let k = 0; k < cur.length; k++) {
      if (cur[k] === '(') stack.push(k);
      else if (cur[k] === ')') stack.pop();
    }
    if (stack.length > 0) {
      cur = cur.slice(0, stack[0]);
      changed = true;
    }
    if (!changed) break;
  }
  return cur;
}
function hasMatchingBracket(s, openIdx) {
  // is there a ']' matching the '[' at openIdx, later in the same inline text?
  let depth = 0;
  let j = openIdx;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j; while (k < n && s[k] === '`') k++;
      const run = k - j;
      let m = k, found = -1;
      while (m < n) {
        if (s[m] === '`') {
          let q = m; while (q < n && s[q] === '`') q++;
          if (q - m === run) { found = m; break; }
          m = q;
        } else m++;
      }
      if (found < 0) return false;
      j = found + run;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return true;
    }
    j++;
  }
  return false;
}
function tryExtAutolink(s, i, noExt, delims) {
  if (noExt) return null;
  // www.
  if (s.startsWith('www.', i)) {
    const prev = i > 0 ? s[i - 1] : '';
    let ok = false;
    if (prev === '' || isSpace(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~') ok = true;
    else if (prev === '[') ok = hasMatchingBracket(s, i - 1);
    if (!ok) return null;
    const dm = DOMAIN_RE.exec(s.slice(i + 4));
    if (!dm) return null;
    const raw = scanUrl(s, i);
    const url = trimAutolinkUrl(raw);
    if (url.length <= 4) return null;
    const href = 'http://' + url;
    return { href: escapeHtml(cleanUrl(href), true), text: escapeHtml(url, true), end: i + url.length };
  }
  // scheme:// (http, https, ftp only)
  const sm = /^(https?|ftp):\/\//i.exec(s.slice(i));
  if (sm) {
    const hostStart = i + sm[0].length;
    const dm = DOMAIN_RE.exec(s.slice(hostStart));
    if (!dm) return null;
    const raw = scanUrl(s, i);
    const url = trimAutolinkUrl(raw);
    if (url.length <= sm[0].length) return null;
    return { href: escapeHtml(cleanUrl(url), true), text: escapeHtml(url, true), end: i + url.length };
  }
  // email, optionally preceded by a mailto: or xmpp: scheme (lowercase
  // only; the scheme is the maximal run of scheme chars before the ':')
  const em = matchEmailAt(s, i);
  if (em) {
    const after = s[i + em.length];
    if (after !== undefined && /[A-Za-z0-9_-]/.test(after)) {
      // a trailing `_` is allowed when it closes an emphasis span whose
      // opener precedes the email (probed 2026-11-16: `__foo@bar.baz__`
      // links, `foo@bar.baz__` does not). Approximate the open span by
      // counting unmatched `_` openers in the delimiters seen so far.
      if (after !== '_') return null;
      let depth = 0;
      if (delims) {
        for (const d of delims) {
          if (d.ch !== '_') continue;
          if (d.canClose && depth > 0) depth--;
          else if (d.canOpen) depth++;
        }
      }
      if (depth <= 0) return null;
    }
    const colon = i - 1;
    let start = i, scheme = null;
    if (colon >= 0 && s[colon] === ':') {
      let j = colon - 1;
      while (j >= 0 && /[A-Za-z0-9+.-]/.test(s[j])) j--;
      const run = s.slice(j + 1, colon);
      if (run === 'mailto' || run === 'xmpp') { scheme = run; start = j + 1; }
    }
    if (scheme) {
      // optional /path segment after the email: [A-Za-z0-9.@]*, one segment
      // only; trailing dots are trimmed but the '/' stays
      let end = i + em.length;
      let path = '';
      if (s[end] === '/') {
        let k = end + 1;
        while (k < s.length && /[A-Za-z0-9.@]/.test(s[k])) k++;
        if (k > end + 1) {
          let seg = s.slice(end + 1, k).replace(/\.+$/, '');
          path = '/' + seg;
          end = end + 1 + seg.length;
        }
      }
      const full = s.slice(start, end);
      return { href: escapeHtml(full, true), text: escapeHtml(full, true), end, start };
    }
    const href = 'mailto:' + em;
    return { href: escapeHtml(href, true), text: escapeHtml(em, true), end: i + em.length, start: i };
  }
  return null;
}

// ---------------------------------------------------------------- link destination / title parsing
function skipWsNoBlank(s, k) {
  let j = k;
  let nl = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t') { j++; continue; }
    if (c === '\n') {
      nl++;
      if (nl >= 2) return -1;
      j++;
      continue;
    }
    break;
  }
  return j;
}
function parseAngleDest(s, k) {
  // s[k] === '<'; ends at the first '>' whose next char is ws / " / ' / ( / )
  // an escaped '>' does not close the destination (cm-493)
  let j = k + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === '\n') return null;
    if (c === '>') {
      const nx = s[j + 1];
      if (nx === undefined || nx === ' ' || nx === '\t' || nx === '\n' || nx === '"' || nx === "'" || nx === '(' || nx === ')') {
        return { dest: s.slice(k + 1, j), end: j + 1 };
      }
      j++;
      continue;
    }
    j++;
  }
  return null;
}
function parseBareDest(s, k) {
  let j = k;
  let depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { j += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7F) {
      return { dest: s.slice(k, j), end: j, depth };
    }
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      if (depth === 0) return { dest: s.slice(k, j), end: j, depth };
      depth--; j++; continue;
    }
    j++;
  }
  return { dest: s.slice(k, j), end: j, depth };
}
function unescapeTitle(t) {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && i + 1 < t.length && isAsciiPunct(t[i + 1])) { out += t[i + 1]; i++; }
    else out += t[i];
  }
  return out;
}
function parseTitle(s, k) {
  const q = s[k];
  if (q === '"' || q === "'") {
    let j = k + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\n' && s[j + 1] === '\n') return null; // a title cannot span a blank line
      if (c === '\\' && j + 1 < s.length && (s[j + 1] === q || s[j + 1] === '\\')) { j += 2; continue; }
      if (c === q) return { title: unescapeTitle(s.slice(k + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = k + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\n' && s[j + 1] === '\n') return null; // a title cannot span a blank line
      if (c === '\\' && j + 1 < s.length && (s[j + 1] === '(' || s[j + 1] === ')' || s[j + 1] === '\\')) { j += 2; continue; }
      if (c === '(') return null;
      if (c === ')') return { title: unescapeTitle(s.slice(k + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}
// Parse what follows a ']' for a link/image. Returns null or:
//  {kind:'inline', end, href, title} | {kind:'ref', end, label}
//  {kind:'collapsed', end} | {kind:'shortcut', end}
function tryLinkAfter(s, j) {
  // When the inline `(...)` form fails, or a `[label]` is unclosed, the
  // bracketed text falls back to a shortcut reference (cm-568).
  const shortcut = { kind: 'shortcut', end: j };
  if (s[j] === '(') {
    let k = j + 1;
    k = skipWsNoBlank(s, k);
    if (k < 0) return shortcut;
    if (s[k] === ')') return { kind: 'inline', end: k + 1, href: '', title: null };
    let dest, title = null;
    if (s[k] === '<') {
      const m = parseAngleDest(s, k);
      if (!m) return shortcut;
      dest = m.dest; k = m.end;
    } else {
      const m = parseBareDest(s, k);
      if (!m || m.depth !== 0) return shortcut;
      dest = m.dest; k = m.end;
    }
    k = skipWsNoBlank(s, k);
    if (k < 0) return shortcut;
    if (s[k] === '"' || s[k] === "'" || s[k] === '(') {
      const t = parseTitle(s, k);
      if (!t) return shortcut;
      title = t.title; k = t.end;
      k = skipWsNoBlank(s, k);
      if (k < 0) return shortcut;
    }
    if (s[k] !== ')') return shortcut;
    return { kind: 'inline', end: k + 1, href: dest, title };
  }
  if (s[j] === '[') {
    let k = j + 1;
    let label = null;
    while (k < s.length) {
      if (s[k] === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (s[k] === ']') { label = s.slice(j + 1, k); break; }
      if (s[k] === '\n' && s[k + 1] === '\n') return shortcut;
      k++;
    }
    if (label === null) return shortcut;
    if (label === '') return { kind: 'collapsed', end: k + 1 };
    // a label with an unescaped '[' or one that folds to empty is not a
    // valid reference: fall back to the shortcut (cm-546)
    if (hasUnescapedOpenBracket(label) || foldLabel(label) === '') return shortcut;
    return { kind: 'ref', end: k + 1, label };
  }
  return { kind: 'shortcut', end: j };
}
// Set when findMatchingBracket fails on a mismatched code span: the index
// of the `]` that would have closed the bracket (or -1). parseInline uses
// it to suppress emphasis inside a failed inline-link attempt.
let bracketFailClose = -1;
// Find the ']' matching the '[' at index i. Accounts for nested brackets,
// code spans, backslash escapes and HTML tags. Returns the index or -1.
function findMatchingBracket(s, i) {
  bracketFailClose = -1;
  let depth = 0;
  let j = i;
  const n = s.length;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j; while (k < n && s[k] === '`') k++;
      const run = k - j;
      // Find the closing run of the same length, noting whether a run of
      // a different length lies inside the span.
      let m = k, closer = -1, mismatch = false;
      while (m < n) {
        if (s[m] === '`') {
          let q = m; while (q < n && s[q] === '`') q++;
          if (q - m === run) { closer = m; break; }
          mismatch = true;
          m = q;
        } else m++;
      }
      if (closer < 0) {
        // No same-length closer: the backticks are literal. Skip past the
        // first backtick run after the opener as well — it belongs to this
        // failed span and must not open a new span across the `]` (e.g.
        // `[issue read two ``small`](u)` forms a link; the lone `` ` ``
        // after `small` must not pair with a later `` ` ``).
        let m2 = k;
        while (m2 < n && s[m2] !== '`') m2++;
        if (m2 < n) { let q2 = m2; while (q2 < n && s[q2] === '`') q2++; j = q2; }
        else j = k;
        continue;
      }
      if (!mismatch) { j = closer + run; continue; } // clean span: skip it
      // Mismatched span (a different-length run inside, e.g. the `` `` a
      // ` b `` `` pattern): the oracle only finds a `]` that lies inside
      // this span, or immediately after its closing run (the span is at
      // the end of the link text); otherwise the bracket search fails
      // outright (so a link whose text holds such a span mid-text does
      // not form). Scan the interior for the matching `]`.
      let d = depth, p = k;
      while (p < closer) {
        const ch = s[p];
        if (ch === '\\' && p + 1 < closer) { p += 2; continue; }
        if (ch === '[') d++;
        else if (ch === ']') { d--; if (d === 0) return p; }
        p++;
      }
      if (closer + run < n && s[closer + run] === ']') { j = closer + run; continue; }
      // Record the would-be `]` after this span (first `]` bringing the
      // depth back to zero), for the emphasis-suppression rule.
      let d2 = depth, q2 = closer + run;
      while (q2 < n) {
        const ch2 = s[q2];
        if (ch2 === '\\' && q2 + 1 < n) { q2 += 2; continue; }
        if (ch2 === '[') d2++;
        else if (ch2 === ']') { d2--; if (d2 === 0) break; }
        q2++;
      }
      bracketFailClose = q2 < n ? q2 : -1;
      return -1;
    }
    if (c === '<') {
      // a valid angle autolink is skipped whole: a `]` inside it does not
      // close the link text (cm-526/538)
      const a = tryAngleAutolink(s, j);
      if (a) { j = a.end; continue; }
      const h = tryHtmlTag(s, j);
      if (h) { j = h.end; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// ---------------------------------------------------------------- inline scanner
// Node kinds: t (text, raw), code (raw code content), html (raw tag),
// link {href, title, ch[]}, img {src, title, alt}, br,
// d (delimiter run, renders as its literal chars unless consumed),
// em/strong/del {ch[]}.
function processEmphasis(nodes, delims) {
  // Block rule (probed 2026-11-16): after an emphasis match whose closer can
  // open, a later closer of the same char cannot match an opener that lies
  // before the opener just used, when (opener.len + closer.len) % 3 === 0
  // unless both lengths are multiples of 3. The block is replaced whenever
  // a new match of that char forms (a match "uses up" the block).
  // This is what makes `*a **b**c*` stay literal while `*a **b** c*` and
  // `***a **b**c***` form the outer emphasis.
  const block = {}; // ch -> { openerSeq, closerLen }
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer.canClose) { di++; continue; }
    let opener = null;
    for (let oi = di - 1; oi >= 0; oi--) {
      const cand = delims[oi];
      if (cand.ch !== closer.ch || !cand.canOpen) continue;
      // odd-match rule (probed 2026-11-16): the shorter-closer skip applies
      // only when the opener can also close; the sum-of-3 skip applies when
      // the opener can close or the closer can open. Both skips are waived
      // when both lengths are multiples of 3 (***foo*** still matches).
      // (`*a ***b**c*` matches its inner ** because the opener cannot close,
      // so the shorter-closer skip does not fire.)
      const odd = (cand.canClose && closer.len < cand.len) ||
        ((cand.canClose || closer.canOpen) &&
         (cand.len + closer.len) % 3 === 0 &&
         !(cand.len % 3 === 0 && closer.len % 3 === 0));
      if (odd) continue;
      // block rule: an opener before a just-used opener is unreachable
      // for this closer when the length-sum rule above fires against the
      // inner closer that created the block
      const b = block[closer.ch];
      if (b && cand.seq < b.openerSeq &&
          (cand.len + b.closerLen) % 3 === 0 &&
          !(cand.len % 3 === 0 && b.closerLen % 3 === 0)) continue;
      opener = cand;
      break;
    }
    if (!opener) { di++; continue; }
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    const kind = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const si = nodes.indexOf(opener);
    const ei = nodes.indexOf(closer);
    if (si < 0 || ei < 0 || ei <= si) { di++; continue; }
    const children = nodes.slice(si + 1, ei);
    // delimiters between the opener and closer are now inside the new node:
    // they can no longer match across its boundary (cm-470)
    for (const nd of children) {
      if (nd.k === 'd') {
        const di2 = delims.indexOf(nd);
        if (di2 >= 0) delims.splice(di2, 1);
      }
    }
    nodes.splice(si + 1, ei - si - 1, { k: kind, ch: children });
    // record the block before shrinking the runs (closer.len is pre-use).
    // Only when the opener cannot also close: an intraword opener (cm-411
    // `*foo**bar**baz*`, cm-429) leaves the outer delimiter reachable.
    if (closer.canOpen && !opener.canClose) block[closer.ch] = { openerSeq: opener.seq, closerLen: closer.len };
    else delete block[closer.ch];
    opener.len -= use;
    closer.len -= use;
    if (opener.len === 0) {
      const ni = nodes.indexOf(opener);
      if (ni >= 0) nodes.splice(ni, 1);
      const oi = delims.indexOf(opener);
      if (oi >= 0) delims.splice(oi, 1);
    }
    if (closer.len === 0) {
      const ni = nodes.indexOf(closer);
      if (ni >= 0) nodes.splice(ni, 1);
      const ci = delims.indexOf(closer);
      if (ci >= 0) delims.splice(ci, 1);
      // the next delimiter slid into the closer's (post-opener-removal) slot
      di = ci;
    } else {
      // closer survives: re-examine it at its current index (it may match
      // another opener, e.g. the second half of ***foo***)
      di = delims.indexOf(closer);
    }
  }
}
function hasLinkNode(list) {
  for (const nd of list) {
    if (nd.k === 'link' && !nd.auto) return true;
    if (nd.ch && hasLinkNode(nd.ch)) return true;
  }
  return false;
}
function plainText(list) {
  let out = '';
  for (const nd of list) {
    if (nd.k === 't') out += nd.s;
    else if (nd.k === 'code') out += nd.s;
    else if (nd.k === 'html') out += nd.s;
    else if (nd.k === 'd') out += nd.ch.repeat(nd.len);
    else if (nd.k === 'br') out += '\n';
    else if (nd.k === 'link') out += plainText(nd.ch);
    else if (nd.k === 'img') out += nd.alt;
    else if (nd.ch) out += plainText(nd.ch);
  }
  return out;
}
// marked keeps a document-wide "inside <a>" flag: an inline <a> tag
// disables extended autolinks until an inline </a> closes it (probed 2026-11-16).
// Reset per parse() call; parse() is synchronous so this is safe.
let docInLink = false;
function parseInline(s, refs, noExt) {
  const nodes = [];
  const delims = [];
  // Ranges [open, close] of failed inline-link attempts (a `[` whose text
  // holds a mismatched code span and whose would-be `]` is followed by
  // `(`): emphasis delimiters inside such a range stay literal (probed
  // 2026-11-16). Only the `](` form suppresses; `] (`, `][ref]`, `]`
  // alone do not.
  const noEmRanges = [];
  let dseq = 0; // delimiter creation order, for the emphasis block rule
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ k: 't', s: buf }); buf = ''; } };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush(); nodes.push({ k: 'br' });
        // a hard break strips the next line's leading whitespace (cm-637)
        let j = i + 2;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        i = j; continue;
      }
      // An escaped & is literal: it must NOT be re-read as an entity when the
      // text node renders, so it gets its own fully-escaped node.
      if (nx === '&') { flush(); nodes.push({ k: 't', s: '&', e: true }); i += 2; continue; }
      if (nx !== undefined && isAsciiPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (c === '`') {
      let j = i; while (j < n && s[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let m = k; while (m < n && s[m] === '`') m++;
          if (m - k === run) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found >= 0) {
        let content = s.slice(j, found).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^[ ]+$/.test(content)) {
          content = content.slice(1, -1);
        }
        flush(); nodes.push({ k: 'code', s: content }); i = found + run; continue;
      }
      buf += s.slice(i, j); i = j; continue;
    }
    if (c === '&') {
      const m = matchEntity(s, i);
      if (m) { buf += m.text; i += m.len; continue; }
      buf += '&amp;'; i++; continue;
    }
    if (c === '<') {
      const a = tryAngleAutolink(s, i);
      if (a) {
        flush();
        nodes.push({ k: 'link', href: a.href, title: null, ch: [{ k: 't', s: a.text }], auto: true });
        i = a.end; continue;
      }
      const h = tryHtmlTag(s, i);
      if (h) {
        flush();
        const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(h.text);
        if (tm && tm[1].toLowerCase() === 'a') {
          // an inline <a> sets the flag only when a literal SPACE follows
          // the tag name (probed 2026-11-16): `<a >`, `<a href=...>` set it;
          // `<a>`, `<a/>` and `<a\t...>` do not. A close tag always clears it.
          if (h.text[1] === '/') docInLink = false;
          else if (h.text[1 + tm[1].length] === ' ') docInLink = true;
        }
        nodes.push({ k: 'html', s: h.text }); i = h.end; continue;
      }
      buf += '&lt;'; i++; continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const isImage = c === '!';
      const openIdx = isImage ? i + 1 : i;
      const closeIdx = findMatchingBracket(s, openIdx);
      if (closeIdx < 0) {
        // Failed on a mismatched code span with an inline `(` dest after
        // the would-be `]`: record the range so `*`/`_` inside it stay
        // literal (no emphasis).
        if (bracketFailClose >= 0 && s[bracketFailClose + 1] === '(') {
          noEmRanges.push([openIdx, bracketFailClose]);
        }
        buf += isImage ? '![' : '[';
        i += isImage ? 2 : 1;
        continue;
      }
      const linkText = s.slice(openIdx + 1, closeIdx);
      const after = tryLinkAfter(s, closeIdx + 1);
      if (!after) {
        buf += isImage ? '![' : '[';
        i += isImage ? 2 : 1;
        continue;
      }
      let href = null, title = null;
      if (after.kind === 'inline') { href = unescapeDest(after.href); title = after.title; }
      else {
        let labelRaw;
        if (after.kind === 'ref') labelRaw = after.label;
        else labelRaw = linkText; // collapsed or shortcut
        const key = foldLabel(labelRaw);
        if (key === '' || !refs.has(key)) {
          buf += isImage ? '![' : '[';
          i += isImage ? 2 : 1;
          continue;
        }
        const def = refs.get(key);
        href = def.href; title = def.title;
      }
      const children = parseInline(linkText, refs, true);
      if (!isImage && hasLinkNode(children)) {
        buf += '[';
        i += 1;
        continue;
      }
      flush();
      if (isImage) {
        const alt = plainText(children);
        nodes.push({ k: 'img', src: href, title, alt });
      } else {
        nodes.push({ k: 'link', href, title, ch: children });
      }
      i = after.end;
      continue;
    }
    if (c === ']') { buf += ']'; i++; continue; }
    if (c === '*' || c === '_' || c === '~') {
      let j = i; while (j < n && s[j] === c) j++;
      const run = j - i;
      if (c === '~' && run >= 3) { buf += s.slice(i, j); i = j; continue; }
      // Inside a failed inline-link attempt's text, `*`/`_` stay literal.
      if ((c === '*' || c === '_') && noEmRanges.some(r => i > r[0] && i < r[1])) {
        buf += s.slice(i, j); i = j; continue;
      }
      const prev = i > 0 ? s[i - 1] : '';
      const next = j < n ? s[j] : '';
      const cc = flanking(c, prev, next);
      flush();
      const node = { k: 'd', ch: c, len: run, canOpen: cc[0], canClose: cc[1], seq: dseq++ };
      nodes.push(node);
      delims.push(node);
      i = j; continue;
    }
    if (c === '\n') {
      if (buf.length >= 2 && buf.endsWith('  ')) {
        buf = buf.replace(/ +$/, '');
        flush(); nodes.push({ k: 'br' });
        // a hard break strips the next line's leading whitespace (cm-636)
        let j = i + 1;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        i = j; continue;
      } else {
        buf += '\n';
      }
      i++; continue;
    }
    if (!noExt && !docInLink) {
      // Only attempt an extended autolink where one can start: `w` (www.),
      // `h`/`f` (http/https/ftp, which may appear mid-word), or a local-part
      // char whose predecessor is not alnum (an email). Skip only when the
      // previous char is alnum: alnum always extends the local part left,
      // so the email would start earlier. But `.`/`_`/`+`/`-` before the
      // email may be emphasis or punctuation (e.g. `__foo@bar.baz__` links
      // the email starting after the `_`), so those still attempt.
      const ch = s[i];
      const pc = i > 0 ? s[i - 1] : '';
      const pcAlnum = (pc >= 'a' && pc <= 'z') || (pc >= 'A' && pc <= 'Z') || (pc >= '0' && pc <= '9');
      const canStart = ch === 'w' || ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || (isLocalChar(ch) && !pcAlnum);
      const a = canStart ? tryExtAutolink(s, i, false, delims) : null;
      if (a) {
        // a scheme:email autolink starts before i: its scheme was already
        // buffered as literal text, so take those chars back
        if (a.start !== undefined && a.start < i) {
          buf = buf.slice(0, buf.length - (i - a.start));
        }
        flush();
        nodes.push({ k: 'link', href: a.href, title: null, ch: [{ k: 't', s: a.text }], auto: true });
        i = a.end; continue;
      }
    }
    buf += c; i++;
  }
  flush();
  processEmphasis(nodes, delims);
  return nodes;
}
function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 't') out += nd.e ? escapeHtml(nd.s, true) : escapeHtml(nd.s, false);
    else if (nd.k === 'code') out += '<code>' + escapeHtml(nd.s, true) + '</code>';
    else if (nd.k === 'html') out += nd.s;
    else if (nd.k === 'br') out += '<br>';
    else if (nd.k === 'd') out += escapeHtml(nd.ch.repeat(nd.len), false);
    else if (nd.k === 'em') out += '<em>' + renderInlineNodes(nd.ch) + '</em>';
    else if (nd.k === 'strong') out += '<strong>' + renderInlineNodes(nd.ch) + '</strong>';
    else if (nd.k === 'del') out += '<del>' + renderInlineNodes(nd.ch) + '</del>';
    else if (nd.k === 'link') {
      // href/title keep valid entities verbatim (marked's escape() without encode)
      const href = escapeHtml(cleanUrl(nd.href), false);
      const title = nd.title ? ' title="' + escapeHtml(nd.title, false) + '"' : '';
      out += '<a href="' + href + '"' + title + '>' + renderInlineNodes(nd.ch) + '</a>';
    } else if (nd.k === 'img') {
      const src = escapeHtml(cleanUrl(nd.src), false);
      const title = nd.title ? ' title="' + escapeHtml(nd.title, false) + '"' : '';
      out += '<img src="' + src + '" alt="' + escapeHtml(nd.alt, true) + '"' + title + '>';
    }
  }
  return out;
}
function renderInline(s, refs) {
  return renderInlineNodes(parseInline(s, refs, false));
}

// ---------------------------------------------------------------- block parser: cursors
// A cursor is {off, col, partial}: off is the index into the line string,
// col is the column (tabs expanded to multiples of 4), partial is the number
// of virtual spaces left from a partially consumed tab.
function advanceCols(line, cur, n) {
  let off = cur.off, col = cur.col, partial = cur.partial, rem = n;
  if (partial > 0) {
    const take = Math.min(partial, rem);
    partial -= take; rem -= take; col += take;
    if (partial === 0) off++; // the partially-consumed tab is now fully consumed
    if (rem === 0) return { off, col, partial };
  }
  while (rem > 0 && off < line.length) {
    const c = line[off];
    if (c === ' ') { off++; col++; rem--; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (w <= rem) { off++; col += w; rem -= w; }
      else { partial = w - rem; col += rem; rem = 0; }
    } else break;
  }
  return { off, col, partial };
}
function skipIndent(line, cur, maxCols) {
  // advance past up to maxCols columns of indent; returns {cur, cols}
  let off = cur.off, col = cur.col, partial = cur.partial, cols = 0;
  if (partial > 0) {
    const take = Math.min(partial, maxCols);
    partial -= take; cols += take; col += take;
    if (partial === 0) off++; // the partially-consumed tab is now fully consumed
    if (cols >= maxCols) return { cur: { off, col, partial }, cols };
  }
  while (cols < maxCols && off < line.length) {
    const c = line[off];
    if (c === ' ') { off++; col++; cols++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (cols + w <= maxCols) { off++; col += w; cols += w; }
      else { partial = w - (maxCols - cols); col += (maxCols - cols); cols = maxCols; }
    } else break;
  }
  return { cur: { off, col, partial }, cols };
}
function indentAt(line, cur) {
  // columns of indent at the cursor, and the cursor after the indent
  let off = cur.off, col = cur.col, partial = cur.partial, cols = 0;
  if (partial > 0) { cols += partial; col += partial; partial = 0; off++; }
  while (off < line.length) {
    const c = line[off];
    if (c === ' ') { off++; col++; cols++; }
    else if (c === '\t') { const w = 4 - (col % 4); off++; col += w; cols += w; }
    else break;
  }
  return { cols, cur: { off, col, partial } };
}
function expandLeadingTabs(content, startCol) {
  // Expand tabs in the leading whitespace to spaces, based on absolute
  // columns (a tab at column c becomes 4 - (c % 4) spaces). Marked does
  // this for content inside a container (blockquote/list item); at the top
  // level tabs are kept literally.
  let col = startCol, i = 0, out = '';
  while (i < content.length) {
    const c = content[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  if (i === 0) return content;
  return out + content.slice(i);
}
function contentStr(line, cur) {
  // A partial tab is materialized as spaces; the tab character itself must
  // then be skipped, or it would be counted twice.
  return ' '.repeat(cur.partial) + line.slice(cur.off + (cur.partial > 0 ? 1 : 0));
}
function isBlankLine(line) { return /^[ \t]*$/.test(line); }
// count leading whitespace columns of a content string, from startCol
function countIndent(content, startCol) {
  let col = startCol, i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col - startCol, chars: i };
}
// strip n columns of leading whitespace from a content string (a tab that
// straddles the boundary leaves virtual spaces behind)
// Strip n columns from the start of content. When wholeTab is set
// (fenced-code indent stripping), a tab met while stripping is removed
// entirely even if it is wider than the remaining indent (probed
// 2026-11-16: an indented fence + `\tfoo` gives `foo`, not `  foo`);
// otherwise (indented code) a partial tab leaves `w - rem` spaces.
function stripCols(content, startCol, n, wholeTab) {
  let col = startCol, i = 0, rem = n;
  while (rem > 0 && i < content.length) {
    const c = content[i];
    if (c === ' ') { col++; i++; rem--; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (w <= rem) { col += w; i++; rem -= w; }
      else if (wholeTab) return content.slice(i + 1);
      else return ' '.repeat(w - rem) + content.slice(i + 1);
    } else break;
  }
  return content.slice(i);
}
function unescapeDest(d) {
  let out = '';
  for (let i = 0; i < d.length; i++) {
    if (d[i] === '\\' && i + 1 < d.length && isAsciiPunct(d[i + 1])) { out += d[i + 1]; i++; }
    else out += d[i];
  }
  return out;
}

// ---------------------------------------------------------------- block-start detectors
// Each takes a content string (line after container prefixes) and the column
// at which that content starts, and returns a description or null.
function matchATX(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  let s = content.slice(ind.chars);
  let level = 0;
  while (level < s.length && s[level] === '#') level++;
  if (level === 0 || level > 6) return null;
  const rest = s.slice(level);
  if (rest.length > 0 && rest[0] !== ' ' && rest[0] !== '\t') return null;
  // closing sequence of #s, preceded by a space — check on the raw rest
  // (trailing spaces trimmed), before trimming, so `### ###` yields empty
  const m = /^(.*?)[ \t]+#+$/.exec(rest.replace(/[ \t]+$/, ''));
  let text = m ? m[1] : rest;
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level, text };
}
function matchFence(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  const s = content.slice(ind.chars);
  if (s.length < 3) return null;
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < s.length && s[len] === ch) len++;
  if (len < 3) return null;
  const info = s.slice(len).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch, len, indent: ind.cols, info };
}
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
function matchHtmlBlock(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  const s = content.slice(ind.chars);
  if (s[0] !== '<') return null;
  const low = s.toLowerCase();
  // type 1: script/pre/style/textarea
  let m = /^<(script|pre|style|textarea)([ \t\n>]|\/>|$)/.exec(low);
  if (m) return { htype: 1, name: m[1] };
  if (low.startsWith('<!--')) return { htype: 2 };
  if (low.startsWith('<?')) return { htype: 3 };
  if (low.startsWith('<![cdata[')) return { htype: 4 };
  if (/^<![a-z]/.test(low)) return { htype: 5 };
  // type 6: < or </ + block tag, followed by space/tab/EOL/> or />
  m = /^<\/?([a-z][a-z0-9-]*)((?:[ \t]|\/>|>|$))/ .exec(low);
  if (m && BLOCK_TAGS.has(m[1])) return { htype: 6, name: m[1] };
  // type 7: complete open or close tag, followed only by whitespace/EOL
  const tag = tryHtmlTag(content.slice(ind.chars), 0);
  if (tag) {
    const after = content.slice(ind.chars + tag.end);
    if (/^[ \t]*$/.test(after)) {
      const name = /^<\/?([a-z][a-z0-9-]*)/i.exec(content.slice(ind.chars));
      if (name && !/^(pre|script|style|textarea)$/i.test(name[1])) return { htype: 7, name: name[1] };
    }
  }
  return null;
}
function matchHr(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  const s = content.slice(ind.chars);
  if (s.length === 0) return null;
  const ch = s[0];
  if (ch !== '*' && ch !== '-' && ch !== '_') return null;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return null;
  }
  return count >= 3 ? { ch } : null;
}
function matchSetext(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  const s = content.slice(ind.chars);
  if (s.length === 0) return null;
  const ch = s[0];
  if (ch !== '=' && ch !== '-') return null;
  // a run of the same char, then only trailing spaces/tabs (no internal spaces)
  let i = 0;
  while (i < s.length && s[i] === ch) i++;
  if (i === 0) return null;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i !== s.length) return null;
  return { level: ch === '=' ? 1 : 2 };
}
// List marker. Returns null or {ordered, bullet, delim, start, markerLen,
// markerCol, contentIndent, empty, content, contentCol}.
function matchListMarker(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  const s = content.slice(ind.chars);
  const markerCol = col + ind.cols;
  let ordered = false, bullet = null, delim = null, start = 0, markerLen = 0;
  if (s[0] === '-' || s[0] === '+' || s[0] === '*') {
    bullet = s[0]; markerLen = 1;
  } else {
    let d = 0;
    while (d < s.length && d < 9 && s[d] >= '0' && s[d] <= '9') d++;
    if (d === 0 || d >= 10) return null;
    if (s[d] !== '.' && s[d] !== ')') return null;
    ordered = true; delim = s[d]; start = parseInt(s.slice(0, d), 10); markerLen = d + 1;
  }
  const after = s[markerLen];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '\n') return null;
  // content indent: advance through spaces/tabs from the marker
  const rest = s.slice(markerLen);
  let ccol = markerCol + markerLen;
  let i = 0, skipped = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === ' ') { ccol++; skipped++; i++; }
    else if (c === '\t') { const w = 4 - (ccol % 4); ccol += w; skipped += w; i++; }
    else break;
  }
  const restContent = rest.slice(i);
  if (restContent === '') {
    // contentIndent is the content column in the STRIPPED coordinates
    // (after the containers above): the marker's indent within the stripped
    // content, plus the marker width, plus 1 space
    return { ordered, bullet, delim, start, markerLen, markerCol, contentIndent: (markerCol - col) + markerLen + 1, empty: true, content: '', contentCol: ccol };
  }
  if (skipped >= 1 && skipped <= 4) {
    return { ordered, bullet, delim, start, markerLen, markerCol, contentIndent: ccol - col, empty: false, content: restContent, contentCol: ccol };
  }
  // 5+ spaces: content indent is marker + 1, extra spaces stay in the content
  const extra = stripCols(rest, markerCol + markerLen, 1);
  return { ordered, bullet, delim, start, markerLen, markerCol, contentIndent: (markerCol - col) + markerLen + 1, empty: false, content: extra, contentCol: markerCol + markerLen + 1 };
}
// Split a table line into cells on unescaped |, skipping code spans.
function splitTableCells(line) {
  const cells = [];
  let cur = '', i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n) { cur += line.slice(i, i + 2); i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  // drop a leading empty cell (leading pipe) and a trailing empty cell (trailing pipe)
  if (cells.length > 0 && cells[0].trim() === '' && line.trimStart().startsWith('|')) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '' && line.trimEnd().endsWith('|')) cells.pop();
  // an escaped pipe \| is a literal | in the cell (unescaped here, before
  // inline parsing, so it is literal even inside code spans)
  return cells.map((x) => x.trim().replace(/\\\|/g, '|'));
}
// Is this line a table delimiter row? Returns the aligns array or null.
function matchTableDelimiter(content, col) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return null;
  const s = content.slice(ind.chars);
  const cells = splitTableCells(s);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] && m[2]) aligns.push('center');
    else if (m[2]) aligns.push('right');
    else if (m[1]) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// ---------------------------------------------------------------- containers
function matchContainers(line, stack, afterBlank) {
  let cur = { off: 0, col: 0, partial: 0 };
  let k = 1;
  while (k < stack.length) {
    const blk = stack[k];
    if (blk.t === 'quote') {
      const sk = skipIndent(line, cur, 3);
      if (line[sk.cur.off] === '>') {
        cur = { off: sk.cur.off + 1, col: sk.cur.col + 1, partial: 0 };
        if (line[cur.off] === ' ') cur = { off: cur.off + 1, col: cur.col + 1, partial: 0 };
        else if (line[cur.off] === '\t') cur = advanceCols(line, cur, 1);
        k++;
        continue;
      }
      break;
    }
    if (blk.t === 'item') {
      const ind = indentAt(line, cur);
      // no non-space character left after the containers above: the item
      // does not match a blank remainder (the blank-line branch decides)
      if (ind.cur.off >= line.length) break;
      // a list marker only stays inside this item when indented to the
      // content indent; otherwise it starts a new item of an enclosing list
      const rem = contentStr(line, ind.cur);
      if (matchListMarker(rem, ind.cur.col) && ind.cols < blk.contentIndent) break;
      // after a blank line, the item only continues for a line indented to
      // its content indent (in the stripped coordinates)
      if (afterBlank && ind.cols < blk.contentIndent) break;
      // the item only matches a line indented to its content indent; a
      // less-indented line does not continue the item (it may still be a
      // lazy paragraph continuation, handled by the caller)
      if (ind.cols < blk.contentIndent) break;
      cur = advanceCols(line, cur, blk.contentIndent);
      k++;
      continue;
    }
    if (blk.t === 'list') { k++; continue; }
    break; // a leaf block: stop
  }
  return { matched: k, cur };
}
function topLeaf(stack) {
  const top = stack[stack.length - 1];
  if (!top) return null;
  return (top.t === 'para' || top.t === 'code' || top.t === 'html' || top.t === 'table') ? top : null;
}
function markTrailingBlank(stack, matched) {
  // Mark the deepest open item as following a blank line, but only when the
  // blank line did not match that item's container (a blank line inside a
  // nested block does not loosen the lists above it).
  for (let k = stack.length - 1; k >= 1; k--) {
    if (stack[k].t === 'item') {
      if (k >= matched) stack[k].trailingBlank = true;
      return;
    }
  }
}
function addBlock(blk, stack, lastBlank) {
  const parent = stack[stack.length - 1];
  parent.children.push(blk);
  if (parent.t === 'item') {
    if (parent.hasContent && (lastBlank || parent.trailingBlank)) {
      const list = stack[stack.length - 2];
      if (list && list.t === 'list') list.loose = true;
    }
    parent.trailingBlank = false;
    parent.hasContent = true;
  }
}
function listMatches(list, lm) {
  if (list.ordered !== lm.ordered) return false;
  if (lm.ordered) return list.delim === lm.delim;
  return list.bullet === lm.bullet;
}
function htmlEndReached(html, content) {
  const low = content.toLowerCase();
  if (html.htype === 1) {
    return low.indexOf('</script') >= 0 || low.indexOf('</pre') >= 0 || low.indexOf('</style') >= 0 || low.indexOf('</textarea') >= 0;
  }
  if (html.htype === 2) return content.indexOf('-->') >= 0;
  if (html.htype === 3) return content.indexOf('?>') >= 0;
  if (html.htype === 4) return content.indexOf(']]>') >= 0;
  if (html.htype === 5) return content.indexOf('>') >= 0;
  return false;
}
function nextLineContinues(lines, idx, containersStack, inputEndsWithNl) {
  if (idx >= lines.length) return inputEndsWithNl;
  const line = lines[idx];
  // the previous line is the html block's (non-blank) end line
  const mc = matchContainers(line, containersStack, false);
  if (mc.matched !== containersStack.length) return false;
  const content = contentStr(line, mc.cur);
  if (/^[ \t]*$/.test(content)) return false;
  return true;
}
// paragraph continuation content: strip 4 columns when the paragraph lives
// inside a container and the line is indented 4+; top-level lines keep all.
function paraAppend(content, contentCol, stack) {
  const parent = stack[stack.length - 2];
  const ind = countIndent(content, contentCol);
  // Only a list-item parent strips 4 columns from a paragraph continuation
  // line's indent; a blockquote (or top level) keeps the leading spaces
  // as-is (probed 2026-11-16: `> foo\n>     indented four` keeps all 4
  // spaces, while `- foo\n      indented four` strips them).
  if (parent && parent.t === 'item' && ind.cols >= 4) return stripCols(content, contentCol, 4);
  return content;
}
function blockStartForPara(content, col, stack) {
  if (matchATX(content, col)) return true;
  if (matchFence(content, col)) return true;
  const hb = matchHtmlBlock(content, col);
  if (hb && hb.htype <= 6) return true;
  if (matchHr(content, col)) return true;
  const qind = countIndent(content, col);
  if (qind.cols <= 3 && content.slice(qind.chars)[0] === '>') return true;
  const lm = matchListMarker(content, col);
  if (lm) {
    // Inside a list, any list item interrupts a paragraph (even an empty
    // one, and even an ordered one not starting at 1). Outside a list, an
    // empty item cannot interrupt, and an ordered item must start at 1.
    const inList = stack ? stack.some((b) => b.t === 'list') : false;
    if (!lm.empty) {
      if (!lm.ordered) return true;
      if (lm.start === 1 || inList) return true;
    } else if (inList) return true;
  }
  return false;
}
function blockStartForTable(content, col) {
  if (matchATX(content, col)) return true;
  if (matchFence(content, col)) return true;
  const hb = matchHtmlBlock(content, col);
  if (hb && hb.htype <= 6) return true;
  if (matchHr(content, col)) return true;
  if (matchListMarker(content, col)) return true;
  const ind = countIndent(content, col);
  if (ind.cols <= 3 && content.slice(ind.chars)[0] === '>') return true;
  return false;
}

// Skip the separator after ':' in a definition: spaces on this line, or one
// newline followed by the leading spaces/tabs of the next line. A tab on the
// same line, or a blank line, fails (returns -1).
function skipDefWs(s, pos) {
  let j = pos;
  while (s[j] === ' ') j++;
  if (s[j] === '\t') return -1;
  if (s[j] === '\n') {
    if (s[j + 1] === '\n' || s[j + 1] === undefined) return -1;
    j++;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] === '\n' || s[j] === undefined) return -1;
  }
  return j;
}
function tryParseDef(lines, startIdx, stack, firstContent) {
  if (firstContent === undefined) return null;
  // the definition's first line starts with '[' (after up to 3 spaces)
  if (firstContent.replace(/^ {0,3}/, '')[0] !== '[') return null;
  // gather the definition's lines: until a blank line, or a line that fails
  // the containers. A title may span many lines, so there is no line cap.
  // Continuation lines keep their leading whitespace: it is part of a
  // multi-line title, and part boundaries skip it inline instead.
  const parts = [firstContent];
  for (let k = 1; startIdx + k < lines.length; k++) {
    const line = lines[startIdx + k];
    if (isBlankLine(line)) break;
    // a def continuation line follows a (non-blank) def line
    const mc = matchContainers(line, stack, false);
    if (mc.matched !== stack.length) break;
    parts.push(contentStr(line, mc.cur));
  }
  const combined = parts.join('\n');
  let pos = 0;
  while (pos < 3 && combined[pos] === ' ') pos++;
  if (combined[pos] !== '[') return null;
  let j = pos + 1, label = null;
  while (j < combined.length) {
    if (combined[j] === '\\' && j + 1 < combined.length) { j += 2; continue; }
    if (combined[j] === ']') { label = combined.slice(pos + 1, j); break; }
    j++;
  }
  if (label === null) return null;
  // a label with an unescaped '[' is invalid, and a label that folds to
  // empty is not a definition (cm-546, cm-551, cm-552)
  if (hasUnescapedOpenBracket(label) || foldLabel(label) === '') return null;
  if (combined[j + 1] !== ':') return null;
  pos = j + 2;
  // separator, then the destination (same line or next line)
  pos = skipDefWs(combined, pos);
  if (pos < 0) return null;
  if (pos >= combined.length) return null;
  let href;
  if (combined[pos] === '<') {
    let k = pos + 1, end = -1;
    while (k < combined.length) {
      if (combined[k] === '\n') return null;
      if (combined[k] === '>') { end = k; break; }
      k++;
    }
    if (end < 0) return null;
    href = combined.slice(pos + 1, end);
    pos = end + 1;
  } else {
    let k = pos, depth = 0;
    while (k < combined.length) {
      const c = combined[k];
      if (c === '\\' && k + 1 < combined.length && isAsciiPunct(combined[k + 1])) { k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    if (k === pos) return null;
    if (depth !== 0) return null;
    href = combined.slice(pos, k);
    pos = k;
  }
  href = unescapeDest(href);
  // optional title (same line or next line). A title that starts on a later
  // line than the destination and then fails (unterminated, or followed by
  // junk) is dropped and the definition ends after the destination; a title
  // that starts on the destination's own line and fails kills the definition.
  let title = null;
  const destEnd = pos;
  let p = pos;
  while (combined[p] === ' ') p++;
  if (combined[p] === '\t') return null;
  if (combined[p] === '\n') {
    const sepLine = p;
    let q = p + 1;
    while (combined[q] === ' ' || combined[q] === '\t') q++;
    if (combined[q] === '"' || combined[q] === "'" || combined[q] === '(') {
      const t = parseTitle(combined, q);
      if (!t) { pos = sepLine; }
      else {
        title = t.title;
        pos = t.end;
        let r = pos;
        while (combined[r] === ' ') r++;
        if (r < combined.length && combined[r] !== '\n') { title = null; pos = sepLine; }
        else pos = r;
      }
    } else {
      pos = p; // next line is not a title; the definition ends after the dest
    }
  } else if (combined[p] === '"' || combined[p] === "'" || combined[p] === '(') {
    if (p === destEnd) return null; // a title needs a space after the dest
    const t = parseTitle(combined, p);
    if (!t) return null;
    title = t.title;
    pos = t.end;
    let q = pos;
    while (combined[q] === ' ') q++;
    if (q < combined.length && combined[q] !== '\n') return null;
    pos = q;
  } else if (p >= combined.length) {
    pos = p;
  } else {
    return null; // junk after the destination
  }
  let consumed = 1;
  for (let k = 0; k < pos && k < combined.length; k++) if (combined[k] === '\n') consumed++;
  if (consumed > parts.length) consumed = parts.length;
  return { consumed, label, href, title };
}

// ---------------------------------------------------------------- block parser: main loop
function matchFenceClose(content, col, leaf) {
  const ind = countIndent(content, col);
  if (ind.cols > 3) return false;
  const s = content.slice(ind.chars);
  if (s[0] !== leaf.ch) return false;
  let len = 0;
  while (len < s.length && s[len] === leaf.ch) len++;
  if (len < leaf.len) return false;
  return /^[ \t]*$/.test(s.slice(len));
}

// Handle one non-blank line when no leaf block is open on top of the stack.
// `content` is the line after the matched container prefixes, `col` its column.
// `firstContent` overrides the def-parsing first line (used for list-item content).
// Returns the number of lines consumed from `lines` (>= 1).
function handleNoLeaf(content, col, stack, lines, i, refs, firstContent) {
  // was the immediately preceding line a (raw) blank line? It loosens lists.
  const lastBlank = i > 0 && isBlankLine(lines[i - 1]);
  // a whitespace-only line never starts a block (and never starts a para)
  if (/^[ \t]+$/.test(content)) return 1;
  const atx = matchATX(content, col);
  if (atx) { addBlock({ t: 'heading', level: atx.level, text: atx.text }, stack, lastBlank); return 1; }
  const fence = matchFence(content, col);
  if (fence) {
    // Tilde fences do NOT strip their indent from content lines (probed
    // 2026-11-16: `  ~~~c\n  foo` keeps `  foo`, while the same backtick
    // fence strips to `foo`); backtick fences strip up to fence.indent.
    const blk = { t: 'code', fence: true, ch: fence.ch, len: fence.len, indent: fence.ch === '~' ? 0 : fence.indent, info: fence.info, lines: [], started: false };
    addBlock(blk, stack, lastBlank);
    stack.push(blk);
    return 1;
  }
  const hb = matchHtmlBlock(content, col);
  if (hb) {
    const blk = { t: 'html', htype: hb.htype, lines: [content], ended: false, keepNl: false };
    if (hb.htype <= 5 && htmlEndReached(blk, content)) blk.ended = true;
    addBlock(blk, stack, lastBlank);
    stack.push(blk);
    return 1;
  }
  if (matchHr(content, col)) { addBlock({ t: 'hr' }, stack, lastBlank); return 1; }
  const qind = countIndent(content, col);
  if (qind.cols <= 3) {
    const s = content.slice(qind.chars);
    if (s[0] === '>') {
      const blk = { t: 'quote', children: [] };
      addBlock(blk, stack, lastBlank);
      stack.push(blk);
      // remainder after '>' plus one optional space, or one tab column
      const after = s.slice(1);
      const afterCol = col + qind.cols + 1;
      let rest, restCol;
      if (after[0] === ' ') { rest = after.slice(1); restCol = afterCol + 1; }
      else if (after[0] === '\t') {
        const cur2 = advanceCols(after, { off: 0, col: afterCol, partial: 0 }, 1);
        rest = contentStr(after, cur2);
        restCol = cur2.col;
      } else { rest = after; restCol = afterCol; }
      if (rest === '') return 1;
      return handleNoLeaf(rest, restCol, stack, lines, i, refs, rest);
    }
  }
  const lm = matchListMarker(content, col);
  if (lm) {
    let list = null;
    const top = stack[stack.length - 1];
    if (top && top.t === 'list' && listMatches(top, lm)) list = top;
    else {
      if (top && top.t === 'list') stack.pop();
      list = { t: 'list', ordered: lm.ordered, bullet: lm.bullet, delim: lm.delim, start: lm.start, loose: false, children: [] };
      addBlock(list, stack, lastBlank);
      stack.push(list);
    }
    const prev = list.children[list.children.length - 1];
    if (prev && (lastBlank || prev.trailingBlank)) list.loose = true;
    const item = { t: 'item', contentIndent: lm.contentIndent, children: [], trailingBlank: false, hasContent: false };
    list.children.push(item);
    stack.push(item);
    if (lm.empty) return 1;
    return handleNoLeaf(lm.content, lm.contentCol, stack, lines, i, refs, lm.content);
  }
  const ind = countIndent(content, col);
  if (ind.cols >= 4) {
    const blk = { t: 'code', fence: false, lines: [stripCols(content, col, 4)] };
    addBlock(blk, stack, lastBlank);
    stack.push(blk);
    return 1;
  }
  const def = tryParseDef(lines, i, stack, firstContent !== undefined ? firstContent : content);
  if (def) {
    // the first definition of a label wins
    const key = foldLabel(def.label);
    if (!refs.has(key)) refs.set(key, { href: def.href, title: def.title });
    return def.consumed;
  }
  const para = { t: 'para', text: content, lastLazy: false, hasLazy: false };
  addBlock(para, stack, lastBlank);
  stack.push(para);
  return 1;
}

function nextNonBlankIsCode(lines, idx, stack) {
  // Is the next non-blank line an indented-code line inside the same
  // containers? Blank lines between indented-code lines are code content.
  for (let k = idx + 1; k < lines.length; k++) {
    const ln = lines[k];
    if (isBlankLine(ln)) continue;
    // the peeked line follows a blank line, so the item rule is strict
    const m2 = matchContainers(ln, stack, true);
    if (m2.matched !== stack.length - 1) return false;
    const c2 = contentStr(ln, m2.cur);
    return countIndent(c2, m2.cur.col).cols >= 4;
  }
  return false;
}

function parseBlocks(md) {
  const refs = new Map();
  const norm = md.replace(/\r\n?/g, '\n');
  const inputEndsWithNl = norm.endsWith('\n');
  const lines = norm.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const doc = { t: 'doc', children: [] };
  const stack = [doc];
  let i = 0;
  let lastBlank = false;
  // was the previous line processed by the blank branch? After a blank line,
  // a line only continues a list item when indented to its content indent.
  let prevWasBlank = false;
  while (i < lines.length) {
    // was the immediately preceding line a (raw) blank line? It loosens lists.
    lastBlank = i > 0 && isBlankLine(lines[i - 1]);
    const line = lines[i];
    const mc = matchContainers(line, stack, prevWasBlank);
    const leaf = topLeaf(stack);
    let content = contentStr(line, mc.cur);
    const col = mc.cur.col;
    // A line of only tabs is a table row (empty cells), not a blank line;
    // a space-only line (or tab+space) is blank and ends the table. This
    // check runs before the leading-tab expansion, which would turn the
    // tabs into spaces.
    if (leaf && leaf.t === 'table' && mc.matched === stack.length - 1 && /^\t+$/.test(content)) {
      leaf.rows.push({ cells: splitTableCells(content), pipe: false });
      i++;
      continue;
    }
    // Inside a container, leading tabs in the content are expanded to
    // spaces; at the top level they are kept literally. When the content is
    // inside a blockquote, marked expands a leading tab as if the containers
    // outside the innermost blockquote were not there (probed 2026-11-16:
    // `> \\tfoo`, `> > \\tfoo`, `> > > \\tfoo` all give 2 spaces; a list
    // item + quote gives 2 as well). With no blockquote, the absolute
    // column stands (a tab directly inside a list item counts its indent).
    if (mc.matched > 1) {
      let lq = -1;
      for (let q = 1; q < mc.matched; q++) if (stack[q].t === 'quote') lq = q;
      let tabCol = col;
      if (lq > 0) {
        for (let q = 1; q < lq; q++) {
          const b = stack[q];
          if (b.t === 'quote') tabCol -= 2;
          else if (b.t === 'item') tabCol -= b.contentIndent;
        }
      }
      content = expandLeadingTabs(content, tabCol);
    }
    // A line is effectively blank when it is blank, or when its content
    // after the matched containers is empty (e.g. a lone `>` line). A
    // whitespace-only but non-empty content (e.g. `>  `) is NOT blank: it
    // continues an open paragraph with that whitespace.
    const rawBlank = isBlankLine(line);
    const fullyMatched = mc.matched === stack.length - (leaf ? 1 : 0);
    if (rawBlank || content === '') {
      prevWasBlank = true;
      // Does this blank line close a blockquote below the leaf? A quote
      // closes when the line does not match it (a raw blank line matches
      // no quote; a `>` line matches the quotes it carries).
      let quoteCloses = false;
      for (let q = 1; q < stack.length - (leaf ? 1 : 0); q++) {
        if (stack[q].t === 'quote' && q >= mc.matched) { quoteCloses = true; break; }
      }
      if (leaf && leaf.t === 'html' && leaf.ended) {
        // Types 1-5 keep the trailing newline when the following line is
        // whitespace-only (spaces/tabs) but not truly empty (probed
        // 2026-11-16); a truly empty line drops it. Types 6-7 always
        // drop it on a blank line.
        leaf.keepNl = leaf.htype <= 5 && rawBlank && line !== '';
        stack.pop();
      } else if (leaf && leaf.t === 'code' && leaf.fence) {
        if (!quoteCloses) {
          leaf.lines.push(stripCols(content, col, leaf.indent, true));
          // a blank line resets the fence's "started" state: the next
          // non-matching line closes the fence instead of being absorbed
          leaf.started = false;
          i++;
          continue;
        }
        stack.pop();
      } else if (leaf && leaf.t === 'code' && !leaf.fence) {
        // a blank line is indented-code content when it matches the
        // containers, or when a later line in the same containers is still
        // indented code (blank lines between code lines are content)
        if (fullyMatched || nextNonBlankIsCode(lines, i, stack)) {
          leaf.lines.push(stripCols(content, col, 4));
          i++;
          continue;
        }
        stack.pop();
      } else if (leaf && leaf.t === 'html' && leaf.htype <= 5) {
        if (!quoteCloses) {
          leaf.lines.push(content);
          i++;
          continue;
        }
        stack.pop();
      } else if (leaf) {
        stack.pop();
      }
      // pop from the outermost unmatched blockquote upward: everything
      // inside a closing quote closes with it (lists/items outside stay)
      let cut = -1;
      for (let q = 1; q < stack.length; q++) {
        if (stack[q].t === 'quote' && q >= mc.matched) { cut = q; break; }
      }
      if (cut >= 0) stack.length = cut;
      // a blank line closes an empty list item: it can hold no more content
      while (stack.length > 1 && stack[stack.length - 1].t === 'item' && stack[stack.length - 1].children.length === 0) stack.pop();
      markTrailingBlank(stack, mc.matched);
      i++;
      continue;
    }
    // a non-blank line: the next line does not follow a blank line
    prevWasBlank = false;
    // fenced code block
    if (leaf && leaf.t === 'code' && leaf.fence) {
      if (mc.matched !== stack.length - 1) {
        // a line that does not match the containers is still fence content
        // once the fence has started (a content line since the last blank
        // line), unless it starts a new block (fence, ATX, hr, html, list,
        // quote) — then it closes the fence instead. But only when the
        // failing container is a list item: a line missing the `>` prefix
        // closes a blockquote (and the fence) instead of being absorbed
        // (probed 2026-11-16: `- \`\`\` / plain` absorbs, `> \`\`\` / plain`
        // does not).
        if (leaf.started && stack[mc.matched].t !== 'quote' && !blockStartForPara(content, col, stack)) {
          leaf.lines.push(stripCols(content, col, leaf.indent, true));
          i++;
          continue;
        }
        stack.pop(); continue;
      }
      if (matchFenceClose(content, col, leaf)) { stack.pop(); i++; continue; }
      leaf.lines.push(stripCols(content, col, leaf.indent, true));
      leaf.started = true;
      i++;
      continue;
    }
    // indented code block
    if (leaf && leaf.t === 'code' && !leaf.fence) {
      const ind = countIndent(content, col);
      if (mc.matched === stack.length - 1 && ind.cols >= 4) {
        leaf.lines.push(stripCols(content, col, 4));
        i++;
        continue;
      }
      stack.pop();
      continue;
    }
    // html block
    if (leaf && leaf.t === 'html') {
      if (leaf.ended) {
        stack.pop();
        leaf.keepNl = nextLineContinues(lines, i, stack, inputEndsWithNl);
        continue;
      }
      if (mc.matched !== stack.length - 1) {
        stack.pop();
        leaf.keepNl = false;
        continue;
      }
      leaf.lines.push(content);
      if (htmlEndReached(leaf, content)) leaf.ended = true;
      i++;
      continue;
    }
    // paragraph
    if (leaf && leaf.t === 'para') {
      if (mc.matched === stack.length - 1) {
        const st = matchSetext(content, col);
        if (st) {
          stack.pop();
          // the paragraph was already added to its parent's children: take
          // it back out before replacing it with the heading
          const par = stack[stack.length - 1];
          const pIdx = par.children.lastIndexOf(leaf);
          if (pIdx >= 0) par.children.splice(pIdx, 1);
          // a setext heading drops the leading whitespace of the paragraph's
          // first line and the trailing whitespace of its last line
          const hlines = leaf.text.split('\n');
          hlines[0] = hlines[0].replace(/^[ \t]+/, '');
          hlines[hlines.length - 1] = hlines[hlines.length - 1].replace(/[ \t]+$/, '');
          addBlock({ t: 'heading', level: st.level, text: hlines.join('\n') }, stack, lastBlank);
          i++;
          continue;
        }
        const aligns = matchTableDelimiter(content, col);
        if (aligns) {
          const plines = leaf.text.split('\n');
          const headerCells = splitTableCells(plines[plines.length - 1]);
          if (headerCells.length === aligns.length) {
            stack.pop();
            const par = stack[stack.length - 1];
            const pIdx = par.children.lastIndexOf(leaf);
            if (pIdx >= 0) par.children.splice(pIdx, 1);
            const rest = plines.slice(0, -1).join('\n');
            if (rest !== '') addBlock({ t: 'para', text: rest, lastLazy: false, hasLazy: false }, stack, lastBlank);
            const tbl = { t: 'table', aligns, header: headerCells, rows: [] };
            addBlock(tbl, stack, lastBlank);
            stack.push(tbl);
            i++;
            continue;
          }
        }
        if (blockStartForPara(content, col, stack)) {
          stack.pop();
          continue;
        }
        leaf.text += '\n' + paraAppend(content, col, stack);
        leaf.lastLazy = false;
        i++;
        continue;
      }
      // containers failed: lazy continuation, unless a block starts here
      if (!blockStartForPara(content, col, stack)) {
        // Only the first lazy line of a paragraph is indent-stripped (up to
        // 4 columns, when indented 4+); later lazy lines are kept verbatim.
        // hasLazy is sticky for the paragraph's lifetime: a matched line in
        // between does not make the next lazy line "first" again (probed
        // 2026-11-16: a `    indented four` lazy line after a `>` line
        // keeps its indent). lastLazy (immediately-preceding) still drives
        // the setext rule below.
        let lazyText;
        if (!leaf.hasLazy) {
          const lind = countIndent(content, col);
          lazyText = lind.cols >= 4 ? stripCols(content, col, 4) : content;
        } else {
          lazyText = content;
        }
        // A lazy line that is a setext `=` underline, inside a blockquote,
        // and following another lazy line, is indented to 4 spaces so it
        // stays paragraph text instead of becoming a heading underline.
        const parent = stack[stack.length - 2];
        if (parent && parent.t === 'quote' && leaf.lastLazy) {
          const sind = countIndent(lazyText, col);
          if (sind.cols <= 3) {
            const rest = lazyText.slice(sind.chars);
            if (/^=+[ \t]*$/.test(rest)) lazyText = '    ' + rest;
          }
        }
        leaf.text += '\n' + lazyText;
        leaf.lastLazy = true;
        leaf.hasLazy = true;
        i++;
        continue;
      }
      stack.pop();
      while (stack.length > mc.matched) stack.pop();
      continue;
    }
    // table
    if (leaf && leaf.t === 'table') {
      if (mc.matched === stack.length - 1 && !blockStartForTable(content, col)) {
        leaf.rows.push({ cells: splitTableCells(content), pipe: content.includes('|') });
        i++;
        continue;
      }
      stack.pop();
      while (stack.length > mc.matched) stack.pop();
      continue;
    }
    // no leaf open: pop unmatched containers, close a list the line does not
    // continue, then handle the line
    while (stack.length > mc.matched) stack.pop();
    const topBlk = stack[stack.length - 1];
    if (topBlk && topBlk.t === 'list') {
      // a list continues only for a list item; any other block start (hr,
      // ATX, fence, html — checked before lists) closes it. Note `* * *` is
      // both a marker and an hr: the hr wins.
      const isMarker = matchListMarker(content, col);
      const isOtherBlock = matchATX(content, col) || matchFence(content, col) || matchHtmlBlock(content, col) || matchHr(content, col);
      if (!isMarker || isOtherBlock) stack.pop();
    }
    const consumed = handleNoLeaf(content, col, stack, lines, i, refs);
    i += consumed;
  }
  // EOF: close open blocks; an html block ending at EOF keeps its final \n
  // iff the input itself ends with a newline.
  while (stack.length > 1) {
    const blk = stack.pop();
    if (blk.t === 'html') blk.keepNl = inputEndsWithNl;
  }
  return { doc, refs };
}

// ---------------------------------------------------------------- rendering
function renderBlocks(blocks, refs) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}
function renderItem(it, list, refs) {
  let out = '<li>';
  const ch = it.children;
  let startIdx = 0;
  // task list: `- [ ] text` / `- [x] text` / `- [X] text` on the first paragraph
  let taskHtml = null;
  if (ch.length > 0 && ch[0].t === 'para') {
    const m = /^\[([ xX])\] /.exec(ch[0].text);
    if (m) {
      taskHtml = m[1] === ' ' ? '<input disabled="" type="checkbox">' : '<input checked="" disabled="" type="checkbox">';
      const rest = { t: 'para', text: ch[0].text.slice(4), lastLazy: false, hasLazy: false };
      if (list.loose) out += '<p>' + taskHtml + ' ' + renderInline(rest.text, refs) + '</p>\n';
      else {
        out += taskHtml + ' ' + renderInline(rest.text, refs);
      }
      startIdx = 1;
    }
  }
  for (let k = startIdx; k < ch.length; k++) {
    const c = ch[k];
    if (c.t === 'para' && !list.loose) {
      out += renderInline(c.text, refs);
    } else {
      out += renderBlock(c, refs);
    }
  }
  out += '</li>\n';
  return out;
}
function renderBlock(blk, refs) {
  switch (blk.t) {
    case 'para':
      return '<p>' + renderInline(blk.text, refs) + '</p>\n';
    case 'heading':
      return '<h' + blk.level + '>' + renderInline(blk.text, refs) + '</h' + blk.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      if (blk.fence) {
        // first word of the info string, with backslash escapes unescaped
        const first = (blk.info.split(/[ \t]+/)[0] || '').replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        const info = first ? ' class="language-' + escapeHtml(first, false) + '"' : '';
        // a fenced code block drops exactly ONE trailing empty line
        const flines = blk.lines.slice();
        if (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
        const body = flines.join('\n') + (flines.length ? '\n' : '');
        return '<pre><code' + info + '>' + escapeHtml(body, true) + '</code></pre>\n';
      }
      const lines = blk.lines.slice();
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const body = lines.join('\n') + (lines.length ? '\n' : '');
      return '<pre><code>' + escapeHtml(body, true) + '</code></pre>\n';
    }
    case 'html':
      return blk.lines.join('\n') + (blk.keepNl ? '\n' : '');
    case 'quote':
      return '<blockquote>\n' + renderBlocks(blk.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = blk.ordered ? 'ol' : 'ul';
      const start = blk.ordered && blk.start !== 1 ? ' start="' + blk.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const it of blk.children) out += renderItem(it, blk, refs);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < blk.header.length; c++) {
        const align = blk.aligns[c] ? ' align="' + blk.aligns[c] + '"' : '';
        out += '<th' + align + '>' + renderInline(blk.header[c], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      // the tbody is rendered only when some row is substantial: it has a
      // non-empty cell, or its source line contained a pipe (a row from a
      // tab-only line has neither, so a table of only such rows has no tbody)
      if (blk.rows.some((r) => r.pipe || r.cells.some((x) => x !== ''))) {
        out += '<tbody>';
        for (const row of blk.rows) {
          out += '<tr>\n';
          for (let c = 0; c < blk.header.length; c++) {
            const align = blk.aligns[c] ? ' align="' + blk.aligns[c] + '"' : '';
            const cell = c < row.cells.length ? row.cells[c] : '';
            out += '<td' + align + '>' + renderInline(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  docInLink = false;
  const { doc, refs } = parseBlocks(markdown);
  return renderBlocks(doc.children, refs);
}
