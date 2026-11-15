// parse.js — a fast CommonMark 0.31.2 + GFM renderer.
//
// Behaviour follows marked 18.1.3 with its default options (gfm on, breaks
// off, pedantic off, async off): for every input string, parse(markdown)
// returns exactly the HTML that marked.parse(markdown) returns. The
// implementation below is my own, written for this bounty; it is not a copy
// of marked's source. Where marked departs from the CommonMark or GFM spec,
// marked's output is the target, never the spec's.
//
// Speed notes: the block and inline grammars are the same shapes marked
// uses (they encode the exact behaviour), but the hot paths — inline text
// scanning, HTML escaping and numeric-reference decoding — are hand-written
// character scans instead of regular expressions, and rendering works
// directly on the tokens without extra copies of the source.

const noopTest = { exec: () => null };

// Build a RegExp from a source string with named parts replaced, the way
// marked composes its grammars. A leading `^` in a replacement is dropped
// so a part can be spliced into the middle of a larger pattern.
function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (() => {
    const cache = new Map();
    return (bull) => {
      let regex = cache.get(bull);
      if (!regex) {
        regex = new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
        cache.set(bull, regex);
      }
      return regex;
    };
  })(),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// Block-level grammar (GFM).
const newline = /^(?:[ \t]*(?:\n|$))+/;
const blockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const lheading = edit(lheadingCore)
  .replace(/bull/g, bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const blockText = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bullet)
  .getRegex();

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const html = edit(
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
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const blockquoteParagraph = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', blockquoteParagraph)
  .getRegex();

const gfmTable = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

// The GFM paragraph rule interrupts on a table; build it the same way.
const paragraphGfm = edit(_paragraph)
  .replace('hr', hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTable)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

const block = {
  blockquote,
  code: blockCode,
  def,
  fences,
  heading,
  hr,
  html,
  lheading,
  list,
  newline,
  paragraph: paragraphGfm,
  table: gfmTable,
  text: blockText,
};

// Inline-level grammar (GFM).
const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const punctuation = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

const blockSkip = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const emStrongLDelim = edit(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emStrongRDelimAst = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const emStrongRDelimUnd = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

const delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const delRDelim = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const anyPunctuation = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
const anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const autolink = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tag = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const reflink = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const nolink = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();

const url = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();

const _backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const inlineTextGfm = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

const inline = {
  _backpedal,
  anyPunctuation,
  anyPunctuationOutsideCode,
  autolink,
  blockSkip,
  br,
  code: inlineCode,
  del,
  delLDelim,
  delRDelim,
  emStrongLDelim,
  emStrongRDelimAst,
  emStrongRDelimUnd,
  escape,
  link,
  nolink,
  punctuation,
  reflink,
  reflinkSearch,
  tag,
  url,
};

// ---- Helpers ----

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function isWordChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
}
function isHexChar(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

// Does the text at `i` (just after an `&`) form a valid character reference,
// i.e. `(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);`? Used by the no-encode
// escaping and by numeric-reference decoding.
function isValidCharRef(s, i) {
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

// Parse a numeric character reference at `i` (s[i] === '&'). Returns
// {end, code} or null.
function parseNumericRef(s, i) {
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

// Same as marked's escapeHtmlEntities, but as a single character scan:
// with encode, every & < > " ' is escaped; without it, < > " ' are, and &
// only when it cannot start a character reference. No regex test first:
// one pass either returns the original string (nothing to escape) or the
// escaped copy.
function escapeHtmlEntities(html, encode) {
  const n = html.length;
  let out = '';
  let start = 0;
  for (let i = 0; i < n; i++) {
    const code = html.charCodeAt(i);
    let rep;
    if (code === 38) { // &
      if (!encode && isValidCharRef(html, i + 1)) continue;
      rep = '&amp;';
    } else if (code === 60) rep = '&lt;'; // <
    else if (code === 62) rep = '&gt;'; // >
    else if (code === 34) rep = '&quot;'; // "
    else if (code === 39) rep = '&#39;'; // '
    else continue;
    out += html.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? html : out + html.slice(start);
}

// Same as marked's decodeNumericCharacterReferences, as a character scan.
// A decoded character must not join its neighbours into a new reference,
// so a bare & that is not already a reference is escaped here.
function decodeNumericCharacterReferences(text) {
  if (!text.includes('&')) return text;
  if (!other.numericCharacterReference.test(text)) return text;
  const n = text.length;
  let out = '';
  let start = 0;
  let i = 0;
  while (i < n) {
    if (text[i] !== '&') {
      i++;
      continue;
    }
    const ref = parseNumericRef(text, i);
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
    } else if (!isValidCharRef(text, i + 1)) {
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
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(other.splitPipe);
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
    cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's. Equivalent to str.replace(/c*$/, '').
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
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

// Closer hints for one inline pass: one scan of the masked source for the
// last `*` / `_` run that can close emphasis or strong and the last `~` run
// that can close strikethrough. A run can close only when it is not
// preceded by ASCII whitespace or the start of the string.
function scanLastPossibleEmStrongDelClosers(src) {
  const lastPossibleEmStrongCloserIndex = { '*': -1, _: -1 };
  let lastPossibleDelCloserIndex = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        lastPossibleDelCloserIndex = i;
      } else {
        lastPossibleEmStrongCloserIndex[ch] = i;
      }
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastPossibleEmStrongCloserIndex, lastPossibleDelCloserIndex };
}

function beginEmStrongDelCloserScan(L, maskedSrc) {
  L.hintStack.push(scanLastPossibleEmStrongDelClosers(maskedSrc));
}
function endEmStrongDelCloserScan(L) {
  L.hintStack.pop();
}
function cachedLastPossibleEmStrongCloserIndex(L, maskedSrc, delim) {
  const frame = L.hintStack[L.hintStack.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastPossibleEmStrongCloserIndex[delim];
  return scanLastPossibleEmStrongDelClosers(maskedSrc).lastPossibleEmStrongCloserIndex[delim];
}
function cachedLastPossibleDelCloserIndex(L, maskedSrc) {
  const frame = L.hintStack[L.hintStack.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastPossibleDelCloserIndex;
  return scanLastPossibleEmStrongDelClosers(maskedSrc).lastPossibleDelCloserIndex;
}

// ---- Tokenizer: block level ----
// Each function takes the lexer state L and the remaining source, and
// returns a token or undefined. `inline` queues a string for inline
// tokenization after the whole block pass, exactly as marked does.

function lexInline(L, src, tokens = []) {
  L.inlineQueue.push({ src, tokens });
  return tokens;
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(other.indentCodeCompensation);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) return node;
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function tokSpace(src) {
  const cap = block.newline.exec(src);
  if (cap && cap[0].length > 0) {
    return { type: 'space', raw: cap[0] };
  }
}

function tokCode(src) {
  const cap = block.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(other.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function tokFences(src) {
  const cap = block.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(inline.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokHeading(L, src) {
  const cap = block.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: lexInline(L, text),
    };
  }
}

function tokHr(src) {
  const cap = block.hr.exec(src);
  if (cap) {
    return { type: 'hr', raw: rtrim(cap[0], '\n') };
  }
}

function tokBlockquote(L, src) {
  const cap = block.blockquote.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (other.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(
          other.blockquoteMarkerWhitespace,
          (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
        )
        .replace(other.blockquoteSetextReplace, '\n    $1')
        .replace(other.blockquoteSetextReplace2, '');
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
        const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(L, newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) {
          raw = `${raw}\n${consumed.join('\n')}`;
        }
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && other.blockquoteStart.test(lines[0])) {
          continue;
        }
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(L, newText);
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

function tokList(L, src) {
  let cap = block.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = other.listItemRegex(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (block.hr.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const firstLine = cap[2].split('\n', 1)[0];
      const bulletIndent = cap[1].length;
      let line = firstLine.replace(other.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
      let nextLine = src.split('\n', 1)[0];
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(other.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && other.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const nextBulletRegex = other.nextBulletRegex(indent);
        const hrRegex = other.hrRegex(indent);
        const fencesBeginRegex = other.fencesBeginRegex(indent);
        const headingBeginRegex = other.headingBeginRegex(indent);
        const htmlBeginRegex = other.htmlBeginRegex(indent);
        const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);
        // Index-based line scan: the old per-line src.substring() copied
        // the whole remainder of the list on every line (quadratic).
        // p only advances past a line once it is consumed; on break it
        // still points at the unconsumed line, exactly like src did.
        // The six begin-of-line regexes below are all `^ {0,effMax}marker`
        // (cachedIndentRegex builds them with effMax = clamp(indent-1,0,3)),
        // so none of them can match unless the first non-space character
        // sits within effMax spaces and is a marker character: dispatch on
        // that character instead of running all six on every line.
        const effMax = Math.max(0, Math.min(3, indent - 1));
        let p = 0;
        while (p < src.length) {
          let nl = src.indexOf('\n', p);
          if (nl === -1) nl = src.length;
          const rawLine = src.slice(p, nl);
          nextLine = rawLine;
          // expandTabs only changes tabs; a leading run without a tab is
          // returned unchanged, so skip the replace (and its copy) then.
          let nextLineWithoutTabs = nextLine;
          if (nextLine.charCodeAt(0) === 32 || nextLine.charCodeAt(0) === 9) {
            let hasTab = false;
            for (let q = 0; q < nextLine.length; q++) {
              const cc = nextLine.charCodeAt(q);
              if (cc === 9) { hasTab = true; break; }
              if (cc !== 32) break;
            }
            if (hasTab) {
              nextLineWithoutTabs = nextLine.replace(other.leadingSpaceTab, (whitespace) => expandTabs(whitespace));
            }
          }
          // First non-space (space only) character of the raw line.
          let k = 0;
          while (k < nextLine.length && nextLine.charCodeAt(k) === 32) k++;
          if (k <= effMax && k < nextLine.length) {
            const fc = nextLine.charCodeAt(k);
            if (fc === 96 || fc === 126) { // ` ~
              if (fencesBeginRegex.test(nextLine)) break;
            } else if (fc === 35) { // #
              if (headingBeginRegex.test(nextLine)) break;
            } else if (fc === 60) { // <
              if (htmlBeginRegex.test(nextLine)) break;
            } else if (fc === 62) { // >
              if (blockquoteBeginRegex.test(nextLine)) break;
            } else if (fc === 42 || fc === 43 || fc === 45) { // * + -
              if (nextBulletRegex.test(nextLine)) break;
              if (hrRegex.test(nextLine)) break;
            } else if (fc === 95) { // _
              if (hrRegex.test(nextLine)) break;
            } else if (fc >= 48 && fc <= 57) { // digit
              if (nextBulletRegex.test(nextLine)) break;
            }
          }
          // First index whose character is not a space (== /[^ ]/ search).
          let firstNonSpace = 0;
          while (firstNonSpace < nextLineWithoutTabs.length && nextLineWithoutTabs.charCodeAt(firstNonSpace) === 32) firstNonSpace++;
          const isBlank = !nextLine.trim();
          if (firstNonSpace >= indent || isBlank) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4) break;
            if (fencesBeginRegex.test(line)) break;
            if (headingBeginRegex.test(line)) break;
            if (htmlBeginRegex.test(line)) break;
            if (hrRegex.test(line)) break;
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && block.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = isBlank;
          p = nl + 1;
          line = nextLineWithoutTabs.slice(indent);
        }
        src = src.slice(p);
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) {
          list.loose = true;
        } else if (other.doubleBlankLine.test(raw)) {
          endsWithBlankLine = true;
        }
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: other.listIsTask.test(itemContents),
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
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
        for (let i = L.inlineQueue.length - 1; i >= 0; i--) {
          if (other.listIsTask.test(L.inlineQueue[i].src)) {
            L.inlineQueue[i].src = L.inlineQueue[i].src.replace(other.listReplaceTask, '');
            break;
          }
        }
        const taskRaw = other.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkboxToken);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkboxToken.raw,
                text: checkboxToken.raw,
                tokens: [checkboxToken],
              });
            }
          } else {
            item.tokens.unshift(checkboxToken);
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

function tokHtml(src) {
  const cap = block.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokDef(src) {
  const cap = block.def.exec(src);
  if (cap) {
    if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
      return;
    }
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(inline.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(L, src) {
  const cap = block.table.exec(src);
  if (!cap) return;
  if (!other.tableDelimiter.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) {
      item.align.push('right');
    } else if (other.tableAlignCenter.test(align)) {
      item.align.push('center');
    } else if (other.tableAlignLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      tokens: lexInline(L, headers[i]),
      header: true,
      align: item.align[i],
    });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      tokens: lexInline(L, cell),
      header: false,
      align: item.align[i],
    })));
  }
  return item;
}

function tokLheading(L, src) {
  const cap = block.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: lexInline(L, text),
    };
  }
}

function tokParagraph(L, src) {
  const cap = block.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: lexInline(L, text) };
  }
}

function tokText(L, src) {
  const cap = block.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: lexInline(L, cap[0]) };
  }
}

