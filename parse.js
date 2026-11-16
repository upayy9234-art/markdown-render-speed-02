// parse.js — renderer Markdown cepat: CommonMark 0.31.2 + GFM.
//
// Target perilaku: marked 18.1.3 dengan opsi default (gfm aktif, breaks
// mati, pedantic mati). Untuk setiap string masukan, parse(markdown)
// mengembalikan HTML yang persis sama dengan marked.parse(markdown).
// Di mana marked menyimpang dari spesifikasi, output marked yang menang.
//
// Cara kerja: pemindai blok lalu pemindai inline, keduanya mengikuti bentuk
// grammar yang sama dengan yang dipakai marked (bentuk itulah yang mengodekan
// perilaku persisnya), sementara jalur panas — pemindaian teks inline,
// escaping HTML, dan dekode referensi numerik — ditulis sebagai loop
// karakter manual, bukan regex. Rendering langsung memakai token, tanpa
// salinan sumber yang tidak perlu. Tidak ada dependensi luar.

const NO_MATCH = { exec: () => null };

// Rakit RegExp dari potongan-potongan bernama, seperti marked menyusun
// grammar-nya. Tanda `^` di awal potongan pengganti dibuang supaya potongan
// itu bisa disisipkan di tengah pola yang lebih besar.
function buildRegex(pattern, flags = '') {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    put(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, v);
      return api;
    },
    done() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// Cache kecil untuk regex yang bergantung pada indentasi (0..3 spasi).
function indentCached(make) {
  const slots = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = slots[idx];
    if (!re) {
      re = make(idx);
      slots[idx] = re;
    }
    return re;
  };
}

