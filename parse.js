// parse.js — a fast Markdown renderer: CommonMark 0.31.2 plus GFM.
//
// Behaviour target: marked 18.1.3 with its default options (GFM on, breaks
// off, pedantic off). For every input string, parse(markdown) returns HTML
// exactly equal to marked.parse(markdown). Wherever marked drifts from the
// spec, marked's output wins.
//
// How it works: a block scanner followed by an inline scanner, both shaped
// by the same grammar marked uses (that shape is what encodes the exact
// behaviour), while the hot paths — inline text scanning, HTML escaping and
// numeric reference decoding — are hand-written character loops instead of
// regular expressions. Rendering works straight from tokens, with no
// needless copies of the source. No outside dependencies.

// Build a RegExp out of named fragments, the way marked assembles its
// grammar. A leading `^` inside a fragment being spliced in is dropped so
// the fragment can sit in the middle of a bigger pattern.
function assemblePattern(source, flags = '') {
  let text = typeof source === 'string' ? source : source.source;
  const builder = {
    swap(name, value) {
      let piece = typeof value === 'string' ? value : value.source;
      piece = piece.replace(/(^|[^\[])\^/g, '$1');
      text = text.replace(name, piece);
      return builder;
    },
    compile() {
      return new RegExp(text, flags);
    },
  };
  return builder;
}

// Small memo for regexes that depend on an indent level (0..3 spaces).
function memoizeByIndent(make) {
  const slots = [];
  return (level) => {
    const slot = Math.max(0, Math.min(3, level - 1));
    let made = slots[slot];
    if (!made) {
      made = make(slot);
      slots[slot] = made;
    }
    return made;
  };
}

// Block-level HTML tag names, as used by the CommonMark HTML-block rules.
const HTML_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

// Shared small patterns, grouped by what they are used for.
const P = {
  stripIndentedCode: /^(?: {0,3}\t| {1,4})/gm,
  unescapeBrackets: /\\([\[\]])/g,
  fenceLeadingIndent: /^(\s+)(?:```)/,
  leadingWhitespace: /^\s+/,
  hashAtEnd: /#$/,
  spaceAtStart: /^ /,
  spaceAtEnd: / $/,
  spaceOrTabAtEnd: /[ \t]$/,
  firstNonSpace: /[^ ]/,
  newlineAll: /\n/g,
  tabAll: /\t/g,
  leadingSpaceOrTab: /^[ \t]+/,
  whitespaceRun: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankEnd: /\n[ \t]*\n[ \t]*$/,
  quoteMarker: /^ {0,3}>/,
  quoteSetextLine: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  quoteMarkerStrip: /^ {0,3}>[ \t]?/gm,
  quoteMarkerSpace: /^( {0,3}>)([ \t]+)/gm,
  nestedListIndent: /^ {1,4}(?=( {4})*[^ ])/g,
  taskItemStart: /^\[[ xX]\][ \t]+\S/,
  taskItemStrip: /^\[[ xX]\][ \t]+/,
  taskCheckbox: /\[[ xX]\]/,
  anyNewlineLine: /\n.*\n/,
  angleWrappedHref: /^<(.*)>$/,
  tablePipeOrColon: /[:|]/,
  tableEdgePipes: /^\||\| *$/g,
  tableTrailingBlank: /\n[ \t]*$/,
  alignToRight: /^ *-+: *$/,
  alignToCenter: /^ *:-+: *$/,
  alignToLeft: /^ *:-+ *$/,
  anchorOpen: /^<a /i,
  anchorClose: /^<\/a>/i,
  rawTagOpen: /^<(pre|code|kbd|script)(\s|>)/i,
  rawTagClose: /^<\/(pre|code|kbd|script)(\s|>)/i,
  angleBracketOpen: /^</,
  angleBracketClose: />$/,
  unicodeAlnum: /[\p{L}\p{N}]/u,
  numericEntity: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericEntityOrBareAmp: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  needsEscape: /[&<>"']/,
  escapeAll: /[&<>"']/g,
  needsLooseEscape: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeLooseAll: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caretStrip: /(^|[^\[])\^/g,
  encodedPercent: /%25/g,
  pipeChar: /\|/g,
  pipeSeparator: / \|/,
  escapedPipe: /\\\|/g,
  crlfPair: /\r\n|\r/g,
  leadingWord: /^\S*/,
  newlineAtEnd: /\n$/,
  itemPatternFor: (() => {
    const seen = new Map();
    return (bullet) => {
      let made = seen.get(bullet);
      if (!made) {
        made = new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
        seen.set(bullet, made);
      }
      return made;
    };
  })(),
  nextBulletPattern: memoizeByIndent((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`)),
  rulePattern: memoizeByIndent((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencePattern: memoizeByIndent((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headingPattern: memoizeByIndent((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlPattern: memoizeByIndent((i) => new RegExp(`^ {0,${i}}(?:</?(?:${HTML_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  quotePattern: memoizeByIndent((i) => new RegExp(`^ {0,${i}}>`)),
};

// ---------- Block grammar (GFM) ----------

const blankRun = /^(?:[ \t]*(?:\n|$))+/;
const indentedCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencedCode = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const ruleLine = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const atxHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletMarker = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const setextCore = /^(?!bull |indCode|fence|quote|atx|html|table)((?:.|\n(?!\s*?\n|bull |fence|quote|atx|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const setextHeading = assemblePattern(setextCore)
  .swap(/bull/g, bulletMarker)
  .swap(/indCode/g, /(?: {4}| {0,3}\t)/)
  .swap(/fence/g, / {0,3}(?:`{3,}|~{3,})/)
  .swap(/quote/g, / {0,3}>/)
  .swap(/atx/g, / {0,3}#{1,6}(?:\s|$)/)
  .swap(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .swap(/html/g, / {0,3}<[^\n>]+>\n/)
  .swap(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .compile();

const paragraphCore = /^([^\n]+(?:\n(?!hr|atx|lhead|quote|fence|list|html|table|[ \t]+\n)[^\n]+)*)/;
const plainBlockText = /^[^\n]+/;
const blockLabelText = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const linkDef = assemblePattern(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .swap('label', blockLabelText)
  .swap('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .compile();

const listStart = assemblePattern(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .swap(/bull/g, bulletMarker)
  .compile();

const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const htmlBlock = assemblePattern(
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
  .swap('comment', htmlComment)
  .swap('tag', HTML_TAGS)
  .swap('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .compile();

const quoteParagraph = assemblePattern(paragraphCore)
  .swap('hr', ruleLine)
  .swap('atx', ' {0,3}#{1,6}(?:\\s|$)')
  .swap('|lhead', '')
  .swap('|table', '')
  .swap('quote', ' {0,3}>')
  .swap('fence', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .swap('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .swap('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .swap('tag', HTML_TAGS)
  .compile();

const blockquotePattern = assemblePattern(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(para)|[^\n]*)(?:\n|$))+/ )
  .swap('para', quoteParagraph)
  .compile();

const tablePattern = assemblePattern(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|atx|quote|code|fence|list|html).*(?:\\n|$))*)\\n*|$)')
  .swap('hr', ruleLine)
  .swap('atx', ' {0,3}#{1,6}(?:\\s|$)')
  .swap('quote', ' {0,3}>')
  .swap('code', '(?: {4}| {0,3}\t)[^\\n]')
  .swap('fence', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .swap('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .swap('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .swap('tag', HTML_TAGS)
  .compile();

// A GFM paragraph also ends at a table.
const gfmParagraph = assemblePattern(paragraphCore)
  .swap('hr', ruleLine)
  .swap('atx', ' {0,3}#{1,6}(?:\\s|$)')
  .swap('|lhead', '')
  .swap('table', tablePattern)
  .swap('quote', ' {0,3}>')
  .swap('fence', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .swap('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .swap('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .swap('tag', HTML_TAGS)
  .compile();

const BLOCK_GRAMMAR = {
  quote: blockquotePattern,
  code: indentedCode,
  def: linkDef,
  fences: fencedCode,
  heading: atxHeading,
  hr: ruleLine,
  html: htmlBlock,
  lheading: setextHeading,
  list: listStart,
  newline: blankRun,
  paragraph: gfmParagraph,
  table: tablePattern,
  text: plainBlockText,
};

// ---------- Inline grammar (GFM) ----------

const backslashEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const codeSpan = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const hardBreak = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const punctChar = /[\p{P}\p{S}]/u;
const punctOrSpace = /[\s\p{P}\p{S}]/u;
const notPunctOrSpace = /[^\s\p{P}\p{S}]/u;
const punctAtStart = assemblePattern(/^((?![*_])punctSpace)/, 'u')
  .swap(/punctSpace/g, punctOrSpace).compile();
const punctNoTilde = /(?!~)[\p{P}\p{S}]/u;
const punctSpaceNoTilde = /(?!~)[\s\p{P}\p{S}]/u;
const notPunctSpaceOrTilde = /(?:[^\s\p{P}\p{S}]|~)/u;

const linkCodeHtmlSkip = assemblePattern(/link|precode-code|html/, 'g')
  .swap('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .swap('precode-', '(?<!`)()')
  .swap('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .swap('html', /<(?! )[^<>]*?>/)
  .compile();

const emOpen = assemblePattern(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .swap(/punct/g, punctNoTilde)
  .compile();

const emCloseAstSrc =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';
const emCloseAst = assemblePattern(emCloseAstSrc, 'gu')
  .swap(/notPunctSpace/g, notPunctSpaceOrTilde)
  .swap(/punctSpace/g, punctSpaceNoTilde)
  .swap(/punct/g, punctNoTilde)
  .compile();

const emCloseUnd = assemblePattern(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .swap(/notPunctSpace/g, notPunctOrSpace)
  .swap(/punctSpace/g, punctOrSpace)
  .swap(/punct/g, punctChar)
  .compile();

const delOpen = assemblePattern(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .swap(/punct/g, punctChar)
  .compile();

const delCloseSrc =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';
const delClose = assemblePattern(delCloseSrc, 'gu')
  .swap(/notPunctSpace/g, notPunctOrSpace)
  .swap(/punctSpace/g, punctOrSpace)
  .swap(/punct/g, punctChar)
  .compile();

const anyPunct = assemblePattern(/\\(punct)/, 'gu')
  .swap(/punct/g, punctChar)
  .compile();
const anyPunctOutsideCode = assemblePattern(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .swap(/punct/g, punctChar)
  .compile();

const autolinkPattern = assemblePattern(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .swap('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .swap('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .compile();

const inlineComment = assemblePattern(htmlComment).swap('(?:-->|$)', '-->').compile();
const tagPattern = assemblePattern(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .swap('comment', inlineComment)
  .swap('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .compile();

const inlineBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const inlineLabel = assemblePattern(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .swap('brackets', inlineBrackets)
  .compile();

const linkPattern = assemblePattern(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .swap('label', inlineLabel)
  .swap('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .swap('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .compile();

const refLinkPattern = assemblePattern(/^!?\[(label)\]\[(ref)\]/)
  .swap('label', inlineLabel)
  .swap('ref', blockLabelText)
  .compile();

const noLinkPattern = assemblePattern(/^!?\[(ref)\](?:\[\])?/)
  .swap('ref', blockLabelText)
  .compile();

const boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const boundedInlineLabel = assemblePattern(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .swap('brackets', inlineBrackets)
  .compile();

const refLinkSearch = assemblePattern('reflink|nolink(?!\\()', 'g')
  .swap('reflink', assemblePattern(/^!?\[(label)\]\[(ref)\]/)
    .swap('label', boundedInlineLabel)
    .swap('ref', boundedBlockLabel)
    .compile())
  .swap('nolink', assemblePattern(/^!?\[(ref)\](?:\[\])?/)
    .swap('ref', boundedBlockLabel)
    .compile())
  .compile();

const protoPattern = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const extEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const extEmailProto = assemblePattern(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .swap(/email/g, extEmail)
  .compile();

const gfmUrl = assemblePattern(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .swap('emailProtocol', extEmailProto)
  .swap('protocol', protoPattern)
  .swap('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .compile();

const backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const deletePattern = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const INLINE_GRAMMAR = {
  backpedal,
  anyPunctuation: anyPunct,
  anyPunctuationOutsideCode: anyPunctOutsideCode,
  autolink: autolinkPattern,
  blockSkip: linkCodeHtmlSkip,
  br: hardBreak,
  code: codeSpan,
  del: deletePattern,
  delLDelim: delOpen,
  delRDelim: delClose,
  emStrongLDelim: emOpen,
  emStrongRDelimAst: emCloseAst,
  emStrongRDelimUnd: emCloseUnd,
  escape: backslashEscape,
  link: linkPattern,
  nolink: noLinkPattern,
  punctuation: punctAtStart,
  reflink: refLinkPattern,
  reflinkSearch: refLinkSearch,
  tag: tagPattern,
  url: gfmUrl,
};

// ---------- Inline text scanning (character loops, not regex) ----------
// This mirrors the GFM text rules marked applies, but steps through the
// string by character code. The old regex form re-checked the email
// lookahead at every position; this scan only looks at email candidates on
// word boundaries, and at protocol / www / hard-break candidates on their
// first letter.

// Characters that end a text run wherever they show up.
const TEXT_ENDERS = new Uint8Array(128);
for (const ch of [92, 60, 33, 91, 96, 42, 126, 95]) TEXT_ENDERS[ch] = 1; // \ < ! [ ` * ~ _
// Characters allowed inside an email address.
const EMAIL_CHARS = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") {
  EMAIL_CHARS[ch.charCodeAt(0)] = 1;
}

function asciiAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function hasMailtoAt(src, i) {
  return src.startsWith('mailto:', i) || src.startsWith('xmpp:', i);
}
// Does an email pattern [email-chars]+@ start at position i?
function hasEmailAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc >= 128 || !EMAIL_CHARS[cc]) break;
    j++;
  }
  return j > i && j < n && src.charCodeAt(j) === 64;
}
// Does ` {2,}\n` (two or more spaces, then a newline) start at i?
function hasHardBreakAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 32) j++;
  return j >= i + 2 && j < n && src.charCodeAt(j) === 10;
}
// Does an autolink protocol (http://, https://, ftp://, any casing) start at i?
function hasProtocolAt(src, i) {
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
// Does `www.` start at i, in a spot GFM allows (start of the run, or after
// a space, *, _, ~, or an opening paren)?
function hasWwwAt(src, i) {
  if (src.charCodeAt(i + 1) !== 119 || src.charCodeAt(i + 2) !== 119 || src.charCodeAt(i + 3) !== 46) return false;
  if (i === 0) return true;
  const p = src.charCodeAt(i - 1);
  return p === 32 || p === 9 || p === 10 || p === 13 || p === 11 || p === 12 || p === 42 || p === 95 || p === 126 || p === 40;
}

// Exclusive end index of the inline text run starting at the start of src.
// fl is a bitmask of what this run may contain, computed once per run by
// tokenizeInline from native includes() scans (a superset test: a set bit
// only causes extra checks, never a missed stop):
// 1 '@', 2 'mailto:'/'xmpp:', 4 '://', 8 'www.', 16 '  \n'.
function inlineTextEnd(src, fl) {
  const n = src.length;
  // A single non-alphanumeric character before mailto:/xmpp: is its own run.
  if (n > 1 && (fl & 2) && !asciiAlnum(src.charCodeAt(0)) && hasMailtoAt(src, 1)) return 1;
  let i = 0;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) {
    while (i < n && src.charCodeAt(i) === 96) i++;
  } else if (c0 === 126) {
    while (i < n && src.charCodeAt(i) === 126) i++;
  } else {
    i = 1;
  }
  // Stop right after the first character or group.
  if (i < n) {
    const ci = src.charCodeAt(i);
    if (ci === 96 || ci === 126) return i;
    if ((fl & 16) && hasHardBreakAt(src, i)) return i;
    if ((fl & 1) && hasEmailAt(src, i)) return i;
  }
  for (let j = i; j < n; j++) {
    const cc = src.charCodeAt(j);
    if (cc < 128 && TEXT_ENDERS[cc]) return j;
    if (cc === 104 || cc === 72 || cc === 102 || cc === 70) { // h H f F
      if ((fl & 4) && hasProtocolAt(src, j)) return j;
    } else if (cc === 119) { // w
      if ((fl & 8) && hasWwwAt(src, j)) return j;
    } else if (cc === 32) { // space: does a hard break (` {2,}\n`) start here?
      if ((fl & 16) && hasHardBreakAt(src, j)) return j;
    }
    // Stop with a one-character lookahead: a non-alphanumeric character
    // before mailto:/xmpp:, or a non-email character before an email
    // pattern, ends the run just after that character.
    if (j + 1 < n) {
      const nc = src.charCodeAt(j + 1);
      if ((fl & 2) && !asciiAlnum(cc) && (nc === 109 || nc === 120)) { // m x
        if (hasMailtoAt(src, j + 1)) return j + 1;
      }
      if ((fl & 1) && (cc >= 128 || !EMAIL_CHARS[cc]) && nc < 128 && EMAIL_CHARS[nc] && hasEmailAt(src, j + 1)) return j + 1;
    }
  }
  return n;
}

// ---------- Helpers ----------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function isWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_';
}
function isHexChar(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

// Does the text at `i` (just after `&`) form a valid character reference,
// that is `(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);`?
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

// The same as marked's escape function, as a single character scan: when
// encoding, every & < > " ' is escaped; otherwise < > " ' are escaped and
// & only when it cannot start a character reference. One pass: when
// nothing needs escaping, the original string comes back untouched.
function htmlEscape(str, encode) {
  const n = str.length;
  let out = '';
  let start = 0;
  for (let i = 0; i < n; i++) {
    const code = str.charCodeAt(i);
    let rep;
    if (code === 38) { // &
      if (!encode && isValidCharRef(str, i + 1)) continue;
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

// The same as marked's numeric-reference decoding, as a character scan.
// A decoded character must not join its neighbours into a new reference,
// so a bare & that is not a reference gets escaped here.
function decodeNumericEntities(text) {
  if (!text.includes('&')) return text;
  if (!P.numericEntity.test(text)) return text;
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

function sanitizeUrl(href) {
  try {
    href = encodeURI(href).replace(P.encodedPercent, '%');
  } catch {
    return null;
  }
  return href;
}

function splitRowCells(rowText, count) {
  const row = rowText.replace(P.pipeChar, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(P.pipeSeparator);
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
    cells[i] = cells[i].trim().replace(P.escapedPipe, '|');
  }
  return cells;
}

// Drop trailing `c` characters. Equivalent to str.replace(/c*$/, '').
function trimTrailingChar(str, c, invert) {
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

function trimTrailingBlanks(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && P.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeRefLabel(label) {
  return label.trim().replace(P.whitespaceRun, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findMatchingClose(str, b) {
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

function expandTabStops(line, indent = 0) {
  // An index loop over charCodeAt, not for...of: a code-point iterator
  // allocates per line, while here only tabs are special (tabs and spaces
  // are all BMP, so UTF-16 indexes match character iteration on this path).
  let col = indent;
  let expanded = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
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

// Closing hints for one inline pass: a single scan of the already-masked
// source for the last `*` / `_` run that could close emphasis or strong,
// and the last `~` run that could close strikethrough. A run can only close
// when it is not preceded by ASCII space or the start of the string.
function scanForClosers(src) {
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

function pushCloserFrame(L, maskedSrc) {
  L.closerHints.push(scanForClosers(maskedSrc));
}
function popCloserFrame(L) {
  L.closerHints.pop();
}
function lastEmCloser(L, maskedSrc, delim) {
  const frame = L.closerHints[L.closerHints.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastEm[delim];
  return scanForClosers(maskedSrc).lastEm[delim];
}
function lastDelCloser(L, maskedSrc) {
  const frame = L.closerHints[L.closerHints.length - 1];
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastDel;
  return scanForClosers(maskedSrc).lastDel;
}

// ---------- Block tokenizers ----------
// Each function takes the lexer state L and the remaining source, and
// returns a token or undefined. `deferInline` holds a string back for
// inline tokenizing after the whole block pass is done, exactly as marked
// does.

function deferInline(L, src, tokens = []) {
  L.pendingInline.push({ src, tokens });
  return tokens;
}

function fixFenceIndent(raw, text) {
  const m = raw.match(P.fenceLeadingIndent);
  if (m === null) return text;
  const indentToCode = m[1];
  return text
    .split('\n')
    .map((node) => {
      const indentMatch = node.match(P.leadingWhitespace);
      if (indentMatch === null) return node;
      const [indentInNode] = indentMatch;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function readSpace(src) {
  const cap = BLOCK_GRAMMAR.newline.exec(src);
  if (cap && cap[0].length > 0) {
    return { type: 'space', raw: cap[0] };
  }
}

function readIndentedCode(src) {
  const cap = BLOCK_GRAMMAR.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlanks(cap[0]);
    const text = raw.replace(P.stripIndentedCode, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function readFence(src) {
  const cap = BLOCK_GRAMMAR.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = fixFenceIndent(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(INLINE_GRAMMAR.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function readAtx(L, src) {
  const cap = BLOCK_GRAMMAR.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (P.hashAtEnd.test(text)) {
      const trimmed = trimTrailingChar(text, '#');
      if (!trimmed || P.spaceOrTabAtEnd.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    return {
      type: 'heading',
      raw: trimTrailingChar(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: deferInline(L, text),
    };
  }
}

function readRule(src) {
  const cap = BLOCK_GRAMMAR.hr.exec(src);
  if (cap) {
    return { type: 'hr', raw: trimTrailingChar(cap[0], '\n') };
  }
}

function readQuote(L, src) {
  const cap = BLOCK_GRAMMAR.quote.exec(src);
  if (cap) {
    let lines = trimTrailingChar(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inQuote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (P.quoteMarker.test(lines[i])) {
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
          P.quoteMarkerSpace,
          (_, marker, whitespace) => marker + expandTabStops(whitespace, marker.length),
        )
        .replace(P.quoteSetextLine, '\n    $1')
        .replace(P.quoteMarkerStrip, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;
      const top = L.state.atTop;
      L.state.atTop = true;
      tokenizeBlocks(L, currentText, tokens, true);
      L.state.atTop = top;
      if (lines.length === 0) break;
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        break;
      } else if (lastToken?.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(P.quoteMarkerStrip, '');
        const newToken = readQuote(L, newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) {
          raw = `${raw}\n${consumed.join('\n')}`;
        }
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && P.quoteMarker.test(lines[0])) {
          continue;
        }
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = readList(L, newText);
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

function readList(L, src) {
  let cap = BLOCK_GRAMMAR.list.exec(src);
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
    const itemPattern = P.itemPatternFor(bull);
    let endsWithBlank = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemPattern.exec(src))) break;
      if (BLOCK_GRAMMAR.hr.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const firstLine = cap[2].split('\n', 1)[0];
      const bulletIndent = cap[1].length;
      let line = firstLine.replace(P.leadingSpaceOrTab, (ws) => expandTabStops(ws, bulletIndent));
      let nextLine = src.split('\n', 1)[0];
      let blankLine = !line.trim();
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(P.firstNonSpace);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && P.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const nextBullPattern = P.nextBulletPattern(indent);
        const rulePattern2 = P.rulePattern(indent);
        const fencePattern2 = P.fencePattern(indent);
        const headPattern2 = P.headingPattern(indent);
        const htmlPattern2 = P.htmlPattern(indent);
        const quotePattern2 = P.quotePattern(indent);
        // Index-based line scan: slicing src per line used to copy the
        // whole remaining list on every line (quadratic). p only walks
        // past lines already consumed; on break, p still points at the
        // unconsumed line, exactly as src used to. All six line-start
        // regexes below are `^ {0,effMax}marker`, so none can match
        // unless the first non-space character sits within effMax spaces
        // and is a marker character: pick by that character instead of
        // running all six on every line.
        const effMax = Math.max(0, Math.min(3, indent - 1));
        let p = 0;
        while (p < src.length) {
          let nl = src.indexOf('\n', p);
          if (nl === -1) nl = src.length;
          const rawLine = src.slice(p, nl);
          nextLine = rawLine;
          // expandTabStops only changes tabs; a line with no leading tab
          // comes back unchanged, so skip the replace (and its copy).
          let lineNoTabs = nextLine;
          if (nextLine.charCodeAt(0) === 32 || nextLine.charCodeAt(0) === 9) {
            let hasTab = false;
            for (let q = 0; q < nextLine.length; q++) {
              const cc = nextLine.charCodeAt(q);
              if (cc === 9) { hasTab = true; break; }
              if (cc !== 32) break;
            }
            if (hasTab) {
              lineNoTabs = nextLine.replace(P.leadingSpaceOrTab, (ws) => expandTabStops(ws));
            }
          }
          // First non-space character (spaces only) on the raw line.
          let k = 0;
          while (k < nextLine.length && nextLine.charCodeAt(k) === 32) k++;
          if (k <= effMax && k < nextLine.length) {
            const fc = nextLine.charCodeAt(k);
            if (fc === 96 || fc === 126) { // ` ~
              if (fencePattern2.test(nextLine)) break;
            } else if (fc === 35) { // #
              if (headPattern2.test(nextLine)) break;
            } else if (fc === 60) { // <
              if (htmlPattern2.test(nextLine)) break;
            } else if (fc === 62) { // >
              if (quotePattern2.test(nextLine)) break;
            } else if (fc === 42 || fc === 43 || fc === 45) { // * + -
              if (nextBullPattern.test(nextLine)) break;
              if (rulePattern2.test(nextLine)) break;
            } else if (fc === 95) { // _
              if (rulePattern2.test(nextLine)) break;
            } else if (fc >= 48 && fc <= 57) { // digit
              if (nextBullPattern.test(nextLine)) break;
            }
          }
          // First index whose character is not a space (== searching /[^ ]/).
          let firstNonSpace = 0;
          while (firstNonSpace < lineNoTabs.length && lineNoTabs.charCodeAt(firstNonSpace) === 32) firstNonSpace++;
          const isBlank = !nextLine.trim();
          if (firstNonSpace >= indent || isBlank) {
            itemContents += '\n' + lineNoTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(P.tabAll, '    ').search(P.firstNonSpace) >= 4) break;
            if (fencePattern2.test(line)) break;
            if (headPattern2.test(line)) break;
            if (htmlPattern2.test(line)) break;
            if (rulePattern2.test(line)) break;
            const setextCont = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && BLOCK_GRAMMAR.lheading.test(`${line}\n${nextLine}`);
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
        } else if (P.doubleBlankEnd.test(raw)) {
          endsWithBlank = true;
        }
      }
      list.items.push({
        type: 'list_item',
        raw,
        task: P.taskItemStart.test(itemContents),
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
      L.state.atTop = false;
      item.tokens = tokenizeBlocks(L, item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultiBreak = spacers.length > 0 && spacers.some((t) => P.anyNewlineLine.test(t.raw));
        list.loose = hasMultiBreak;
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
        item.text = item.text.replace(P.taskItemStrip, '');
        firstTok.raw = firstTok.raw.replace(P.taskItemStrip, '');
        firstTok.text = firstTok.text.replace(P.taskItemStrip, '');
        for (let i = L.pendingInline.length - 1; i >= 0; i--) {
          if (P.taskItemStart.test(L.pendingInline[i].src)) {
            L.pendingInline[i].src = L.pendingInline[i].src.replace(P.taskItemStrip, '');
            break;
          }
        }
        const taskRaw = P.taskCheckbox.exec(item.raw);
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

function readHtmlBlock(src) {
  const cap = BLOCK_GRAMMAR.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlanks(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function readDef(src) {
  const cap = BLOCK_GRAMMAR.def.exec(src);
  if (cap) {
    if (!P.angleBracketOpen.test(cap[2]) && findMatchingClose(cap[2], '()') !== -1) {
      return;
    }
    const tag = normalizeRefLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(P.angleWrappedHref, '$1').replace(INLINE_GRAMMAR.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE_GRAMMAR.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: trimTrailingChar(cap[0], '\n'), href, title };
  }
}

function readTable(L, src) {
  const cap = BLOCK_GRAMMAR.table.exec(src);
  if (!cap) return;
  if (!P.tablePipeOrColon.test(cap[2])) return;
  const headers = splitRowCells(cap[1]);
  const aligns = cap[2].replace(P.tableEdgePipes, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(P.tableTrailingBlank, '').split('\n') : [];
  const item = { type: 'table', raw: trimTrailingChar(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (P.alignToRight.test(align)) {
      item.align.push('right');
    } else if (P.alignToCenter.test(align)) {
      item.align.push('center');
    } else if (P.alignToLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      tokens: deferInline(L, headers[i]),
      header: true,
      align: item.align[i],
    });
  }
  for (const row of rows) {
    item.rows.push(splitRowCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      tokens: deferInline(L, cell),
      header: false,
      align: item.align[i],
    })));
  }
  return item;
}

function readSetext(L, src) {
  const cap = BLOCK_GRAMMAR.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: trimTrailingChar(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: deferInline(L, text),
    };
  }
}

function readParagraph(L, src) {
  const cap = BLOCK_GRAMMAR.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: deferInline(L, text) };
  }
}

function readText(L, src) {
  const cap = BLOCK_GRAMMAR.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: deferInline(L, cap[0]) };
  }
}

// ---------- Inline tokenizers ----------

function labelClosesInTag(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE_GRAMMAR.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE_GRAMMAR.tag.exec(tokenSrc) || INLINE_GRAMMAR.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function makeLinkToken(L, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(P.unescapeBrackets, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = L.state.insideLink;
  const outerEmitted = L.state.linkSeen;
  const outerRaw = L.state.insideRaw;
  L.state.insideLink = true;
  L.state.linkSeen = false;
  const tokens = tokenizeInline(L, text);
  const textHasLink = L.state.linkSeen;
  L.state.linkSeen = outerEmitted;
  L.state.insideLink = outerInLink;
  if (!isImage) {
    // CommonMark: a link may not contain another link, at any depth.
    // Give up so the caller falls back to text and the inner link is the
    // one kept. Images are exempt.
    if (textHasLink) {
      L.state.insideRaw = outerRaw;
      return;
    }
    L.state.linkSeen = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function readEscape(src) {
  const cap = INLINE_GRAMMAR.escape.exec(src);
  if (cap) {
    return { type: 'escape', raw: cap[0], text: cap[1] };
  }
}

function readInlineTag(L, src) {
  const cap = INLINE_GRAMMAR.tag.exec(src);
  if (cap) {
    if (!L.state.insideLink && P.anchorOpen.test(cap[0])) {
      L.state.insideLink = true;
    } else if (L.state.insideLink && P.anchorClose.test(cap[0])) {
      L.state.insideLink = false;
    }
    if (!L.state.insideRaw && P.rawTagOpen.test(cap[0])) {
      L.state.insideRaw = true;
    } else if (L.state.insideRaw && P.rawTagClose.test(cap[0])) {
      L.state.insideRaw = false;
    }
    return {
      type: 'html',
      raw: cap[0],
      inLink: L.state.insideLink,
      inRawBlock: L.state.insideRaw,
      block: false,
      text: cap[0],
    };
  }
}

function readLink(L, src) {
  // The link regex can backtrack quadratically on unclosed link input;
  // tokenizeInline plants a single paren scan per run, and when that is
  // false the regex cannot match, so bail out before running it.
  if (L.state.mayHaveParen === false) return undefined;
  const cap = INLINE_GRAMMAR.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelClosesInTag(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (P.angleBracketOpen.test(trimmedUrl)) {
      if (!(P.angleBracketClose.test(trimmedUrl))) return;
      const rtrimSlash = trimTrailingChar(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParen = findMatchingClose(cap[2], '()');
      if (lastParen === -2) return;
      if (lastParen > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParen;
        cap[2] = cap[2].substring(0, lastParen);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' ending the match only closes the link when it is not
    // escaped. `[foo](/url\)` has no closing paren; that paren is
    // destination text.
    const unescaped = trimTrailingChar(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (P.angleBracketOpen.test(href)) {
      href = href.slice(1, -1);
    }
    return makeLinkToken(L, cap, {
      href: href ? href.replace(INLINE_GRAMMAR.anyPunctuation, '$1') : href,
      title: title ? title.replace(INLINE_GRAMMAR.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}

function readRefLink(L, src) {
  let cap;
  if ((cap = INLINE_GRAMMAR.reflink.exec(src)) || (cap = INLINE_GRAMMAR.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (labelClosesInTag(src, cap[1], labelStart)) return;
    const link = L.defs[normalizeRefLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return makeLinkToken(L, cap, link, cap[0]);
  }
}

function readEmphasis(L, src, maskedSrc, prevChar = '') {
  let match = INLINE_GRAMMAR.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delim = match[0][0];
  // An opener in the middle of a run may only pair with a delimiter that
  // can only close, or it would steal the next span's opener.
  const midRun = prevChar === delim;
  // The start of this delimiter run may already sit behind src. Flanking
  // and rules 9-10 concern the whole run, so find where it begins.
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delim) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE_GRAMMAR.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE_GRAMMAR.punctuation.exec(prevChar);
  // _ may not sit between two alphanumeric characters.
  if (match[4] && prevChar.match(P.unicodeAlnum)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLen = [...match[0]].length - 1;
    let rDelim, rLen, delimTotal = lLen, midTotal = 0;
    // Rules 9-10 count the whole run, and also apply when the opener can
    // close as well.
    const runLen = srcStart - runStart + lLen;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return;
    const endRe = delim === '*' ? INLINE_GRAMMAR.emStrongRDelimAst : INLINE_GRAMMAR.emStrongRDelimUnd;
    const lastCloser = lastEmCloser(L, maskedSrc, delim);
    const windowStart = maskedSrc.length - src.length + lLen;
    if (lastCloser < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLen);
    const lastCloserInWindow = lastCloser - windowStart;
    endRe.lastIndex = 0;
    while ((match = endRe.exec(maskedSrc)) !== null) {
      if (match.index > lastCloserInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip a lone * inside __abc*abc__
      rLen = [...rDelim].length;
      if (match[3] || match[4]) { // found another left delimiter
        delimTotal += rLen;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // left or right delimiter
        if (midRun && (match[5] || match[6])) break;
        if (runLen % 3 && !((runLen + rLen) % 3)) {
          midTotal += rLen;
          continue; // CommonMark emphasis rules 9-10
        }
      }
      delimTotal -= rLen;
      if (delimTotal > 0) continue; // not enough closing delimiters yet
      rLen = Math.min(rLen, rLen + delimTotal + midTotal);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + firstLen + rLen);
      if (Math.min(lLen, rLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: tokenizeInline(L, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: tokenizeInline(L, text) };
    }
  }
}

function readCodeSpan(src) {
  const cap = INLINE_GRAMMAR.code.exec(src);
  if (cap) {
    let text = cap[2].replace(P.newlineAll, ' ');
    const hasNonSpace = P.firstNonSpace.test(text);
    const spaceBothEnds = P.spaceAtStart.test(text) && P.spaceAtEnd.test(text);
    if (hasNonSpace && spaceBothEnds) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: cap[0], text };
  }
}

function readBreak(src) {
  const cap = INLINE_GRAMMAR.br.exec(src);
  if (cap) {
    return { type: 'br', raw: cap[0] };
  }
}

function readDelete(L, src, maskedSrc, prevChar = '') {
  let match = INLINE_GRAMMAR.delLDelim.exec(src);
  if (!match) return;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE_GRAMMAR.punctuation.exec(prevChar)) {
    const lLen = [...match[0]].length - 1;
    let rDelim, rLen, delimTotal = lLen;
    const endRe = INLINE_GRAMMAR.delRDelim;
    const lastCloser = lastDelCloser(L, maskedSrc);
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
      if (match[3] || match[4]) { // found another left delimiter
        delimTotal += rLen;
        continue;
      }
      delimTotal -= rLen;
      if (delimTotal > 0) continue; // not enough closing delimiters yet
      rLen = Math.min(rLen, rLen + delimTotal);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, lLen + match.index + firstLen + rLen);
      const text = raw.slice(lLen, -lLen);
      return { type: 'del', raw, text, tokens: tokenizeInline(L, text) };
    }
  }
}

function readAutolink(src) {
  const cap = INLINE_GRAMMAR.autolink.exec(src);
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

function readGfmUrl(src) {
  let cap;
  if (cap = INLINE_GRAMMAR.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevZero;
      do {
        prevZero = cap[0];
        cap[0] = INLINE_GRAMMAR.backpedal.exec(cap[0])?.[0] ?? '';
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

function readInlineText(L, src, fl) {
  const end = inlineTextEnd(src, fl);
  const raw = src.slice(0, end);
  const inRaw = L.state.insideRaw;
  return {
    type: 'text',
    raw,
    // Raw HTML keeps its text as-is; elsewhere numeric character
    // references mean the character itself.
    text: inRaw ? raw : decodeNumericEntities(raw),
    escaped: inRaw,
  };
}

// ---------- Lexer ----------

function newLexer() {
  return {
    defs: Object.create(null),
    pendingInline: [],
    state: {
      insideLink: false,
      insideRaw: false,
      linkSeen: false,
      mayHaveParen: true,
      atTop: true,
    },
    closerHints: [],
  };
}

function tokenizeBlocks(L, src, tokens = [], lastParaClipped = false) {
  let srcLen = Infinity;
  while (src) {
    if (src.length < srcLen) {
      srcLen = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    let token;
    // blank lines
    if (token = readSpace(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (token.raw.length === 1 && lastToken !== undefined) {
        // a lone \n acts as a separator closing the last line, so move it there
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    // indented code
    if (token = readIndentedCode(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      // An indented code block must not break a paragraph.
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.pendingInline[L.pendingInline.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // fenced code
    if (token = readFence(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // heading
    if (token = readAtx(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // horizontal rule
    if (token = readRule(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // blockquote
    if (token = readQuote(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // list
    if (token = readList(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // html block
    if (token = readHtmlBlock(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // link definition
    if (token = readDef(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        L.pendingInline[L.pendingInline.length - 1].src = lastToken.text;
      } else {
        // The first definition for a label wins, but later definitions
        // still consume their text.
        if (!L.defs[token.tag]) {
          L.defs[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }
    // table (gfm)
    if (token = readTable(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // setext heading
    if (token = readSetext(L, src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // top-level paragraph
    if (L.state.atTop && (token = readParagraph(L, src))) {
      const lastToken = tokens[tokens.length - 1];
      if (lastParaClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.pendingInline.pop();
        L.pendingInline[L.pendingInline.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParaClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    // text
    if (token = readText(L, src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        L.pendingInline.pop();
        L.pendingInline[L.pendingInline.length - 1].src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  L.state.atTop = true;
  return tokens;
}

// Does this link text already hold a link? Images do not count: an image
// may hold a link, a link may not.
function textHasLink(L, text) {
  if (!text.includes('[')) return false;
  const linkRule = INLINE_GRAMMAR.link;
  for (const match of text.matchAll(INLINE_GRAMMAR.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(INLINE_GRAMMAR.reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(L.defs, normalizeRefLabel(m0.slice(refStart + 1, -1)))) {
      continue;
    }
    if (refStart > 1 && textHasLink(L, m0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

// Hide links, code, html and escapes so emphasis and strikethrough do not
// see delimiters inside them.
function maskDelimiters(L, src) {
  let masked = src;
  if (L.defs && src.includes('[')) {
    const search = INLINE_GRAMMAR.reflinkSearch;
    const maskOne = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(L.defs, normalizeRefLabel(m0.slice(refStart + 1, -1)))) {
        return m0;
      }
      // A candidate whose text already holds a link never becomes a link,
      // so flattening the whole span would hide emphasis that still
      // applies inside it. Mask only the link it holds. Images are
      // exempt: their text is flattened into the alt attribute.
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (textHasLink(L, text)) {
          return '[' + text.replace(search, maskOne)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  // Mask escaped characters. Every mask must keep the length of what it
  // replaces: emphasis and strikethrough line maskedSrc up with src by
  // slicing from the end. A backslash inside a code span is a literal,
  // not an escape. This pattern can only match a backslash or a backtick.
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(INLINE_GRAMMAR.anyPunctuationOutsideCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) {
        return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      }
      return m0;
    });
  }
  // Mask the other blocks. This pattern can only match a link ([), a code
  // span (`), or an html tag (<).
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(INLINE_GRAMMAR.blockSkip, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }
  return masked;
}

function tokenizeInline(L, src, tokens = []) {
  const prevParen = L.state.mayHaveParen;
  L.state.mayHaveParen = prevParen && src.includes(')');
  try {
    return tokenizeInlineBody(L, src, tokens);
  } finally {
    L.state.mayHaveParen = prevParen;
  }
}

function tokenizeInlineBody(L, src, tokens) {
  // The masked source and the closer scan are only read by emphasis and
  // strikethrough, which need *, _ or ~ to start. Skip both for runs
  // without those delimiters.
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? maskDelimiters(L, src) : src;
  if (!hasDelim) {
    return scanInline(L, src, masked, tokens);
  }
  pushCloserFrame(L, masked);
  try {
    return scanInline(L, src, masked, tokens);
  } finally {
    popCloserFrame(L);
  }
}

// Could the GFM url rule match at the start of src? It only matches www.,
// http(s)://, ftp://, mailto:/xmpp: plus an email, or a bare email (a local
// part at position 0, then @). Anything else cannot match, so the url
// tokenizer need not run. This is a superset test: true only causes an
// extra tokenUrl call that fails, never a missed match.
function urlCouldMatch(src) {
  const c0 = src.charCodeAt(0);
  if (c0 === 119) { // w: www.
    if (src.charCodeAt(1) === 119 && src.charCodeAt(2) === 119 && src.charCodeAt(3) === 46) return true;
  } else if (c0 === 104 || c0 === 72) { // h/H: http:// or https://
    // Compare per character code (case-insensitive via |32) instead of
    // allocating a slice plus a lower-cased string per url candidate.
    const h = src.charCodeAt(1) | 32;
    const t1 = src.charCodeAt(2) | 32;
    const t2 = src.charCodeAt(3) | 32;
    const p = src.charCodeAt(4) | 32;
    if (h === 116 && t1 === 116 && t2 === 112 && p === 58
      && src.charCodeAt(5) === 47 && src.charCodeAt(6) === 47) return true;
    if (h === 116 && t1 === 116 && t2 === 112 && p === 115
      && src.charCodeAt(5) === 58 && src.charCodeAt(6) === 47
      && src.charCodeAt(7) === 47) return true;
  } else if (c0 === 102 || c0 === 70) { // f/F: ftp://
    if ((src.charCodeAt(1) | 32) === 116 && (src.charCodeAt(2) | 32) === 112
      && src.charCodeAt(3) === 58 && src.charCodeAt(4) === 47
      && src.charCodeAt(5) === 47) return true;
  } else if (c0 === 109) { // m: mailto:
    if (src.startsWith('mailto:')) return true;
  } else if (c0 === 120) { // x: xmpp:
    if (src.startsWith('xmpp:')) return true;
  }
  // Bare email: local-part characters [A-Za-z0-9._+-] from 0, then @.
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

function scanInline(L, src, maskedSrc, tokens) {
  let keepPrev = false;
  let prevChar = '';
  let srcLen = Infinity;
  // What this inline run may hold, from native includes() scans
  // (a superset flag set for inlineTextEnd; see its comment).
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
    // Dispatch on the first character: every inline tokenizer is
    // anchored and can only match when src starts with one of a few
    // characters, so trying the others first would only burn failed
    // regex runs. The order inside each branch keeps marked's order.
    const c = src.charCodeAt(0);
    if (c === 92) { // backslash: escape, or a backslash-newline break
      if (token = readEscape(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = readBreak(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 60) { // <: html tag or autolink
      if (token = readInlineTag(L, src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = readAutolink(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 91 || c === 33) { // [ or !: link or reflink
      if (token = readLink(L, src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = readRefLink(L, src)) {
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
    } else if (c === 42 || c === 95) { // * or _: emphasis
      if (token = readEmphasis(L, src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      // A bare email can start with `_` (its local part allows it), so
      // when emphasis fails on `_`, the GFM url rule still has to be
      // tried before falling through to text — otherwise `_foo@bar.com`
      // loses its leading underscore from the email link.
      if (c === 95 && !L.state.insideLink && urlCouldMatch(src)) {
        if (token = readGfmUrl(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }
    } else if (c === 96) { // `: code span
      if (token = readCodeSpan(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 32) { // space: hard break (two spaces + newline)
      if (token = readBreak(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === 126) { // ~: strikethrough
      if (token = readDelete(L, src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (!L.state.insideLink && urlCouldMatch(src)) {
      // url (gfm): only reachable from a non-delimiter start
      if (token = readGfmUrl(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }
    // text
    if (token = readInlineText(L, src, fl)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // track prevChar before a ____ run starts
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

function renderCode(L, token) {
  const lang = (token.lang || '').match(P.leadingWord)?.[0];
  // An empty code block has no content, so it must not get a newline.
  const code = token.text ? token.text.replace(P.newlineAtEnd, '') + '\n' : '';
  if (!lang) {
    return '<pre><code>' + htmlEscape(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + htmlEscape(lang) + '">'
    + htmlEscape(code, true) + '</code></pre>\n';
}

function renderCheck(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderText(L, token, textOnly) {
  if (textOnly) return token.text;
  if ('tokens' in token && token.tokens) {
    return renderInlineTokens(L, token.tokens);
  }
  return ('escaped' in token && token.escaped) ? token.text : htmlEscape(token.text);
}

function renderAnchor(L, token) {
  // References are not resolved inside an autolink, so every `&` there
  // is a literal. Elsewhere only an `&` that cannot start a reference
  // needs escaping.
  const inner = token.autolink
    ? htmlEscape(token.text, true)
    : renderInlineTokens(L, token.tokens);
  const cleaned = sanitizeUrl(token.href);
  if (cleaned === null) return inner;
  const href = htmlEscape(cleaned, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) {
    out += ' title="' + htmlEscape(token.title) + '"';
  }
  out += '>' + inner + '</a>';
  return out;
}

function renderImg(L, token) {
  let text = token.text;
  if (token.tokens) {
    text = renderAsPlainText(L, token.tokens);
  }
  const cleaned = sanitizeUrl(token.href);
  if (cleaned === null) return htmlEscape(text);
  const href = cleaned;
  let out = `<img src="${htmlEscape(href)}" alt="${htmlEscape(text)}"`;
  if (token.title) {
    out += ` title="${htmlEscape(token.title)}"`;
  }
  out += '>';
  return out;
}

function renderTableCell(L, token) {
  const content = renderInlineTokens(L, token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTableBlock(L, token) {
  let cell = '';
  for (let j = 0; j < token.header.length; j++) {
    cell += renderTableCell(L, token.header[j]);
  }
  const header = `<tr>\n${cell}</tr>\n`;
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

function renderListBlock(L, token) {
  let body = '';
  for (let j = 0; j < token.items.length; j++) {
    body += `<li>${renderBlockTokens(L, token.items[j].tokens)}</li>\n`;
  }
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlockTokens(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInlineTokens(L, token.tokens)}</h${token.depth}>\n`; break;
      case 'code': out += renderCode(L, token); break;
      case 'table': out += renderTableBlock(L, token); break;
      case 'blockquote': out += `<blockquote>\n${renderBlockTokens(L, token.tokens)}</blockquote>\n`; break;
      case 'list': out += renderListBlock(L, token); break;
      case 'checkbox': out += renderCheck(token); break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInlineTokens(L, token.tokens)}</p>\n`; break;
      case 'text': out += renderText(L, token, false); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// Plain-text rendering: only the textual part of a token (used for image
// alt text).
function renderAsPlainText(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderAsPlainText(L, token.tokens) : token.text;
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

function renderInlineTokens(L, tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape': out += renderText(L, token, false); break;
      case 'html': out += token.text; break;
      case 'link': out += renderAnchor(L, token); break;
      case 'image': out += renderImg(L, token); break;
      case 'checkbox': out += renderCheck(token); break;
      case 'strong': out += `<strong>${renderInlineTokens(L, token.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInlineTokens(L, token.tokens)}</em>`; break;
      case 'codespan': out += `<code>${htmlEscape(token.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInlineTokens(L, token.tokens)}</del>`; break;
      case 'text': out += renderText(L, token, false); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------- Entry point ----------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const L = newLexer();
  // Most documents hold no \r; skip the replace scan when there is none,
  // since replace always scans the whole string.
  const src = markdown.includes('\r') ? markdown.replace(P.crlfPair, '\n') : markdown;
  const tokens = tokenizeBlocks(L, src, []);
  for (let i = 0; i < L.pendingInline.length; i++) {
    const next = L.pendingInline[i];
    // An inline <pre>, <code>, <kbd> or <script> tag left open ends with
    // the block holding it; carried on, it would stop text escaping in
    // every block after it.
    L.state.insideRaw = false;
    tokenizeInline(L, next.src, next.tokens);
  }
  L.pendingInline = [];
  return renderBlockTokens(L, tokens);
}