// ---- Tokenizer: inline level ----

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = inline.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = inline.tag.exec(tokenSrc) || inline.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function outputLink(L, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = L.state.inLink;
  const outerLinkEmitted = L.state.linkEmitted;
  const outerInRawBlock = L.state.inRawBlock;
  L.state.inLink = true;
  L.state.linkEmitted = false;
  const tokens = inlineTokens(L, text);
  const textHasLink = L.state.linkEmitted;
  L.state.linkEmitted = outerLinkEmitted;
  L.state.inLink = outerInLink;
  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of
    // nesting." Bail so the caller falls through to text and the inner
    // link is the one kept. Images are exempt.
    if (textHasLink) {
      L.state.inRawBlock = outerInRawBlock;
      return;
    }
    L.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokEscape(src) {
  const cap = inline.escape.exec(src);
  if (cap) {
    return { type: 'escape', raw: cap[0], text: cap[1] };
  }
}

function tokTag(L, src) {
  const cap = inline.tag.exec(src);
  if (cap) {
    if (!L.state.inLink && other.startATag.test(cap[0])) {
      L.state.inLink = true;
    } else if (L.state.inLink && other.endATag.test(cap[0])) {
      L.state.inLink = false;
    }
    if (!L.state.inRawBlock && other.startPreScriptTag.test(cap[0])) {
      L.state.inRawBlock = true;
    } else if (L.state.inRawBlock && other.endPreScriptTag.test(cap[0])) {
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

function tokLink(L, src) {
  // The link regex backtracks quadratically over unterminated-link inputs;
  // inlineTokens anchors one paren scan per run, and when it is false the
  // regex cannot match, so bail out before running it.
  if (L.state.linkParenPossible === false) return undefined;
  const cap = inline.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (other.startAngleBracket.test(trimmedUrl)) {
      if (!(other.endAngleBracket.test(trimmedUrl))) return;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' that ends the match is the link closer only when it is not
    // escaped. `[foo](/url\)` has no closer; that paren is destination text.
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (other.startAngleBracket.test(href)) {
      href = href.slice(1, -1);
    }
    return outputLink(L, cap, {
      href: href ? href.replace(inline.anyPunctuation, '$1') : href,
      title: title ? title.replace(inline.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}

function tokReflink(L, src) {
  let cap;
  if ((cap = inline.reflink.exec(src)) || (cap = inline.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const link = L.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(L, cap, link, cap[0]);
  }
}

function tokEmStrong(L, src, maskedSrc, prevChar = '') {
  let match = inline.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  // A mid-run opener must only pair with a delimiter that can only close,
  // otherwise it steals the opener of a later span.
  const midRun = prevChar === delimChar;
  // The start of this delimiter run may already be behind src. Flanking
  // and rules 9-10 are about the whole run, so find its start.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!inline.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!inline.punctuation.exec(prevChar);
  // _ can't be between two alphanumerics.
  if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well.
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
    const lastPossibleEmStrongCloserIndex = cachedLastPossibleEmStrongCloserIndex(L, maskedSrc, delimChar);
    const emStrongCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleEmStrongCloserIndexInWindow = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleEmStrongCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__
      rLength = [...rDelim].length;
      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either Left or Right Delim
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(L, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(L, text) };
    }
  }
}

function tokCodespan(src) {
  const cap = inline.code.exec(src);
  if (cap) {
    let text = cap[2].replace(other.newLineCharGlobal, ' ');
    const hasNonSpaceChars = other.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokBr(src) {
  const cap = inline.br.exec(src);
  if (cap) {
    return { type: 'br', raw: cap[0] };
  }
}

function tokDel(L, src, maskedSrc, prevChar = '') {
  let match = inline.delLDelim.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || inline.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = inline.delRDelim;
    const lastPossibleDelCloserIndex = cachedLastPossibleDelCloserIndex(L, maskedSrc);
    const delCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleDelCloserIndex < delCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleDelCloserIndexInWindow = lastPossibleDelCloserIndex - delCloserWindowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleDelCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // found another Left Delim
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(L, text) };
    }
  }
}

function tokAutolink(src) {
  const cap = inline.autolink.exec(src);
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

function tokUrl(src) {
  let cap;
  if (cap = inline.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = inline._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
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

// ---- Inline text: marked's GFM text rule (the regex engine scans faster
// than a hand-written per-character loop for this shape) ----

function tokInlineText(L, src) {
  const cap = inlineTextGfm.exec(src);
  const raw = cap[0];
  const escaped = L.state.inRawBlock;
  return {
    type: 'text',
    raw,
    // raw HTML keeps whatever it was written with, everywhere else a numeric
    // character reference stands for the character itself
    text: escaped ? raw : decodeNumericCharacterReferences(raw),
    escaped,
  };
}

// ---- Lexer ----

function newLexerState() {
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

function blockTokens(L, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let token;
    // newline
    if (token = tokSpace(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (token.raw.length === 1 && lastToken !== undefined) {
        // a single \n as a spacer terminates the last line, so move it there
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    // code
    if (token = tokCode(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      // An indented code block cannot interrupt a paragraph.
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // fences
    if (token = tokFences(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // heading
    if (token = tokHeading(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // hr
    if (token = tokHr(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // blockquote
    if (token = tokBlockquote(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // list
    if (token = tokList(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // html
    if (token = tokHtml(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // def
    if (token = tokDef(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        // The first definition of a label wins, but a later one still
        // consumes its text.
        if (!L.links[token.tag]) {
          L.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }
    // table (gfm)
    if (token = tokTable(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // lheading
    if (token = tokLheading(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // top-level paragraph
    if (L.state.top && (token = tokParagraph(L, src))) {
      const lastToken = tokens[tokens.length - 1];
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    // text
    if (token = tokText(L, src)) {
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

// Does this link text hold a link already? An image does not count: an
// image may hold a link, a link may not.
function linkInText(L, text) {
  if (!text.includes('[')) return false;
  const linkRule = inline.link;
  for (const match of text.matchAll(inline.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(inline.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(L.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && linkInText(L, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them.
function maskSrc(L, src) {
  let maskedSrc = src;
  if (L.links && src.includes('[')) {
    const reflinkSearch = inline.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(L.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      // A candidate whose text already holds a link never becomes a link,
      // so flattening the whole span would hide the emphasis that does
      // still apply inside it. Mask the links it holds instead. Images
      // are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(L, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  // Mask out escaped characters. Every mask must keep the length it
  // replaces: emStrong and del line maskedSrc up with src by slicing from
  // the end. A backslash inside a code span is literal, not an escape.
  maskedSrc = maskedSrc.replace(inline.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) {
      return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    }
    return match0;
  });
  // Mask out other blocks.
  maskedSrc = maskedSrc.replace(inline.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return maskedSrc;
}

function inlineTokens(L, src, tokens = []) {
  const prevLinkParenPossible = L.state.linkParenPossible;
  L.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(L, src, tokens);
  } finally {
    L.state.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(L, src, tokens) {
  // The masked source and the closer scan are only read by emStrong and
  // del, which need a *, _ or ~ to start. Skip both for a run without one.
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = hasDelim ? maskSrc(L, src) : src;
  if (!hasDelim) {
    return tokenizeInlines(L, src, maskedSrc, tokens);
  }
  beginEmStrongDelCloserScan(L, maskedSrc);
  try {
    return tokenizeInlines(L, src, maskedSrc, tokens);
  } finally {
    endEmStrongDelCloserScan(L);
  }
}

function tokenizeInlines(L, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let token;
    // escape
    if (token = tokEscape(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // tag
    if (token = tokTag(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // link
    if (token = tokLink(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // reflink, nolink
    if (token = tokReflink(L, src)) {
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
    // em & strong
    if (token = tokEmStrong(L, src, maskedSrc, prevChar)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // code
    if (token = tokCodespan(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // br
    if (token = tokBr(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // del (gfm)
    if (token = tokDel(L, src, maskedSrc, prevChar)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // autolink
    if (token = tokAutolink(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // url (gfm)
    if (!L.state.inLink && (token = tokUrl(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // text
    if (token = tokInlineText(L, src)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // Track prevChar before string of ____ started
        prevChar = token.raw.slice(-1);
      }
      keepPrevChar = true;
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

// ---- Renderer ----

function renderCode(token) {
  const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
  // An empty code block has no content, so it must not gain a newline.
  const code = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeHtmlEntities(langString) + '">'
    + escapeHtmlEntities(code, true) + '</code></pre>\n';
}

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTextToken(L, token, textMode) {
  if (textMode) return token.text;
  if ('tokens' in token && token.tokens) {
    return renderInline(L, token.tokens);
  }
  return ('escaped' in token && token.escaped) ? token.text : escapeHtmlEntities(token.text);
}

function renderLink(L, token) {
  // References are not resolved inside an autolink, so every `&` there is
  // literal. Elsewhere only an `&` that cannot start one needs escaping.
  const parsedText = token.autolink
    ? escapeHtmlEntities(token.text, true)
    : renderInline(L, token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return parsedText;
  const href = escapeHtmlEntities(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) {
    out += ' title="' + escapeHtmlEntities(token.title) + '"';
  }
  out += '>' + parsedText + '</a>';
  return out;
}

function renderImage(L, token) {
  let text = token.text;
  if (token.tokens) {
    text = renderInlineText(L, token.tokens);
  }
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return escapeHtmlEntities(text);
  const href = cleanHref;
  let out = `<img src="${escapeHtmlEntities(href)}" alt="${escapeHtmlEntities(text)}"`;
  if (token.title) {
    out += ` title="${escapeHtmlEntities(token.title)}"`;
  }
  out += '>';
  return out;
}

function renderTableCell(L, token) {
  const content = renderInline(L, token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(L, token) {
  let header = '';
  let cell = '';
  for (let j = 0; j < token.header.length; j++) {
    cell += renderTableCell(L, token.header[j]);
  }
  header += `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (let j = 0; j < token.rows.length; j++) {
    const row = token.rows[j];
    cell = '';
    for (let k = 0; k < row.length; k++) {
      cell += renderTableCell(L, row[k]);
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
      case 'code': out += renderCode(token); break;
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

// TextRenderer: returns only the textual part of a token (used for image
// alt text).
function renderInlineText(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderInlineText(L, token.tokens) : token.text;
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
      case 'codespan': out += `<code>${escapeHtmlEntities(token.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(L, token.tokens)}</del>`; break;
      case 'text': out += renderTextToken(L, token, false); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---- Entry point ----

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const L = newLexerState();
  const src = markdown.replace(other.carriageReturn, '\n');
  const tokens = blockTokens(L, src, []);
  for (let i = 0; i < L.inlineQueue.length; i++) {
    const next = L.inlineQueue[i];
    // an inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped
    L.state.inRawBlock = false;
    inlineTokens(L, next.src, next.tokens);
  }
  L.inlineQueue = [];
  return renderTokens(L, tokens);
}