const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const rx = {
  codeIndentStrip: /^(?: {0,3}\t| {1,4})/gm,
  linkBracketEscape: /\\([\[\]])/g,
  fenceIndent: /^(\s+)(?:```)/,
  leadingWs: /^\s+/,
  trailingHash: /#$/,
  leadingSpace: /^ /,
  trailingSpace: / $/,
  trailingSpaceTab: /[ \t]$/,
  nonSpace: /[^ ]/,
  newlineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multiSpace: /\s+/g,
  blank: /^[ \t]*$/,
  twoBlank: /\n[ \t]*\n[ \t]*$/,
  quoteStart: /^ {0,3}>/,
  quoteSetext: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  quoteStrip: /^ {0,3}>[ \t]?/gm,
  quoteMarkerWs: /^( {0,3}>)([ \t]+)/gm,
  listNest: /^ {1,4}(?=( {4})*[^ ])/g,
  taskStart: /^\[[ xX]\][ \t]+\S/,
  taskStrip: /^\[[ xX]\][ \t]+/,
  taskBox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  angleHref: /^<(.*)>$/,
  tablePipe: /[:|]/,
  tableEdge: /^\||\| *$/g,
  tableRowTrail: /\n[ \t]*$/,
  alignRight: /^ *-+: *$/,
  alignCenter: /^ *:-+: *$/,
  alignLeft: /^ *:-+ *$/,
  aOpen: /^<a /i,
  aClose: /^<\/a>/i,
  rawOpen: /^<(pre|code|kbd|script)(\s|>)/i,
  rawClose: /^<\/(pre|code|kbd|script)(\s|>)/i,
  angleOpen: /^</,
  angleClose: />$/,
  alnumUnicode: /[\p{L}\p{N}]/u,
  numericRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericRefOrAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escTest: /[&<>"']/,
  escReplace: /[&<>"']/g,
  escTestLoose: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escReplaceLoose: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  pct25: /%25/g,
  pipeFind: /\|/g,
  pipeSplit: / \|/,
  pipeEscaped: /\\\|/g,
  crlf: /\r\n|\r/g,
  wordStart: /^\S*/,
  trailingNl: /\n$/,
  itemRe: (() => {
    const cache = new Map();
    return (bull) => {
      let re = cache.get(bull);
      if (!re) {
        re = new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
        cache.set(bull, re);
      }
      return re;
    };
  })(),
  nextBullRe: indentCached((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`)),
  hrRe: indentCached((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fenceRe: indentCached((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headRe: indentCached((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlRe: indentCached((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  quoteRe: indentCached((i) => new RegExp(`^ {0,${i}}>`)),
};

// ---------- Grammar blok (GFM) ----------

const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const indentedCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fenceRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const atxRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const setextCore = /^(?!bull |indCode|fence|quote|atx|html|table)((?:.|\n(?!\s*?\n|bull |fence|quote|atx|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const setextRe = buildRegex(setextCore)
  .put(/bull/g, bulletRe)
  .put(/indCode/g, /(?: {4}| {0,3}\t)/)
  .put(/fence/g, / {0,3}(?:`{3,}|~{3,})/)
  .put(/quote/g, / {0,3}>/)
  .put(/atx/g, / {0,3}#{1,6}(?:\s|$)/)
  .put(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .put(/html/g, / {0,3}<[^\n>]+>\n/)
  .put(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .done();

const paraCore = /^([^\n]+(?:\n(?!hr|atx|lhead|quote|fence|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockTextRe = /^[^\n]+/;
const blockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = buildRegex(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .put('label', blockLabelRe)
  .put('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .done();

const listStartRe = buildRegex(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .put(/bull/g, bulletRe)
  .done();

const commentRe = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const htmlBlockRe = buildRegex(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i')
  .put('comment', commentRe)
  .put('tag', TAG_LIST)
  .put('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .done();

const quoteParaRe = buildRegex(paraCore)
  .put('hr', hrRe)
  .put('atx', ' {0,3}#{1,6}(?:\\s|$)')
  .put('|lhead', '')
  .put('|table', '')
  .put('quote', ' {0,3}>')
  .put('fence', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .put('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .put('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .put('tag', TAG_LIST)
  .done();

const quoteRe = buildRegex(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(para)|[^\n]*)(?:\n|$))+/ )
  .put('para', quoteParaRe)
  .done();

const tableRe = buildRegex(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|atx|quote|code|fence|list|html).*(?:\\n|$))*)\\n*|$)')
  .put('hr', hrRe)
  .put('atx', ' {0,3}#{1,6}(?:\\s|$)')
  .put('quote', ' {0,3}>')
  .put('code', '(?: {4}| {0,3}\t)[^\\n]')
  .put('fence', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .put('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .put('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .put('tag', TAG_LIST)
  .done();

// Paragraf GFM: juga terputus oleh tabel.
const paraGfmRe = buildRegex(paraCore)
  .put('hr', hrRe)
  .put('atx', ' {0,3}#{1,6}(?:\\s|$)')
  .put('|lhead', '')
  .put('table', tableRe)
  .put('quote', ' {0,3}>')
  .put('fence', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .put('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .put('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .put('tag', TAG_LIST)
  .done();

const BLOCK = {
  quote: quoteRe,
  code: indentedCodeRe,
  def: defRe,
  fences: fenceRe,
  heading: atxRe,
  hr: hrRe,
  html: htmlBlockRe,
  lheading: setextRe,
  list: listStartRe,
  newline: newlineRe,
  paragraph: paraGfmRe,
  table: tableRe,
  text: blockTextRe,
};

// ---------- Grammar inline (GFM) ----------

const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const codeSpanRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const punctRe = /[\p{P}\p{S}]/u;
const punctSpaceRe = /[\s\p{P}\p{S}]/u;
const notPunctSpaceRe = /[^\s\p{P}\p{S}]/u;
const punctStartRe = buildRegex(/^((?![*_])punctSpace)/, 'u')
  .put(/punctSpace/g, punctSpaceRe).done();
const punctNoTilde = /(?!~)[\p{P}\p{S}]/u;
const punctSpaceNoTilde = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctSpaceTilde = /(?:[^\s\p{P}\p{S}]|~)/u;

const blockSkipRe = buildRegex(/link|precode-code|html/, 'g')
  .put('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .put('precode-', '(?<!`)()')
  .put('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .put('html', /<(?! )[^<>]*?>/)
  .done();

const emOpenRe = buildRegex(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .put(/punct/g, punctNoTilde)
  .done();

const emCloseAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emCloseAstRe = buildRegex(emCloseAstCore, 'gu')
  .put(/notPunctSpace/g, notPunctSpaceTilde)
  .put(/punctSpace/g, punctSpaceNoTilde)
  .put(/punct/g, punctNoTilde)
  .done();

const emCloseUndRe = buildRegex(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .put(/notPunctSpace/g, notPunctSpaceRe)
  .put(/punctSpace/g, punctSpaceRe)
  .put(/punct/g, punctRe)
  .done();

const delOpenRe = buildRegex(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .put(/punct/g, punctRe)
  .done();

const delCloseCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const delCloseRe = buildRegex(delCloseCore, 'gu')
  .put(/notPunctSpace/g, notPunctSpaceRe)
  .put(/punctSpace/g, punctSpaceRe)
  .put(/punct/g, punctRe)
  .done();

const anyPunctRe = buildRegex(/\\(punct)/, 'gu')
  .put(/punct/g, punctRe)
  .done();
const anyPunctOutsideCodeRe = buildRegex(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .put(/punct/g, punctRe)
  .done();

const autolinkRe = buildRegex(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .put('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .put('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .done();

const inlineCommentRe = buildRegex(commentRe).put('(?:-->|$)', '-->').done();
const tagRe = buildRegex(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .put('comment', inlineCommentRe)
  .put('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .done();

const inlineBracketsRe = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabelRe = buildRegex(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .put('brackets', inlineBracketsRe)
  .done();

const linkRe = buildRegex(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .put('label', inlineLabelRe)
  .put('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .put('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();

const reflinkRe = buildRegex(/^!?\[(label)\]\[(ref)\]/)
  .put('label', inlineLabelRe)
  .put('ref', blockLabelRe)
  .done();

const nolinkRe = buildRegex(/^!?\[(ref)\](?:\[\])?/)
  .put('ref', blockLabelRe)
  .done();

const boundedBlockLabelRe = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabelRe = buildRegex(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .put('brackets', inlineBracketsRe)
  .done();

const reflinkSearchRe = buildRegex('reflink|nolink(?!\\()', 'g')
  .put('reflink', buildRegex(/^!?\[(label)\]\[(ref)\]/)
    .put('label', boundedInlineLabelRe)
    .put('ref', boundedBlockLabelRe)
    .done())
  .put('nolink', buildRegex(/^!?\[(ref)\](?:\[\])?/)
    .put('ref', boundedBlockLabelRe)
    .done())
  .done();

const protoRe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extEmailRe = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extEmailProtoRe = buildRegex(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .put(/email/g, extEmailRe)
  .done();

const urlRe = buildRegex(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .put('emailProtocol', extEmailProtoRe)
  .put('protocol', protoRe)
  .put('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .done();

const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const delRe = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const INLINE = {
  backpedal: backpedalRe,
  anyPunctuation: anyPunctRe,
  anyPunctuationOutsideCode: anyPunctOutsideCodeRe,
  autolink: autolinkRe,
  blockSkip: blockSkipRe,
  br: brRe,
  code: codeSpanRe,
  del: delRe,
  delLDelim: delOpenRe,
  delRDelim: delCloseRe,
  emStrongLDelim: emOpenRe,
  emStrongRDelimAst: emCloseAstRe,
  emStrongRDelimUnd: emCloseUndRe,
  escape: escapeRe,
  link: linkRe,
  nolink: nolinkRe,
  punctuation: punctStartRe,
  reflink: reflinkRe,
  reflinkSearch: reflinkSearchRe,
  tag: tagRe,
  url: urlRe,
};

// ---------- Pemindaian teks inline (loop karakter, bukan regex) ----------
// Bentuknya setara aturan teks GFM marked, tetapi melompat berdasarkan kode
// karakter. Regex lama mengevaluasi ulang lookahead email di tiap posisi;
// pemindaian ini hanya memeriksa kandidat email di batas kata, dan kandidat
// protokol/www/hard-break di huruf pertamanya.

// Karakter yang mengakhiri sebuah run teks di mana pun ia muncul.
const TEXT_STOP = new Uint8Array(128);
for (const ch of [92, 60, 33, 91, 96, 42, 126, 95]) TEXT_STOP[ch] = 1; // \ < ! [ ` * ~ _
// Karakter yang boleh ada di dalam alamat email.
const EMAIL_OK = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") {
  EMAIL_OK[ch.charCodeAt(0)] = 1;
}

function isAsciiAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function mailtoAt(src, i) {
  return src.startsWith('mailto:', i) || src.startsWith('xmpp:', i);
}
// Apakah pola email [karakter-email]+@ mulai di posisi i?
function emailAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc >= 128 || !EMAIL_OK[cc]) break;
    j++;
  }
  return j > i && j < n && src.charCodeAt(j) === 64;
}
// Apakah ` {2,}\n` (dua spasi atau lebih lalu newline) mulai di posisi i?
function hardBreakAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 32) j++;
  return j >= i + 2 && j < n && src.charCodeAt(j) === 10;
}
// Apakah protokol autolink (http://, https://, ftp://, sembarang kapital) mulai di i?
function protocolAt(src, i) {
  const c = src.charCodeAt(i) | 32;
  if (c === 104) { // h
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 2) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((src.charCodeAt(j) | 32) === 115) j++; // s
    return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
  }
  if (c === 102) { // f
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 2) | 32) !== 112) return false;
    return src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
  }
  return false;
}
// Apakah `www.` mulai di i, di posisi yang diizinkan GFM (awal run, atau
// setelah spasi, *, _, ~, atau paren buka)?
function wwwAt(src, i) {
  if (src.charCodeAt(i + 1) !== 119 || src.charCodeAt(i + 2) !== 119 || src.charCodeAt(i + 3) !== 46) return false;
  if (i === 0) return true;
  const p = src.charCodeAt(i - 1);
  return p === 32 || p === 9 || p === 10 || p === 13 || p === 11 || p === 12 || p === 42 || p === 95 || p === 126 || p === 40;
}

// Indeks akhir (eksklusif) run teks inline yang mulai di awal src.
// fl adalah bitmask kemampuan run ini, dihitung sekali per run oleh
// tokenizeInline dari pemindaian includes() (tes superset: bit yang nyala
// hanya menimbulkan pemeriksaan ekstra, tidak pernah melewatkan stop):
// 1 '@', 2 'mailto:'/'xmpp:', 4 '://', 8 'www.', 16 '  \n'.
function textRunEnd(src, fl) {
  const n = src.length;
  // Satu karakter non-alnum sebelum mailto:/xmpp: adalah run-nya sendiri.
  if (n > 1 && (fl & 2) && !isAsciiAlnum(src.charCodeAt(0)) && mailtoAt(src, 1)) return 1;
  let i = 0;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) {
    while (i < n && src.charCodeAt(i) === 96) i++;
  } else if (c0 === 126) {
    while (i < n && src.charCodeAt(i) === 126) i++;
  } else {
    i = 1;
  }
  // Stop langsung tepat setelah karakter/grup pertama.
  if (i < n) {
    const ci = src.charCodeAt(i);
    if (ci === 96 || ci === 126) return i;
    if ((fl & 16) && hardBreakAt(src, i)) return i;
    if ((fl & 1) && emailAt(src, i)) return i;
  }
  for (let j = i; j < n; j++) {
    const cc = src.charCodeAt(j);
    if (cc < 128 && TEXT_STOP[cc]) return j;
    if (cc === 104 || cc === 72 || cc === 102 || cc === 70) { // h H f F
      if ((fl & 4) && protocolAt(src, j)) return j;
    } else if (cc === 119) { // w
      if ((fl & 8) && wwwAt(src, j)) return j;
    } else if (cc === 32) { // spasi: hard break (` {2,}\n`) mulai di sini?
      if ((fl & 16) && hardBreakAt(src, j)) return j;
    }
    // Stop dengan lookahead satu karakter: karakter non-alnum sebelum
    // mailto:/xmpp:, atau karakter non-email sebelum pola email, mengakhiri
    // run tepat setelah karakter itu.
    if (j + 1 < n) {
      const nc = src.charCodeAt(j + 1);
      if ((fl & 2) && !isAsciiAlnum(cc) && (nc === 109 || nc === 120)) { // m x
        if (mailtoAt(src, j + 1)) return j + 1;
      }
      if ((fl & 1) && (cc >= 128 || !EMAIL_OK[cc]) && nc < 128 && EMAIL_OK[nc] && emailAt(src, j + 1)) return j + 1;
    }
  }
  return n;
}

// ---------- Util ----------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function isWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_';
}
function isHexChar(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

// Apakah teks di `i` (tepat setelah `&`) membentuk referensi karakter yang
// valid, yaitu `(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);`?
function validCharRef(s, i) {
  const n = s.length;
  if (i >= n) return false;
  if (s[i] === '#') {
    let j = i + 1;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const start = j;
      while (j < n && j < start + 6 && isHexChar(s[j])) j++;
      return j > start && j < n && s[j] === ';';
    }
    const start = j;
    while (j < n && j < start + 7 && s[j] >= '0' && s[j] <= '9') j++;
    return j > start && j < n && s[j] === ';';
  }
  let j = i;
  while (j < n && isWordChar(s[j])) j++;
  return j > i && j < n && s[j] === ';';
}

// Urai referensi karakter numerik di `i` (s[i] === '&'). Kembalikan
// {end, code} atau null.
function readNumericRef(s, i) {
  const n = s.length;
  if (s[i + 1] !== '#') return null;
  let j = i + 2;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) {
    j++;
    const start = j;
    while (j < n && j < start + 6 && isHexChar(s[j])) j++;
    if (j === start || j >= n || s[j] !== ';') return null;
    return { end: j + 1, code: parseInt(s.slice(start, j), 16) };
  }
  const start = j;
  while (j < n && j < start + 7 && s[j] >= '0' && s[j] <= '9') j++;
  if (j === start || j >= n || s[j] !== ';') return null;
  return { end: j + 1, code: parseInt(s.slice(start, j), 10) };
}

// Sama seperti escapeHtmlEntities marked, sebagai satu pemindaian karakter:
// bila encode, semua & < > " ' di-escape; bila tidak, < > " ' di-escape dan
// & hanya bila tidak bisa memulai referensi karakter. Satu pass: bila tidak
// ada yang perlu di-escape, string aslinya dikembalikan apa adanya.
function escapeHtml(str, encode) {
  const n = str.length;
  let out = '';
  let start = 0;
  for (let i = 0; i < n; i++) {
    const code = str.charCodeAt(i);
    let rep;
    if (code === 38) { // &
      if (!encode && validCharRef(str, i + 1)) continue;
      rep = '&amp;';
    } else if (code === 60) rep = '&lt;';
    else if (code === 62) rep = '&gt;';
    else if (code === 34) rep = '&quot;';
    else if (code === 39) rep = '&#39;';
    else continue;
    out += str.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? str : out + str.slice(start);
}

// Sama seperti decodeNumericCharacterReferences marked, sebagai pemindaian
// karakter. Karakter hasil dekode tidak boleh bergabung dengan tetangganya
// membentuk referensi baru, jadi & telanjang yang bukan referensi di-escape
// di sini.
function decodeNumericRefs(text) {
  if (!text.includes('&')) return text;
  if (!rx.numericRef.test(text)) return text;
  const n = text.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    if (text[i] !== '&') {
      i++;
      continue;
    }
    const ref = readNumericRef(text, i);
    if (ref) {
      out += text.slice(start, i);
      const code = ref.code;
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        out += '\uFFFD';
      } else if (code === 38) {
        out += '&amp;';
      } else {
        out += String.fromCodePoint(code);
      }
      i = ref.end;
      start = i;
    } else if (!validCharRef(text, i + 1)) {
      out += text.slice(start, i) + '&amp;';
      i++;
      start = i;
    } else {
      i++;
    }
  }
  return out + text.slice(start);
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(rx.pct25, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(rowText, count) {
  const row = rowText.replace(rx.pipeFind, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(rx.pipeSplit);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(rx.pipeEscaped, '|');
  }
  return cells;
}

// Hapus 'c' di akhir. Setara str.replace(/c*$/, '').
function rtrimChar(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suff = 0;
  while (suff < l) {
    const ch = str.charAt(l - suff - 1);
    if (ch === c && !invert) {
      suff++;
    } else if (ch !== c && invert) {
      suff++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suff);
}

function trimBlankTail(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && rx.blank.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(rx.multiSpace, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// Petunjuk penutup untuk satu pass inline: satu pemindaian sumber yang
// sudah di-mask untuk run `*` / `_` terakhir yang bisa menutup emphasis
// atau strong, dan run `~` terakhir yang bisa menutup strikethrough.
// Sebuah run hanya bisa menutup bila tidak didahului spasi ASCII atau awal
// string.
function scanClosers(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastDel = i;
      } else {
        lastEm[ch] = i;
      }
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}

function pushCloserScan(L, maskedSrc) {
  L.hintStack.push(scanClosers(maskedSrc));
}
function popCloserScan(L) {
  L.hintStack.pop();
}
function cachedEmCloser(L, maskedSrc, delim) {
  const frame = L.hintStack[L.hintStack.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastEm[delim];
  return scanClosers(maskedSrc).lastEm[delim];
}
function cachedDelCloser(L, maskedSrc) {
  const frame = L.hintStack[L.hintStack.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastDel;
  return scanClosers(maskedSrc).lastDel;
}

// ---------- Tokenizer blok ----------
// Tiap fungsi menerima state lexer L dan sisa sumber, lalu mengembalikan
// token atau undefined. `queueInline` menunda sebuah string untuk
// tokenisasi inline setelah seluruh pass blok selesai, persis seperti marked.

function queueInline(L, src, tokens = []) {
  L.inlineQueue.push({ src, tokens });
  return tokens;
}

function fenceIndentFix(raw, text) {
  const m = raw.match(rx.fenceIndent);
  if (m === null) return text;
  const indentToCode = m[1];
  return text
    .split('\n')
    .map((node) => {
      const indentMatch = node.match(rx.leadingWs);
      if (indentMatch === null) return node;
      const [indentInNode] = indentMatch;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function tokenSpace(src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) {
    return { type: 'space', raw: cap[0] };
  }
}

function tokenIndentedCode(src) {
  const cap = BLOCK.code.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    const text = raw.replace(rx.codeIndentStrip, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function tokenFences(src) {
  const cap = BLOCK.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = fenceIndentFix(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokenHeading(L, src) {
  const cap = BLOCK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (rx.trailingHash.test(text)) {
      const trimmed = rtrimChar(text, '#');
      if (!trimmed || rx.trailingSpaceTab.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    return {
      type: 'heading',
      raw: rtrimChar(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: queueInline(L, text),
    };
  }
}

function tokenHr(src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) {
    return { type: 'hr', raw: rtrimChar(cap[0], '\n') };
  }
}

function tokenBlockquote(L, src) {
  const cap = BLOCK.quote.exec(src);
  if (cap) {
    let lines = rtrimChar(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (rx.quoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inQuote = true;
        } else if (!inQuote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(
          rx.quoteMarkerWs,
          (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
        )
        .replace(rx.quoteSetext, '\n    $1')
        .replace(rx.quoteStrip, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;
      const top = L.state.top;
      L.state.top = true;
      blockTokens(L, currentText, tokens, true);
      L.state.top = top;
      if (lines.length === 0) break;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        break;
      } else if (lastToken?.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(rx.quoteStrip, '');
        const newToken = tokenBlockquote(L, newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) {
          raw = `${raw}\n${consumed.join('\n')}`;
        }
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && rx.quoteStart.test(lines[0])) {
          continue;
        }
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokenList(L, newText);
        tokens[tokens.length - 1] = newToken;
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
}

function tokenList(L, src) {
  let cap = BLOCK.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isOrdered = bull.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered: isOrdered,
      start: isOrdered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bull = isOrdered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = rx.itemRe(bull);
    let endsWithBlank = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (BLOCK.hr.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const firstLine = cap[2].split('\n', 1)[0];
      const bulletIndent = cap[1].length;
      let line = firstLine.replace(rx.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
      let nextLine = src.split('\n', 1)[0];
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(rx.nonSpace);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && rx.blank.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const nextBullRe = rx.nextBullRe(indent);
        const hrRe2 = rx.hrRe(indent);
        const fenceRe2 = rx.fenceRe(indent);
        const headRe2 = rx.headRe(indent);
        const htmlRe2 = rx.htmlRe(indent);
        const quoteRe2 = rx.quoteRe(indent);
        // Pemindaian baris berbasis indeks: pemotongan src per baris dulu
        // menyalin seluruh sisa list di tiap baris (kuadratik). p hanya
        // maju melewati baris yang sudah dikonsumsi; saat break, p masih
        // menunjuk baris yang belum dikonsumsi, persis seperti src dulu.
        // Keenam regex awal-baris di bawah semuanya `^ {0,effMax}marker`,
        // jadi tidak ada yang bisa cocok kecuali karakter non-spasi pertama
        // berada dalam effMax spasi dan berupa karakter marker: pilih
        // berdasarkan karakter itu, bukan menjalankan keenamnya tiap baris.
        const effMax = Math.max(0, Math.min(3, indent - 1));
        let p = 0;
        while (p < src.length) {
          let nl = src.indexOf('\n', p);
          if (nl === -1) nl = src.length;
          const rawLine = src.slice(p, nl);
          nextLine = rawLine;
          // expandTabs hanya mengubah tab; baris tanpa tab di awal
          // dikembalikan apa adanya, jadi lewati replace (dan salinannya).
          let lineNoTabs = nextLine;
          if (nextLine.charCodeAt(0) === 32 || nextLine.charCodeAt(0) === 9) {
            let hasTab = false;
            for (let q = 0; q < nextLine.length; q++) {
              const cc = nextLine.charCodeAt(q);
              if (cc === 9) { hasTab = true; break; }
              if (cc !== 32) break;
            }
            if (hasTab) {
              lineNoTabs = nextLine.replace(rx.leadingSpaceTab, (ws) => expandTabs(ws));
            }
          }
          // Karakter non-spasi pertama (spasi saja) pada baris mentah.
          let k = 0;
          while (k < nextLine.length && nextLine.charCodeAt(k) === 32) k++;
          if (k <= effMax && k < nextLine.length) {
            const fc = nextLine.charCodeAt(k);
            if (fc === 96 || fc === 126) { // ` ~
              if (fenceRe2.test(nextLine)) break;
            } else if (fc === 35) { // #
              if (headRe2.test(nextLine)) break;
            } else if (fc === 60) { // <
              if (htmlRe2.test(nextLine)) break;
            } else if (fc === 62) { // >
              if (quoteRe2.test(nextLine)) break;
            } else if (fc === 42 || fc === 43 || fc === 45) { // * + -
              if (nextBullRe.test(nextLine)) break;
              if (hrRe2.test(nextLine)) break;
            } else if (fc === 95) { // _
              if (hrRe2.test(nextLine)) break;
            } else if (fc >= 48 && fc <= 57) { // digit
              if (nextBullRe.test(nextLine)) break;
            }
          }
          // Indeks pertama yang karakternya bukan spasi (== pencarian /[^ ]/).
          let firstNonSpace = 0;
          while (firstNonSpace < lineNoTabs.length && lineNoTabs.charCodeAt(firstNonSpace) === 32) firstNonSpace++;
          const isBlank = !nextLine.trim();
          if (firstNonSpace >= indent || isBlank) {
            itemContents += '\n' + lineNoTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(rx.tabGlobal, '    ').search(rx.nonSpace) >= 4) break;
            if (fenceRe2.test(line)) break;
            if (headRe2.test(line)) break;
            if (htmlRe2.test(line)) break;
            if (hrRe2.test(line)) break;
            const setextCont = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && BLOCK.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextCont
              ? `    ${lineNoTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = isBlank;
          p = nl + 1;
          line = lineNoTabs.slice(indent);
        }
        src = src.slice(p);
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlank) {
          list.loose = true;
        } else if (rx.twoBlank.test(raw)) {
          endsWithBlank = true;
        }
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: rx.taskStart.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();
    for (const item of list.items) {
      L.state.top = false;
      item.tokens = blockTokens(L, item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultiBreak = spacers.length > 0 && spacers.some((t) => rx.anyLine.test(t.raw));
        list.loose = hasMultiBreak;
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
        item.text = item.text.replace(rx.taskStrip, '');
        firstTok.raw = firstTok.raw.replace(rx.taskStrip, '');
        firstTok.text = firstTok.text.replace(rx.taskStrip, '');
        for (let i = L.inlineQueue.length - 1; i >= 0; i--) {
          if (rx.taskStart.test(L.inlineQueue[i].src)) {
            L.inlineQueue[i].src = L.inlineQueue[i].src.replace(rx.taskStrip, '');
            break;
          }
        }
        const taskRaw = rx.taskBox.exec(item.raw);
        if (taskRaw) {
          const checkbox = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkbox.raw,
                text: checkbox.raw,
                tokens: [checkbox],
              });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }
    return list;
  }
}

function tokenHtmlBlock(src) {
  const cap = BLOCK.html.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokenDef(src) {
  const cap = BLOCK.def.exec(src);
  if (cap) {
    if (!rx.angleOpen.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(rx.angleHref, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrimChar(cap[0], '\n'), href, title };
  }
}

function tokenTable(L, src) {
  const cap = BLOCK.table.exec(src);
  if (!cap) return;
  if (!rx.tablePipe.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(rx.tableEdge, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(rx.tableRowTrail, '').split('\n') : [];
  const item = { type: 'table', raw: rtrimChar(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (rx.alignRight.test(align)) {
      item.align.push('right');
    } else if (rx.alignCenter.test(align)) {
      item.align.push('center');
    } else if (rx.alignLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      tokens: queueInline(L, headers[i]),
      header: true,
      align: item.align[i],
    });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      tokens: queueInline(L, cell),
      header: false,
      align: item.align[i],
    })));
  }
  return item;
}

function tokenSetext(L, src) {
  const cap = BLOCK.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrimChar(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: queueInline(L, text),
    };
  }
}

function tokenParagraph(L, src) {
  const cap = BLOCK.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(L, text) };
  }
}

function tokenText(L, src) {
  const cap = BLOCK.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(L, cap[0]) };
  }
}

// ---------- Tokenizer inline ----------

function labelEndsInTag(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function emitLink(L, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(rx.linkBracketEscape, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = L.state.inLink;
  const outerEmitted = L.state.linkEmitted;
  const outerRaw = L.state.inRawBlock;
  L.state.inLink = true;
  L.state.linkEmitted = false;
  const tokens = inlineTokens(L, text);
  const textHasLink = L.state.linkEmitted;
  L.state.linkEmitted = outerEmitted;
  L.state.inLink = outerInLink;
  if (!isImage) {
    // CommonMark: "Link tidak boleh berisi link lain, di level mana pun."
    // Batalkan supaya pemanggil jatuh ke teks dan link dalamlah yang
    // dipertahankan. Gambar dikecualikan.
    if (textHasLink) {
      L.state.inRawBlock = outerRaw;
      return;
    }
    L.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokenEscape(src) {
  const cap = INLINE.escape.exec(src);
  if (cap) {
    return { type: 'escape', raw: cap[0], text: cap[1] };
  }
}

function tokenTag(L, src) {
  const cap = INLINE.tag.exec(src);
  if (cap) {
    if (!L.state.inLink && rx.aOpen.test(cap[0])) {
      L.state.inLink = true;
    } else if (L.state.inLink && rx.aClose.test(cap[0])) {
      L.state.inLink = false;
    }
    if (!L.state.inRawBlock && rx.rawOpen.test(cap[0])) {
      L.state.inRawBlock = true;
    } else if (L.state.inRawBlock && rx.rawClose.test(cap[0])) {
      L.state.inRawBlock = false;
    }
    return {
      type: 'html',
      raw: cap[0],
      inLink: L.state.inLink,
      inRawBlock: L.state.inRawBlock,
      block: false,
      text: cap[0],
    };
  }
}

function tokenLink(L, src) {
  // Regex link bisa backtrack kuadratik pada input link yang tak tertutup;
  // inlineTokens menancapkan satu pemindaian paren per run, dan bila itu
  // false regex tidak mungkin cocok, jadi batalkan sebelum menjalankannya.
  if (L.state.linkParenPossible === false) return undefined;
  const cap = INLINE.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelEndsInTag(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (rx.angleOpen.test(trimmedUrl)) {
      if (!(rx.angleClose.test(trimmedUrl))) return;
      const rtrimSlash = rtrimChar(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParen = findClosingBracket(cap[2], '()');
      if (lastParen === -2) return;
      if (lastParen > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParen;
        cap[2] = cap[2].substring(0, lastParen);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // ')' yang mengakhiri match adalah penutup link hanya bila tidak
    // di-escape. `[foo](/url\)` tidak punya penutup; paren itu adalah teks
    // destinasi.
    const unescaped = rtrimChar(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (rx.angleOpen.test(href)) {
      href = href.slice(1, -1);
    }
    return emitLink(L, cap, {
      href: href ? href.replace(INLINE.anyPunctuation, '$1') : href,
      title: title ? title.replace(INLINE.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}

function tokenReflink(L, src) {
  let cap;
  if ((cap = INLINE.reflink.exec(src)) || (cap = INLINE.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelEndsInTag(src, cap[1], labelStart)) return;
    const link = L.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return emitLink(L, cap, link, cap[0]);
  }
}

function tokenEmStrong(L, src, maskedSrc, prevChar = '') {
  let match = INLINE.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delim = match[0][0];
  // Pembuka di tengah run hanya boleh berpasangan dengan delimiter yang
  // hanya bisa menutup, kalau tidak ia mencuri pembuka span berikutnya.
  const midRun = prevChar === delim;
  // Awal run delimiter ini mungkin sudah berada di belakang src. Flanking
  // dan aturan 9-10 menyangkut seluruh run, jadi cari awalnya.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delim) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punctuation.exec(prevChar);
  // _ tidak boleh berada di antara dua alfanumerik.
  if (match[4] && prevChar.match(rx.alnumUnicode)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLen = [...match[0]].length - 1;
    let rDelim, rLen, delimTotal = lLen, midTotal = 0;
    // Aturan 9-10 menghitung seluruh run, dan juga berlaku saat pembuka
    // bisa menutup juga.
    const runLen = srcStart - runStart + lLen;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return;
    const endRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastCloser = cachedEmCloser(L, maskedSrc, delim);
    const windowStart = maskedSrc.length - src.length + lLen;
    if (lastCloser < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLen);
    const lastCloserInWindow = lastCloser - windowStart;
    endRe.lastIndex = 0;
    while ((match = endRe.exec(maskedSrc)) !== null) {
      if (match.index > lastCloserInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // lewati satu * dalam __abc*abc__
      rLen = [...rDelim].length;
      if (match[3] || match[4]) { // menemukan Left Delim lain
        delimTotal += rLen;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // Left atau Right Delim
        if (midRun && (match[5] || match[6])) break;
        if (runLen % 3 && !((runLen + rLen) % 3)) {
          midTotal += rLen;
          continue; // Aturan Emphasis CommonMark 9-10
        }
      }
      delimTotal -= rLen;
      if (delimTotal > 0) continue; // belum cukup delimiter penutup
      rLen = Math.min(rLen, rLen + delimTotal + midTotal);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + firstLen + rLen);
      if (Math.min(lLen, rLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(L, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(L, text) };
    }
  }
}

function tokenCodespan(src) {
  const cap = INLINE.code.exec(src);
  if (cap) {
    let text = cap[2].replace(rx.newlineGlobal, ' ');
    const hasNonSpace = rx.nonSpace.test(text);
    const spaceBothEnds = rx.leadingSpace.test(text) && rx.trailingSpace.test(text);
    if (hasNonSpace && spaceBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokenBr(src) {
  const cap = INLINE.br.exec(src);
  if (cap) {
    return { type: 'br', raw: cap[0] };
  }
}

function tokenDel(L, src, maskedSrc, prevChar = '') {
  let match = INLINE.delLDelim.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const lLen = [...match[0]].length - 1;
    let rDelim, rLen, delimTotal = lLen;
    const endRe = INLINE.delRDelim;
    const lastCloser = cachedDelCloser(L, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLen;
    if (lastCloser < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLen);
    const lastCloserInWindow = lastCloser - windowStart;
    endRe.lastIndex = 0;
    while ((match = endRe.exec(maskedSrc)) !== null) {
      if (match.index > lastCloserInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLen = [...rDelim].length;
      if (rLen !== lLen) continue;
      if (match[3] || match[4]) { // menemukan Left Delim lain
        delimTotal += rLen;
        continue;
      }
      delimTotal -= rLen;
      if (delimTotal > 0) continue; // belum cukup delimiter penutup
      rLen = Math.min(rLen, rLen + delimTotal);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + firstLen + rLen);
      const text = raw.slice(lLen, -lLen);
      return { type: 'del', raw, text, tokens: inlineTokens(L, text) };
    }
  }
}

function tokenAutolink(src) {
  const cap = INLINE.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokenUrl(src) {
  let cap;
  if (cap = INLINE.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevZero;
      do {
        prevZero = cap[0];
        cap[0] = INLINE.backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevZero !== cap[0]);
      text = cap[0];
      if (cap[1] === 'www.') {
        href = 'http://' + cap[0];
      } else {
        href = cap[0];
      }
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokenInlineText(L, src, fl) {
  const end = textRunEnd(src, fl);
  const raw = src.slice(0, end);
  const inRaw = L.state.inRawBlock;
  return {
    type: 'text',
    raw,
    // HTML mentah mempertahankan apa adanya; di tempat lain referensi
    // karakter numerik berarti karakter itu sendiri.
    text: inRaw ? raw : decodeNumericRefs(raw),
    escaped: inRaw,
  };
}

// ---------- Lexer ----------

function freshState() {
  return {
    links: Object.create(null),
    inlineQueue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
    hintStack: [],
  };
}

function blockTokens(L, src, tokens = [], lastParaClipped = false) {
  let srcLen = Infinity;
  while (src) {
    if (src.length < srcLen) {
      srcLen = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let token;
    // baris kosong
    if (token = tokenSpace(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (token.raw.length === 1 && lastToken !== undefined) {
        // satu \n sebagai pemisah menutup baris terakhir, jadi pindahkan ke sana
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    // kode indentasi
    if (token = tokenIndentedCode(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      // Blok kode indentasi tidak boleh memutus paragraf.
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // pagar kode
    if (token = tokenFences(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // heading
    if (token = tokenHeading(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // garis horizontal
    if (token = tokenHr(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // blockquote
    if (token = tokenBlockquote(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // list
    if (token = tokenList(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // html blok
    if (token = tokenHtmlBlock(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // definisi link
    if (token = tokenDef(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        // Definisi pertama untuk sebuah label yang menang, tetapi definisi
        // berikutnya tetap mengonsumsi teksnya.
        if (!L.links[token.tag]) {
          L.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }
    // tabel (gfm)
    if (token = tokenTable(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // heading setext
    if (token = tokenSetext(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // paragraf level atas
    if (L.state.top && (token = tokenParagraph(L, src))) {
      const lastToken = tokens[tokens.length - 1];
      if (lastParaClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParaClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    // teks
    if (token = tokenText(L, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  L.state.top = true;
  return tokens;
}

// Apakah teks link ini sudah memuat sebuah link? Gambar tidak dihitung:
// gambar boleh memuat link, link tidak boleh.
function linkInsideText(L, text) {
  if (!text.includes('[')) return false;
  const linkRule = INLINE.link;
  for (const match of text.matchAll(INLINE.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(L.links, normalizeLabel(m0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInsideText(L, m0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

// Sembunyikan link, kode, html, dan escape supaya emStrong dan del tidak
// melihat delimiter di dalamnya.
function maskSource(L, src) {
  let masked = src;
  if (L.links && src.includes('[')) {
    const search = INLINE.reflinkSearch;
    const maskOne = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(L.links, normalizeLabel(m0.slice(refStart + 1, -1)))) {
        return m0;
      }
      // Kandidat yang teksnya sudah memuat link tidak pernah menjadi link,
      // jadi meratakan seluruh span akan menyembunyikan emphasis yang masih
      // berlaku di dalamnya. Mask link yang dimuatnya saja. Gambar
      // dikecualikan: teksnya diratakan menjadi atribut alt.
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInsideText(L, text)) {
          return '[' + text.replace(search, maskOne)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  // Mask karakter yang di-escape. Setiap mask harus mempertahankan panjang
  // yang digantikannya: emStrong dan del menyelaraskan maskedSrc dengan src
  // dengan mengiris dari akhir. Backslash di dalam code span adalah
  // literal, bukan escape. Pola ini hanya bisa cocok dengan backslash atau
  // backtick.
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(INLINE.anyPunctuationOutsideCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) {
        return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return m0;
    });
  }
  // Mask blok lain. Pola ini hanya bisa cocok dengan link ([), code span
  // (`), atau tag html (<).
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(INLINE.blockSkip, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

function inlineTokens(L, src, tokens = []) {
  const prevParen = L.state.linkParenPossible;
  L.state.linkParenPossible = prevParen && src.includes(')');
  try {
    return inlineTokensInner(L, src, tokens);
  } finally {
    L.state.linkParenPossible = prevParen;
  }
}

function inlineTokensInner(L, src, tokens) {
  // Sumber yang di-mask dan pemindaian penutup hanya dibaca oleh emStrong
  // dan del, yang butuh *, _ atau ~ untuk mulai. Lewati keduanya untuk run
  // tanpa delimiter itu.
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? maskSource(L, src) : src;
  if (!hasDelim) {
    return tokenizeInline(L, src, masked, tokens);
  }
  pushCloserScan(L, masked);
  try {
    return tokenizeInline(L, src, masked, tokens);
  } finally {
    popCloserScan(L);
  }
}

// Bisakah aturan url GFM cocok di awal src? Ia hanya cocok dengan www.,
// http(s)://, ftp://, mailto:/xmpp: + email, atau email telanjang (bagian
// lokal di posisi 0, lalu @). Selain itu tidak bisa cocok, jadi tokenizer
// url tidak perlu jalan. Ini tes superset: true hanya menimbulkan panggilan
// tokenUrl ekstra yang gagal, tidak pernah melewatkan kecocokan.
function urlMayMatch(src) {
  const c0 = src.charCodeAt(0);
  if (c0 === 119) { // w: www.
    if (src.charCodeAt(1) === 119 && src.charCodeAt(2) === 119 && src.charCodeAt(3) === 46) return true;
  } else if (c0 === 104 || c0 === 72) { // h/H: http:// atau https://
    const s = src.slice(0, 8).toLowerCase();
    if (s.startsWith('http://') || s === 'https://') return true;
  } else if (c0 === 102 || c0 === 70) { // f/F: ftp://
    if (src.slice(0, 6).toLowerCase() === 'ftp://') return true;
  } else if (c0 === 109) { // m: mailto:
    if (src.startsWith('mailto:')) return true;
  } else if (c0 === 120) { // x: xmpp:
    if (src.startsWith('xmpp:')) return true;
  }
  // Email telanjang: karakter bagian lokal [A-Za-z0-9._+-] dari 0, lalu @.
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c === 46 || c === 95 || c === 43 || c === 45) {
      i++;
    } else break;
  }
  return i > 0 && i < n && src.charCodeAt(i) === 64;
}

function tokenizeInline(L, src, maskedSrc, tokens) {
  let keepPrev = false;
  let prevChar = '';
  let srcLen = Infinity;
  // Apa yang bisa dimuat run inline ini, dari pemindaian includes() native
  // (flag superset untuk textRunEnd; lihat komentarnya).
  const fl = (src.includes('@') ? 1 : 0)
    | ((src.includes('mailto:') || src.includes('xmpp:')) ? 2 : 0)
    | (src.includes('://') ? 4 : 0)
    | (src.includes('www.') ? 8 : 0)
    | (src.includes('  \n') ? 16 : 0);
  while (src) {
    if (src.length < srcLen) {
      srcLen = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    let token;
    // Dispatch berdasarkan karakter pertama: setiap tokenizer inline
    // berjangkar dan hanya bisa cocok bila src mulai dengan salah satu dari
    // sedikit karakter, jadi mencoba yang lain dulu hanya membakar eksekusi
    // regex yang gagal. Urutan di dalam tiap cabang mempertahankan urutan
    // marked.
    const c = src.charCodeAt(0);
    if (c === 92) { // backslash: escape, atau break backslash-newline
      if (token = tokenEscape(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokenBr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 60) { // <: tag html atau autolink
      if (token = tokenTag(L, src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokenAutolink(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 91 || c === 33) { // [ atau !: link atau reflink
      if (token = tokenLink(L, src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokenReflink(L, src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens[tokens.length - 1];
        if (token.type === 'text' && lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    } else if (c === 42 || c === 95) { // * atau _: emphasis
      if (token = tokenEmStrong(L, src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      // Email telanjang bisa mulai dengan `_` (bagian lokalnya
      // mengizinkannya), jadi saat emphasis gagal di `_`, aturan url GFM
      // tetap harus dicoba sebelum jatuh ke teks — kalau tidak,
      // `_foo@bar.com` kehilangan underscore depannya dari link email.
      if (c === 95 && !L.state.inLink && urlMayMatch(src)) {
        if (token = tokenUrl(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }
    } else if (c === 96) { // `: code span
      if (token = tokenCodespan(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 32) { // spasi: hard break (dua spasi + newline)
      if (token = tokenBr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 126) { // ~: strikethrough
      if (token = tokenDel(L, src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (!L.state.inLink && urlMayMatch(src)) {
      // url (gfm): hanya bisa dicapai dari awal non-delimiter
      if (token = tokenUrl(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // teks
    if (token = tokenInlineText(L, src, fl)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // lacak prevChar sebelum run ____ dimulai
        prevChar = token.raw.slice(-1);
      }
      keepPrev = true;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  return tokens;
}

// ---------- Renderer ----------

function renderCodeBlock(token) {
  const lang = (token.lang || '').match(rx.wordStart)?.[0];
  // Blok kode kosong tidak punya isi, jadi tidak boleh mendapat newline.
  const code = token.text ? token.text.replace(rx.trailingNl, '') + '\n' : '';
  if (!lang) {
    return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeHtml(lang) + '">'
    + escapeHtml(code, true) + '</code></pre>\n';
}

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTextToken(L, token, textOnly) {
  if (textOnly) return token.text;
  if ('tokens' in token && token.tokens) {
    return renderInline(L, token.tokens);
  }
  return ('escaped' in token && token.escaped) ? token.text : escapeHtml(token.text);
}

function renderLink(L, token) {
  // Referensi tidak di-resolve di dalam autolink, jadi setiap `&` di sana
  // adalah literal. Di tempat lain hanya `&` yang tidak bisa memulai
  // referensi yang perlu di-escape.
  const inner = token.autolink
    ? escapeHtml(token.text, true)
    : renderInline(L, token.tokens);
  const cleaned = cleanUrl(token.href);
  if (cleaned === null) return inner;
  const href = escapeHtml(cleaned, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) {
    out += ' title="' + escapeHtml(token.title) + '"';
  }
  out += '>' + inner + '</a>';
  return out;
}

function renderImage(L, token) {
  let text = token.text;
  if (token.tokens) {
    text = renderInlineAsText(L, token.tokens);
  }
  const cleaned = cleanUrl(token.href);
  if (cleaned === null) return escapeHtml(text);
  const href = cleaned;
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`;
  if (token.title) {
    out += ` title="${escapeHtml(token.title)}"`;
  }
  out += '>';
  return out;
}

function renderCell(L, token) {
  const content = renderInline(L, token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(L, token) {
  let cell = '';
  for (let j = 0; j < token.header.length; j++) {
    cell += renderCell(L, token.header[j]);
  }
  const header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (let j = 0; j < token.rows.length; j++) {
    const row = token.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) {
      cell += renderCell(L, row[k]);
    }
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n' + '<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(L, token) {
  let body = '';
  for (let j = 0; j < token.items.length; j++) {
    body += `<li>${renderTokens(L, token.items[j].tokens)}</li>\n`;
  }
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderTokens(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInline(L, token.tokens)}</h${token.depth}>\n`; break;
      case 'code': out += renderCodeBlock(token); break;
      case 'table': out += renderTable(L, token); break;
      case 'blockquote': out += `<blockquote>\n${renderTokens(L, token.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(L, token); break;
      case 'checkbox': out += renderCheckbox(token); break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(L, token.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(L, token, false); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// TextRenderer: hanya mengembalikan bagian tekstual token (dipakai untuk
// alt text gambar).
function renderInlineAsText(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderInlineAsText(L, token.tokens) : token.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += token.text;
        break;
      case 'br': break;
      case 'checkbox': out += token.raw; break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderInline(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape': out += renderTextToken(L, token, false); break;
      case 'html': out += token.text; break;
      case 'link': out += renderLink(L, token); break;
      case 'image': out += renderImage(L, token); break;
      case 'checkbox': out += renderCheckbox(token); break;
      case 'strong': out += `<strong>${renderInline(L, token.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(L, token.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(token.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(L, token.tokens)}</del>`; break;
      case 'text': out += renderTextToken(L, token, false); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------- Titik masuk ----------

/** HTML yang dirender marked 18.1.3 untuk `markdown`, dengan opsi default marked. */
export function parse(markdown) {
  const L = freshState();
  // Sebagian besar dokumen tidak mengandung \r; lewati pemindaian replace
  // bila tidak ada, karena replace selalu memindai seluruh string.
  const src = markdown.includes('\r') ? markdown.replace(rx.crlf, '\n') : markdown;
  const tokens = blockTokens(L, src, []);
  for (let i = 0; i < L.inlineQueue.length; i++) {
    const next = L.inlineQueue[i];
    // Tag <pre>, <code>, <kbd>, atau <script> inline yang dibiarkan terbuka
    // berakhir bersama blok yang memuatnya; kalau dibawa terus, ia akan
    // menghentikan escaping teks di semua blok berikutnya.
    L.state.inRawBlock = false;
    inlineTokens(L, next.src, next.tokens);
  }
  L.inlineQueue = [];
  return renderTokens(L, tokens);
}
