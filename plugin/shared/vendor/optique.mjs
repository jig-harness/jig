// @bun
// Optique (@optique/core) 1.3.6, MIT License (optique.LICENSE), bundled by `bun tools/plugin/vendor-optique.ts`; do not edit.
// node_modules/@optique/core/dist/displaywidth.js
var ansiRegex = /\x1B(?:\[[0-9;:]*[@-~]|\][^\x1B\x07]*(?:\x1B\\|\x07))/g;
function stripAnsi(text) {
  return text.replace(ansiRegex, "");
}
var segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function getDisplayWidth(text) {
  const stripped = stripAnsi(text);
  let width = 0;
  for (const { segment } of segmenter.segment(stripped))
    width += graphemeWidth(segment);
  return width;
}
var zeroWidthRegex = /^[\p{Cf}\p{Mn}\p{Me}]+$/u;
var emojiPresentationRegex = /\p{Emoji_Presentation}/u;
var emojiWithVS16Regex = /\p{Emoji}\uFE0F/u;
var keycapEmojiRegex = /^[#*0-9]\uFE0F?\u20E3$/u;
var textPresentationRegex = /\uFE0E/u;
var regionalIndicatorRegex = /[\u{1F1E6}-\u{1F1FF}]/u;
function graphemeWidth(grapheme) {
  const cp = grapheme.codePointAt(0);
  if (cp == null)
    return 0;
  if (cp === 9)
    return 1;
  if (cp < 32 || cp >= 127 && cp < 160)
    return 0;
  if (zeroWidthRegex.test(grapheme))
    return 0;
  if (keycapEmojiRegex.test(grapheme) || !textPresentationRegex.test(grapheme) && (emojiPresentationRegex.test(grapheme) || emojiWithVS16Regex.test(grapheme) || regionalIndicatorRegex.test(grapheme)))
    return 2;
  let width = isEastAsianWide(cp) ? 2 : 1;
  for (let i = cp > 65535 ? 2 : 1;i < grapheme.length; i++) {
    const c = grapheme.charCodeAt(i);
    if (c === 65438 || c === 65439)
      width += 1;
  }
  return width;
}
function isEastAsianWide(cp) {
  return cp >= 4352 && cp <= 4447 || cp >= 9001 && cp <= 9002 || cp >= 9776 && cp <= 9783 || cp >= 9866 && cp <= 9871 || cp >= 11904 && cp <= 12255 || cp >= 12272 && cp <= 12350 || cp >= 12353 && cp <= 40959 || cp >= 40960 && cp <= 42191 || cp >= 43360 && cp <= 43391 || cp >= 44032 && cp <= 55215 || cp >= 63744 && cp <= 64255 || cp >= 65040 && cp <= 65049 || cp >= 65072 && cp <= 65135 || cp >= 65281 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 94176 && cp <= 101759 || cp >= 110576 && cp <= 111359 || cp >= 127488 && cp <= 127490 || cp >= 127504 && cp <= 127547 || cp >= 127552 && cp <= 127560 || cp >= 127568 && cp <= 127569 || cp >= 127584 && cp <= 127589 || cp >= 131072 && cp <= 196605 || cp >= 196608 && cp <= 262141;
}

// node_modules/@optique/core/dist/terminal-separators.js
var wrapTrimmableFragments = /* @__PURE__ */ new WeakSet;

// node_modules/@optique/core/dist/terminal.js
var plain = (text) => ({
  type: "text",
  text
});
var styled = (text, style) => ({
  type: "style",
  style,
  children: [plain(text)]
});
var valuesSeparator = plain(" ");
wrapTrimmableFragments.add(valuesSeparator);
var defaultTerminalTheme = {
  optionName: (_term, ctx) => styled(ctx.text, ctx.usage === "command" ? { bold: true } : { italic: true }),
  optionNames: (term, ctx) => ({
    type: "concat",
    children: term.optionNames.flatMap((name, i) => [...i === 0 ? [] : [ctx.format({
      type: "syntaxPunctuation",
      punctuation: "/",
      kind: "messageOptionSeparator"
    })], ctx.format({
      type: "optionName",
      optionName: name
    })])
  }),
  metavar: (_term, ctx) => ctx.usage === "optionValue" ? {
    type: "style",
    style: { underline: true },
    children: [styled(ctx.text, { dim: true })]
  } : styled(ctx.text, ctx.usage === "argument" ? { underline: true } : { bold: true }),
  value: (_term, ctx) => ctx.usage === "literal" ? plain(ctx.text) : styled(ctx.text, { foreground: "green" }),
  values: (term, ctx) => ({
    type: "concat",
    children: term.values.flatMap((value, i) => [...i === 0 ? [] : [valuesSeparator], ctx.format({
      type: "value",
      value
    })])
  }),
  envVar: (_term, ctx) => styled(ctx.text, {
    bold: true,
    underline: true
  }),
  commandLine: (_term, ctx) => styled(ctx.text, { foreground: "cyan" }),
  url: (term, ctx) => ({
    type: "link",
    href: term.url.href,
    children: [plain(ctx.text)]
  }),
  programName: (_term, ctx) => styled(ctx.text, { bold: true }),
  label: (term, ctx) => term.kind === "usageSummary" || term.kind === "choices" ? plain(ctx.text) : styled(ctx.text, {
    bold: true,
    dim: true
  }),
  syntaxPunctuation: (term, ctx) => [
    "alternative",
    "messageOptionSeparator",
    "defaultPrefix",
    "defaultSuffix",
    "choicesPrefix",
    "choicesSuffix"
  ].includes(term.kind) ? plain(ctx.text) : styled(ctx.text, { dim: true }),
  errorLabel: (_term, ctx) => plain(ctx.text),
  annotationStyles: {
    default: { dim: true },
    choices: { dim: true }
  }
};

// node_modules/@optique/core/dist/terminal-internal.js
function terminalText(text) {
  return {
    type: "text",
    text
  };
}
function valuesFormatter(theme) {
  if (theme.values != null && theme.values !== defaultTerminalTheme.values)
    return theme.values;
  if (theme.value != null && theme.value !== defaultTerminalTheme.value)
    return defaultTerminalTheme.values;
  return (term, context) => ({
    type: "style",
    style: { foreground: "green" },
    children: [defaultTerminalTheme.values(term, context)]
  });
}
var defaultFormatters = new WeakSet(Object.values(defaultTerminalTheme).filter((value) => typeof value === "function"));
function formatTerminalTerm(term, theme = {}, quotes = false, usage) {
  return formatTerminalLeaf(term, theme, quotes, usage).fragment;
}
function formatTerminalLeaf(term, theme = {}, quotes = false, usage) {
  const quote = (s) => quotes ? `\`${s}\`` : s;
  let text;
  switch (term.type) {
    case "text":
      return {
        fragment: terminalText(term.text),
        defaultOrigin: true
      };
    case "lineBreak":
      throw new TypeError("Hard breaks must be rendered at the message level.");
    case "optionName":
      text = quote(term.optionName);
      break;
    case "optionNames":
      text = term.optionNames.map(quote).join("/");
      break;
    case "metavar":
      text = quote(term.metavar);
      break;
    case "value":
      text = quotes ? JSON.stringify(term.value) : term.value;
      break;
    case "values":
      text = term.values.map((v) => quotes ? JSON.stringify(v) : v).join(" ");
      break;
    case "envVar":
      text = quote(term.envVar);
      break;
    case "commandLine":
      text = quote(term.commandLine);
      break;
    case "url":
      text = quotes ? `<${term.url.href}>` : term.url.href;
      break;
    case "programName":
      text = term.programName;
      break;
    case "label":
    case "errorLabel":
      text = term.label;
      break;
    case "syntaxPunctuation":
      text = term.punctuation;
      break;
    default:
      throw new TypeError(`Invalid MessageTerm type: ${term["type"]}.`);
  }
  const ctx = {
    quotes,
    text,
    usage,
    format: (child) => formatTerminalTerm(child, theme, quotes, usage)
  };
  function render(formatter, value) {
    return {
      fragment: formatter(value, ctx),
      defaultOrigin: defaultFormatters.has(formatter)
    };
  }
  switch (term.type) {
    case "optionName":
      return render(theme.optionName ?? defaultTerminalTheme.optionName, term);
    case "optionNames":
      return render(theme.optionNames ?? defaultTerminalTheme.optionNames, term);
    case "metavar":
      return render(theme.metavar ?? defaultTerminalTheme.metavar, term);
    case "value":
      return render(theme.value ?? defaultTerminalTheme.value, term);
    case "values":
      return render(valuesFormatter(theme), term);
    case "envVar":
      return render(theme.envVar ?? defaultTerminalTheme.envVar, term);
    case "commandLine":
      return render(theme.commandLine ?? defaultTerminalTheme.commandLine, term);
    case "url":
      return render(theme.url ?? defaultTerminalTheme.url, term);
    case "programName":
      return render(theme.programName ?? defaultTerminalTheme.programName, term);
    case "label":
      return render(theme.label ?? defaultTerminalTheme.label, term);
    case "syntaxPunctuation":
      return render(theme.syntaxPunctuation ?? defaultTerminalTheme.syntaxPunctuation, term);
    case "errorLabel":
      return render(theme.errorLabel ?? defaultTerminalTheme.errorLabel, term);
  }
}
var colorNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite"
];
function colorCode(color, background) {
  const channel = (n) => {
    if (!Number.isInteger(n) || n < 0 || n > 255)
      throw new RangeError("Terminal color channels must be integers from 0 to 255.");
    return n;
  };
  if (typeof color === "string") {
    const i = colorNames.indexOf(color);
    if (i < 0)
      throw new RangeError("Unknown terminal color.");
    return String((background ? 40 : 30) + (i >= 8 ? 60 + i - 8 : i));
  }
  const prefix = background ? 48 : 38;
  if ("index" in color)
    return `${prefix};5;${channel(color.index)}`;
  return `${prefix};2;${color.map(channel).join(";")}`;
}
function styleCode(style) {
  const codes = [];
  if (style.bold)
    codes.push(1);
  if (style.dim)
    codes.push(2);
  if (style.italic)
    codes.push(3);
  if (style.underline)
    codes.push(4);
  if (style.foreground != null)
    codes.push(colorCode(style.foreground, false));
  if (style.background != null)
    codes.push(colorCode(style.background, true));
  return codes.length ? `\x1B[${codes.join(";")}m` : "";
}
function sameStyle(a, b) {
  return a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && JSON.stringify(a.foreground) === JSON.stringify(b.foreground) && JSON.stringify(a.background) === JSON.stringify(b.background);
}
function* fragmentTokens(fragment, scopes = [], inherited = {}) {
  if (fragment.type === "text") {
    const marks = wrapTrimmableFragments.has(fragment) ? { trimOnWrap: true } : {};
    const lines = fragment.text.split(`
`);
    for (let i = 0;i < lines.length; i++) {
      if (i > 0)
        yield {
          text: `
`,
          width: -1,
          scopes
        };
      if (lines[i].length > 0 || lines.length === 1)
        yield {
          text: lines[i],
          width: getDisplayWidth(lines[i]),
          scopes,
          ...marks
        };
    }
    return;
  }
  let next = scopes;
  let style = inherited;
  if (fragment.type === "style") {
    styleCode(fragment.style);
    style = {
      ...inherited,
      ...fragment.style
    };
    if (!sameStyle(style, inherited))
      next = [...scopes, {
        kind: "style",
        style: fragment.style
      }];
  } else if (fragment.type === "link")
    next = [...scopes, {
      kind: "link",
      href: fragment.href
    }];
  for (const child of fragment.children)
    yield* fragmentTokens(child, next, style);
}
function serializeTokens(tokens, colors = false, resetSuffix = "", ambient = {}) {
  let output = "";
  let active = [];
  function transition(next) {
    let common = 0;
    while (common < active.length && common < next.length && active[common] === next[common])
      common++;
    const surviving = active.slice(0, common);
    const restored = surviving.reduce((style, scope) => ({
      ...style,
      ...scope.style
    }), ambient);
    let reset = false;
    let closedLink = false;
    for (let i = active.length - 1;i >= common; i--)
      if (active[i].kind === "link") {
        output += `\x1B]8;;\x1B\\${resetSuffix}${styleCode(restored)}`;
        closedLink = true;
      } else
        reset = true;
    active = surviving;
    if (closedLink) {
      const parentLink = active.findLast((scope) => scope.kind === "link");
      if (parentLink != null)
        output += `\x1B]8;;${parentLink.href}\x1B\\`;
    }
    if (reset)
      output += "\x1B[0m" + resetSuffix + styleCode(restored);
    for (const scope of next.slice(common)) {
      if (scope.kind === "link")
        output += `\x1B]8;;${scope.href}\x1B\\`;
      else if (scope.style)
        if (Object.values(scope.style).includes(false)) {
          const inherited = active.reduce((s, x) => ({
            ...s,
            ...x.style
          }), ambient);
          output += "\x1B[0m" + resetSuffix + styleCode({
            ...inherited,
            ...scope.style
          });
        } else
          output += styleCode(scope.style);
      active = [...active, scope];
    }
  }
  const items = [...tokens];
  for (let i = 0;i < items.length; i++) {
    const token = items[i];
    if (colors && token.width === -1 && token.scopes.length === 0) {
      const next = items.slice(i + 1).find((t) => t.width !== -1)?.scopes ?? [];
      let common = 0;
      while (common < active.length && common < next.length && active[common] === next[common])
        common++;
      transition(active.slice(0, common));
    } else if (colors)
      transition(token.scopes);
    output += token.text;
  }
  if (colors)
    transition([]);
  return output;
}
function renderTerminalTerm(term, theme, colors, usage, ambient, resetSuffix = "") {
  return serializeTokens(fragmentTokens(formatTerminalTerm(term, theme, false, usage)), colors, resetSuffix, ambient);
}
function cacheTerminalTheme(theme = {}) {
  function cache(formatter) {
    const fragments = /* @__PURE__ */ new Map;
    const cached = (term, context) => {
      const key = JSON.stringify([
        term,
        context.quotes,
        context.usage
      ]);
      let fragment = fragments.get(key);
      if (fragment == null) {
        fragment = formatter(term, context);
        fragments.set(key, fragment);
      }
      return fragment;
    };
    if (defaultFormatters.has(formatter))
      defaultFormatters.add(cached);
    return cached;
  }
  return {
    optionName: cache(theme.optionName ?? defaultTerminalTheme.optionName),
    optionNames: cache(theme.optionNames ?? defaultTerminalTheme.optionNames),
    metavar: cache(theme.metavar ?? defaultTerminalTheme.metavar),
    value: cache(theme.value ?? defaultTerminalTheme.value),
    values: cache(valuesFormatter(theme)),
    envVar: cache(theme.envVar ?? defaultTerminalTheme.envVar),
    commandLine: cache(theme.commandLine ?? defaultTerminalTheme.commandLine),
    url: cache(theme.url ?? defaultTerminalTheme.url),
    programName: cache(theme.programName ?? defaultTerminalTheme.programName),
    label: cache(theme.label ?? defaultTerminalTheme.label),
    syntaxPunctuation: cache(theme.syntaxPunctuation ?? defaultTerminalTheme.syntaxPunctuation),
    errorLabel: cache(theme.errorLabel ?? defaultTerminalTheme.errorLabel),
    annotationStyles: theme.annotationStyles == null ? undefined : {
      default: theme.annotationStyles.default == null ? undefined : { ...theme.annotationStyles.default },
      choices: theme.annotationStyles.choices == null ? undefined : { ...theme.annotationStyles.choices }
    }
  };
}

// node_modules/@optique/core/dist/message-registry.js
var messageRenderers = /* @__PURE__ */ new WeakMap;

// node_modules/@optique/core/dist/message.js
function cloneMessageTerm(term) {
  switch (term.type) {
    case "optionNames":
      return {
        ...term,
        optionNames: [...term.optionNames]
      };
    case "values":
      return {
        ...term,
        values: [...term.values]
      };
    case "url":
      return {
        type: "url",
        url: new URL(term.url.href)
      };
    default:
      return { ...term };
  }
}
function cloneMessage(msg) {
  return msg.map(cloneMessageTerm);
}
function message(message$1, ...values$1) {
  const messageTerms = [];
  for (let i = 0;i < message$1.length; i++) {
    if (message$1[i] !== "")
      messageTerms.push({
        type: "text",
        text: message$1[i]
      });
    if (i >= values$1.length)
      continue;
    const value$1 = values$1[i];
    if (typeof value$1 === "string")
      messageTerms.push({
        type: "value",
        value: value$1
      });
    else if (Array.isArray(value$1))
      messageTerms.push(...cloneMessage(value$1));
    else if (typeof value$1 === "object" && value$1 != null && "type" in value$1)
      messageTerms.push(cloneMessageTerm(value$1));
    else
      throw new TypeError(`Invalid value type in message: ${typeof value$1}.`);
  }
  return messageTerms;
}
function text(text$1) {
  return {
    type: "text",
    text: text$1
  };
}
function optionName(name) {
  return {
    type: "optionName",
    optionName: name
  };
}
function optionNames(names) {
  return {
    type: "optionNames",
    optionNames: [...names]
  };
}
function metavar(metavar$1) {
  return {
    type: "metavar",
    metavar: metavar$1
  };
}
function value(value$1) {
  return {
    type: "value",
    value: value$1
  };
}
function values(values$1) {
  if (values$1.length === 0)
    throw new TypeError("values must not be empty.");
  return {
    type: "values",
    values: [...values$1]
  };
}
function commandLine(commandLine$1) {
  return {
    type: "commandLine",
    commandLine: commandLine$1
  };
}
function lineBreak() {
  return { type: "lineBreak" };
}
function valueSet(values$1, fallbackOrOptions) {
  if (fallbackOrOptions == null || typeof fallbackOrOptions !== "string" && typeof fallbackOrOptions.fallback !== "string")
    throw new TypeError("valueSet() requires a fallback string or an options object with a fallback field.");
  const options = typeof fallbackOrOptions === "string" ? { fallback: fallbackOrOptions } : fallbackOrOptions;
  if (values$1.length === 0)
    return options.fallback === "" ? [] : [{
      type: "text",
      text: options.fallback
    }];
  const formatter = new Intl.ListFormat(options?.locale, {
    type: options?.type,
    style: options?.style
  });
  const parts = formatter.formatToParts(values$1);
  const result = [];
  for (const part of parts)
    if (part.type === "element")
      result.push({
        type: "value",
        value: part.value
      });
    else
      result.push({
        type: "text",
        text: part.value
      });
  return result;
}
function formatMessage(msg, options = {}) {
  return renderMessage(msg, options, {});
}
function createMessageFormatter(theme) {
  const snapshot = { ...theme };
  const formatter = (msg, options = {}) => renderMessage(msg, options, snapshot);
  messageRenderers.set(formatter, (msg, options, ambient) => renderMessage(msg, options, snapshot, ambient));
  return formatter;
}
function renderMessage(msg, options, theme, ambient) {
  const initialWidth = options.initialWidth ?? 0;
  if (!Number.isFinite(initialWidth) || !Number.isInteger(initialWidth))
    throw new TypeError("Initial width must be a finite integer.");
  if (initialWidth < 0)
    throw new RangeError("Initial width must be nonnegative.");
  const colorConfig = options.colors ?? false;
  const useColors = typeof colorConfig === "boolean" ? colorConfig : true;
  const resetSuffix = typeof colorConfig === "object" ? colorConfig.resetSuffix ?? "" : "";
  const useQuotes = options.quotes ?? true;
  function* stream() {
    const wordPattern = /\s*\S+\s*/g;
    let prevWasLineBreak = false;
    for (const term of msg) {
      const isAfterLineBreak = prevWasLineBreak;
      prevWasLineBreak = false;
      if (term.type === "text") {
        const rawText = isAfterLineBreak ? term.text.replace(/^\n(?!\n)/, "") : term.text;
        if (rawText.includes(`

`)) {
          const paragraphs = rawText.split(/\n\n+/);
          for (let paragraphIndex = 0;paragraphIndex < paragraphs.length; paragraphIndex++) {
            if (paragraphIndex > 0) {
              const breakText = isAfterLineBreak && paragraphIndex === 1 ? `
` : `

`;
              yield {
                text: breakText,
                width: -1,
                scopes: []
              };
            }
            const paragraph = paragraphs[paragraphIndex].replace(/\n/g, " ");
            wordPattern.lastIndex = 0;
            while (true) {
              const match = wordPattern.exec(paragraph);
              if (match == null)
                break;
              yield {
                text: match[0],
                width: getDisplayWidth(match[0]),
                scopes: [],
                trimOnWrap: true
              };
            }
          }
        } else {
          const normalizedText = rawText.replace(/\n/g, " ");
          if (normalizedText.trim() === "" && normalizedText.length > 0)
            yield {
              text: " ",
              width: 1,
              scopes: [],
              trimOnWrap: true
            };
          else {
            wordPattern.lastIndex = 0;
            while (true) {
              const match = wordPattern.exec(normalizedText);
              if (match == null)
                break;
              yield {
                text: match[0],
                width: getDisplayWidth(match[0]),
                scopes: [],
                trimOnWrap: true
              };
            }
          }
        }
      } else if (term.type === "lineBreak") {
        yield {
          text: `
`,
          width: -1,
          scopes: []
        };
        prevWasLineBreak = true;
      } else
        yield* fragmentTokens(formatTerminalTerm(term, theme, useQuotes));
    }
  }
  const tokens = [];
  let totalWidth = initialWidth;
  let pendingWrap = false;
  let atWrappedLineStart = false;
  for (let token of stream()) {
    if (token.width === -1) {
      tokens.push(token);
      totalWidth = 0;
      pendingWrap = false;
      atWrappedLineStart = false;
      continue;
    }
    const wraps = pendingWrap || options.maxWidth != null && totalWidth > 0 && totalWidth + token.width > options.maxWidth;
    if ((wraps || atWrappedLineStart) && token.trimOnWrap) {
      const text$1 = token.text.trimStart();
      token = {
        ...token,
        text: text$1,
        width: token.width - getDisplayWidth(token.text.slice(0, token.text.length - text$1.length))
      };
      if (text$1 === "") {
        if (wraps)
          pendingWrap = true;
        continue;
      }
    }
    if (pendingWrap && stripAnsi(token.text) === "") {
      tokens.push(token);
      continue;
    }
    if (wraps) {
      tokens.push({
        text: `
`,
        width: -1,
        scopes: []
      });
      totalWidth = 0;
      pendingWrap = false;
      atWrappedLineStart = true;
    }
    tokens.push(token);
    totalWidth += token.width;
    if (token.width > 0)
      atWrappedLineStart = false;
  }
  return serializeTokens(tokens, useColors, ambient == null ? resetSuffix : "", ambient);
}
messageRenderers.set(formatMessage, (msg, options, ambient) => renderMessage(msg, options, {}, ambient));
// node_modules/@optique/core/dist/internal/annotations.js
var annotationKey = Symbol.for("@optique/core/parser/annotation");
var firstPassAnnotationKey = Symbol.for("@optique/core/parser/firstPass");
var annotationStateValueKey = Symbol.for("@optique/core/parser/annotationStateValue");
var annotationWrapperKey = Symbol.for("@optique/core/parser/annotationWrapper");
var annotationWrapperKeys = new Set([
  annotationKey,
  annotationStateValueKey,
  annotationWrapperKey
]);
var injectedAnnotationWrappers = /* @__PURE__ */ new WeakSet;
function hasInjectedAnnotationWrapperShape(value) {
  const valueRecord = value;
  if (valueRecord[annotationWrapperKey] !== true)
    return false;
  const ownKeys = Reflect.ownKeys(valueRecord);
  if (ownKeys.length !== 3 || !ownKeys.every((key) => annotationWrapperKeys.has(key)))
    return false;
  const annotations = Object.getOwnPropertyDescriptor(value, annotationKey);
  const wrappedState = Object.getOwnPropertyDescriptor(value, annotationStateValueKey);
  const wrapper = Object.getOwnPropertyDescriptor(value, annotationWrapperKey);
  return annotations?.enumerable === true && annotations.writable === true && annotations.configurable === true && annotations.value != null && typeof annotations.value === "object" && wrappedState?.enumerable === false && wrappedState.writable === true && wrappedState.configurable === true && wrapper?.enumerable === false && wrapper.writable === true && wrapper.configurable === true && wrapper.value === true;
}
function getAnnotations(state) {
  if (state == null || typeof state !== "object")
    return;
  const stateObj = state;
  const annotations = stateObj[annotationKey];
  if (annotations != null && typeof annotations === "object")
    return annotations;
  return;
}
function annotateFreshArray(source, target) {
  const annotations = getAnnotations(source);
  if (annotations === undefined)
    return target;
  const annotated = target;
  annotated[annotationKey] = annotations;
  return annotated;
}
function inheritAnnotations(source, target) {
  const annotations = getAnnotations(source);
  if (annotations === undefined)
    return target;
  if (target == null || typeof target !== "object")
    return injectAnnotations(target, annotations);
  if (isInjectedAnnotationWrapper(target))
    return injectAnnotations(target, annotations);
  if (Array.isArray(target)) {
    const cloned$1 = [...target];
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (target instanceof Date) {
    const cloned$1 = new Date(target.getTime());
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (target instanceof Map) {
    const cloned$1 = new Map(target);
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (target instanceof Set) {
    const cloned$1 = new Set(target);
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (target instanceof RegExp) {
    const cloned$1 = new RegExp(target);
    cloned$1.lastIndex = target.lastIndex;
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (Object.getPrototypeOf(target) !== Object.prototype && Object.getPrototypeOf(target) !== null)
    return target;
  const cloned = Object.create(Object.getPrototypeOf(target), Object.getOwnPropertyDescriptors(target));
  cloned[annotationKey] = annotations;
  return cloned;
}
function hasMeaningfulAnnotations(annotations) {
  return annotations != null && Object.getOwnPropertySymbols(annotations).length > 0;
}
function injectAnnotations(state, annotations) {
  if (!hasMeaningfulAnnotations(annotations))
    return state;
  if (state == null || typeof state !== "object") {
    const wrapper = {};
    Object.defineProperties(wrapper, {
      [annotationKey]: {
        value: annotations,
        enumerable: true,
        writable: true,
        configurable: true
      },
      [annotationStateValueKey]: {
        value: state,
        enumerable: false,
        writable: true,
        configurable: true
      },
      [annotationWrapperKey]: {
        value: true,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
    injectedAnnotationWrappers.add(wrapper);
    return wrapper;
  }
  if (Array.isArray(state)) {
    const cloned$1 = [...state];
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (isInjectedAnnotationWrapper(state)) {
    const unwrapped = unwrapInjectedAnnotationWrapper(state);
    if (unwrapped !== state)
      return injectAnnotations(unwrapped, annotations);
    const cloned$1 = Object.create(Object.getPrototypeOf(state), Object.getOwnPropertyDescriptors(state));
    cloned$1[annotationKey] = annotations;
    injectedAnnotationWrappers.add(cloned$1);
    return cloned$1;
  }
  if (state instanceof Date) {
    const cloned$1 = new Date(state.getTime());
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (state instanceof Map) {
    const cloned$1 = new Map(state);
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (state instanceof Set) {
    const cloned$1 = new Set(state);
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  if (state instanceof RegExp) {
    const cloned$1 = new RegExp(state);
    cloned$1.lastIndex = state.lastIndex;
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  const proto = Object.getPrototypeOf(state);
  if (proto === Object.prototype || proto === null) {
    const cloned$1 = Object.create(proto, Object.getOwnPropertyDescriptors(state));
    cloned$1[annotationKey] = annotations;
    return cloned$1;
  }
  const cloned = Object.create(proto, Object.getOwnPropertyDescriptors(state));
  cloned[annotationKey] = annotations;
  return cloned;
}
function unwrapInjectedAnnotationWrapper(value) {
  if (value == null || typeof value !== "object")
    return value;
  if (!hasInjectedAnnotationWrapperShape(value))
    return value;
  const valueRecord = value;
  return valueRecord[annotationStateValueKey];
}
function isInjectedAnnotationWrapper(value) {
  return value != null && typeof value === "object" && (injectedAnnotationWrappers.has(value) || hasInjectedAnnotationWrapperShape(value));
}

// node_modules/@optique/core/dist/validate.js
var CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
var CONTROL_CHAR_RE_GLOBAL = new RegExp(CONTROL_CHAR_RE.source, "g");
function escapeControlChars(value) {
  return value.replace(CONTROL_CHAR_RE_GLOBAL, (ch) => {
    const code = ch.charCodeAt(0);
    switch (code) {
      case 9:
        return "\\t";
      case 10:
        return "\\n";
      case 13:
        return "\\r";
      default:
        return code > 255 ? `\\u${code.toString(16).padStart(4, "0")}` : `\\x${code.toString(16).padStart(2, "0")}`;
    }
  });
}
function validateOptionNames(names, label) {
  if (names.length === 0)
    throw new TypeError(`Expected at least one ${label.toLowerCase()} name.`);
  for (const name of names) {
    if (name === "")
      throw new TypeError(`${label} name must not be empty.`);
    if (/^\s+$/.test(name))
      throw new TypeError(`${label} name must not be whitespace-only: "${escapeControlChars(name)}".`);
    if (CONTROL_CHAR_RE.test(name))
      throw new TypeError(`${label} name must not contain control characters: "${escapeControlChars(name)}".`);
    if (/\s/.test(name))
      throw new TypeError(`${label} name must not contain whitespace: "${escapeControlChars(name)}".`);
    if (!/^(--|[-/+])/.test(name))
      throw new TypeError(`${label} name must start with "--", "-", "/", or "+": "${name}".`);
    if (name === "--")
      throw new TypeError(`${label} name must not be the options terminator "--".`);
  }
}
function validateCommandNames(names, label) {
  if (names.length === 0)
    throw new TypeError(`Expected at least one ${label.toLowerCase()} name.`);
  for (const name of names) {
    if (name === "")
      throw new TypeError(`${label} name must not be empty.`);
    if (/^\s+$/.test(name))
      throw new TypeError(`${label} name must not be whitespace-only: "${escapeControlChars(name)}".`);
    if (CONTROL_CHAR_RE.test(name))
      throw new TypeError(`${label} name must not contain control characters: "${escapeControlChars(name)}".`);
    if (/\s/.test(name))
      throw new TypeError(`${label} name must not contain whitespace: "${escapeControlChars(name)}".`);
  }
}
function validateMetaNameCollisions(metaEntries) {
  for (const [, label, names] of metaEntries) {
    const seen = /* @__PURE__ */ new Set;
    for (const name of names) {
      if (seen.has(name))
        throw new TypeError(`${capitalize(label)} has a duplicate name: "${name}"`);
      seen.add(name);
    }
  }
  const nameToLabel = /* @__PURE__ */ new Map;
  for (const [, label, names] of metaEntries)
    for (const name of names) {
      const existingLabel = nameToLabel.get(name);
      if (existingLabel != null)
        throw new TypeError(`Name "${name}" is used by both ${existingLabel} and ${label}.`);
      nameToLabel.set(name, label);
    }
  for (let i = 0;i < metaEntries.length; i++) {
    const [, label, names, prefixMatch] = metaEntries[i];
    if (!prefixMatch)
      continue;
    for (const name of names) {
      const prefix = name + "=";
      for (let j = 0;j < metaEntries.length; j++) {
        const [, otherLabel, otherNames] = metaEntries[j];
        for (const otherName of otherNames) {
          if (i === j && otherName === name)
            continue;
          if (!otherName.startsWith(prefix))
            continue;
          throw new TypeError('The prefix form of name "' + name + '" in ' + label + ' shadows "' + otherName + '" in ' + otherLabel + ".");
        }
      }
    }
  }
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function validateProgramName(programName) {
  if (typeof programName !== "string")
    throw new TypeError("Program name must be a string.");
  if (programName === "")
    throw new TypeError("Program name must not be empty.");
  if (/^\s+$/.test(programName))
    throw new TypeError(`Program name must not be whitespace-only: "${escapeControlChars(programName)}".`);
  if (CONTROL_CHAR_RE.test(programName))
    throw new TypeError(`Program name must not contain control characters: "${escapeControlChars(programName)}".`);
}
function validateLabel(label) {
  if (typeof label !== "string")
    throw new TypeError("Label must be a string.");
  if (label === "")
    throw new TypeError("Label must not be empty.");
  if (/^\s+$/.test(label))
    throw new TypeError(`Label must not be whitespace-only: "${escapeControlChars(label)}".`);
  if (CONTROL_CHAR_RE.test(label))
    throw new TypeError(`Label must not contain control characters: "${escapeControlChars(label)}".`);
}

// node_modules/@optique/core/dist/usage.js
function isUsageHidden(hidden) {
  return hidden === true || hidden === "usage" || hidden === "help";
}
function isDocHidden(hidden) {
  return hidden === true || hidden === "doc" || hidden === "help";
}
function isSuggestionHidden(hidden) {
  return hidden === true;
}
function mergeHidden(a, b) {
  if (a == null)
    return b;
  if (b == null)
    return a;
  if (a === true || b === true)
    return true;
  if (a === false)
    return b;
  if (b === false)
    return a;
  if (a === b)
    return a;
  if (a === "help" || b === "help")
    return "help";
  if ((a === "usage" || a === "doc") && (b === "usage" || b === "doc"))
    return "help";
  return a;
}
function extractOptionNames(usage, includeHidden) {
  const names = /* @__PURE__ */ new Set;
  function traverseUsage(terms) {
    if (!terms || !Array.isArray(terms))
      return;
    for (const term of terms)
      if (term.type === "option") {
        if (!includeHidden && isSuggestionHidden(term.hidden))
          continue;
        for (const name of term.names)
          names.add(name);
      } else if (term.type === "optional" || term.type === "multiple" || term.type === "sequence")
        traverseUsage(term.terms);
      else if (term.type === "exclusive")
        for (const exclusiveUsage of term.terms)
          traverseUsage(exclusiveUsage);
  }
  traverseUsage(usage);
  return names;
}
function extractCommandNames(usage, includeHidden) {
  const names = /* @__PURE__ */ new Set;
  function traverseUsage(terms) {
    if (!terms || !Array.isArray(terms))
      return;
    for (const term of terms)
      if (term.type === "command") {
        if (!includeHidden && isSuggestionHidden(term.hidden))
          continue;
        names.add(term.name);
        for (const alias of term.aliases ?? [])
          names.add(alias);
        if (includeHidden)
          for (const alias of term.hiddenAliases ?? [])
            names.add(alias);
      } else if (term.type === "optional" || term.type === "multiple" || term.type === "sequence")
        traverseUsage(term.terms);
      else if (term.type === "exclusive")
        for (const exclusiveUsage of term.terms)
          traverseUsage(exclusiveUsage);
  }
  traverseUsage(usage);
  return names;
}
function extractArgumentMetavars(usage) {
  const metavars = /* @__PURE__ */ new Set;
  function traverseUsage(terms) {
    if (!terms || !Array.isArray(terms))
      return;
    for (const term of terms)
      if (term.type === "argument") {
        if (isSuggestionHidden(term.hidden))
          continue;
        metavars.add(term.metavar);
      } else if (term.type === "optional" || term.type === "multiple" || term.type === "sequence")
        traverseUsage(term.terms);
      else if (term.type === "exclusive")
        for (const exclusiveUsage of term.terms)
          traverseUsage(exclusiveUsage);
  }
  traverseUsage(usage);
  return metavars;
}
function formatUsage(programName, usage, options = {}) {
  options = {
    ...options,
    theme: cacheTerminalTheme(options.theme)
  };
  validateProgramName(programName);
  usage = normalizeUsage(filterUsageForDisplay(usage));
  if (options.expandCommands) {
    const lastTerm = usage.at(-1);
    if (usage.length > 0 && usage.slice(0, -1).every((t) => t.type === "command") && lastTerm.type === "exclusive" && lastTerm.terms.every((t) => t.length > 0 && (t[0].type === "command" || t[0].type === "option" || t[0].type === "argument" || t[0].type === "optional" && t[0].terms.length === 1 && (t[0].terms[0].type === "command" || t[0].terms[0].type === "option" || t[0].terms[0].type === "argument")))) {
      const lines = [];
      for (let command of lastTerm.terms) {
        const firstTerm = command[0];
        if (firstTerm?.type === "command" && isUsageHidden(firstTerm.hidden))
          continue;
        if (usage.length > 1)
          command = [...usage.slice(0, -1), ...command];
        lines.push(formatUsage(programName, command, options));
      }
      if (lines.length > 0)
        return lines.join(`
`);
    }
  }
  return wrapUsageTokens(function* () {
    yield* usageLeafTokens({
      type: "programName",
      programName
    }, options);
    yield {
      ...usageSpace,
      programBoundary: true
    };
    yield* formatUsageTerms(usage, options);
  }(), options);
}
function normalizeUsage(usage) {
  const terms = usage.map(normalizeUsageTerm).filter(isNonDegenerateTerm);
  terms.sort((a, b) => {
    const aCmd = a.type === "command";
    const bCmd = b.type === "command";
    const aArg = a.type === "argument" || (a.type === "optional" || a.type === "multiple") && a.terms.at(-1)?.type === "argument";
    const bArg = b.type === "argument" || (b.type === "optional" || b.type === "multiple") && b.terms.at(-1)?.type === "argument";
    return aCmd === bCmd ? aArg === bArg ? 0 : aArg ? 1 : -1 : aCmd ? -1 : 1;
  });
  return terms;
}
function normalizeUsageTerm(term) {
  if (term.type === "optional") {
    const normalized = normalizeUsage(term.terms);
    if (normalized.length === 1 && normalized[0].type === "optional")
      return normalized[0];
    return {
      type: "optional",
      terms: normalized
    };
  } else if (term.type === "multiple")
    return {
      type: "multiple",
      terms: normalizeUsage(term.terms),
      min: term.min
    };
  else if (term.type === "sequence")
    return {
      type: "sequence",
      terms: term.terms.map(normalizeUsageTerm).filter(isNonDegenerateTerm)
    };
  else if (term.type === "exclusive") {
    const terms = [];
    for (const usage of term.terms) {
      const normalized = normalizeUsage(usage);
      if (normalized.length >= 1 && normalized[0].type === "exclusive") {
        const rest = normalized.slice(1);
        for (const subUsage of normalized[0].terms)
          terms.push([...subUsage, ...rest]);
      } else if (normalized.length > 0 || !containsMalformedLeaf(usage))
        terms.push(normalized);
    }
    return {
      type: "exclusive",
      terms
    };
  } else {
    if (term.type === "option")
      return {
        ...term,
        names: [...term.names]
      };
    else if (term.type === "command") {
      if (term.usageLine == null || typeof term.usageLine === "function")
        return { ...term };
      return {
        ...term,
        usageLine: cloneUsage(term.usageLine)
      };
    }
    return { ...term };
  }
}
function isNonDegenerateTerm(term) {
  if (term.type === "option")
    return term.names.length > 0;
  if (term.type === "command")
    return term.name !== "";
  if (term.type === "argument")
    return term.metavar.length > 0;
  if (term.type === "optional" || term.type === "multiple" || term.type === "exclusive" || term.type === "sequence")
    return term.terms.length > 0;
  return true;
}
function containsMalformedLeaf(usage) {
  for (const term of usage) {
    if (term.type === "option" && term.names.length === 0)
      return true;
    if (term.type === "command" && term.name === "")
      return true;
    if (term.type === "argument" && term.metavar.length === 0)
      return true;
    if (term.type === "optional" || term.type === "multiple" || term.type === "sequence") {
      if (containsMalformedLeaf(term.terms))
        return true;
    }
    if (term.type === "exclusive") {
      for (const branch of term.terms)
        if (containsMalformedLeaf(branch))
          return true;
    }
  }
  return false;
}
function cloneUsageTerm(term) {
  switch (term.type) {
    case "argument":
      return { ...term };
    case "option":
      return {
        ...term,
        names: [...term.names]
      };
    case "command": {
      if (term.usageLine == null || typeof term.usageLine === "function")
        return {
          ...term,
          ...term.aliases != null ? { aliases: [...term.aliases] } : {},
          ...term.hiddenAliases != null ? { hiddenAliases: [...term.hiddenAliases] } : {}
        };
      return {
        ...term,
        ...term.aliases != null ? { aliases: [...term.aliases] } : {},
        ...term.hiddenAliases != null ? { hiddenAliases: [...term.hiddenAliases] } : {},
        usageLine: term.usageLine.map(cloneUsageTerm)
      };
    }
    case "optional":
      return {
        type: "optional",
        terms: term.terms.map(cloneUsageTerm)
      };
    case "multiple":
      return {
        type: "multiple",
        terms: term.terms.map(cloneUsageTerm),
        min: term.min
      };
    case "exclusive":
      return {
        type: "exclusive",
        terms: term.terms.map((u) => u.map(cloneUsageTerm))
      };
    case "sequence":
      return {
        type: "sequence",
        terms: term.terms.map(cloneUsageTerm)
      };
    case "literal":
    case "passthrough":
    case "ellipsis":
      return { ...term };
  }
}
function cloneUsage(usage) {
  return usage.map(cloneUsageTerm);
}
function filterUsageForDisplay(usage, isHidden = isUsageHidden) {
  const terms = [];
  for (const term of usage) {
    if ((term.type === "argument" || term.type === "option" || term.type === "command" || term.type === "passthrough") && isHidden(term.hidden))
      continue;
    if (term.type === "option" && term.names.length === 0)
      continue;
    if (term.type === "command" && term.name === "")
      continue;
    if (term.type === "argument" && term.metavar.length === 0)
      continue;
    if (term.type === "literal" && term.value === "")
      continue;
    if (term.type === "optional") {
      const filtered = filterUsageForDisplay(term.terms, isHidden);
      if (filtered.length > 0)
        terms.push({
          type: "optional",
          terms: filtered
        });
      continue;
    }
    if (term.type === "multiple") {
      const filtered = filterUsageForDisplay(term.terms, isHidden);
      if (filtered.length > 0)
        terms.push({
          type: "multiple",
          terms: filtered,
          min: term.min
        });
      continue;
    }
    if (term.type === "exclusive") {
      const filteredBranches = term.terms.map((branch) => {
        const first = branch[0];
        if (first?.type === "command" && isHidden(first.hidden))
          return [];
        return filterUsageForDisplay(branch, isHidden);
      }).filter((branch) => branch.length > 0);
      if (filteredBranches.length > 0)
        terms.push({
          type: "exclusive",
          terms: filteredBranches
        });
      continue;
    }
    if (term.type === "sequence") {
      const filtered = filterUsageForDisplay(term.terms, isHidden);
      if (filtered.length > 0)
        terms.push({
          type: "sequence",
          terms: filtered
        });
      continue;
    }
    terms.push(term);
  }
  return terms;
}
var usageSpace = {
  text: " ",
  width: 1,
  scopes: [],
  separator: true
};
function* usageLeafTokens(term, options, usage) {
  const { fragment, defaultOrigin } = formatTerminalLeaf(term, options.theme, false, usage);
  for (const token of fragmentTokens(fragment))
    yield {
      ...token,
      legacyWhitespace: defaultOrigin
    };
}
function* formatUsageTerms(terms, options) {
  let i = 0;
  for (const t of terms) {
    if (i > 0)
      yield usageSpace;
    yield* formatUsageTermInternal(t, options);
    i++;
  }
}
function formatUsageTerm(term, options = {}) {
  options = {
    ...options,
    theme: cacheTerminalTheme(options.theme)
  };
  const hiddenCheck = options.context === "doc" ? isDocHidden : isUsageHidden;
  const visibleTerms = filterUsageForDisplay([term], hiddenCheck);
  if (visibleTerms.length < 1)
    return "";
  return wrapUsageTokens(formatUsageTermInternal(visibleTerms[0], options), options);
}
function wrapUsageTokens(input, options) {
  return serializeTokens(layoutUsageTokens(input, options), options.colors);
}
function* normalizeUsageSeparators(input) {
  let previous;
  let pending = [];
  for (const token of input) {
    if (token.separator || token.text === "") {
      pending.push(token);
      continue;
    }
    let separated = false;
    for (const item of pending)
      if (!item.separator)
        yield item;
      else if (!separated && previous != null && previous.width !== -1 && token.width !== -1) {
        yield item;
        separated = true;
      }
    pending = [];
    yield token;
    previous = token;
  }
  for (const item of pending)
    if (!item.separator)
      yield item;
}
function layoutUsageTokens(input, options) {
  let lineWidth = 0;
  const output = [];
  const tokens = [...normalizeUsageSeparators(input)];
  for (const [index, token] of tokens.entries()) {
    if (token.programBoundary && options.maxWidth != null) {
      const next = tokens.find((item, i) => i > index && item.text !== "");
      if (next != null && lineWidth + token.width + next.width > options.maxWidth) {
        output.push({
          text: `
`,
          width: -1,
          scopes: []
        });
        lineWidth = 0;
        continue;
      }
    }
    if (token.width === -1) {
      output.push(token);
      lineWidth = 0;
      continue;
    }
    if (options.maxWidth != null && lineWidth > 0 && token.width > 0 && lineWidth + token.width > options.maxWidth) {
      let lastIndex = output.length - 1;
      while (lastIndex >= 0 && output[lastIndex].text === "")
        lastIndex--;
      const last = output[lastIndex];
      if (last?.text.endsWith(" ") && (last.separator || last.legacyWhitespace && (!options.colors || last.scopes.length === 0)))
        output[lastIndex] = {
          ...last,
          text: last.text.slice(0, -1),
          width: last.width - 1
        };
      output.push({
        text: `
`,
        width: -1,
        scopes: []
      });
      lineWidth = 0;
      if (token.separator || token.legacyWhitespace && token.text === " ")
        continue;
    }
    output.push(token);
    lineWidth += token.width;
  }
  return output;
}
function* formatUsageTermInternal(term, options) {
  function leaf(t, usage) {
    return usageLeafTokens(t, options, usage);
  }
  function punctuation(punctuation$1, kind) {
    return leaf({
      type: "syntaxPunctuation",
      punctuation: punctuation$1,
      kind
    });
  }
  const space = usageSpace;
  if (term.type === "argument")
    yield* leaf({
      type: "metavar",
      metavar: term.metavar
    }, "argument");
  else if (term.type === "option") {
    const names = options.onlyShortestOptions ? [term.names.reduce((a, b) => getDisplayWidth(a) <= getDisplayWidth(b) ? a : b)] : term.names;
    for (let i = 0;i < names.length; i++) {
      if (i > 0)
        yield* punctuation(options.optionsSeparator ?? "/", "optionSeparator");
      yield* leaf({
        type: "optionName",
        optionName: names[i]
      });
    }
    if (!options.onlyShortestOptions && term.metavar != null) {
      yield space;
      yield* leaf({
        type: "metavar",
        metavar: term.metavar
      }, "optionValue");
    }
  } else if (term.type === "command")
    yield* leaf({
      type: "optionName",
      optionName: term.name
    }, "command");
  else if (term.type === "optional") {
    yield* punctuation("[", "optionalOpen");
    yield* formatUsageTerms(term.terms, options);
    yield* punctuation("]", "optionalClose");
  } else if (term.type === "exclusive") {
    yield* punctuation("(", "groupOpen");
    for (let i = 0;i < term.terms.length; i++) {
      if (i > 0) {
        yield space;
        yield* punctuation("|", "alternative");
        yield space;
      }
      yield* formatUsageTerms(term.terms[i], options);
    }
    yield* punctuation(")", "groupClose");
  } else if (term.type === "sequence")
    yield* formatUsageTerms(term.terms, options);
  else if (term.type === "multiple") {
    if (term.min < 1)
      yield* punctuation("[", "optionalOpen");
    for (let i = 0;i < Math.max(1, term.min); i++) {
      if (i > 0)
        yield space;
      yield* formatUsageTerms(term.terms, options);
    }
    yield* punctuation("...", "ellipsis");
    if (term.min < 1)
      yield* punctuation("]", "optionalClose");
  } else if (term.type === "literal")
    yield* leaf({
      type: "value",
      value: term.value
    }, "literal");
  else if (term.type === "passthrough")
    yield* punctuation("[...]", "passthrough");
  else if (term.type === "ellipsis")
    yield* punctuation("...", "ellipsis");
  else
    throw new TypeError(`Unknown usage term type: ${term["type"]}.`);
}

// node_modules/@optique/core/dist/text-layout.js
function measureText(text) {
  const lines = stripAnsi(text).split(`
`);
  const widths = lines.map(getDisplayWidth);
  return {
    firstLineWidth: widths[0],
    lastLineWidth: widths[widths.length - 1],
    maxLineWidth: widths.reduce((widest, width) => Math.max(widest, width), 0),
    lineCount: lines.length
  };
}
function placeText(text, cursor, maxWidth, trailingRoom = 0) {
  const plain = stripAnsi(text);
  const lines = plain.split(`
`);
  const offset = cursor.column - getDisplayWidth(cursor.line);
  const joinedWidth = offset + getDisplayWidth(cursor.line + lines[0]);
  const room = lines.length === 1 ? trailingRoom : 0;
  const breaks = maxWidth != null && (cursor.column > 0 || room > 0) && (joinedWidth > cursor.column || room > 0) && joinedWidth + room > maxWidth;
  const lastLine = lines[lines.length - 1];
  return {
    text: breaks ? `
` + text : text,
    cursor: lines.length > 1 || breaks ? {
      line: lastLine,
      column: getDisplayWidth(lastLine)
    } : {
      line: cursor.line + plain,
      column: joinedWidth
    }
  };
}
var leadingSpacePattern = /^((?:\x1B(?:\[[0-9;:]*[@-~]|\][^\x1B\x07]*(?:\x1B\\|\x07)))*)[^\S\n]+/;
function trimLeadingSpace(text) {
  return text.replace(leadingSpacePattern, "$1");
}
function measureAnnotation(prefix, suffix) {
  const prefixMetrics = measureText(prefix);
  const suffixMetrics = measureText(suffix);
  return {
    prefix,
    suffix,
    prefixMetrics,
    suffixMetrics,
    minWidth: Math.max(prefixMetrics.maxLineWidth, suffixMetrics.maxLineWidth, suffixMetrics.firstLineWidth + 1)
  };
}
function spaceAfterLabel(label) {
  return measureText(label).lastLineWidth > 0 ? label + " " : label;
}

// node_modules/@optique/core/dist/terminal-width.js
var automaticWidth = Symbol.for("@optique/core/automaticWidth");
function withAutomaticWidth(options, onResolved = () => {}) {
  return {
    ...options,
    [automaticWidth]: onResolved
  };
}
function hasAutomaticWidth(options) {
  return automaticWidth in options && typeof options[automaticWidth] === "function";
}
function reportAutomaticWidth(options, width) {
  if (automaticWidth in options && typeof options[automaticWidth] === "function")
    options[automaticWidth](width);
}
function minimumUsageWidth(programName, usage, label, theme) {
  const labelWidth = measureText(label).lastLineWidth;
  const programWidth = Math.max(0, ...[...fragmentTokens(formatTerminalTerm({
    type: "programName",
    programName
  }, theme))].map((token) => token.width));
  const atomicWidth = usage.reduce((widest, term) => Math.max(widest, measureText(formatUsageTerm(term, {
    theme,
    maxWidth: 1
  })).maxLineWidth), 0);
  return Math.max(measureText(label).maxLineWidth, labelWidth + Math.max(programWidth, Math.min(atomicWidth, programWidth + labelWidth)));
}

// node_modules/@optique/core/dist/message-renderer.js
function resolveMessageFormatter(options) {
  const formatter = options.messageFormatter ?? (options.theme == null ? formatMessage : createMessageFormatter(options.theme));
  return (message, options$1 = {}, ambient) => {
    const builtin = messageRenderers.get(formatter);
    if (builtin != null)
      return builtin(message, options$1, ambient);
    return formatter(message, {
      ...options$1,
      colors: typeof options$1.colors === "object" ? true : options$1.colors
    });
  };
}
function renderErrorMessage(message, options = {}) {
  const occupied = options.initialWidth ?? 0;
  if (!Number.isFinite(occupied) || !Number.isInteger(occupied))
    throw new TypeError("Initial width must be a finite integer.");
  if (occupied < 0)
    throw new RangeError("Initial width must be nonnegative.");
  const colors = options.colors;
  const label = spaceAfterLabel(renderTerminalTerm({
    type: "errorLabel",
    label: "Error:"
  }, options.theme, typeof colors === "object" ? true : colors, undefined, undefined, typeof colors === "object" ? colors.resetSuffix : undefined));
  if (hasAutomaticWidth(options) && options.maxWidth != null) {
    const size = measureText(label);
    if (options.maxWidth < Math.max(size.maxLineWidth, occupied + size.lastLineWidth + 1))
      options = {
        ...options,
        maxWidth: undefined
      };
  }
  reportAutomaticWidth(options, options.maxWidth);
  const prefix = placeText(label, {
    line: "",
    column: occupied
  }, options.maxWidth);
  const formatted = resolveMessageFormatter(options)(message, {
    colors,
    quotes: options.quotes,
    maxWidth: options.maxWidth,
    initialWidth: prefix.cursor.column
  });
  return prefix.text + formatted;
}

// node_modules/@optique/core/dist/doc.js
function isDocEntryHidden(entry) {
  const term = entry.term;
  if (term.type === "argument" || term.type === "option" || term.type === "command" || term.type === "passthrough")
    return isDocHidden(term.hidden);
  return false;
}
function getDocEntryKey(entry) {
  const term = entry.term;
  switch (term.type) {
    case "command":
      return `command:${term.name}`;
    case "option":
      return `option:${[...term.names].sort().join(",")}:${term.metavar ?? ""}`;
    case "argument":
      return `argument:${term.metavar}`;
    default:
      return JSON.stringify(term);
  }
}
function deduplicateDocEntries(entries) {
  const seen = /* @__PURE__ */ new Set;
  const result = [];
  for (const entry of entries) {
    if (isDocEntryHidden(entry))
      continue;
    if (entry.term.type === "argument") {
      result.push(entry);
      continue;
    }
    const key = getDocEntryKey(entry);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}
function deduplicateDocFragments(fragments) {
  const untitledSeen = /* @__PURE__ */ new Set;
  const titledSectionMap = /* @__PURE__ */ new Map;
  const titledSectionPositioned = /* @__PURE__ */ new Set;
  const slots = [];
  for (const fragment of fragments)
    if (fragment.type === "entry") {
      if (isDocEntryHidden(fragment))
        continue;
      if (fragment.term.type === "argument")
        slots.push(fragment);
      else {
        const key = getDocEntryKey(fragment);
        if (!untitledSeen.has(key)) {
          untitledSeen.add(key);
          slots.push(fragment);
        }
      }
    } else if (fragment.title == null) {
      const dedupedEntries = [];
      for (const entry of fragment.entries) {
        if (isDocEntryHidden(entry))
          continue;
        if (entry.term.type === "argument") {
          dedupedEntries.push(entry);
          continue;
        }
        const key = getDocEntryKey(entry);
        if (!untitledSeen.has(key)) {
          untitledSeen.add(key);
          dedupedEntries.push(entry);
        }
      }
      if (dedupedEntries.length > 0)
        slots.push({
          ...fragment,
          type: "section",
          entries: dedupedEntries
        });
    } else {
      if (!titledSectionMap.has(fragment.title))
        titledSectionMap.set(fragment.title, []);
      if (!titledSectionPositioned.has(fragment.title) && fragment.entries.some((e) => !isDocEntryHidden(e))) {
        titledSectionPositioned.add(fragment.title);
        slots.push(fragment.title);
      }
      titledSectionMap.get(fragment.title).push(...fragment.entries);
    }
  const result = [];
  for (const slot of slots)
    if (typeof slot === "string") {
      const entries = deduplicateDocEntries(titledSectionMap.get(slot));
      if (entries.length > 0)
        result.push({
          type: "section",
          title: slot,
          entries
        });
    } else
      result.push(slot);
  return result;
}
function cloneDocEntry(entry) {
  return {
    term: cloneUsageTerm(entry.term),
    ...entry.description != null && { description: cloneMessage(entry.description) },
    ...entry.default != null && { default: cloneMessage(entry.default) },
    ...entry.choices != null && { choices: cloneMessage(entry.choices) }
  };
}
function classifySection(section) {
  const hasCommand = section.entries.some((e) => e.term.type === "command");
  const hasNonCommand = section.entries.some((e) => e.term.type !== "command");
  if (hasCommand && !hasNonCommand)
    return 0;
  if (hasCommand && hasNonCommand)
    return 1;
  return 2;
}
function scoreSection(section) {
  return classifySection(section) + (section.title == null ? -1 : 0);
}
function defaultSectionOrder(a, b) {
  return scoreSection(a) - scoreSection(b);
}
function formatDocPage(programName, page, options = {}) {
  options = {
    ...options,
    theme: cacheTerminalTheme(options.theme)
  };
  const formatMessage = resolveMessageFormatter(options);
  const opaqueFormatter = options.messageFormatter != null && !messageRenderers.has(options.messageFormatter);
  const defaultAmbient = options.theme?.annotationStyles?.default ?? { dim: true };
  const choicesAmbient = options.theme?.annotationStyles?.choices ?? { dim: true };
  const labelCache = /* @__PURE__ */ new Map;
  const label = (label$1, kind) => {
    const key = `${kind}:${label$1}`;
    let rendered = labelCache.get(key);
    if (rendered == null) {
      rendered = renderTerminalTerm({
        type: "label",
        label: label$1,
        kind
      }, options.theme, options.colors, undefined, kind === "choices" ? choicesAmbient : undefined);
      labelCache.set(key, rendered);
    }
    return rendered;
  };
  const punctuationCache = /* @__PURE__ */ new Map;
  const punctuation = (punctuation$1, kind) => {
    const key = `${kind}:${punctuation$1}`;
    let rendered = punctuationCache.get(key);
    if (rendered == null) {
      rendered = renderTerminalTerm({
        type: "syntaxPunctuation",
        punctuation: punctuation$1,
        kind
      }, options.theme, options.colors, undefined, kind.startsWith("default") ? defaultAmbient : kind.startsWith("choices") ? choicesAmbient : undefined);
      punctuationCache.set(key, rendered);
    }
    return rendered;
  };
  const usageLabel = page.usage != null && options.showUsage !== false ? spaceAfterLabel(label("Usage:", "usage")) : "";
  const usageLabelWidth = measureText(usageLabel).lastLineWidth;
  const defaultStyle = styleCode(options.theme?.annotationStyles?.default ?? { dim: true });
  const choicesStyle = styleCode(options.theme?.annotationStyles?.choices ?? { dim: true });
  validateProgramName(programName);
  const termIndent = options.termIndent ?? 2;
  const showUsage = options.showUsage ?? true;
  if (options.maxWidth != null && (!Number.isFinite(options.maxWidth) || !Number.isInteger(options.maxWidth)))
    throw new TypeError(`maxWidth must be a finite integer, got ${options.maxWidth}.`);
  const filteredSections = page.sections.map((s) => ({
    ...s,
    entries: s.entries.filter((e) => {
      const rendered = formatUsageTerm(e.term, { context: "doc" });
      return rendered.trim() !== "";
    })
  }));
  page = {
    ...page,
    sections: filteredSections
  };
  if (typeof options.showChoices === "object" && options.showChoices.maxItems != null) {
    const maxItems = options.showChoices.maxItems;
    if (maxItems < 1)
      throw new RangeError(`showChoices.maxItems must be at least 1, but got ${maxItems}.`);
  }
  const hasContent = (msg) => Array.isArray(msg) && msg.length > 0;
  const needsDescriptionColumn = (entry) => hasContent(entry.description) || (options.showDefault === true || typeof options.showDefault === "object") && hasContent(entry.default) || (options.showChoices === true || typeof options.showChoices === "object") && hasContent(entry.choices);
  const annotations = /* @__PURE__ */ new Map;
  const annotation = (kind) => {
    const cached = annotations.get(kind);
    if (cached != null)
      return cached;
    const config = kind === "default" ? options.showDefault : options.showChoices;
    const prefix = punctuation(typeof config === "object" ? config.prefix ?? (kind === "default" ? " [" : " (") : kind === "default" ? " [" : " (", kind === "default" ? "defaultPrefix" : "choicesPrefix");
    const suffix = punctuation(typeof config === "object" ? config.suffix ?? (kind === "default" ? "]" : ")") : kind === "default" ? "]" : ")", kind === "default" ? "defaultSuffix" : "choicesSuffix");
    const choicesLabel = kind === "choices" ? label(typeof options.showChoices === "object" ? options.showChoices.label ?? "choices: " : "choices: ", "choices") : "";
    const layout = measureAnnotation(prefix + choicesLabel, suffix);
    annotations.set(kind, layout);
    return layout;
  };
  const automaticTermWidth = () => {
    let widest;
    for (const section of page.sections)
      for (const entry of section.entries) {
        if (!needsDescriptionColumn(entry))
          continue;
        const rendered = formatUsageTerm(entry.term, {
          colors: options.colors,
          theme: options.theme,
          optionsSeparator: ", ",
          context: "doc"
        });
        const width = measureText(rendered).maxLineWidth;
        widest = widest == null ? width : Math.max(widest, width);
      }
    return widest;
  };
  const termWidth = options.termWidth === "auto" ? automaticTermWidth() ?? 26 : options.termWidth ?? 26;
  const hasEntries = page.sections.some((s) => s.entries.length > 0);
  const needsDescColumn = hasEntries && page.sections.some((s) => s.entries.some(needsDescriptionColumn));
  let effectiveTermWidth;
  if (options.maxWidth == null)
    effectiveTermWidth = termWidth;
  else {
    const availableForColumns = options.maxWidth - termIndent - 2;
    const evenlySplitTermWidth = Math.max(1, Math.floor(availableForColumns / 2));
    effectiveTermWidth = options.termWidth === "auto" && needsDescColumn ? Math.min(termWidth, evenlySplitTermWidth) : availableForColumns >= termWidth + 1 ? termWidth : evenlySplitTermWidth;
  }
  if (options.maxWidth != null) {
    let minDescWidth = 1;
    if (needsDescColumn)
      for (const kind of ["default", "choices"]) {
        const enabled = kind === "default" ? options.showDefault : options.showChoices;
        if (enabled && page.sections.some((section) => section.entries.some((entry) => hasContent(entry[kind]))))
          minDescWidth = Math.max(minDescWidth, annotation(kind).minWidth);
      }
    const splitEntryMin = termIndent + 2 + Math.max(2, 2 * minDescWidth - 1);
    const fixedEntryMin = termIndent + 2 + termWidth + minDescWidth;
    const entryMin = needsDescColumn ? Math.min(splitEntryMin, fixedEntryMin) : hasEntries ? termIndent + 1 : 1;
    const usageMin = page.usage != null && showUsage ? minimumUsageWidth(programName, page.usage, usageLabel, options.theme) : 1;
    let sectionMin = 1;
    for (const kind of [
      "examples",
      "author",
      "bugs"
    ]) {
      if (!hasContent(page[kind]))
        continue;
      const title = kind === "examples" ? "Examples:" : kind === "author" ? "Author:" : "Bugs:";
      sectionMin = Math.max(sectionMin, 3, measureText(label(title, kind)).maxLineWidth);
    }
    const minWidth = Math.max(entryMin, usageMin, sectionMin);
    if (options.maxWidth < minWidth) {
      if (!hasAutomaticWidth(options))
        throw new RangeError(`maxWidth must be at least ${minWidth}, got ${options.maxWidth}.`);
      options = {
        ...options,
        maxWidth: undefined
      };
      effectiveTermWidth = termWidth;
    }
    if (options.maxWidth != null && needsDescColumn && minDescWidth > 1) {
      const avail = options.maxWidth - termIndent - 2;
      const descW = avail - effectiveTermWidth;
      if (descW < minDescWidth) {
        const needed = termIndent + effectiveTermWidth + 2 + minDescWidth;
        if (!hasAutomaticWidth(options))
          throw new RangeError(`maxWidth must be at least ${needed}, got ${options.maxWidth}.`);
        options = {
          ...options,
          maxWidth: undefined
        };
        effectiveTermWidth = termWidth;
      }
    }
  }
  reportAutomaticWidth(options, options.maxWidth);
  let output = "";
  if (hasContent(page.brief)) {
    output += formatMessage(page.brief, {
      colors: options.colors,
      maxWidth: options.maxWidth,
      quotes: !options.colors
    });
    output += `
`;
  }
  if (page.usage != null && showUsage) {
    output += usageLabel;
    output += indentLines(formatUsage(programName, page.usage, {
      colors: options.colors,
      theme: options.theme,
      maxWidth: options.maxWidth == null ? undefined : options.maxWidth - usageLabelWidth,
      expandCommands: true
    }), usageLabelWidth);
    output += `
`;
  }
  if (hasContent(page.description)) {
    output += `
`;
    output += formatMessage(page.description, {
      colors: options.colors,
      maxWidth: options.maxWidth,
      quotes: !options.colors
    });
    output += `
`;
  }
  const comparator = options.sectionOrder ?? defaultSectionOrder;
  const sections = page.sections.map((s, i) => ({
    section: s,
    index: i
  })).toSorted((a, b) => {
    const cmp = comparator(a.section, b.section);
    if (cmp !== 0)
      return cmp;
    return a.index - b.index;
  }).map(({ section }) => section);
  for (const section of sections) {
    if (section.entries.length < 1)
      continue;
    output += `
`;
    if (section.title != null) {
      validateLabel(section.title);
      const sectionLabel = label(`${section.title}:`, "section") + `
`;
      output += sectionLabel;
    }
    for (const entry of section.entries) {
      const termOptions = {
        colors: options.colors,
        theme: options.theme,
        optionsSeparator: ", ",
        context: "doc"
      };
      const unwrappedTerm = formatUsageTerm(entry.term, termOptions);
      const multilineReplacement = measureText(unwrappedTerm).lineCount > 1;
      const term = options.maxWidth == null ? unwrappedTerm : formatUsageTerm(entry.term, {
        ...termOptions,
        maxWidth: options.maxWidth - termIndent
      });
      const descColumnWidth = options.maxWidth == null ? undefined : options.maxWidth - termIndent - effectiveTermWidth - 2;
      const termVisibleWidth = measureText(term).lastLineWidth;
      const extraTermOffset = descColumnWidth != null ? Math.max(0, termVisibleWidth - effectiveTermWidth) : 0;
      const descFormatOptions = {
        colors: options.colors,
        quotes: !options.colors,
        maxWidth: descColumnWidth,
        initialWidth: extraTermOffset > 0 ? extraTermOffset : undefined
      };
      let description = entry.description == null ? "" : formatMessage(entry.description, descFormatOptions);
      let cursor = placeText(description, {
        line: "",
        column: extraTermOffset
      }).cursor;
      const appendAnnotation = (content, layout, style, ambient, quotes) => {
        let prefixText = layout.prefix;
        let prefix = placeText(prefixText, cursor, descColumnWidth, 1);
        if (prefix.text !== layout.prefix) {
          description += `
`;
          prefixText = trimLeadingSpace(layout.prefix);
          prefix = placeText(prefixText, {
            line: "",
            column: 0
          });
        }
        const rendered = formatMessage(content, {
          colors: options.colors ? { resetSuffix: style } : false,
          quotes,
          maxWidth: descColumnWidth == null ? undefined : descColumnWidth - layout.suffixMetrics.firstLineWidth,
          initialWidth: descColumnWidth != null || layout.prefixMetrics.lineCount > 1 ? prefix.cursor.column : undefined
        }, ambient);
        const suffix = placeText(layout.suffix, placeText(rendered, prefix.cursor).cursor, descColumnWidth);
        const annotationText = `${prefixText}${rendered}${opaqueFormatter && options.colors ? style : ""}${suffix.text}`;
        description += options.colors ? `${style}${annotationText}${style ? "\x1B[0m" : ""}` : annotationText;
        cursor = suffix.cursor;
      };
      if (options.showDefault && hasContent(entry.default))
        appendAnnotation(entry.default, annotation("default"), defaultStyle, defaultAmbient, !options.colors);
      if (options.showChoices && hasContent(entry.choices)) {
        const maxItems = typeof options.showChoices === "object" ? options.showChoices.maxItems ?? 8 : 8;
        const terms = Array.isArray(entry.choices) ? entry.choices : [];
        let truncatedTerms = terms;
        let truncated = false;
        if (maxItems < Infinity) {
          let valueCount = 0;
          let cutIndex = terms.length;
          for (let i = 0;i < terms.length; i++)
            if (terms[i].type === "value") {
              valueCount++;
              if (valueCount > maxItems) {
                cutIndex = i > 0 && terms[i - 1].type === "text" ? i - 1 : i;
                truncated = true;
                break;
              }
            }
          if (truncated)
            truncatedTerms = [...terms.slice(0, cutIndex), text(", ...")];
        }
        appendAnnotation(truncatedTerms, annotation("choices"), choicesStyle, choicesAmbient, false);
      }
      const paddedTerm = ansiAwareRightPad(term, effectiveTermWidth);
      output += `${" ".repeat(termIndent)}${multilineReplacement ? indentLines(paddedTerm, termIndent) : paddedTerm}${description === "" ? "" : `  ${indentLines(description, termIndent + effectiveTermWidth + 2)}`}
`;
    }
  }
  if (hasContent(page.examples)) {
    output += `
`;
    const examplesLabel = label("Examples:", "examples") + `
`;
    output += examplesLabel;
    const examplesContent = formatMessage(page.examples, {
      colors: options.colors,
      maxWidth: options.maxWidth == null ? undefined : options.maxWidth - 2,
      quotes: !options.colors
    });
    output += "  " + indentLines(examplesContent, 2);
    output += `
`;
  }
  if (hasContent(page.author)) {
    output += `
`;
    const authorLabel = label("Author:", "author") + `
`;
    output += authorLabel;
    const authorContent = formatMessage(page.author, {
      colors: options.colors,
      maxWidth: options.maxWidth == null ? undefined : options.maxWidth - 2,
      quotes: !options.colors
    });
    output += "  " + indentLines(authorContent, 2);
    output += `
`;
  }
  if (hasContent(page.bugs)) {
    output += `
`;
    const bugsLabel = label("Bugs:", "bugs") + `
`;
    output += bugsLabel;
    const bugsContent = formatMessage(page.bugs, {
      colors: options.colors,
      maxWidth: options.maxWidth == null ? undefined : options.maxWidth - 2,
      quotes: !options.colors
    });
    output += "  " + indentLines(bugsContent, 2);
    output += `
`;
  }
  if (hasContent(page.footer)) {
    output += `
`;
    output += formatMessage(page.footer, {
      colors: options.colors,
      maxWidth: options.maxWidth,
      quotes: !options.colors
    });
  }
  return output;
}
function indentLines(text$1, indent) {
  return text$1.split(`
`).join(`
` + " ".repeat(indent));
}
function ansiAwareRightPad(text$1, length, char = " ") {
  const visibleWidth = measureText(text$1).lastLineWidth;
  if (visibleWidth >= length)
    return text$1;
  return text$1 + char.repeat(length - visibleWidth);
}

// node_modules/@optique/core/dist/internal/mode-dispatch.js
function dispatchByMode(mode, syncFn, asyncFn) {
  if (mode === "async")
    return asyncFn();
  return syncFn();
}
function wrapForMode(mode, value) {
  if (mode === "async")
    return Promise.resolve(value);
  if (value instanceof Promise)
    throw new TypeError("Synchronous mode cannot wrap Promise value.");
  return value;
}
function mapModeValue(mode, value, mapFn) {
  if (mode === "async")
    return Promise.resolve(value).then(mapFn);
  if (value instanceof Promise)
    throw new TypeError("Synchronous mode cannot map Promise value.");
  return mapFn(value);
}
function dispatchIterableByMode(mode, syncFn, asyncFn) {
  if (mode === "async")
    return asyncFn();
  return syncFn();
}

// node_modules/@optique/core/dist/internal/dependency.js
var dependencySourceMarker = Symbol.for("@optique/core/dependency/dependencySourceMarker");
var dependencySourceId = Symbol.for("@optique/core/dependency/dependencySourceId");
var derivedValueParserMarker = Symbol.for("@optique/core/dependency/derivedValueParserMarker");
var dependencyId = Symbol.for("@optique/core/dependency/dependencyId");
var dependencyIds = Symbol.for("@optique/core/dependency/dependencyIds");
var defaultValues = Symbol.for("@optique/core/dependency/defaultValues");
var singleDefaultValue = Symbol.for("@optique/core/dependency/singleDefaultValue");
var defaultDependencyValueSnapshot = Symbol.for("@optique/core/dependency/defaultDependencyValueSnapshot");
var parseWithDependency = Symbol.for("@optique/core/dependency/parseWithDependency");
var suggestWithDependency = Symbol.for("@optique/core/dependency/suggestWithDependency");
function isDependencySource(parser) {
  return dependencySourceMarker in parser && parser[dependencySourceMarker] === true;
}
function isDerivedValueParser(parser) {
  return derivedValueParserMarker in parser && parser[derivedValueParserMarker] === true;
}
function getSnapshottedDefaultDependencyValues(result) {
  return result[defaultDependencyValueSnapshot];
}
var deferredParseMarker = Symbol.for("@optique/core/dependency/deferredParseMarker");
function isDeferredParseState(value) {
  return typeof value === "object" && value !== null && deferredParseMarker in value && value[deferredParseMarker] === true;
}
function getDependencyIds(parser) {
  if (dependencyIds in parser)
    return parser[dependencyIds];
  return [parser[dependencyId]];
}
function getDefaultValuesFunction(parser) {
  if (Object.hasOwn(parser, defaultValues))
    return parser[defaultValues];
  return;
}
var dependencySourceStateMarker = Symbol.for("@optique/core/dependency/dependencySourceStateMarker");
function isDependencySourceState(value) {
  return typeof value === "object" && value !== null && dependencySourceStateMarker in value && value[dependencySourceStateMarker] === true;
}
function createDependencySourceState(result, depId) {
  return {
    [dependencySourceStateMarker]: true,
    [dependencyId]: depId,
    result
  };
}
var pendingDependencySourceStateMarker = Symbol.for("@optique/core/dependency/pendingDependencySourceStateMarker");
function isPendingDependencySourceState(value) {
  return typeof value === "object" && value !== null && pendingDependencySourceStateMarker in value && value[pendingDependencySourceStateMarker] === true;
}
var wrappedDependencySourceMarker = Symbol.for("@optique/core/dependency/wrappedDependencySourceMarker");
var transformsDependencyValueMarker = Symbol.for("@optique/core/dependency/transformsDependencyValueMarker");
function isWrappedDependencySource(parser) {
  return typeof parser === "object" && parser !== null && wrappedDependencySourceMarker in parser;
}

// node_modules/@optique/core/dist/dependency-runtime.js
var derivedRawInputKey = Symbol("@optique/core/dependency-runtime/derivedRawInput");
var derivedRawInputs = /* @__PURE__ */ new WeakMap;
function recordDerivedRawInput(state, rawInput) {
  derivedRawInputs.set(state, rawInput);
}
var symbolIds = /* @__PURE__ */ new WeakMap;
var symbolCounter = 0;
function stableSymbolKey(sym) {
  const registeredKey = Symbol.keyFor(sym);
  if (registeredKey !== undefined)
    return `reg:${registeredKey}`;
  let id = symbolIds.get(sym);
  if (id === undefined) {
    id = `sym:${symbolCounter++}`;
    symbolIds.set(sym, id);
  }
  return id;
}
var DependencyRuntimeContextImpl = class {
  registry;
  #replayCache = /* @__PURE__ */ new Map;
  #failedSources = /* @__PURE__ */ new Set;
  #sourceMetadata = /* @__PURE__ */ new Map;
  #sourceFailures = /* @__PURE__ */ new Map;
  constructor(registry) {
    if (registry instanceof FailedAwareRegistry) {
      this.registry = registry.rebindFailedSources(this.#failedSources);
      return;
    }
    this.registry = new FailedAwareRegistry(registry, this.#failedSources);
  }
  registerSource(sourceId, value) {
    if (this.registry.isPreserved(sourceId))
      return;
    this.registry.set(sourceId, value);
    this.#sourceFailures.delete(sourceId);
  }
  hasSource(sourceId) {
    return this.registry.has(sourceId);
  }
  getSource(sourceId) {
    return this.registry.get(sourceId);
  }
  resolveDependencies(request) {
    return resolveRequest(this, request);
  }
  getReplayResult(key) {
    return this.#replayCache.get(serializeReplayKey(key));
  }
  setReplayResult(key, result) {
    this.#replayCache.set(serializeReplayKey(key), result);
  }
  markSourceFailed(sourceId) {
    if (this.registry.isPreserved(sourceId))
      return;
    this.#failedSources.add(sourceId);
    const lineage = this.#getSourceLineage(sourceId, /* @__PURE__ */ new Set);
    const failure = {
      chain: lineage.labels,
      participants: lineage.sourceIds,
      diagnosticChain: lineage.labels
    };
    this.#sourceFailures.set(sourceId, failure);
    this.#promoteDiagnosticChain(failure);
  }
  registerSourceMetadata(sourceId, label, dependencyIds = []) {
    this.#sourceMetadata.set(sourceId, {
      label,
      dependencyIds
    });
  }
  propagateSourceFailure(dependencyIds, label, sourceId) {
    const upstream = dependencyIds.filter((id) => this.isSourceFailed(id)).map((id) => this.#sourceFailures.get(id) ?? {
      chain: [this.#getSourceLabel(id)],
      participants: [id],
      diagnosticChain: [this.#getSourceLabel(id)]
    }).sort((left, right) => right.chain.length - left.chain.length)[0];
    if (upstream == null)
      return false;
    const chain = upstream.chain.at(-1) === label ? upstream.chain : [...upstream.chain, label];
    const participants = sourceId == null || upstream.participants.includes(sourceId) ? upstream.participants : [...upstream.participants, sourceId];
    const failure = {
      chain,
      participants,
      diagnosticChain: chain
    };
    if (sourceId != null && !this.registry.isPreserved(sourceId)) {
      this.#failedSources.add(sourceId);
      this.#sourceFailures.set(sourceId, failure);
    }
    this.#promoteDiagnosticChain(failure);
    return true;
  }
  getSourceFailureChain(sourceId) {
    if (!this.#failedSources.has(sourceId))
      return;
    return this.#sourceFailures.get(sourceId)?.diagnosticChain;
  }
  isSourceFailed(sourceId) {
    return this.#failedSources.has(sourceId);
  }
  getSuggestionDependencies(request) {
    return resolveRequest(this, request);
  }
  #getSourceLabel(sourceId) {
    return this.#sourceMetadata.get(sourceId)?.label ?? sourceId.description ?? String(sourceId);
  }
  #getSourceLineage(sourceId, visited) {
    if (visited.has(sourceId))
      return {
        labels: [this.#getSourceLabel(sourceId)],
        sourceIds: [sourceId]
      };
    visited.add(sourceId);
    const metadata = this.#sourceMetadata.get(sourceId);
    const upstream = (metadata?.dependencyIds ?? []).map((id) => this.#getSourceLineage(id, new Set(visited))).sort((left, right) => right.labels.length - left.labels.length)[0];
    return upstream == null ? {
      labels: [this.#getSourceLabel(sourceId)],
      sourceIds: [sourceId]
    } : {
      labels: [...upstream.labels, this.#getSourceLabel(sourceId)],
      sourceIds: [...upstream.sourceIds, sourceId]
    };
  }
  #promoteDiagnosticChain(failure) {
    for (const sourceId of failure.participants) {
      const current = this.#sourceFailures.get(sourceId);
      if (current != null && current.diagnosticChain.length < failure.diagnosticChain.length)
        current.diagnosticChain = failure.diagnosticChain;
    }
  }
};
var FailedAwareRegistry = class FailedAwareRegistry {
  #inner;
  #failedSources;
  #preserved = /* @__PURE__ */ new Map;
  constructor(inner, failedSources) {
    this.#inner = inner;
    this.#failedSources = failedSources;
  }
  set(id, value) {
    if (this.isPreserved(id))
      return;
    this.#inner.set(id, value);
    this.#failedSources.delete(id);
  }
  get(id) {
    if (this.#failedSources.has(id))
      return;
    return this.#inner.get(id);
  }
  has(id) {
    if (this.#failedSources.has(id))
      return false;
    return this.#inner.has(id);
  }
  preserve(id, paths) {
    this.#preserved.set(id, paths);
  }
  allowUncollectedOccurrence(id, path) {
    const paths = this.#preserved.get(id);
    if (paths != null && !paths.some((covered) => covered.length === path.length && covered.every((segment, index) => segment === path[index])))
      this.#preserved.delete(id);
  }
  isPreserved(id) {
    return this.#preserved.has(id);
  }
  copyFailedSources(target) {
    for (const sourceId of this.#failedSources)
      target.add(sourceId);
  }
  rebindFailedSources(target) {
    this.copyFailedSources(target);
    const rebound = new FailedAwareRegistry(this.#inner, target);
    for (const [id, paths] of this.#preserved)
      rebound.preserve(id, paths);
    return rebound;
  }
  clone() {
    const failedSources = new Set(this.#failedSources);
    const innerClone = this.#inner.clone();
    return innerClone instanceof FailedAwareRegistry ? innerClone.rebindFailedSources(failedSources) : new FailedAwareRegistry(innerClone, failedSources);
  }
};
var sourceScopes = /* @__PURE__ */ new WeakMap;
function recordSourceCollection(nodes, runtime) {
  const sources = nodes.flatMap((node) => {
    const source = node.parser.dependencyMetadata?.source;
    return source == null ? [] : [{
      sourceId: source.sourceId,
      path: node.path
    }];
  });
  recordSourceScope(runtime, /* @__PURE__ */ new Set, sources);
}
function releaseUncollectedSourceValues(nodes, runtime) {
  if (!(runtime instanceof DependencyRuntimeContextImpl))
    return;
  for (const node of nodes) {
    const source = node.parser.dependencyMetadata?.source;
    if (source != null)
      runtime.registry.allowUncollectedOccurrence(source.sourceId, node.path);
  }
}
function recordSourceScope(runtime, sourceIds, collectedSources) {
  if (collectedSources.length === 0)
    return;
  const values = /* @__PURE__ */ new Map;
  const ids = new Set([...sourceIds, ...collectedSources.map((source) => source.sourceId)]);
  for (const id of ids)
    if (runtime.hasSource(id))
      values.set(id, {
        success: true,
        value: runtime.getSource(id)
      });
    else if (runtime.isSourceFailed(id))
      values.set(id, { success: false });
  let scopes = sourceScopes.get(runtime);
  if (scopes == null) {
    scopes = [];
    sourceScopes.set(runtime, scopes);
  }
  scopes.push({
    values,
    collectedSources
  });
}
function resolveRequest(ctx, request) {
  const values = [];
  const usedDefaults = [];
  let resolvedCount = 0;
  let defaultedCount = 0;
  for (let i = 0;i < request.dependencyIds.length; i++) {
    const id = request.dependencyIds[i];
    if (ctx.isSourceFailed(id)) {
      values.push(undefined);
      usedDefaults.push(false);
    } else if (ctx.hasSource(id)) {
      values.push(ctx.getSource(id));
      usedDefaults.push(false);
      resolvedCount++;
    } else if (request.defaultValues != null && i < request.defaultValues.length) {
      values.push(request.defaultValues[i]);
      usedDefaults.push(true);
      defaultedCount++;
    } else {
      values.push(undefined);
      usedDefaults.push(false);
    }
  }
  const total = request.dependencyIds.length;
  const foundOrDefaulted = resolvedCount + defaultedCount;
  let kind;
  if (foundOrDefaulted === total)
    kind = "resolved";
  else if (resolvedCount === 0 && defaultedCount === 0)
    kind = "missing";
  else
    kind = "partial";
  return {
    kind,
    values,
    usedDefaults
  };
}
function lengthPrefix(s) {
  return `${s.length}:${s}`;
}
function serializePathSegment(p) {
  if (typeof p === "string")
    return lengthPrefix(`s${p}`);
  if (typeof p === "number")
    return lengthPrefix(`n${p}`);
  return lengthPrefix(`y${stableSymbolKey(p)}`);
}
function serializeReplayKey(key) {
  const pathStr = key.path.map(serializePathSegment).join("");
  return `${pathStr}\x01${lengthPrefix(key.rawInput)}\x01${key.dependencyFingerprint}\x01${key.parserFingerprint}`;
}
var SimpleRegistry = class SimpleRegistry {
  #map = /* @__PURE__ */ new Map;
  set(id, value) {
    this.#map.set(id, value);
  }
  get(id) {
    return this.#map.get(id);
  }
  has(id) {
    return this.#map.has(id);
  }
  clone() {
    const copy = new SimpleRegistry;
    for (const [k, v] of this.#map)
      copy.set(k, v);
    return copy;
  }
};
function createDependencyRuntimeContext(registry) {
  return new DependencyRuntimeContextImpl(registry ?? new SimpleRegistry);
}
function createDependencyFingerprint(values) {
  return values.map((v) => {
    const raw = fingerprintValue(v);
    return `${raw.length}:${raw}`;
  }).join("");
}
var objectIds = /* @__PURE__ */ new WeakMap;
var objectIdCounter = 0;
function fingerprintValue(v) {
  if (v === undefined)
    return "u:";
  if (v === null)
    return "n:";
  if (typeof v === "string")
    return `s:${v}`;
  if (typeof v === "number") {
    if (Object.is(v, -0))
      return "d:-0";
    return `d:${v}`;
  }
  if (typeof v === "boolean")
    return `b:${v}`;
  if (typeof v === "symbol")
    return `y:${stableSymbolKey(v)}`;
  if (typeof v === "object" || typeof v === "function") {
    let id = objectIds.get(v);
    if (id === undefined) {
      id = objectIdCounter++;
      objectIds.set(v, id);
    }
    return `o:${id}`;
  }
  return `?:${String(v)}`;
}
var parserIds = /* @__PURE__ */ new WeakMap;
var parserIdCounter = 0;
function getParserFingerprint(replayParse) {
  let id = parserIds.get(replayParse);
  if (id === undefined) {
    id = parserIdCounter++;
    parserIds.set(replayParse, id);
  }
  return `p:${id}`;
}
function createReplayKey(path, rawInput, dependencyValues, replayParse) {
  return {
    path,
    rawInput,
    dependencyFingerprint: createDependencyFingerprint(dependencyValues),
    parserFingerprint: replayParse != null ? getParserFingerprint(replayParse) : ""
  };
}
function collectExplicitSourceValues(nodes, runtime) {
  releaseUncollectedSourceValues(nodes, runtime);
  registerRuntimeSourceMetadata(nodes, runtime);
  for (const node of nodes) {
    const meta = node.parser.dependencyMetadata;
    if (meta?.source == null)
      continue;
    if (meta.source.extractSourceValue == null)
      continue;
    if (meta.derived != null && getNodeRawInput(node) != null)
      continue;
    const result = meta.source.extractSourceValue(node.state);
    if (isPromiseLike(result))
      throw new TypeError(`collectExplicitSourceValues() received an async extractSourceValue() result for ${String(meta.source.sourceId)}. Use collectExplicitSourceValuesAsync() instead.`);
    registerExplicitSourceValue(meta.source.sourceId, result, runtime);
  }
  resolveDerivedSourceValues(nodes, runtime);
  recordSourceCollection(nodes, runtime);
}
function registerExplicitSourceValue(sourceId, result, runtime) {
  if (result == null)
    return;
  if (result.success)
    runtime.registerSource(sourceId, result.value);
  else
    runtime.markSourceFailed(sourceId);
}
function isPromiseLike(value) {
  return value != null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function";
}
async function collectExplicitSourceValuesAsync(nodes, runtime) {
  releaseUncollectedSourceValues(nodes, runtime);
  registerRuntimeSourceMetadata(nodes, runtime);
  for (const node of nodes) {
    const meta = node.parser.dependencyMetadata;
    if (meta?.source == null)
      continue;
    if (meta.source.extractSourceValue == null)
      continue;
    if (meta.derived != null && getNodeRawInput(node) != null)
      continue;
    const result = await meta.source.extractSourceValue(node.state);
    registerExplicitSourceValue(meta.source.sourceId, result, runtime);
  }
  await resolveDerivedSourceValuesAsync(nodes, runtime);
  recordSourceCollection(nodes, runtime);
}
function orderDependencyNodes(nodes) {
  return drainDependencyGraph(buildDependencyGraph(nodes));
}
function buildDependencyGraph(nodes) {
  const providers = /* @__PURE__ */ new Map;
  const addProvider = (sourceId, node) => {
    const existing = providers.get(sourceId);
    if (existing == null)
      providers.set(sourceId, [node]);
    else
      existing.push(node);
  };
  for (const node of nodes) {
    const source = node.parser.dependencyMetadata?.source;
    if (source != null)
      addProvider(source.sourceId, node);
    for (const sourceId of node.providesSourceIds ?? [])
      addProvider(sourceId, node);
  }
  const outgoing = /* @__PURE__ */ new Map;
  const indegree = /* @__PURE__ */ new Map;
  for (const node of nodes)
    indegree.set(node, 0);
  const addEdge = (provider, consumer, advisory) => {
    const edges = outgoing.get(provider) ?? /* @__PURE__ */ new Map;
    const existing = edges.get(consumer);
    if (existing != null) {
      if (existing && !advisory)
        edges.set(consumer, false);
      return;
    }
    edges.set(consumer, advisory);
    outgoing.set(provider, edges);
    indegree.set(consumer, (indegree.get(consumer) ?? 0) + 1);
  };
  for (const node of nodes) {
    const derived = node.parser.dependencyMetadata?.derived;
    if (derived != null)
      for (const dependencySourceId of derived.dependencyIds)
        for (const provider of providers.get(dependencySourceId) ?? [])
          addEdge(provider, node, false);
    const completion = node.parser.dependencyMetadata?.completion;
    if (completion != null && !hasInactiveCompletion(node)) {
      const ownSourceId = node.parser.dependencyMetadata?.source?.sourceId;
      for (const dependencySourceId of completion.dependencyIds) {
        if (dependencySourceId === ownSourceId)
          continue;
        for (const provider of providers.get(dependencySourceId) ?? [])
          if (provider !== node)
            addEdge(provider, node, false);
      }
    }
    if (node.requiresSourceId != null) {
      for (const provider of providers.get(node.requiresSourceId) ?? [])
        if (provider !== node)
          addEdge(provider, node, false);
    }
    const barrierDeps = node.barrierCompletionDependencies;
    if (barrierDeps != null) {
      const advisory = node.barrierResolutionState !== "resolved";
      for (const dependencySourceId of barrierDeps.orderingDependencyIds)
        for (const provider of providers.get(dependencySourceId) ?? [])
          if (provider !== node)
            addEdge(provider, node, advisory);
    }
  }
  const declarationOrder = new Map(nodes.map((node, index) => [node, index]));
  return {
    nodes,
    outgoing,
    indegree,
    declarationOrder
  };
}
function drainDependencyGraph(graph) {
  const { nodes, outgoing, declarationOrder } = graph;
  const indegree = new Map(graph.indegree);
  const ready = nodes.filter((node) => indegree.get(node) === 0);
  const ordered = [];
  while (true) {
    while (ready.length > 0) {
      ready.sort((left, right) => declarationOrder.get(left) - declarationOrder.get(right));
      const node = ready.shift();
      ordered.push(node);
      for (const consumer of outgoing.get(node)?.keys() ?? []) {
        const next = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, next);
        if (next === 0)
          ready.push(consumer);
      }
    }
    if (ordered.length === nodes.length)
      return ordered;
    const residual = nodes.filter((node) => (indegree.get(node) ?? 0) > 0);
    const sccOf = findStronglyConnected(residual, outgoing);
    let relaxed = false;
    for (const provider of residual) {
      const edges = outgoing.get(provider);
      if (edges == null)
        continue;
      for (const [consumer, advisory] of edges) {
        if (!advisory)
          continue;
        const providerScc = sccOf.get(provider);
        if (providerScc == null || providerScc !== sccOf.get(consumer))
          continue;
        edges.delete(consumer);
        const next = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, next);
        if (next === 0)
          ready.push(consumer);
        relaxed = true;
      }
    }
    if (!relaxed) {
      const labels = residual.map(formatDependencyNodeLabel).join(" -> ");
      throw new TypeError(`Circular dependency detected among dependency sources: ${labels}.`);
    }
  }
}
function findStronglyConnected(subset, outgoing) {
  const inSubset = new Set(subset);
  const index = /* @__PURE__ */ new Map;
  const lowLink = /* @__PURE__ */ new Map;
  const onStack = /* @__PURE__ */ new Set;
  const stack = [];
  const sccOf = /* @__PURE__ */ new Map;
  let nextIndex = 0;
  let nextScc = 0;
  const strongConnect = (root) => {
    const frames = [{
      node: root,
      children: [...outgoing.get(root)?.keys() ?? []].filter((child) => inSubset.has(child)),
      i: 0
    }];
    index.set(root, nextIndex);
    lowLink.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.i < frame.children.length) {
        const child = frame.children[frame.i++];
        if (!index.has(child)) {
          index.set(child, nextIndex);
          lowLink.set(child, nextIndex);
          nextIndex++;
          stack.push(child);
          onStack.add(child);
          frames.push({
            node: child,
            children: [...outgoing.get(child)?.keys() ?? []].filter((c) => inSubset.has(c)),
            i: 0
          });
        } else if (onStack.has(child))
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node), index.get(child)));
        continue;
      }
      frames.pop();
      const node = frame.node;
      if (lowLink.get(node) === index.get(node)) {
        const members = [];
        while (true) {
          const member = stack.pop();
          onStack.delete(member);
          members.push(member);
          if (member === node)
            break;
        }
        if (members.length > 1) {
          for (const member of members)
            sccOf.set(member, nextScc);
          nextScc++;
        }
      }
      const parent = frames[frames.length - 1];
      if (parent != null)
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node), lowLink.get(node)));
    }
  };
  for (const node of subset)
    if (!index.has(node))
      strongConnect(node);
  return sccOf;
}
function resolveDerivedSourceValues(nodes, runtime, options) {
  resolveDerivedSourceValuesInOrder(orderDependencyNodes(nodes), nodes, runtime, (node, rawInput) => replayDerivedParser(node, rawInput, runtime), options);
}
async function resolveDerivedSourceValuesAsync(nodes, runtime, options) {
  await resolveDerivedSourceValuesInOrderAsync(orderDependencyNodes(nodes), nodes, runtime, options);
}
function resolveDerivedSourceValuesInOrder(ordered, allNodes, runtime, replay, options) {
  const providers = collectSourceProviders(allNodes);
  const settled = /* @__PURE__ */ new Set;
  for (const node of ordered) {
    const metadata = node.parser.dependencyMetadata;
    const rawInput = getNodeRawInput(node);
    if (metadata?.derived == null)
      continue;
    const label = formatDependencyNodeMetavar(node);
    if (runtime.propagateSourceFailure(metadata.derived.dependencyIds, label, metadata.source?.sourceId)) {
      if (metadata.source != null)
        settled.add(node);
      continue;
    }
    if (metadata.source == null || rawInput == null)
      continue;
    if (hasPendingProvider(node, providers, settled, runtime, options))
      continue;
    settleDerivedSource(node, rawInput, runtime, replay);
    settled.add(node);
  }
}
async function resolveDerivedSourceValuesInOrderAsync(ordered, allNodes, runtime, options) {
  const providers = collectSourceProviders(allNodes);
  const settled = /* @__PURE__ */ new Set;
  for (const node of ordered) {
    const metadata = node.parser.dependencyMetadata;
    const rawInput = getNodeRawInput(node);
    if (metadata?.derived == null)
      continue;
    const label = formatDependencyNodeMetavar(node);
    if (runtime.propagateSourceFailure(metadata.derived.dependencyIds, label, metadata.source?.sourceId)) {
      if (metadata.source != null)
        settled.add(node);
      continue;
    }
    if (metadata.source == null || rawInput == null)
      continue;
    if (hasPendingProvider(node, providers, settled, runtime, options))
      continue;
    const result = await replayDerivedParserAsync(node, rawInput, runtime);
    publishDerivedSourceResult(metadata.source.sourceId, result, runtime);
    settled.add(node);
  }
}
function settleDerivedSource(node, rawInput, runtime, replay) {
  const metadata = node.parser.dependencyMetadata;
  publishDerivedSourceResult(metadata.source.sourceId, replay(node, rawInput), runtime);
}
function publishDerivedSourceResult(sourceId, result, runtime) {
  if (result == null || result.success && result.deferred === true)
    return;
  if (!result.success)
    runtime.markSourceFailed(sourceId);
  else
    runtime.registerSource(sourceId, result.value);
}
function collectSourceProviders(nodes) {
  const providers = /* @__PURE__ */ new Map;
  for (const node of nodes) {
    const sourceId = node.parser.dependencyMetadata?.source?.sourceId;
    if (sourceId == null)
      continue;
    const existing = providers.get(sourceId);
    if (existing == null)
      providers.set(sourceId, [node]);
    else
      existing.push(node);
  }
  return providers;
}
function hasPendingProvider(node, providers, settled, runtime, options) {
  const derived = node.parser.dependencyMetadata.derived;
  return derived.dependencyIds.some((sourceId) => (providers.get(sourceId) ?? []).some((provider) => {
    if (provider === node || runtime.hasSource(sourceId) || runtime.isSourceFailed(sourceId))
      return false;
    const metadata = provider.parser.dependencyMetadata;
    if (metadata?.derived != null && getNodeRawInput(provider) != null)
      return !settled.has(provider);
    return options?.effectfulProviders !== "inactive" && metadata?.source?.completeSource != null;
  }));
}
function getNodeRawInput(node) {
  return node.rawInput ?? extractRawInputFromState(node.state);
}
var inactiveCompletionCache = /* @__PURE__ */ new WeakMap;
function hasInactiveCompletion(node) {
  const cached = inactiveCompletionCache.get(node);
  if (cached != null)
    return cached;
  const inactive = computeInactiveCompletion(node);
  inactiveCompletionCache.set(node, inactive);
  return inactive;
}
function computeInactiveCompletion(node) {
  const metadata = node.parser.dependencyMetadata;
  if (metadata?.completion == null || metadata.source == null)
    return false;
  const extracted = metadata.source.extractSourceValue?.(node.state);
  if (isPromiseLike(extracted)) {
    Promise.resolve(extracted).catch(() => {});
    return false;
  }
  return extracted != null && extracted.success === true;
}
function registerRuntimeSourceMetadata(nodes, runtime) {
  for (const node of nodes) {
    const metadata = node.parser.dependencyMetadata;
    if (metadata?.source == null)
      continue;
    const completion = hasInactiveCompletion(node) ? undefined : metadata.completion;
    const dependencyIds = completion == null ? metadata.derived?.dependencyIds : [...metadata.derived?.dependencyIds ?? [], ...completion.dependencyIds.filter((id) => !(metadata.derived?.dependencyIds ?? []).includes(id))];
    runtime.registerSourceMetadata(metadata.source.sourceId, formatDependencyNodeMetavar(node), dependencyIds);
  }
}
function propagateRuntimeSourceFailures(nodes, runtime) {
  for (const node of orderDependencyNodes(nodes)) {
    const metadata = node.parser.dependencyMetadata;
    if (metadata == null)
      continue;
    const completion = hasInactiveCompletion(node) ? undefined : metadata.completion;
    if (metadata.derived == null && completion == null)
      continue;
    runtime.propagateSourceFailure([...metadata.derived?.dependencyIds ?? [], ...completion?.dependencyIds ?? []], formatDependencyNodeMetavar(node), metadata.source?.sourceId);
  }
}
function includeSourceFailureChain(error, sourceId, runtime) {
  const chain = runtime.getSourceFailureChain(sourceId);
  return chain == null || chain.length < 2 ? error : message`${error} Dependency chain: ${chain.join(" -> ")}.`;
}
function formatDependencyNodeMetavar(node) {
  return node.parser.dependencyMetadata?.derived?.metavar ?? node.parser.dependencyMetadata?.source?.metavar ?? (node.path.map(String).join(".") || "<root>");
}
function formatDependencyNodeLabel(node) {
  const metavar = node.parser.dependencyMetadata?.derived?.metavar ?? node.parser.dependencyMetadata?.source?.metavar;
  const path = node.path.map(String).join(".") || "<root>";
  return metavar == null ? path : `${metavar} (${path})`;
}
function replayDerivedParser(node, rawInput, runtime) {
  const meta = node.parser.dependencyMetadata;
  if (meta?.derived == null)
    return;
  let defaults = node.defaultDependencyValues;
  if (defaults == null && meta.derived.getDefaultDependencyValues != null)
    try {
      defaults = meta.derived.getDefaultDependencyValues();
    } catch {
      return;
    }
  const resolution = runtime.resolveDependencies({
    dependencyIds: meta.derived.dependencyIds,
    defaultValues: defaults
  });
  if (resolution.kind === "missing")
    return;
  if (resolution.kind === "partial")
    return;
  if (resolution.usedDefaults.every((usedDefault) => usedDefault)) {
    const preliminary = extractPreliminaryResultFromState(node.state);
    if (preliminary != null)
      return preliminary;
  }
  const key = createReplayKey(node.path, rawInput, resolution.values, meta.derived.replayParse);
  const cached = runtime.getReplayResult(key);
  if (cached != null)
    return cached;
  const result = meta.derived.replayParse(rawInput, resolution.values);
  if (isPromiseLike(result))
    throw new TypeError("replayDerivedParser() received an async replayParse() result. Use replayDerivedParserAsync() instead.");
  runtime.setReplayResult(key, result);
  return result;
}
async function replayDerivedParserAsync(node, rawInput, runtime) {
  const meta = node.parser.dependencyMetadata;
  if (meta?.derived == null)
    return;
  let defaults = node.defaultDependencyValues;
  if (defaults == null && meta.derived.getDefaultDependencyValues != null)
    try {
      defaults = meta.derived.getDefaultDependencyValues();
    } catch {
      return;
    }
  const resolution = runtime.resolveDependencies({
    dependencyIds: meta.derived.dependencyIds,
    defaultValues: defaults
  });
  if (resolution.kind === "missing")
    return;
  if (resolution.kind === "partial")
    return;
  if (resolution.usedDefaults.every((usedDefault) => usedDefault)) {
    const preliminary = extractPreliminaryResultFromState(node.state);
    if (preliminary != null)
      return preliminary;
  }
  const key = createReplayKey(node.path, rawInput, resolution.values, meta.derived.replayParse);
  const cached = runtime.getReplayResult(key);
  if (cached != null)
    return cached;
  const result = await meta.derived.replayParse(rawInput, resolution.values);
  runtime.setReplayResult(key, result);
  return result;
}
function extractRawInputFromState(state) {
  return extractRawInputFromStateInner(state, /* @__PURE__ */ new Set);
}
function extractRawInputFromStateInner(state, visited) {
  if (state == null)
    return;
  if (typeof state !== "object")
    return;
  if (visited.has(state))
    return;
  visited.add(state);
  const recordedRawInput = getRecordedDerivedRawInput(state);
  if (recordedRawInput != null)
    return recordedRawInput;
  if (isDeferredParseState(state))
    return state.rawInput;
  if (Array.isArray(state)) {
    for (let index = state.length - 1;index >= 0; index--) {
      const rawInput = extractRawInputFromStateInner(state[index], visited);
      if (rawInput != null)
        return rawInput;
    }
    return;
  }
  const nested = /* @__PURE__ */ new Set;
  for (const value of Object.values(state)) {
    const rawInput = extractRawInputFromStateInner(value, visited);
    if (rawInput != null)
      nested.add(rawInput);
  }
  return nested.size === 1 ? nested.values().next().value : undefined;
}
function extractPreliminaryResultFromState(state) {
  return extractPreliminaryResultFromStateInner(state, /* @__PURE__ */ new Set);
}
function extractPreliminaryResultFromStateInner(state, visited) {
  if (state == null || typeof state !== "object")
    return;
  if (visited.has(state))
    return;
  visited.add(state);
  if (isDeferredParseState(state))
    return state.preliminaryResult;
  if (getRecordedDerivedRawInput(state) != null && "success" in state && typeof state.success === "boolean") {
    if (state.success === true && "value" in state)
      return state;
    if (state.success === false && "error" in state)
      return state;
  }
  if (Array.isArray(state)) {
    for (let index = state.length - 1;index >= 0; index--) {
      const result = extractPreliminaryResultFromStateInner(state[index], visited);
      if (result != null)
        return result;
    }
    return;
  }
  const nested = /* @__PURE__ */ new Set;
  for (const value of Object.values(state)) {
    const result = extractPreliminaryResultFromStateInner(value, visited);
    if (result != null)
      nested.add(result);
  }
  return nested.size === 1 ? nested.values().next().value : undefined;
}
function getRecordedDerivedRawInput(state) {
  const recorded = derivedRawInputs.get(state);
  if (recorded != null)
    return recorded;
  if (derivedRawInputKey in state && typeof state[derivedRawInputKey] === "string")
    return state[derivedRawInputKey];
  return;
}
var effectfulSchedulingNodesKey = Symbol("@optique/core/dependency-runtime/effectfulSchedulingNodes");
var sourceCollectionExpansionKey = Symbol("@optique/core/dependency-runtime/sourceCollectionExpansion");
var staticSourceScopeKey = Symbol("@optique/core/dependency-runtime/staticSourceScope");
var exclusiveSourceScopeKey = Symbol("@optique/core/dependency-runtime/exclusiveSourceScope");
var guaranteedStaticSourceIdsKey = Symbol("@optique/core/dependency-runtime/guaranteedStaticSourceIds");
function defineForwardedEffectfulSchedulingNodes(wrapper, inner, adaptState) {
  Object.defineProperty(wrapper, staticSourceScopeKey, {
    value: [inner],
    configurable: true,
    enumerable: false
  });
  if (inner.dependencyMetadata?.source != null)
    return;
  Object.defineProperty(wrapper, effectfulSchedulingNodesKey, {
    value: (state, parentPath) => [{
      path: parentPath ?? [],
      parser: inner,
      state: adaptState == null ? state : adaptState(state)
    }],
    configurable: true,
    enumerable: false
  });
  if (inner[sourceCollectionExpansionKey] === true)
    Object.defineProperty(wrapper, sourceCollectionExpansionKey, {
      value: true,
      configurable: true,
      enumerable: false
    });
}
function collectDemandedDependencyIds(nodes, state, trace) {
  const demanded = /* @__PURE__ */ new Set;
  for (const node of nodes) {
    const derived = node.parser.dependencyMetadata?.derived;
    if (derived == null)
      continue;
    const hasRawInput = trace?.get(node.path)?.rawInput != null || extractRawInputFromState(node.state) != null;
    if (!hasRawInput)
      continue;
    for (const id of derived.dependencyIds)
      demanded.add(id);
  }
  collectDeferredDemand(state, demanded, /* @__PURE__ */ new WeakSet);
  return demanded;
}
function collectDeferredDemand(state, demanded, visited) {
  if (state == null || typeof state !== "object")
    return;
  if (visited.has(state))
    return;
  visited.add(state);
  if (isDeferredParseState(state)) {
    const ids = state.dependencyIds != null && state.dependencyIds.length > 0 ? state.dependencyIds : [state.dependencyId];
    for (const id of ids)
      demanded.add(id);
    return;
  }
  for (const key of Reflect.ownKeys(state))
    collectDeferredDemand(state[key], demanded, visited);
}
function propagateDemand(universe, session) {
  let demandAdded = true;
  while (demandAdded) {
    demandAdded = false;
    for (const node of universe) {
      const metadata = node.parser.dependencyMetadata;
      if (metadata?.source != null && metadata.derived != null && session.demanded.has(metadata.source.sourceId))
        for (const dependencySourceId of metadata.derived.dependencyIds) {
          if (session.demanded.has(dependencySourceId))
            continue;
          session.demanded.add(dependencySourceId);
          demandAdded = true;
        }
      if (metadata?.source != null && metadata.completion != null && session.demanded.has(metadata.source.sourceId) && !hasInactiveCompletion(node))
        for (const dependencySourceId of metadata.completion.dependencyIds) {
          if (session.demanded.has(dependencySourceId))
            continue;
          session.demanded.add(dependencySourceId);
          demandAdded = true;
        }
      if (node.barrierCompletionDependencies != null && (node.barrierDemandActivation !== "after-resolution" || node.barrierResolutionState === "resolved"))
        for (const edge of node.barrierCompletionDependencies.demandEdges) {
          if (!session.demanded.has(edge.consumerSourceId))
            continue;
          for (const dependencySourceId of edge.dependencyIds) {
            if (session.demanded.has(dependencySourceId))
              continue;
            session.demanded.add(dependencySourceId);
            demandAdded = true;
          }
        }
      if (node.requiresSourceId == null || node.providesSourceIds == null)
        continue;
      if (session.demanded.has(node.requiresSourceId))
        continue;
      for (const provided of node.providesSourceIds)
        if (session.demanded.has(provided)) {
          session.demanded.add(node.requiresSourceId);
          demandAdded = true;
          break;
        }
    }
  }
}
var barrierFailureDescription = "optique.barrierFailure";
function isGatedUnresolvedBarrier(node) {
  return node.resolveBarrier != null && node.barrierDemandActivation === "after-resolution" && node.barrierResolutionState == null;
}
function collectParkedNodes(pending, session) {
  const parked = /* @__PURE__ */ new Set;
  for (const node of pending) {
    const source = node.parser.dependencyMetadata?.source;
    if (source?.completeSource != null && !session.demanded.has(source.sourceId))
      parked.add(node);
  }
  if (parked.size === 0)
    return parked;
  const graph = buildDependencyGraph(pending);
  const queue = [...parked];
  while (queue.length > 0) {
    const provider = queue.pop();
    for (const [consumer, advisoryOnly] of graph.outgoing.get(provider) ?? []) {
      if (advisoryOnly || parked.has(consumer))
        continue;
      parked.add(consumer);
      queue.push(consumer);
    }
  }
  return parked;
}
async function completeEffectfulSourcesAsync(nodes, state, runtime, exec, options) {
  const empty = {
    success: true,
    completed: []
  };
  if (exec == null || exec.phase !== "complete")
    return empty;
  registerRuntimeSourceMetadata(nodes, runtime);
  const session = exec.effectfulCompletionSession;
  if (session?.policy === "demand-only") {
    const demandNodes = options?.demandNodes ?? nodes;
    const demanded = collectDemandedDependencyIds(demandNodes, state, exec.trace);
    for (const id of demanded)
      session.demanded.add(id);
    propagateDemand(nodes, session);
  }
  if (session != null) {
    for (const result of session.results.values())
      if (!result.success)
        return {
          success: false,
          error: result.error
        };
  }
  const schedulable = nodes.filter((node) => node.parser.dependencyMetadata?.source?.completeSource != null || node.prepare != null);
  if (schedulable.length === 0 && options?.includeStructural !== true)
    return empty;
  const completed = [];
  const barrierContext = {
    runtime,
    exec,
    schedule: (barrierNodes) => completeEffectfulSourcesAsync(barrierNodes, state, runtime, exec, {
      isReusable: () => false,
      isCollected: () => true,
      includeStructural: true
    }).then((result) => result.success ? undefined : result)
  };
  const pending = [...nodes];
  const metadataUniverse = [...nodes];
  const declarationIndex = new Map(nodes.map((node, index) => [node, index]));
  const lastPublicationBySource = /* @__PURE__ */ new Map;
  const recordPublication = (index, sourceId, value) => {
    const existing = lastPublicationBySource.get(sourceId);
    if (existing == null || index >= existing.index)
      lastPublicationBySource.set(sourceId, {
        index,
        value
      });
    options?.onPublish?.(sourceId, value);
  };
  const publishFromNode = (node, sourceId, value) => {
    runtime.registerSource(sourceId, value);
    recordPublication(declarationIndex.get(node) ?? 0, sourceId, value);
  };
  const providesId = (node, id) => node.parser.dependencyMetadata?.source?.sourceId === id || node.providesSourceIds?.has(id) === true;
  const demandSession = session?.policy === "demand-only" ? session : undefined;
  const resolveBarrierAt = async (index) => {
    const candidate = pending[index];
    const resolution = await candidate.resolveBarrier(barrierContext);
    if (resolution != null && "success" in resolution) {
      session?.results.set(Symbol(barrierFailureDescription), resolution);
      return resolution;
    }
    const replacement = resolution == null ? {
      ...candidate,
      barrierResolutionState: "unresolvable"
    } : {
      ...candidate,
      barrierResolutionState: "resolved",
      providesSourceIds: resolution.activeProvidesSourceIds,
      barrierCompletionDependencies: {
        orderingDependencyIds: resolution.orderingDependencyIds,
        demandEdges: resolution.demandEdges
      }
    };
    pending[index] = replacement;
    const originalIndex = declarationIndex.get(candidate);
    if (originalIndex != null)
      declarationIndex.set(replacement, originalIndex);
    const universeIndex = metadataUniverse.indexOf(candidate);
    if (universeIndex >= 0)
      metadataUniverse[universeIndex] = replacement;
    if (resolution != null && demandSession != null)
      propagateDemand(metadataUniverse, demandSession);
    return;
  };
  while (pending.length > 0) {
    const parkingActive = demandSession != null && pending.some(isGatedUnresolvedBarrier);
    for (let i = 0;i < pending.length; i++) {
      const candidate = pending[i];
      if (candidate.resolveBarrier == null || candidate.barrierResolutionState != null)
        continue;
      const requires = candidate.requiresSourceId;
      if (requires == null)
        continue;
      if (parkingActive && demandSession != null && !demandSession.demanded.has(requires))
        continue;
      if (pending.some((other) => other !== candidate && providesId(other, requires)))
        continue;
      const failure = await resolveBarrierAt(i);
      if (failure != null)
        return failure;
    }
    const ordered = orderDependencyNodes(pending);
    let node = ordered[0];
    const parkingStillActive = demandSession != null && pending.some(isGatedUnresolvedBarrier);
    if (parkingStillActive && demandSession != null) {
      const parked = collectParkedNodes(pending, demandSession);
      const isSkippedBarrier = (candidate) => candidate.resolveBarrier != null && candidate.barrierResolutionState == null && candidate.requiresSourceId != null && !demandSession.demanded.has(candidate.requiresSourceId);
      const selectable = ordered.find((candidate) => !parked.has(candidate) && !isSkippedBarrier(candidate));
      if (selectable != null)
        node = selectable;
      else {
        const stalled = ordered.find((candidate) => candidate.resolveBarrier != null && candidate.barrierResolutionState == null);
        if (stalled != null) {
          const failure = await resolveBarrierAt(pending.indexOf(stalled));
          if (failure != null)
            return failure;
          continue;
        }
      }
    }
    if (node.resolveBarrier != null && node.barrierResolutionState == null) {
      const failure = await resolveBarrierAt(pending.indexOf(node));
      if (failure != null)
        return failure;
      continue;
    }
    pending.splice(pending.indexOf(node), 1);
    if (node.prepare != null) {
      const barrierIndex = declarationIndex.get(node) ?? 0;
      const publishedDuringPrepare = /* @__PURE__ */ new Set;
      const nodeBarrierContext = {
        ...barrierContext,
        schedule: (barrierNodes) => completeEffectfulSourcesAsync(barrierNodes, state, runtime, exec, {
          isReusable: () => false,
          isCollected: () => true,
          includeStructural: true,
          onPublish: (sourceId, value) => {
            publishedDuringPrepare.add(sourceId);
            recordPublication(barrierIndex, sourceId, value);
          }
        }).then((result$1) => result$1.success ? undefined : result$1)
      };
      const barrierFailure = await node.prepare(nodeBarrierContext);
      if (barrierFailure != null)
        return barrierFailure;
      for (const sourceId of publishedDuringPrepare) {
        const entry = lastPublicationBySource.get(sourceId);
        if (entry != null && entry.index > barrierIndex) {
          runtime.registerSource(sourceId, entry.value);
          options?.onPublish?.(sourceId, entry.value);
        }
      }
      continue;
    }
    const source = node.parser.dependencyMetadata?.source;
    if (source == null)
      continue;
    if (source.completeSource == null) {
      const derived = node.parser.dependencyMetadata?.derived;
      const rawInput = getNodeRawInput(node);
      if (derived != null && rawInput != null) {
        if (runtime.propagateSourceFailure(derived.dependencyIds, formatDependencyNodeMetavar(node), source.sourceId))
          continue;
        const replayed = await replayDerivedParserAsync(node, rawInput, runtime);
        if (replayed == null)
          continue;
        if (!replayed.success) {
          runtime.markSourceFailed(source.sourceId);
          propagateRuntimeSourceFailures(nodes, runtime);
          return {
            success: false,
            error: includeSourceFailureChain(replayed.error, source.sourceId, runtime)
          };
        }
        if (replayed.deferred === true)
          continue;
        publishFromNode(node, source.sourceId, replayed.value);
        if (source.preservesSourceValue && (options?.isReusable?.(node) ?? true))
          completed.push({
            key: node.path[node.path.length - 1],
            result: replayed
          });
        continue;
      }
      const collected = options?.isCollected?.(node) ?? options?.isReusable?.(node) ?? true;
      if (source.extractSourceValue == null || collected === false)
        continue;
      const extracted = await source.extractSourceValue(node.state);
      if (extracted?.success === true) {
        publishFromNode(node, source.sourceId, extracted.value);
        continue;
      }
      if (options?.includeStructural === true && extracted?.success !== false && node.matched !== true && source.preservesSourceValue && source.getMissingSourceValue != null && !runtime.hasSource(source.sourceId) && !runtime.isSourceFailed(source.sourceId)) {
        let fallback = session?.missingDefaultsByOccurrence.get(source.getMissingSourceValue);
        if (fallback == null) {
          try {
            fallback = await source.getMissingSourceValue();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            fallback = {
              success: false,
              error: message`Default value evaluation failed: ${msg}`
            };
          }
          session?.missingDefaultsByOccurrence.set(source.getMissingSourceValue, fallback);
        }
        if (fallback.success)
          publishFromNode(node, source.sourceId, fallback.value);
        else {
          runtime.markSourceFailed(source.sourceId);
          propagateRuntimeSourceFailures(nodes, runtime);
          return {
            success: false,
            error: includeSourceFailureChain(fallback.error, source.sourceId, runtime)
          };
        }
      }
      continue;
    }
    const pathKey = serializeSchedulingPath(node.path);
    const priorResult = session?.completedByPath.get(pathKey);
    if (priorResult != null) {
      if (source.preservesSourceValue && (options?.isReusable?.(node) ?? true))
        completed.push({
          key: node.path[node.path.length - 1],
          result: priorResult
        });
      if (exec.republishCachedCompletions === true && priorResult.success && priorResult.value !== undefined)
        publishFromNode(node, source.sourceId, priorResult.value);
      continue;
    }
    const reusable = source.preservesSourceValue && (options?.isReusable?.(node) ?? true);
    if (!reusable && session == null)
      continue;
    const childExec = {
      ...exec,
      path: node.path,
      republishCachedCompletions: undefined
    };
    const result = await source.completeSource(node.state, childExec);
    if (result == null)
      continue;
    if (!result.success) {
      runtime.markSourceFailed(source.sourceId);
      propagateRuntimeSourceFailures(nodes, runtime);
      return {
        success: false,
        error: includeSourceFailureChain(result.error, source.sourceId, runtime)
      };
    }
    if (result.deferred === true)
      continue;
    session?.completedByPath.set(pathKey, result);
    if (reusable)
      completed.push({
        key: node.path[node.path.length - 1],
        result
      });
    if (result.value !== undefined)
      publishFromNode(node, source.sourceId, result.value);
  }
  return {
    success: true,
    completed
  };
}
function serializeSchedulingPath(path) {
  return path.map(serializePathSegment).join("");
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function resolveSingleDeferred(deferred, runtime) {
  const isMultiDep = deferred.dependencyIds != null && deferred.dependencyIds.length > 0;
  const depIds = isMultiDep ? deferred.dependencyIds : [deferred.dependencyId];
  const resolution = runtime.resolveDependencies({
    dependencyIds: depIds,
    defaultValues: deferred.defaultValues
  });
  if (resolution.kind !== "resolved")
    return deferred.preliminaryResult;
  if (resolution.usedDefaults.every((d) => d))
    return deferred.preliminaryResult;
  const depValue = isMultiDep ? resolution.values : resolution.values[0];
  const result = deferred.parser[parseWithDependency](deferred.rawInput, depValue);
  if (isPromiseLike(result))
    throw new TypeError("resolveStateWithRuntime() received an async parseWithDependency() result. Use resolveStateWithRuntimeAsync() instead.");
  return result;
}
function resolveSingleDeferredAsync(deferred, runtime) {
  const isMultiDep = deferred.dependencyIds != null && deferred.dependencyIds.length > 0;
  const depIds = isMultiDep ? deferred.dependencyIds : [deferred.dependencyId];
  const resolution = runtime.resolveDependencies({
    dependencyIds: depIds,
    defaultValues: deferred.defaultValues
  });
  if (resolution.kind !== "resolved")
    return Promise.resolve(deferred.preliminaryResult);
  if (resolution.usedDefaults.every((d) => d))
    return Promise.resolve(deferred.preliminaryResult);
  const depValue = isMultiDep ? resolution.values : resolution.values[0];
  return Promise.resolve(deferred.parser[parseWithDependency](deferred.rawInput, depValue));
}
function collectSourcesFromState(state, runtime, visited = /* @__PURE__ */ new WeakSet, excludedFields) {
  if (state == null || typeof state !== "object")
    return;
  if (visited.has(state))
    return;
  visited.add(state);
  if (isDependencySourceState(state)) {
    const depId = state[dependencyId];
    const result = state.result;
    if (depId != null && result.success)
      runtime.registerSource(depId, result.value);
    else if (depId != null)
      runtime.markSourceFailed(depId);
    return;
  }
  if (isDeferredParseState(state))
    return;
  if (Array.isArray(state)) {
    for (const item of state)
      collectSourcesFromState(item, runtime, visited);
    return;
  }
  if (typeof state === "object")
    for (const key of Reflect.ownKeys(state)) {
      if (excludedFields?.has(key))
        continue;
      collectSourcesFromState(state[key], runtime, visited);
    }
}
function resolveStateWithRuntime(state, runtime) {
  collectSourcesFromState(state, runtime);
  return resolveDeferredInState(state, runtime);
}
function resolveDeferredInState(state, runtime, visited = /* @__PURE__ */ new WeakSet, deferredCache = /* @__PURE__ */ new WeakMap) {
  if (state == null)
    return state;
  if (isDeferredParseState(state)) {
    const cached = deferredCache.get(state);
    if (cached !== undefined)
      return cached;
    const resolved = resolveSingleDeferred(state, runtime);
    deferredCache.set(state, resolved);
    return resolved;
  }
  if (isDependencySourceState(state))
    return state;
  if (typeof state === "object") {
    if (visited.has(state))
      return state;
    visited.add(state);
  }
  if (Array.isArray(state)) {
    const resolved = state.map((item) => resolveDeferredInState(item, runtime, visited, deferredCache));
    return resolved.every((item, index) => item === state[index]) ? state : resolved;
  }
  if (isPlainObject(state)) {
    const keys = Reflect.ownKeys(state);
    const resolvedEntries = keys.map((key) => [key, resolveDeferredInState(state[key], runtime, visited, deferredCache)]);
    if (resolvedEntries.every(([key, value]) => value === state[key]))
      return state;
    const resolved = Object.create(Object.getPrototypeOf(state));
    for (const [key, value] of resolvedEntries)
      resolved[key] = value;
    return resolved;
  }
  return state;
}
function resolveStateWithRuntimeAsync(state, runtime) {
  collectSourcesFromState(state, runtime);
  return resolveDeferredInStateAsync(state, runtime);
}
async function resolveDeferredInStateAsync(state, runtime, visited = /* @__PURE__ */ new WeakSet, deferredCache = /* @__PURE__ */ new WeakMap) {
  if (state == null)
    return state;
  if (isDeferredParseState(state)) {
    const cached = deferredCache.get(state);
    if (cached !== undefined)
      return cached;
    const resolved = resolveSingleDeferredAsync(state, runtime);
    deferredCache.set(state, resolved);
    return resolved;
  }
  if (isDependencySourceState(state))
    return state;
  if (typeof state === "object") {
    if (visited.has(state))
      return state;
    visited.add(state);
  }
  if (Array.isArray(state)) {
    const resolved = await Promise.all(state.map((item) => resolveDeferredInStateAsync(item, runtime, visited, deferredCache)));
    return resolved.every((item, index) => item === state[index]) ? state : resolved;
  }
  if (isPlainObject(state)) {
    const keys = Reflect.ownKeys(state);
    const resolvedEntries = await Promise.all(keys.map(async (key) => {
      return [key, await resolveDeferredInStateAsync(state[key], runtime, visited, deferredCache)];
    }));
    if (resolvedEntries.every(([key, value]) => value === state[key]))
      return state;
    const resolved = Object.create(Object.getPrototypeOf(state));
    for (const [key, value] of resolvedEntries)
      resolved[key] = value;
    return resolved;
  }
  return state;
}
function isMatchedState(fieldState, parser) {
  if (fieldState === undefined)
    return false;
  const innerState = Array.isArray(fieldState) && fieldState.length === 1 ? fieldState[0] : fieldState;
  if (isPendingDependencySourceState(innerState))
    return false;
  if (parser[unmatchedNonCliDependencySourceStateMarker] === true && innerState != null && typeof innerState === "object" && Object.hasOwn(innerState, "hasCliValue") && innerState.hasCliValue === false)
    return false;
  if (fieldState === parser.initialState)
    return false;
  return true;
}
function buildRuntimeNodesFromPairs(pairs, state, parentPath) {
  const prefix = parentPath ?? [];
  const nodes = [];
  for (const [field, parser] of pairs) {
    const fieldState = Object.hasOwn(state, field) ? state[field] : undefined;
    const isDerived = parser.dependencyMetadata?.derived != null;
    const rawInput = isDerived ? extractRawInputFromState(fieldState) : undefined;
    const defaultDependencyValues = isDerived ? getDefaultDependencySnapshot(fieldState) : undefined;
    nodes.push({
      path: [...prefix, field],
      parser,
      state: fieldState,
      matched: isMatchedState(fieldState, parser),
      ...rawInput != null ? { rawInput } : {},
      ...defaultDependencyValues != null ? { defaultDependencyValues } : {}
    });
  }
  return nodes;
}
function getDefaultDependencySnapshot(state) {
  return getDefaultDependencySnapshotInner(state, /* @__PURE__ */ new Set);
}
function getDefaultDependencySnapshotInner(state, visited) {
  if (state == null || typeof state !== "object")
    return;
  if (visited.has(state))
    return;
  visited.add(state);
  const direct = getSnapshottedDefaultDependencyValues(state);
  if (direct != null)
    return direct;
  if (Array.isArray(state)) {
    for (let index = state.length - 1;index >= 0; index--) {
      const snapshot = getDefaultDependencySnapshotInner(state[index], visited);
      if (snapshot != null)
        return snapshot;
    }
    return;
  }
  const nested = [];
  for (const value of Object.values(state)) {
    const snapshot = getDefaultDependencySnapshotInner(value, visited);
    if (snapshot != null)
      nested.push(snapshot);
  }
  return nested.length === 1 ? nested[0] : undefined;
}

// node_modules/@optique/core/dist/input-trace.js
var symbolKeys = /* @__PURE__ */ new WeakMap;
var symbolCounter2 = 0;
function lengthPrefix2(s) {
  return `${s.length}:${s}`;
}
function serializeKey(key) {
  if (typeof key === "string")
    return lengthPrefix2(`s${key}`);
  if (typeof key === "number")
    return lengthPrefix2(`n${key}`);
  const registeredKey = Symbol.keyFor(key);
  if (registeredKey !== undefined)
    return lengthPrefix2(`r${registeredKey}`);
  let id = symbolKeys.get(key);
  if (id === undefined) {
    id = `y${symbolCounter2++}`;
    symbolKeys.set(key, id);
  }
  return lengthPrefix2(id);
}
function serializePath(path) {
  if (path.length === 0)
    return "";
  return path.map(serializeKey).join("");
}
var InputTraceImpl = class InputTraceImpl {
  #entries;
  constructor(entries) {
    this.#entries = entries ?? /* @__PURE__ */ new Map;
  }
  get(path) {
    return this.#entries.get(serializePath(path));
  }
  set(path, entry) {
    const copy = new Map(this.#entries);
    copy.set(serializePath(path), entry);
    return new InputTraceImpl(copy);
  }
  delete(path) {
    const copy = new Map(this.#entries);
    copy.delete(serializePath(path));
    return new InputTraceImpl(copy);
  }
};
function createInputTrace() {
  return new InputTraceImpl;
}

// node_modules/@optique/core/dist/internal/parser.js
var parseLanesKey = Symbol("parseLanes");
function createEffectfulCompletionSession(policy = "eager") {
  return {
    policy,
    results: /* @__PURE__ */ new Map,
    demanded: /* @__PURE__ */ new Set,
    effectfulSources: /* @__PURE__ */ new Set,
    completedByPath: /* @__PURE__ */ new Map,
    preparedByPath: /* @__PURE__ */ new Map,
    missingDefaultsByOccurrence: /* @__PURE__ */ new WeakMap
  };
}
var unmatchedNonCliDependencySourceStateMarker = Symbol.for("@optique/core/parser/unmatchedNonCliDependencySourceStateMarker");
var inheritParentAnnotationsKey = Symbol.for("@optique/core/inheritParentAnnotations");
var annotationWrapperRequiresSourceBindingKey = Symbol.for("@optique/core/annotationWrapperRequiresSourceBinding");
function createParserContext(frame, exec) {
  return {
    exec,
    trace: exec.trace,
    buffer: frame.buffer,
    state: frame.state,
    optionsTerminated: frame.optionsTerminated,
    usage: exec.usage,
    dependencyRegistry: exec.dependencyRegistry
  };
}
function injectAnnotationsIntoState(state, options) {
  return injectAnnotations(state, options?.annotations);
}
function getFailureProgress(args, buffer, consumedInStep) {
  return {
    remainingArgs: buffer.slice(consumedInStep),
    consumedCount: args.length - buffer.length + consumedInStep
  };
}
function createParseExec(parser) {
  return {
    usage: parser.usage,
    phase: "parse",
    path: [],
    commandPath: [],
    trace: createInputTrace()
  };
}
function getCommandPath(exec) {
  return [...exec?.commandPath ?? []];
}
function createCompleteExec(exec, context, session) {
  const runtime = createDependencyRuntimeContext();
  return {
    ...exec,
    phase: "complete",
    dependencyRuntime: runtime,
    dependencyRegistry: runtime.registry,
    commandPath: context.exec?.commandPath ?? exec.commandPath,
    trace: context.exec?.trace ?? context.trace ?? exec.trace,
    effectfulCompletionSession: session ?? createEffectfulCompletionSession()
  };
}
function attemptParseSync(parser, args, options = {}) {
  const initialState = injectAnnotationsIntoState(parser.initialState, options.parseOptions);
  const shouldUnwrapAnnotatedValue = hasMeaningfulAnnotations(options.parseOptions?.annotations) || isInjectedAnnotationWrapper(parser.initialState);
  const exec = createParseExec(parser);
  let context = createParserContext({
    buffer: [...args],
    state: initialState,
    optionsTerminated: false
  }, exec);
  do {
    const result = parser.parse(context);
    if (!result.success) {
      const progress = getFailureProgress(args, context.buffer, result.consumed);
      return {
        kind: "failure",
        error: result.error,
        remainingArgs: progress.remainingArgs,
        consumedCount: progress.consumedCount,
        optionsTerminated: context.optionsTerminated,
        commandPath: getCommandPath(context.exec)
      };
    }
    const previousBuffer = context.buffer;
    context = result.next;
    if (isBufferUnchanged(previousBuffer, context.buffer)) {
      const progress = getFailureProgress(args, previousBuffer, result.consumed.length);
      return {
        kind: "failure",
        error: message`Unexpected option or argument: ${context.buffer[0]}.`,
        remainingArgs: progress.remainingArgs,
        consumedCount: progress.consumedCount,
        optionsTerminated: context.optionsTerminated,
        commandPath: getCommandPath(context.exec)
      };
    }
  } while (context.buffer.length > 0);
  if (options.mode === "parse-only")
    return {
      kind: "success",
      result: {
        success: true,
        value: undefined
      }
    };
  const endResult = parser.complete(context.state, createCompleteExec(exec, context, options.session));
  if (!endResult.success)
    return {
      kind: "failure",
      error: endResult.error,
      remainingArgs: [],
      consumedCount: args.length,
      optionsTerminated: context.optionsTerminated,
      commandPath: getCommandPath(context.exec)
    };
  return {
    kind: "success",
    result: {
      success: true,
      value: shouldUnwrapAnnotatedValue ? unwrapInjectedAnnotationWrapper(endResult.value) : endResult.value,
      ...endResult.deferred ? { deferred: true } : {},
      ...endResult.deferredKeys ? { deferredKeys: endResult.deferredKeys } : {}
    }
  };
}
async function attemptParseAsync(parser, args, options = {}) {
  const initialState = injectAnnotationsIntoState(parser.initialState, options.parseOptions);
  const shouldUnwrapAnnotatedValue = hasMeaningfulAnnotations(options.parseOptions?.annotations) || isInjectedAnnotationWrapper(parser.initialState);
  const exec = createParseExec(parser);
  let context = createParserContext({
    buffer: [...args],
    state: initialState,
    optionsTerminated: false
  }, exec);
  do {
    const result = await parser.parse(context);
    if (!result.success) {
      const progress = getFailureProgress(args, context.buffer, result.consumed);
      return {
        kind: "failure",
        error: result.error,
        remainingArgs: progress.remainingArgs,
        consumedCount: progress.consumedCount,
        optionsTerminated: context.optionsTerminated,
        commandPath: getCommandPath(context.exec)
      };
    }
    const previousBuffer = context.buffer;
    context = result.next;
    if (isBufferUnchanged(previousBuffer, context.buffer)) {
      const progress = getFailureProgress(args, previousBuffer, result.consumed.length);
      return {
        kind: "failure",
        error: message`Unexpected option or argument: ${context.buffer[0]}.`,
        remainingArgs: progress.remainingArgs,
        consumedCount: progress.consumedCount,
        optionsTerminated: context.optionsTerminated,
        commandPath: getCommandPath(context.exec)
      };
    }
  } while (context.buffer.length > 0);
  if (options.mode === "parse-only")
    return {
      kind: "success",
      result: {
        success: true,
        value: undefined
      }
    };
  const endResult = await parser.complete(context.state, createCompleteExec(exec, context, options.session));
  if (!endResult.success)
    return {
      kind: "failure",
      error: endResult.error,
      remainingArgs: [],
      consumedCount: args.length,
      optionsTerminated: context.optionsTerminated,
      commandPath: getCommandPath(context.exec)
    };
  return {
    kind: "success",
    result: {
      success: true,
      value: shouldUnwrapAnnotatedValue ? unwrapInjectedAnnotationWrapper(endResult.value) : endResult.value,
      ...endResult.deferred ? { deferred: true } : {},
      ...endResult.deferredKeys ? { deferredKeys: endResult.deferredKeys } : {}
    }
  };
}
function parseSync(parser, args, options) {
  const attempted = attemptParseSync(parser, args, { parseOptions: options });
  return attempted.kind === "success" ? attempted.result : {
    success: false,
    error: attempted.error
  };
}
function isBufferUnchanged(previous, current) {
  return current.length > 0 && current.length === previous.length && current.every((item, i) => item === previous[i]);
}
async function parseAsync(parser, args, options) {
  const attempted = await attemptParseAsync(parser, args, { parseOptions: options });
  return attempted.kind === "success" ? attempted.result : {
    success: false,
    error: attempted.error
  };
}
function parse(parser, args, options) {
  return dispatchByMode(parser.mode, () => parseSync(parser, args, options), () => parseAsync(parser, args, options));
}
function getParserSuggestRuntimeNodes(parser, state, path) {
  if (typeof parser.getSuggestRuntimeNodes === "function")
    return parser.getSuggestRuntimeNodes(state, path);
  if (parser.dependencyMetadata?.source == null)
    return [];
  return [{
    path,
    parser,
    state
  }];
}
function defineParseLanes(parser, lanes) {
  if (lanes == null)
    return;
  Object.defineProperty(parser, parseLanesKey, {
    value: lanes,
    configurable: true,
    enumerable: false
  });
}
function getOwnParseLanes(parser) {
  if (!Object.hasOwn(parser, parseLanesKey))
    return;
  return parser[parseLanesKey];
}
function defineInheritedAnnotationParser(parser) {
  Object.defineProperty(parser, inheritParentAnnotationsKey, {
    value: true,
    configurable: true,
    enumerable: false
  });
}
function defineSourceBindingOnlyAnnotationCompletionParser(parser) {
  Object.defineProperty(parser, annotationWrapperRequiresSourceBindingKey, {
    value: true,
    configurable: true,
    enumerable: false
  });
}
function findCommandInExclusive(term, commandName) {
  if (term.type !== "exclusive")
    return null;
  for (const termGroup of term.terms) {
    const firstTerm = termGroup[0];
    if (firstTerm == null)
      continue;
    const found = findCommandInCurrentUsageTerm(firstTerm, commandName, termGroup.slice(1));
    if (found)
      return found;
  }
  return null;
}
function findCommandInUsageSequence(usage, commandName) {
  for (let index = 0;index < usage.length; index++) {
    const found = findCommandInCurrentUsageTerm(usage[index], commandName, usage.slice(index + 1));
    if (found)
      return found;
  }
  return null;
}
function findCommandInCurrentUsageTerm(term, commandName, trailingUsage) {
  if (term.type === "command" && commandTermMatches(term, commandName))
    return [term, ...trailingUsage];
  if (term.type === "exclusive") {
    const found = findCommandInExclusive(term, commandName);
    if (found)
      return [...found, ...trailingUsage];
  } else if (term.type === "sequence") {
    const found = findCommandInUsageSequence(term.terms, commandName);
    if (found)
      return [...found, ...trailingUsage];
  }
  return null;
}
function commandTermMatches(term, commandName) {
  return term?.type === "command" && (term.name === commandName || term.aliases?.includes(commandName) === true || term.hiddenAliases?.includes(commandName) === true);
}
function collectCommandInputNames(usage, commandName, names) {
  for (const term of usage)
    if (term.type === "command") {
      if (commandTermMatches(term, commandName)) {
        names.add(term.name);
        for (const alias of term.aliases ?? [])
          names.add(alias);
        for (const alias of term.hiddenAliases ?? [])
          names.add(alias);
      }
    } else if (term.type === "exclusive")
      for (const branch of term.terms)
        collectCommandInputNames(branch, commandName, names);
    else if (term.type === "sequence")
      collectCommandInputNames(term.terms, commandName, names);
    else if (term.type === "optional" || term.type === "multiple")
      collectCommandInputNames(term.terms, commandName, names);
}
function findLastCommandInputIndex(consumed, commandName, usage, searchEnd) {
  const names = new Set([commandName]);
  collectCommandInputNames(usage, commandName, names);
  for (let index = searchEnd - 1;index >= 0; index--)
    if (names.has(consumed[index]))
      return index;
  return -1;
}
function recordMatchedCommandArgIndices(usage, consumed, previousCommandPath, nextCommandPath, consumedOffset, indices) {
  const previousLength = previousCommandPath?.length ?? 0;
  const next = nextCommandPath ?? [];
  if (next.length <= previousLength || consumed.length < 1)
    return;
  let searchEnd = consumed.length;
  for (let index = next.length - 1;index >= previousLength; index--) {
    if (searchEnd <= 0)
      break;
    const commandName = next[index];
    const localIndex = findLastCommandInputIndex(consumed, commandName, usage, searchEnd);
    if (localIndex < 0)
      continue;
    indices.add(consumedOffset + localIndex);
    searchEnd = localIndex;
  }
}
function getDocPage(parser, argsOrOptions, options) {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const opts = Array.isArray(argsOrOptions) ? options : argsOrOptions ?? options;
  if (parser.mode === "sync")
    return getDocPageSyncImpl(parser, args, opts);
  return getDocPageAsyncImpl(parser, args, opts);
}
function getDocPageSyncImpl(parser, args, options) {
  const initialState = injectAnnotationsIntoState(parser.initialState, options);
  const exec = {
    usage: parser.usage,
    phase: "parse",
    path: [],
    trace: createInputTrace()
  };
  let context = createParserContext({
    buffer: args,
    state: initialState,
    optionsTerminated: false
  }, exec);
  const matchedCommandArgIndices = /* @__PURE__ */ new Set;
  while (context.buffer.length > 0) {
    const result = parser.parse(context);
    if (!result.success)
      break;
    const previousCommandPath = context.exec?.commandPath;
    const previousBuffer = context.buffer;
    context = result.next;
    const consumedCount = previousBuffer.length - context.buffer.length;
    recordMatchedCommandArgIndices(parser.usage, previousBuffer.slice(0, consumedCount), previousCommandPath, context.exec?.commandPath, args.length - previousBuffer.length, matchedCommandArgIndices);
    if (isBufferUnchanged(previousBuffer, context.buffer))
      break;
  }
  return buildDocPage(parser, context, args, matchedCommandArgIndices);
}
async function getDocPageAsyncImpl(parser, args, options) {
  const initialState = injectAnnotationsIntoState(parser.initialState, options);
  const exec = {
    usage: parser.usage,
    phase: "parse",
    path: [],
    trace: createInputTrace()
  };
  let context = createParserContext({
    buffer: args,
    state: initialState,
    optionsTerminated: false
  }, exec);
  const matchedCommandArgIndices = /* @__PURE__ */ new Set;
  while (context.buffer.length > 0) {
    const result = await parser.parse(context);
    if (!result.success)
      break;
    const previousCommandPath = context.exec?.commandPath;
    const previousBuffer = context.buffer;
    context = result.next;
    const consumedCount = previousBuffer.length - context.buffer.length;
    recordMatchedCommandArgIndices(parser.usage, previousBuffer.slice(0, consumedCount), previousCommandPath, context.exec?.commandPath, args.length - previousBuffer.length, matchedCommandArgIndices);
    if (isBufferUnchanged(previousBuffer, context.buffer))
      break;
  }
  return buildDocPage(parser, context, args, matchedCommandArgIndices);
}
function buildDocPage(parser, context, args, matchedCommandArgIndices) {
  let effectiveArgs = args;
  let { brief, description, fragments, footer } = parser.getDocFragments({
    kind: "available",
    state: context.state
  }, undefined);
  if (args.length === 0 && Reflect.get(parser, Symbol.for("@optique/core/commandParser")) === true && fragments.length === 1 && fragments[0].type === "entry" && fragments[0].term.type === "command") {
    const cmdName = fragments[0].term.name;
    const matchedState = inheritAnnotations(context.state, ["matched", cmdName]);
    const matched = parser.getDocFragments({
      kind: "available",
      state: matchedState
    }, undefined);
    ({ brief, description, fragments, footer } = matched);
    effectiveArgs = [cmdName];
  }
  const buildingSections = [];
  let untitledSection = null;
  const titledSectionMap = /* @__PURE__ */ new Map;
  for (const fragment of fragments)
    if (fragment.type === "entry") {
      if (isDocEntryHidden(fragment))
        continue;
      if (untitledSection == null) {
        untitledSection = { entries: [] };
        buildingSections.push(untitledSection);
      }
      untitledSection.entries.push(cloneDocEntry(fragment));
    } else if (fragment.type === "section") {
      const visible = fragment.entries.filter((e) => !isDocEntryHidden(e));
      if (visible.length === 0)
        continue;
      if (fragment.title == null) {
        if (untitledSection == null) {
          untitledSection = { entries: [] };
          buildingSections.push(untitledSection);
        }
        untitledSection.entries.push(...visible.map(cloneDocEntry));
      } else {
        let section = titledSectionMap.get(fragment.title);
        if (section == null) {
          section = {
            title: fragment.title,
            entries: []
          };
          titledSectionMap.set(fragment.title, section);
          buildingSections.push(section);
        }
        section.entries.push(...visible.map(cloneDocEntry));
      }
    }
  const sections = buildingSections;
  const usage = [...normalizeUsage(parser.usage)];
  const maybeApplyCommandUsageLine = (term, arg, isLastArg, usageIndex) => {
    if (term?.type !== "command" || !commandTermMatches(term, arg) || !isLastArg || term.usageLine == null)
      return;
    const defaultUsageLine = cloneUsage(usage.slice(usageIndex + 1));
    const customUsageLine = typeof term.usageLine === "function" ? term.usageLine(defaultUsageLine) : term.usageLine;
    const normalizedCustomUsageLine = normalizeUsage(customUsageLine);
    usage.splice(usageIndex + 1, usage.length - (usageIndex + 1), ...normalizedCustomUsageLine);
  };
  let i = 0;
  const consumedArgsCount = Math.max(0, effectiveArgs.length - context.buffer.length);
  const commandArgIndices = args.length > 0 ? matchedCommandArgIndices : null;
  for (let argIndex = 0;argIndex < effectiveArgs.length; argIndex++) {
    const arg = effectiveArgs[argIndex];
    if (i >= usage.length)
      break;
    let term = usage[i];
    const canSearchCommand = commandArgIndices == null || commandArgIndices.has(argIndex);
    if (!canSearchCommand)
      continue;
    let found = null;
    for (let searchIndex = i;searchIndex < usage.length; searchIndex++) {
      found = findCommandInCurrentUsageTerm(usage[searchIndex], arg, usage.slice(searchIndex + 1));
      if (found != null)
        break;
    }
    if (found) {
      usage.splice(i, usage.length - i, ...found);
      term = usage[i];
    }
    maybeApplyCommandUsageLine(term, arg, argIndex === effectiveArgs.length - 1, i);
    if (found != null || term.type !== "sequence" || argIndex >= consumedArgsCount)
      i++;
  }
  if (effectiveArgs.length === 0 && usage.length > 0) {
    const first = usage[0];
    if (first.type === "command" && first.usageLine != null) {
      const defaultUsageLine = cloneUsage(usage.slice(1));
      const customUsageLine = typeof first.usageLine === "function" ? first.usageLine(defaultUsageLine) : first.usageLine;
      const normalizedCustomUsageLine = normalizeUsage(customUsageLine);
      usage.splice(1, usage.length - 1, ...normalizedCustomUsageLine);
    }
  }
  return {
    usage: revealMatchedCommandUsage(usage, effectiveArgs, commandArgIndices ?? null),
    sections,
    ...brief != null && { brief: cloneMessage(brief) },
    ...description != null && { description: cloneMessage(description) },
    ...footer != null && { footer: cloneMessage(footer) }
  };
}
function revealMatchedCommandUsage(usage, args, matchedCommandArgIndices) {
  if (args.length < 1)
    return usage;
  const [revealed] = revealMatchedCommandUsageTerms(usage, args, matchedCommandArgIndices, 0);
  return revealed;
}
function revealMatchedCommandUsageTerms(usage, args, matchedCommandArgIndices, argIndex) {
  const terms = [];
  let nextArgIndex = argIndex;
  for (const term of usage) {
    const [revealed, afterTermArgIndex] = revealMatchedCommandUsageTerm(term, args, matchedCommandArgIndices, nextArgIndex);
    terms.push(revealed);
    nextArgIndex = afterTermArgIndex;
  }
  return [terms, nextArgIndex];
}
function revealMatchedCommandUsageTerm(term, args, matchedCommandArgIndices, argIndex) {
  if (term.type === "command") {
    const nextArgIndex = findNextMatchedCommandArgIndex(args, matchedCommandArgIndices, argIndex);
    if (nextArgIndex < args.length && commandTermMatches(term, args[nextArgIndex])) {
      const { hidden: _hidden, ...revealed } = term;
      return [revealed, nextArgIndex + 1];
    }
    return [term, argIndex];
  }
  if (term.type === "sequence") {
    const [terms, nextArgIndex] = revealMatchedCommandUsageTerms(term.terms, args, matchedCommandArgIndices, argIndex);
    return [{
      ...term,
      terms
    }, nextArgIndex];
  }
  if (term.type === "optional" || term.type === "multiple") {
    const [terms, nextArgIndex] = revealMatchedCommandUsageTerms(term.terms, args, matchedCommandArgIndices, argIndex);
    return [{
      ...term,
      terms
    }, nextArgIndex];
  }
  if (term.type === "exclusive") {
    let maxArgIndex = argIndex;
    const terms = term.terms.map((branch) => {
      const [revealed, nextArgIndex] = revealMatchedCommandUsageTerms(branch, args, matchedCommandArgIndices, argIndex);
      if (nextArgIndex > maxArgIndex)
        maxArgIndex = nextArgIndex;
      return revealed;
    });
    return [{
      ...term,
      terms
    }, maxArgIndex];
  }
  return [term, argIndex];
}
function findNextMatchedCommandArgIndex(args, matchedCommandArgIndices, start) {
  if (matchedCommandArgIndices == null)
    return start;
  for (let index = start;index < args.length; index++)
    if (matchedCommandArgIndices.has(index))
      return index;
  return args.length;
}
// node_modules/@optique/core/dist/annotation-state.js
var annotationViewTargets = /* @__PURE__ */ new WeakMap;
var delegatedAnnotationCloneTargets = /* @__PURE__ */ new WeakMap;
function unwrapAnnotationView(value) {
  if (value == null || typeof value !== "object")
    return value;
  return annotationViewTargets.get(value) ?? value;
}
function unwrapDelegatedAnnotationClone(value) {
  if (value == null || typeof value !== "object")
    return value;
  return delegatedAnnotationCloneTargets.get(value) ?? value;
}
function withAnnotationView(state, annotations) {
  const target = unwrapAnnotationView(state);
  const view = new Proxy(target, {
    get(target$1, key) {
      if (key === annotationKey)
        return annotations;
      const value = Reflect.get(target$1, key, target$1);
      return typeof value === "function" ? value.bind(target$1) : value;
    },
    has(target$1, key) {
      return key === annotationKey || Reflect.has(target$1, key);
    }
  });
  annotationViewTargets.set(view, target);
  return view;
}
function normalizeInjectedAnnotationState(state) {
  return unwrapInjectedAnnotationWrapper(state);
}
function isNonPlainDelegatedObject(state) {
  const proto = Object.getPrototypeOf(state);
  if (proto === Array.prototype || proto === Date.prototype || proto === Map.prototype || proto === Set.prototype || proto === RegExp.prototype)
    return false;
  return proto !== Object.prototype && proto !== null;
}
function inheritDelegatedAnnotations(parentState, childState) {
  const target = normalizeDelegatedAnnotationState(childState);
  const delegatedState = inheritAnnotations(parentState, target);
  if (delegatedState !== target)
    delegatedAnnotationCloneTargets.set(delegatedState, target);
  return delegatedState;
}
function normalizeDelegatedAnnotationState(state) {
  return normalizeInjectedAnnotationState(unwrapDelegatedAnnotationClone(unwrapAnnotationView(state)));
}
function hasDelegatedAnnotationCarrier(state) {
  return state != null && typeof state === "object" && (isInjectedAnnotationWrapper(state) || delegatedAnnotationCloneTargets.has(state) || annotationViewTargets.has(state));
}
function getOrCreateNestedNormalizationClone(entry) {
  entry.clone ??= entry.createClone();
  return entry.clone;
}
function getPendingNestedNormalizationEntry(originalValue, normalizedValue, seen) {
  if (originalValue == null || typeof originalValue !== "object")
    return;
  const entry = seen.get(originalValue);
  return entry != null && entry.clone != null && entry.clone === normalizedValue && (!entry.finalized || entry.preferCloneOnRead) ? entry : undefined;
}
function createPendingNestedNormalizationClone(source) {
  if (!Array.isArray(source))
    return Object.create(Object.getPrototypeOf(source));
  if (Object.getPrototypeOf(source) === Array.prototype)
    return [];
  try {
    return source.slice(0, 0);
  } catch {
    return [];
  }
}
function createPendingNestedNormalizationCollectionClone(source) {
  const proto = Object.getPrototypeOf(source);
  if (source instanceof Map && proto === Map.prototype)
    return /* @__PURE__ */ new Map;
  if (source instanceof Set && proto === Set.prototype)
    return /* @__PURE__ */ new Set;
  const Constructor = source.constructor;
  if (typeof Constructor === "function")
    try {
      return new Constructor;
    } catch {}
  return source instanceof Map ? /* @__PURE__ */ new Map : /* @__PURE__ */ new Set;
}
function normalizeNestedDelegatedStructuredState(source, seen, preferPendingClone) {
  const entry = {
    clone: undefined,
    createClone: () => createPendingNestedNormalizationClone(source),
    finalized: false,
    result: source,
    preferCloneOnRead: false
  };
  seen.set(source, entry);
  const overrides = /* @__PURE__ */ new Map;
  let changed = false;
  let hasPendingAliasOverride = false;
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor == null || !("value" in descriptor))
      continue;
    const nextValue = normalizeNestedDelegatedAnnotationState(descriptor.value, seen, true);
    if (nextValue === descriptor.value)
      continue;
    overrides.set(key, nextValue);
    if (getPendingNestedNormalizationEntry(descriptor.value, nextValue, seen) == null)
      changed = true;
    else
      hasPendingAliasOverride = true;
  }
  if (!changed && !hasPendingAliasOverride) {
    entry.finalized = true;
    entry.result = source;
    return source;
  }
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const [key, nextValue] of overrides) {
    const descriptor = descriptors[key];
    if (descriptor == null || !("value" in descriptor))
      continue;
    descriptors[key] = {
      ...descriptor,
      value: nextValue
    };
  }
  const clone = getOrCreateNestedNormalizationClone(entry);
  Object.defineProperties(clone, descriptors);
  entry.finalized = true;
  entry.preferCloneOnRead = !changed && hasPendingAliasOverride;
  entry.result = changed ? clone : source;
  return changed || preferPendingClone ? clone : source;
}
function normalizeNestedDelegatedMapState(source, seen, preferPendingClone) {
  const entry = {
    clone: undefined,
    createClone: () => createPendingNestedNormalizationCollectionClone(source),
    finalized: false,
    result: source,
    preferCloneOnRead: false
  };
  seen.set(source, entry);
  const normalizedEntries = [];
  const overrides = /* @__PURE__ */ new Map;
  let changed = false;
  let hasPendingAliasOverride = false;
  for (const [key, value] of source) {
    const nextKey = normalizeNestedDelegatedAnnotationState(key, seen, true);
    const nextValue = normalizeNestedDelegatedAnnotationState(value, seen, true);
    normalizedEntries.push([nextKey, nextValue]);
    if (nextKey !== key)
      if (getPendingNestedNormalizationEntry(key, nextKey, seen) == null)
        changed = true;
      else
        hasPendingAliasOverride = true;
    if (nextValue !== value)
      if (getPendingNestedNormalizationEntry(value, nextValue, seen) == null)
        changed = true;
      else
        hasPendingAliasOverride = true;
  }
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor == null || !("value" in descriptor))
      continue;
    const nextValue = normalizeNestedDelegatedAnnotationState(descriptor.value, seen, true);
    if (nextValue === descriptor.value)
      continue;
    overrides.set(key, nextValue);
    if (getPendingNestedNormalizationEntry(descriptor.value, nextValue, seen) == null)
      changed = true;
    else
      hasPendingAliasOverride = true;
  }
  if (!changed && !hasPendingAliasOverride) {
    entry.finalized = true;
    entry.result = source;
    return source;
  }
  const clone = getOrCreateNestedNormalizationClone(entry);
  for (const [key, value] of normalizedEntries)
    clone.set(key, value);
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const [key, nextValue] of overrides) {
    const descriptor = descriptors[key];
    if (descriptor == null || !("value" in descriptor))
      continue;
    descriptors[key] = {
      ...descriptor,
      value: nextValue
    };
  }
  Object.defineProperties(clone, descriptors);
  entry.finalized = true;
  entry.preferCloneOnRead = !changed && hasPendingAliasOverride;
  entry.result = changed ? clone : source;
  return changed || preferPendingClone ? clone : source;
}
function normalizeNestedDelegatedSetState(source, seen, preferPendingClone) {
  const entry = {
    clone: undefined,
    createClone: () => createPendingNestedNormalizationCollectionClone(source),
    finalized: false,
    result: source,
    preferCloneOnRead: false
  };
  seen.set(source, entry);
  const normalizedValues = [];
  const overrides = /* @__PURE__ */ new Map;
  let changed = false;
  let hasPendingAliasOverride = false;
  for (const value of source) {
    const nextValue = normalizeNestedDelegatedAnnotationState(value, seen, true);
    normalizedValues.push(nextValue);
    if (nextValue === value)
      continue;
    if (getPendingNestedNormalizationEntry(value, nextValue, seen) == null)
      changed = true;
    else
      hasPendingAliasOverride = true;
  }
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor == null || !("value" in descriptor))
      continue;
    const nextValue = normalizeNestedDelegatedAnnotationState(descriptor.value, seen, true);
    if (nextValue === descriptor.value)
      continue;
    overrides.set(key, nextValue);
    if (getPendingNestedNormalizationEntry(descriptor.value, nextValue, seen) == null)
      changed = true;
    else
      hasPendingAliasOverride = true;
  }
  if (!changed && !hasPendingAliasOverride) {
    entry.finalized = true;
    entry.result = source;
    return source;
  }
  const clone = getOrCreateNestedNormalizationClone(entry);
  for (const value of normalizedValues)
    clone.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const [key, nextValue] of overrides) {
    const descriptor = descriptors[key];
    if (descriptor == null || !("value" in descriptor))
      continue;
    descriptors[key] = {
      ...descriptor,
      value: nextValue
    };
  }
  Object.defineProperties(clone, descriptors);
  entry.finalized = true;
  entry.preferCloneOnRead = !changed && hasPendingAliasOverride;
  entry.result = changed ? clone : source;
  return changed || preferPendingClone ? clone : source;
}
function normalizeNestedDelegatedAnnotationState(value, seen = /* @__PURE__ */ new WeakMap, preferPendingClone = false) {
  const normalized = normalizeDelegatedAnnotationState(value);
  if (normalized == null || typeof normalized !== "object")
    return normalized;
  const source = normalized;
  const existing = seen.get(source);
  if (existing != null) {
    if (!existing.finalized)
      return getOrCreateNestedNormalizationClone(existing);
    return preferPendingClone && existing.preferCloneOnRead ? getOrCreateNestedNormalizationClone(existing) : existing.result;
  }
  if (Array.isArray(source))
    return normalizeNestedDelegatedStructuredState(source, seen, preferPendingClone);
  if (source instanceof Map)
    return normalizeNestedDelegatedMapState(source, seen, preferPendingClone);
  if (source instanceof Set)
    return normalizeNestedDelegatedSetState(source, seen, preferPendingClone);
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null)
    return normalized;
  return normalizeNestedDelegatedStructuredState(source, seen, preferPendingClone);
}
function getDelegatedAnnotationState(parentState, childState) {
  const annotations = getAnnotations(parentState);
  if (annotations === undefined)
    return childState;
  if (isInjectedAnnotationWrapper(childState))
    return injectAnnotations(normalizeInjectedAnnotationState(childState), annotations);
  if (childState == null || typeof childState !== "object")
    return injectAnnotations(childState, annotations);
  if (getAnnotations(childState) === annotations && (delegatedAnnotationCloneTargets.has(childState) || annotationViewTargets.has(childState)))
    return childState;
  if (isNonPlainDelegatedObject(childState))
    return withAnnotationView(childState, annotations);
  return inheritDelegatedAnnotations(parentState, childState);
}
function isAnnotationWrappedInitialState(state) {
  return normalizeInjectedAnnotationState(state) === undefined;
}
function getWrappedChildParseState(parentState, childState, parser) {
  const annotations = getAnnotations(parentState);
  const shouldInheritAnnotations = Reflect.get(parser, inheritParentAnnotationsKey) === true;
  if (childState == null) {
    if (annotations !== undefined && shouldInheritAnnotations)
      return injectAnnotations(childState, annotations);
    return childState;
  }
  if (annotations === undefined || typeof childState !== "object" || getAnnotations(childState) === annotations || !shouldInheritAnnotations)
    return childState;
  const injectedState = injectAnnotations(childState, annotations);
  return getAnnotations(injectedState) === annotations ? injectedState : childState;
}
function getWrappedChildState(parentState, childState, parser) {
  const annotations = getAnnotations(parentState);
  const shouldInheritAnnotations = Reflect.get(parser, inheritParentAnnotationsKey) === true;
  if (childState == null) {
    if (annotations !== undefined && shouldInheritAnnotations)
      return injectAnnotations(childState, annotations);
    return childState;
  }
  if (annotations === undefined || typeof childState !== "object" || getAnnotations(childState) === annotations)
    return childState;
  if (shouldInheritAnnotations) {
    const injectedState = injectAnnotations(childState, annotations);
    if (getAnnotations(injectedState) === annotations)
      return injectedState;
  }
  return withAnnotationView(childState, annotations);
}
function reconcileObjectChildState(parentState, childState) {
  const annotations = getAnnotations(parentState);
  if (annotations === undefined || childState == null || typeof childState !== "object" || getAnnotations(childState) === annotations)
    return childState;
  return inheritAnnotations(parentState, childState);
}

// node_modules/@optique/core/dist/internal/joined-file-suggestion.js
var joinedFiles = /* @__PURE__ */ new WeakMap;
function joinedFileSuggestion(prefix, file, value) {
  const literal = {
    kind: "literal",
    text: prefix + (file.pattern ?? ""),
    description: file.description
  };
  joinedFiles.set(literal, {
    files: [{
      prefix,
      file: file.pattern === value && !/[?*]/.test(value) && !(file.prefix != null && file.prefix !== "" && value.startsWith(file.prefix)) ? {
        ...file,
        pattern: undefined
      } : file
    }],
    literal: false
  });
  return literal;
}
function getJoinedFileSuggestion(suggestion) {
  return joinedFiles.get(suggestion);
}
function mergeJoinedFileSuggestions(target, source) {
  const a = joinedFiles.get(target);
  const b = joinedFiles.get(source);
  if (a === undefined && b === undefined)
    return;
  const files = [...a?.files ?? [], ...b?.files ?? []];
  const seen = /* @__PURE__ */ new Set;
  joinedFiles.set(target, {
    literal: (a?.literal ?? true) || (b?.literal ?? true),
    files: files.filter(({ prefix, file }) => {
      const key = JSON.stringify([
        prefix,
        file.type,
        file.pattern,
        file.prefix,
        file.includeHidden === true,
        file.extensions?.toSorted()
      ]);
      if (seen.has(key))
        return false;
      seen.add(key);
      return true;
    })
  });
}

// node_modules/@optique/core/dist/internal/command-doc-metadata.js
function withOrigin(metadata, origin) {
  const result = { ...metadata };
  Object.defineProperty(result, "origin", {
    value: origin,
    enumerable: false
  });
  return result;
}
var commandDocMetadata = Symbol.for("@optique/core/commandDocMetadata");
var commandDocCarrier = Symbol.for("@optique/core/commandDocMetadataCarrier");
function getCommandDocMetadata(docs) {
  const carrier = docs.fragments[commandDocCarrier];
  if (carrier != null) {
    const brief = docs.brief === carrier.brief ? carrier.metadata.brief : docs.brief;
    const origin = carrier.metadata.origin ?? "entry";
    const customPage = origin === "entry" && (docs.brief !== carrier.brief || docs.footer !== carrier.footer);
    const description = origin === "entry" && !customPage || docs.description === carrier.description ? carrier.metadata.description : docs.description;
    const footer = docs.footer === carrier.footer ? carrier.metadata.footer : docs.footer;
    return withOrigin({
      ...brief == null ? {} : { brief },
      ...description == null ? {} : { description },
      ...footer == null ? {} : { footer }
    }, customPage ? "custom" : origin);
  }
  const metadata = docs[commandDocMetadata];
  if (metadata != null)
    return metadata;
  return docs.brief != null || docs.description != null || docs.footer != null ? withOrigin({
    brief: docs.brief,
    description: docs.description,
    footer: docs.footer
  }, "custom") : undefined;
}
function withCommandDocMetadata(docs, metadata) {
  if (metadata == null)
    return docs;
  metadata = withOrigin(metadata, metadata.origin ?? "entry");
  const fragments = [...docs.fragments];
  Object.defineProperty(fragments, commandDocCarrier, { value: {
    metadata,
    brief: docs.brief,
    description: docs.description,
    footer: docs.footer
  } });
  const result = {
    ...docs,
    fragments
  };
  Object.defineProperty(result, commandDocMetadata, { value: metadata });
  return result;
}
function collectCommandDocMetadata(current, docs, includeCustom = false) {
  const next = getCommandDocMetadata(docs);
  if (next == null)
    return current;
  const origin = next.origin ?? "entry";
  if (origin === "entry" || origin === "custom" && !includeCustom)
    return current ?? withOrigin({}, "entry");
  if (current?.origin === "command" && origin !== "command")
    return current;
  if (current?.origin !== origin)
    current = undefined;
  const brief = current?.brief ?? next.brief;
  const description = current?.description ?? next.description;
  const footer = current?.footer ?? next.footer;
  return withOrigin({
    ...brief == null ? {} : { brief },
    ...description == null ? {} : { description },
    ...footer == null ? {} : { footer }
  }, origin);
}

// node_modules/@optique/core/dist/internal/passthrough.js
function retainConsumingFailure(current, failure, priority) {
  return {
    failure: current != null && current.failure.consumed >= failure.consumed ? current.failure : failure,
    priority: Math.max(current?.priority ?? -Infinity, priority)
  };
}
var passThroughFailure = Symbol("passThroughFailure");
function getPassThroughFailure(context, capturePriority$1 = -Infinity) {
  const hinted = context;
  const hint = hinted[passThroughFailure];
  return hint?.buffer === context.buffer && hint.optionsTerminated === context.optionsTerminated && hint.failure.priority >= capturePriority$1 ? hint.failure : undefined;
}
function withPassThroughFailure(context, failure, capturePriority$1 = -Infinity) {
  const token = context.buffer[0];
  const existing = getPassThroughFailure(context);
  if (existing != null && existing.priority < capturePriority$1) {
    const hinted$1 = context;
    const { [passThroughFailure]: _discarded, ...rest } = hinted$1;
    context = rest;
  }
  if (failure == null || failure.failure.consumed < 1 || failure.priority < capturePriority$1 || context.optionsTerminated || token == null || token === "--" || !/^[-/+]/.test(token))
    return context;
  const retained = getPassThroughFailure(context);
  const combined = retainConsumingFailure(retained, failure.failure, failure.priority);
  const hinted = {
    ...context,
    [passThroughFailure]: {
      buffer: context.buffer,
      optionsTerminated: context.optionsTerminated,
      failure: combined
    }
  };
  return hinted;
}
function retainConsumingFailureHint(current, context, next) {
  if (next.buffer !== context.buffer || next.optionsTerminated !== context.optionsTerminated)
    return current;
  const hint = getPassThroughFailure(next);
  return hint == null ? current : retainConsumingFailure(current, hint.failure, hint.priority);
}
var capturePriority = Symbol("capturePriority");
function hasPassThroughUsage(usage) {
  return usage.some((term) => term.type === "passthrough" || (term.type === "optional" || term.type === "multiple") && hasPassThroughUsage(term.terms) || term.type === "exclusive" && term.terms.some(hasPassThroughUsage));
}
function getPassThroughPriority(parser, state = parser.initialState, token) {
  if (!hasPassThroughUsage(parser.usage))
    return;
  const annotated = parser;
  const hint = annotated[capturePriority];
  if (hint == null)
    return parser.priority;
  const priority = hint.getPriority == null ? hint.priority : hint.getPriority(state, token);
  return priority == null ? undefined : hint.ownerPriority === parser.priority ? priority : parser.priority;
}
function definePassThroughPriority(parser, children, getPriority) {
  const priorities = children.filter((child) => hasPassThroughUsage(child.usage)).map((child) => getPassThroughPriority(child) ?? child.priority);
  if (priorities.length === 0)
    return;
  Object.defineProperty(parser, capturePriority, {
    value: {
      ownerPriority: parser.priority,
      priority: Math.max(...priorities),
      getPriority
    },
    enumerable: true
  });
}
function getPassThroughFailureHint(context) {
  const hinted = context;
  const hint = hinted[passThroughFailure];
  return hint != null && getPassThroughFailure(context) != null ? { [passThroughFailure]: hint } : {};
}
function hasFlagUsage(usage, name) {
  return usage.some((term) => term.type === "option" && term.metavar == null && term.names.some((optionName) => optionName === name) || (term.type === "optional" || term.type === "multiple") && hasFlagUsage(term.terms, name) || term.type === "exclusive" && term.terms.some((terms) => hasFlagUsage(terms, name)));
}
function matchesOptionToken(parser, token) {
  if (token == null || token === "--" || !/^[-/+]/.test(token))
    return false;
  if (parser.leadingNames.has(token))
    return true;
  const slashOption = token.startsWith("/");
  const separator = slashOption ? token.indexOf(":") : token.startsWith("-") ? token.indexOf("=") : -1;
  if (separator > (slashOption ? 0 : 2) && parser.leadingNames.has(token.slice(0, separator)))
    return true;
  const shortName = token.slice(0, 2);
  return token.length > 2 && /^-[^-]$/.test(shortName) && parser.leadingNames.has(shortName) && hasFlagUsage(parser.usage, shortName);
}
var optionMatchKey = Symbol("optionMatch");
function defineOptionMatch(parser, match) {
  Object.defineProperty(parser, optionMatchKey, {
    value: {
      ownerPriority: parser.priority,
      match
    },
    enumerable: true
  });
}
function getOptionMatch(parser, state, token) {
  if (token == null || token === "--" || !/^[-/+]/.test(token))
    return;
  const annotated = parser;
  const matcher = annotated[optionMatchKey];
  if (matcher != null) {
    const match = matcher.match(state, token);
    return match == null || matcher.ownerPriority === parser.priority ? match : {
      ...match,
      priority: parser.priority
    };
  }
  return matchesOptionToken(parser, token) ? {
    priority: parser.priority,
    continuesCommand: false
  } : undefined;
}
function combineOptionMatches(matches) {
  const found = matches.filter((match) => match != null);
  return found.length === 0 ? undefined : {
    priority: Math.max(...found.map((match) => match.priority)),
    continuesCommand: found.some((match) => match.continuesCommand)
  };
}
var knownCompletionKey = Symbol("knownCompletion");
function defineKnownCompletion(parser, value) {
  defineKnownCompletionLookup(parser, (state) => ({ value: value(state) }));
}
function defineKnownCompletionLookup(parser, value) {
  Object.defineProperty(parser, knownCompletionKey, {
    value: {
      complete: parser.complete,
      value
    },
    enumerable: true
  });
}
function getKnownCompletion(parser, state) {
  const annotated = parser;
  const hint = annotated[knownCompletionKey];
  return hint != null && hint.complete === parser.complete ? hint.value(state) : undefined;
}
function combinePassThroughPriorities(priorities) {
  const found = priorities.filter((priority) => priority != null);
  return found.length === 0 ? undefined : Math.max(...found);
}
function delegateKnownCompletion(wrapper, inner) {
  Object.defineProperty(wrapper, knownCompletionKey, {
    value: {
      complete: wrapper.complete,
      value: (state) => getKnownCompletion(inner, state)
    },
    enumerable: true
  });
}

// node_modules/@optique/core/dist/execution-context.js
function withChildExecPath(exec, segment) {
  if (exec == null)
    return;
  return {
    ...exec,
    path: [...exec.path ?? [], segment]
  };
}
function mergeChildExec(parent, child) {
  if (parent == null)
    return child;
  if (child == null)
    return parent;
  return {
    ...parent,
    trace: child.trace ?? parent.trace,
    dependencyRuntime: child.dependencyRuntime ?? parent.dependencyRuntime,
    dependencyRegistry: child.dependencyRegistry ?? parent.dependencyRegistry,
    commandPath: child.commandPath ?? parent.commandPath,
    preCompletedByParser: child.preCompletedByParser ?? parent.preCompletedByParser,
    excludedSourceFields: child.excludedSourceFields ?? parent.excludedSourceFields
  };
}
function withChildContext(context, segment, state, usage) {
  const exec = withChildExecPath(context.exec, segment);
  const dependencyRegistry = context.dependencyRegistry ?? exec?.dependencyRegistry;
  return {
    ...context,
    state,
    ...usage != null ? { usage } : {},
    ...exec != null ? {
      exec: dependencyRegistry === exec.dependencyRegistry ? exec : {
        ...exec,
        dependencyRegistry
      },
      dependencyRegistry
    } : {}
  };
}

// node_modules/@optique/core/dist/phase2-seed.js
var extractPhase2SeedKey = Symbol("@optique/core/extractPhase2Seed");
function phase2SeedFromValueResult(result) {
  return {
    value: unwrapInjectedAnnotationWrapper(result.value),
    ...result.deferred ? { deferred: true } : {},
    ...result.deferredKeys != null ? { deferredKeys: result.deferredKeys } : {}
  };
}
function extractPhase2Seed(parser, state, exec) {
  return dispatchByMode(parser.mode, () => {
    const extractor = parser[extractPhase2SeedKey];
    return extractor == null ? null : extractor(state, exec);
  }, async () => {
    const extractor = parser[extractPhase2SeedKey];
    return extractor == null ? null : await extractor(state, exec);
  });
}
function completeOrExtractPhase2Seed(parser, state, exec) {
  return dispatchByMode(parser.mode, () => {
    const result = parser.complete(state, exec);
    if (result.success)
      return phase2SeedFromValueResult(result);
    return extractPhase2Seed(parser, state, exec);
  }, async () => {
    const result = await parser.complete(state, exec);
    if (result.success)
      return phase2SeedFromValueResult(result);
    return await extractPhase2Seed(parser, state, exec);
  });
}

// node_modules/@optique/core/dist/dependency-metadata.js
function extractDependencyMetadata(valueParser) {
  let source;
  if (isDependencySource(valueParser))
    source = {
      kind: "source",
      sourceId: valueParser[dependencySourceId],
      metavar: valueParser.metavar,
      extractSourceValue: extractFromBareState,
      preservesSourceValue: true
    };
  let derived;
  if (isDerivedValueParser(valueParser)) {
    const isMultiSource = dependencyIds in valueParser && valueParser[dependencyIds] != null;
    const allIds = isMultiSource ? valueParser[dependencyIds] : [valueParser[dependencyId]];
    let defaultValuesFn;
    if (defaultValues in valueParser && valueParser[defaultValues] != null)
      defaultValuesFn = valueParser[defaultValues];
    else if (singleDefaultValue in valueParser && valueParser[singleDefaultValue] != null) {
      const singleFn = valueParser[singleDefaultValue];
      defaultValuesFn = () => [singleFn()];
    }
    const parser = valueParser;
    const replayParse = (rawInput, depValues) => {
      const depArg = isMultiSource ? depValues : depValues[0];
      return parser[parseWithDependency](rawInput, depArg);
    };
    const suggestFn = suggestWithDependency in parser ? parser[suggestWithDependency] : undefined;
    const replaySuggest = suggestFn != null ? (prefix, depValues) => {
      const depArg = isMultiSource ? depValues : depValues[0];
      return suggestFn(prefix, depArg);
    } : undefined;
    derived = {
      kind: "derived",
      dependencyIds: allIds,
      metavar: valueParser.metavar,
      getDefaultDependencyValues: defaultValuesFn,
      replayParse,
      replaySuggest
    };
  }
  return source == null && derived == null ? undefined : {
    source,
    derived
  };
}
function extractFromBareState(state) {
  if (isDependencySourceState(state))
    return state.result;
  if (state != null && typeof state === "object" && Object.hasOwn(state, "success") && typeof state.success === "boolean" && (state.success && Object.hasOwn(state, "value") || !state.success && Object.hasOwn(state, "error")))
    return state;
  return;
}
function unwrapArrayThenExtract(innerExtract) {
  return (state) => {
    if (Array.isArray(state) && state.length === 1)
      return innerExtract(state[0]);
    return innerExtract(state);
  };
}
function unwrapArrayThenComplete(innerComplete) {
  return (state, exec) => {
    if (Array.isArray(state) && state.length === 1)
      return innerComplete(state[0], exec);
    return innerComplete(state, exec);
  };
}
function composeDependencyMetadata(inner, wrapperKind, options) {
  if (inner === undefined)
    return;
  switch (wrapperKind) {
    case "optional": {
      if (inner.source != null && inner.source.extractSourceValue != null)
        return {
          ...inner,
          source: {
            ...inner.source,
            extractSourceValue: unwrapArrayThenExtract(inner.source.extractSourceValue),
            completesWhenMissing: false,
            ...inner.source.completeSource != null && { completeSource: unwrapArrayThenComplete(inner.source.completeSource) }
          }
        };
      return inner;
    }
    case "withDefault": {
      const wrappedExtract = inner.source?.extractSourceValue != null ? unwrapArrayThenExtract(inner.source.extractSourceValue) : undefined;
      const preservesSourceValue = inner.source?.preservesSourceValue !== false;
      if (inner.source != null)
        return {
          ...inner,
          source: {
            ...inner.source,
            ...wrappedExtract != null && { extractSourceValue: wrappedExtract },
            ...inner.source.completeSource != null && { completeSource: unwrapArrayThenComplete(inner.source.completeSource) },
            ...preservesSourceValue && options?.defaultValue != null && { getMissingSourceValue: options.defaultValue }
          }
        };
      return inner;
    }
    case "map": {
      const result = {
        ...inner,
        transform: { transformsSourceValue: true }
      };
      if (inner.source != null)
        return {
          ...result,
          source: {
            ...inner.source,
            preservesSourceValue: false
          }
        };
      return result;
    }
  }
}

// node_modules/@optique/core/dist/modifiers.js
function isTerminalMultipleItemState(state) {
  const unwrapped = unwrapMultipleItemState(state).value;
  return unwrapped != null && typeof unwrapped === "object" && Object.hasOwn(unwrapped, "success") && typeof unwrapped.success === "boolean";
}
function isMatchedCommandParserState(parser, state) {
  if (Reflect.get(parser, Symbol.for("@optique/core/commandParser")) !== true)
    return false;
  const unwrapped = unwrapMultipleItemState(state).value;
  return Array.isArray(unwrapped) && unwrapped.length === 2 && unwrapped[0] === "matched" && typeof unwrapped[1] === "string";
}
function isUnstartedMultipleItemState(state, originalState) {
  const unwrappedState = unwrapMultipleItemState(state);
  if (unwrappedState.value == null)
    return true;
  if (originalState === undefined)
    return false;
  const unwrappedOriginalState = unwrapMultipleItemState(originalState);
  return unwrappedState.value === unwrappedOriginalState.value && (unwrappedState.viaBoundCliWrapper || unwrappedOriginalState.viaBoundCliWrapper || unwrappedOriginalState.value != null && typeof unwrappedOriginalState.value === "object");
}
function isBoundCliWrapperState(state) {
  return state != null && typeof state === "object" && Object.hasOwn(state, "hasCliValue") && typeof state.hasCliValue === "boolean" && (Object.hasOwn(state, "cliState") || state.hasCliValue === false);
}
function unwrapMultipleItemState(state) {
  let unwrapped = state;
  let viaBoundCliWrapper = false;
  while (true) {
    if (isInjectedAnnotationWrapper(unwrapped)) {
      unwrapped = unwrapInjectedAnnotationWrapper(unwrapped);
      continue;
    }
    if (Array.isArray(unwrapped) && unwrapped.length === 1) {
      unwrapped = unwrapped[0];
      continue;
    }
    if (isBoundCliWrapperState(unwrapped)) {
      viaBoundCliWrapper = true;
      unwrapped = unwrapped.cliState;
      continue;
    }
    return {
      value: unwrapped,
      viaBoundCliWrapper
    };
  }
}
function isPromiseLike2(value) {
  return value != null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function";
}
function normalizeOptionalLikeCompleteResult(result, shouldNormalize) {
  return result.success && shouldNormalize ? {
    ...result,
    value: normalizeNestedDelegatedAnnotationState(result.value)
  } : result;
}
function shouldRetryOptionalLikeCompatibilityError(error, state) {
  return error instanceof TypeError && state != null && typeof state === "object" && isInjectedAnnotationWrapper(state);
}
function completeOptionalLikeSync(parser, state, exec) {
  const hasCarrier = hasDelegatedAnnotationCarrier(state);
  const shouldRetryFalseResult = hasCarrier && isAnnotationWrappedInitialState(state);
  const run = (candidate, shouldNormalize) => normalizeOptionalLikeCompleteResult(parser.complete(candidate, exec), shouldNormalize);
  try {
    const result = run(state, hasCarrier);
    if (!result.success && shouldRetryFalseResult)
      return run(normalizeDelegatedAnnotationState(state), false);
    return result;
  } catch (error) {
    if (!shouldRetryOptionalLikeCompatibilityError(error, state))
      throw error;
    return run(normalizeDelegatedAnnotationState(state), false);
  }
}
async function completeOptionalLikeAsync(parser, state, exec) {
  const hasCarrier = hasDelegatedAnnotationCarrier(state);
  const shouldRetryFalseResult = hasCarrier && isAnnotationWrappedInitialState(state);
  const run = async (candidate, shouldNormalize) => normalizeOptionalLikeCompleteResult(await parser.complete(candidate, exec), shouldNormalize);
  try {
    const result = await run(state, hasCarrier);
    if (!result.success && shouldRetryFalseResult)
      return await run(normalizeDelegatedAnnotationState(state), false);
    return result;
  } catch (error) {
    if (!shouldRetryOptionalLikeCompatibilityError(error, state))
      throw error;
    return await run(normalizeDelegatedAnnotationState(state), false);
  }
}
function normalizeOptionalLikePhase2Seed(seed, shouldNormalize) {
  return seed == null ? null : shouldNormalize ? {
    ...seed,
    value: normalizeNestedDelegatedAnnotationState(seed.value)
  } : seed;
}
function extractOptionalLikePhase2Seed(parser, state, exec) {
  if (!Array.isArray(state) && !(state != null && typeof state === "object"))
    return wrapForMode(parser.mode, null);
  const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
  const hasCarrier = hasDelegatedAnnotationCarrier(innerState);
  const shouldRetryFalseResult = hasCarrier && isAnnotationWrappedInitialState(innerState);
  return dispatchByMode(parser.mode, () => {
    try {
      const result = parser.complete(innerState, exec);
      if (result.success)
        return normalizeOptionalLikePhase2Seed(phase2SeedFromValueResult(result), hasCarrier);
      if (shouldRetryFalseResult) {
        const fallbackState = normalizeDelegatedAnnotationState(innerState);
        const fallbackResult = parser.complete(fallbackState, exec);
        if (fallbackResult.success)
          return normalizeOptionalLikePhase2Seed(phase2SeedFromValueResult(fallbackResult), false);
      }
      const seed = extractPhase2Seed(parser, innerState, exec);
      if (seed == null && hasCarrier) {
        const fallbackState = normalizeDelegatedAnnotationState(innerState);
        return normalizeOptionalLikePhase2Seed(extractPhase2Seed(parser, fallbackState, exec), false);
      }
      return normalizeOptionalLikePhase2Seed(seed, hasCarrier);
    } catch (error) {
      if (!shouldRetryOptionalLikeCompatibilityError(error, innerState))
        throw error;
      const fallbackState = normalizeDelegatedAnnotationState(innerState);
      const result = parser.complete(fallbackState, exec);
      if (result.success)
        return normalizeOptionalLikePhase2Seed(phase2SeedFromValueResult(result), false);
      return normalizeOptionalLikePhase2Seed(extractPhase2Seed(parser, fallbackState, exec), false);
    }
  }, async () => {
    try {
      const result = await parser.complete(innerState, exec);
      if (result.success)
        return normalizeOptionalLikePhase2Seed(phase2SeedFromValueResult(result), hasCarrier);
      if (shouldRetryFalseResult) {
        const fallbackState = normalizeDelegatedAnnotationState(innerState);
        const fallbackResult = await parser.complete(fallbackState, exec);
        if (fallbackResult.success)
          return normalizeOptionalLikePhase2Seed(phase2SeedFromValueResult(fallbackResult), false);
      }
      const seed = await extractPhase2Seed(parser, innerState, exec);
      if (seed == null && hasCarrier) {
        const fallbackState = normalizeDelegatedAnnotationState(innerState);
        return normalizeOptionalLikePhase2Seed(await extractPhase2Seed(parser, fallbackState, exec), false);
      }
      return normalizeOptionalLikePhase2Seed(seed, hasCarrier);
    } catch (error) {
      if (!shouldRetryOptionalLikeCompatibilityError(error, innerState))
        throw error;
      const fallbackState = normalizeDelegatedAnnotationState(innerState);
      const result = await parser.complete(fallbackState, exec);
      if (result.success)
        return normalizeOptionalLikePhase2Seed(phase2SeedFromValueResult(result), false);
      return normalizeOptionalLikePhase2Seed(await extractPhase2Seed(parser, fallbackState, exec), false);
    }
  });
}
function deriveOptionalInnerParseState(outerState, parser) {
  if (Array.isArray(outerState)) {
    const innerState = outerState[0];
    if (getAnnotations(outerState) != null && innerState != null && typeof innerState === "object")
      return getDelegatedAnnotationState(outerState, innerState);
    return innerState;
  }
  const initial = parser.initialState;
  if (initial != null && typeof initial !== "object")
    return initial;
  return initial != null && typeof initial === "object" ? getDelegatedAnnotationState(outerState, initial) : inheritAnnotations(outerState, initial);
}
function parseOptionalStyleSync(context, parser) {
  const innerState = deriveOptionalInnerParseState(context.state, parser);
  const result = parser.parse({
    ...context,
    state: innerState
  });
  return processOptionalStyleResult(result, innerState, context);
}
async function parseOptionalStyleAsync(context, parser) {
  const innerState = deriveOptionalInnerParseState(context.state, parser);
  const result = await parser.parse({
    ...context,
    state: innerState
  });
  return processOptionalStyleResult(result, innerState, context);
}
function hasOptionalLikeParseStateChanged(previousState, nextState) {
  return previousState !== nextState && normalizeDelegatedAnnotationState(previousState) !== normalizeDelegatedAnnotationState(nextState);
}
function processOptionalStyleResult(result, innerState, context) {
  if (result.success) {
    if (hasOptionalLikeParseStateChanged(innerState, result.next.state) || result.consumed.length === 0)
      return {
        success: true,
        ...result.provisional ? { provisional: true } : {},
        next: {
          ...result.next,
          state: [result.next.state]
        },
        consumed: result.consumed
      };
    return {
      success: true,
      ...result.provisional ? { provisional: true } : {},
      next: {
        ...result.next,
        state: context.state
      },
      consumed: result.consumed
    };
  }
  if (result.consumed === 0)
    return {
      success: true,
      next: context,
      consumed: []
    };
  return result;
}
function adaptOptionalStyleParseLanes(parser) {
  const lanes = getOwnParseLanes(parser);
  if (lanes == null)
    return;
  const consumptionGroup = {};
  return lanes.map((lane) => ({
    priority: lane.priority,
    zeroConsumptionGroup: lane.zeroConsumptionGroup,
    settlesZeroConsumption: lane.settlesZeroConsumption,
    leadingNames: lane.leadingNames,
    acceptingAnyToken: false,
    requiredConsumptionGroups: [...lane.requiredConsumptionGroups?.map((group) => ({
      id: group.id,
      ...group.isActive == null ? {} : { isActive(state) {
        const innerState = Array.isArray(state) ? state[0] : parser.initialState;
        return group.isActive?.(innerState) ?? true;
      } }
    })) ?? [], {
      id: consumptionGroup,
      isActive(state) {
        return Array.isArray(state);
      }
    }],
    parse(context) {
      const innerState = deriveOptionalInnerParseState(context.state, parser);
      const innerContext = {
        ...context,
        state: innerState
      };
      return dispatchByMode(parser.mode, () => {
        const result = lane.parse(innerContext);
        return processOptionalStyleResult(result, innerState, context);
      }, async () => {
        const result = await lane.parse(innerContext);
        return processOptionalStyleResult(result, innerState, context);
      });
    }
  }));
}
function adaptShouldDeferCompletion(innerCheck, parser) {
  return (state, exec) => {
    if (Array.isArray(state) || state != null && typeof state === "object") {
      const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
      const hasCarrier = hasDelegatedAnnotationCarrier(innerState);
      const shouldRetryFalseResult = hasCarrier && isAnnotationWrappedInitialState(innerState);
      try {
        const result = innerCheck(innerState, exec);
        if (!result && shouldRetryFalseResult)
          return innerCheck(normalizeDelegatedAnnotationState(innerState), exec);
        return result;
      } catch (error) {
        if (!shouldRetryOptionalLikeCompatibilityError(error, innerState))
          throw error;
        return innerCheck(normalizeDelegatedAnnotationState(innerState), exec);
      }
    }
    return false;
  };
}
function isAnnotationOnlyObjectState(state) {
  if (state == null || typeof state !== "object" || Array.isArray(state) || isInjectedAnnotationWrapper(state))
    return false;
  const keys = Reflect.ownKeys(state);
  return getAnnotations(state) != null && keys.length === 1 && keys[0] === annotationKey;
}
function normalizeOptionalLikeInnerState(state, initialState, parser) {
  if (Array.isArray(state))
    return getDelegatedAnnotationState(state, state[0]);
  if (isAnnotationOnlyObjectState(state)) {
    if (parser != null && (parser.dependencyMetadata?.source != null || typeof parser.shouldDeferCompletion === "function"))
      return getDelegatedAnnotationState(state, initialState);
    return initialState;
  }
  if (state != null && typeof state === "object")
    return state;
  return initialState;
}
function normalizeOptionalLikeSuggestState(state, initialState, parser) {
  if (Array.isArray(state)) {
    const innerState = state[0];
    return innerState != null && typeof innerState === "object" ? getDelegatedAnnotationState(state, innerState) : innerState;
  }
  return normalizeOptionalLikeInnerState(state, initialState, parser);
}
function optional(parser) {
  const syncParser = parser;
  function* suggestSync(context, prefix) {
    const innerState = normalizeOptionalLikeSuggestState(context.state, syncParser.initialState, parser);
    yield* syncParser.suggest({
      ...context,
      state: innerState
    }, prefix);
  }
  async function* suggestAsync(context, prefix) {
    const innerState = normalizeOptionalLikeSuggestState(context.state, syncParser.initialState, parser);
    const suggestions = parser.suggest({
      ...context,
      state: innerState
    }, prefix);
    for await (const s of suggestions)
      yield s;
  }
  const optionalParser = {
    mode: parser.mode,
    $valueType: [],
    $stateType: [],
    ...parser[unmatchedNonCliDependencySourceStateMarker] === true ? { [unmatchedNonCliDependencySourceStateMarker]: true } : {},
    placeholder: undefined,
    priority: parser.priority,
    usage: [{
      type: "optional",
      terms: parser.usage
    }],
    leadingNames: parser.leadingNames,
    acceptingAnyToken: false,
    initialState: undefined,
    canSkip(state, exec) {
      if (!Array.isArray(state))
        return true;
      const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
      return parser.canSkip?.(innerState, exec) === true;
    },
    ...typeof parser.shouldDeferCompletion === "function" ? { shouldDeferCompletion: adaptShouldDeferCompletion(parser.shouldDeferCompletion.bind(parser), parser) } : {},
    getSuggestRuntimeNodes(state, path) {
      if (optionalParser.dependencyMetadata?.source != null)
        return [{
          path,
          parser: optionalParser,
          state
        }];
      const innerState = normalizeOptionalLikeSuggestState(state, parser.initialState, parser);
      return parser.getSuggestRuntimeNodes?.(innerState, path) ?? (parser.dependencyMetadata?.source != null ? [{
        path,
        parser,
        state: innerState
      }] : []);
    },
    [extractPhase2SeedKey](state, exec) {
      return extractOptionalLikePhase2Seed(parser, state, exec);
    },
    parse(context) {
      return dispatchByMode(parser.mode, () => parseOptionalStyleSync(context, syncParser), () => parseOptionalStyleAsync(context, parser));
    },
    complete(state, exec) {
      if (!Array.isArray(state)) {
        const delegateToInner = (resolvedInnerState) => {
          const innerResult = dispatchByMode(parser.mode, () => completeOptionalLikeSync(syncParser, resolvedInnerState, exec), async () => await completeOptionalLikeAsync(parser, resolvedInnerState, exec));
          return mapModeValue(parser.mode, innerResult, (result) => result.success ? result : {
            success: true,
            value: undefined
          });
        };
        if (typeof parser.shouldDeferCompletion === "function" && state != null && typeof state === "object") {
          const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
          return delegateToInner(innerState);
        }
        const sourceMetadata = parser.dependencyMetadata?.source;
        if (sourceMetadata?.preservesSourceValue !== false && sourceMetadata?.getMissingSourceValue != null) {
          const delegatedState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
          return dispatchByMode(parser.mode, () => completeOptionalLikeSync(syncParser, delegatedState, exec), async () => await completeOptionalLikeAsync(parser, delegatedState, exec));
        }
        if (parser[unmatchedNonCliDependencySourceStateMarker] === true && state != null && typeof state === "object") {
          const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
          return delegateToInner(innerState);
        }
        return {
          success: true,
          value: undefined
        };
      }
      const innerElement = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
      return dispatchByMode(parser.mode, () => completeOptionalLikeSync(syncParser, innerElement, exec), async () => await completeOptionalLikeAsync(parser, innerElement, exec));
    },
    suggest(context, prefix) {
      return dispatchIterableByMode(parser.mode, () => suggestSync(context, prefix), () => suggestAsync(context, prefix));
    },
    getDocFragments(state, defaultValue) {
      const innerState = state.kind === "unavailable" ? { kind: "unavailable" } : state.state === undefined ? { kind: "unavailable" } : {
        kind: "available",
        state: state.state[0]
      };
      return syncParser.getDocFragments(innerState, defaultValue);
    }
  };
  if (typeof parser.normalizeValue === "function") {
    const innerNormalize = parser.normalizeValue.bind(parser);
    Object.defineProperty(optionalParser, "normalizeValue", {
      value(v) {
        if (v == null)
          return v;
        return innerNormalize(v);
      },
      configurable: true,
      enumerable: false
    });
  }
  if (typeof parser.validateValue === "function") {
    const innerValidate = parser.validateValue.bind(parser);
    Object.defineProperty(optionalParser, "validateValue", {
      value(v) {
        if (v === undefined)
          return wrapForMode(parser.mode, {
            success: true,
            value: v
          });
        return innerValidate(v);
      },
      configurable: true,
      enumerable: false
    });
  }
  if (parser.dependencyMetadata != null) {
    const composed = composeDependencyMetadata(parser.dependencyMetadata, "optional");
    if (composed != null) {
      const rebound = composed.source?.completeSource == null ? composed : composed.source.preservesSourceValue === false ? {
        ...composed,
        source: {
          ...composed.source,
          completeSource: undefined
        }
      } : {
        ...composed,
        source: {
          ...composed.source,
          completeSource: (state, exec) => Promise.resolve(optionalParser.complete(state, exec))
        }
      };
      optionalParser.dependencyMetadata = rebound;
    }
  }
  defineForwardedEffectfulSchedulingNodes(optionalParser, parser, (state) => Array.isArray(state) && state.length === 1 ? state[0] : state);
  defineParseLanes(optionalParser, adaptOptionalStyleParseLanes(parser));
  defineInheritedAnnotationParser(optionalParser);
  defineSourceBindingOnlyAnnotationCompletionParser(optionalParser);
  defineOptionMatch(optionalParser, (state, token) => getOptionMatch(parser, normalizeOptionalLikeSuggestState(state, parser.initialState, parser), token));
  definePassThroughPriority(optionalParser, [parser], (state, token) => getPassThroughPriority(parser, normalizeOptionalLikeSuggestState(state, parser.initialState, parser), token));
  defineKnownCompletionLookup(optionalParser, (state) => getKnownCompletion(parser, deriveOptionalInnerParseState(state, parser)));
  return fluent(optionalParser);
}
var WithDefaultError = class extends Error {
  errorMessage;
  constructor(message$1) {
    super(formatMessage(message$1));
    this.errorMessage = message$1;
    this.name = "WithDefaultError";
  }
};
function withDefault(parser, defaultValue, options) {
  const syncParser = parser;
  const getDocDefaultValue = (upperDefaultValue) => {
    if (upperDefaultValue != null)
      return upperDefaultValue;
    if (options?.message)
      return;
    if (typeof defaultValue !== "function")
      return defaultValue;
    try {
      return defaultValue();
    } catch {
      return;
    }
  };
  function* suggestSync(context, prefix) {
    const innerState = normalizeOptionalLikeSuggestState(context.state, syncParser.initialState, parser);
    yield* syncParser.suggest({
      ...context,
      state: innerState
    }, prefix);
  }
  async function* suggestAsync(context, prefix) {
    const innerState = normalizeOptionalLikeSuggestState(context.state, syncParser.initialState, parser);
    const suggestions = parser.suggest({
      ...context,
      state: innerState
    }, prefix);
    for await (const s of suggestions)
      yield s;
  }
  const withDefaultParser = {
    mode: parser.mode,
    $valueType: [],
    $stateType: [],
    ...parser[unmatchedNonCliDependencySourceStateMarker] === true ? { [unmatchedNonCliDependencySourceStateMarker]: true } : {},
    priority: parser.priority,
    usage: [{
      type: "optional",
      terms: parser.usage
    }],
    leadingNames: parser.leadingNames,
    acceptingAnyToken: false,
    initialState: undefined,
    canSkip(state, exec) {
      if (!Array.isArray(state))
        return true;
      const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
      return parser.canSkip?.(innerState, exec) === true;
    },
    ...typeof parser.shouldDeferCompletion === "function" ? { shouldDeferCompletion: adaptShouldDeferCompletion(parser.shouldDeferCompletion.bind(parser), parser) } : {},
    getSuggestRuntimeNodes(state, path) {
      if (withDefaultParser.dependencyMetadata?.source != null)
        return [{
          path,
          parser: withDefaultParser,
          state
        }];
      const innerState = normalizeOptionalLikeSuggestState(state, parser.initialState, parser);
      return parser.getSuggestRuntimeNodes?.(innerState, path) ?? (parser.dependencyMetadata?.source != null ? [{
        path,
        parser,
        state: innerState
      }] : []);
    },
    [extractPhase2SeedKey](state, exec) {
      return extractOptionalLikePhase2Seed(parser, state, exec);
    },
    parse(context) {
      return dispatchByMode(parser.mode, () => parseOptionalStyleSync(context, syncParser), () => parseOptionalStyleAsync(context, parser));
    },
    complete(state, exec) {
      function evaluateDefault() {
        const raw = typeof defaultValue === "function" ? defaultValue() : defaultValue;
        if (typeof parser.normalizeValue === "function")
          try {
            return parser.normalizeValue(raw);
          } catch {}
        return raw;
      }
      if (!Array.isArray(state)) {
        if (typeof parser.shouldDeferCompletion === "function" && state != null && typeof state === "object") {
          const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
          const innerResult = dispatchByMode(parser.mode, () => completeOptionalLikeSync(syncParser, innerState, exec), async () => await completeOptionalLikeAsync(parser, innerState, exec));
          return innerResult;
        }
        if (parser[unmatchedNonCliDependencySourceStateMarker] === true && state != null && typeof state === "object") {
          const innerState = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
          const innerResult = dispatchByMode(parser.mode, () => completeOptionalLikeSync(syncParser, innerState, exec), async () => await completeOptionalLikeAsync(parser, innerState, exec));
          const handleInnerResult = (result) => {
            if (result.success && result.value !== undefined)
              return result;
            try {
              return {
                success: true,
                value: evaluateDefault()
              };
            } catch (error) {
              return {
                success: false,
                error: error instanceof WithDefaultError ? error.errorMessage : message`${text(String(error))}`
              };
            }
          };
          return mapModeValue(parser.mode, innerResult, handleInnerResult);
        }
        try {
          const value = evaluateDefault();
          return {
            success: true,
            value
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof WithDefaultError ? error.errorMessage : message`${text(String(error))}`
          };
        }
      }
      const innerElement = normalizeOptionalLikeInnerState(state, parser.initialState, parser);
      return dispatchByMode(parser.mode, () => completeOptionalLikeSync(syncParser, innerElement, exec), async () => await completeOptionalLikeAsync(parser, innerElement, exec));
    },
    suggest(context, prefix) {
      return dispatchIterableByMode(parser.mode, () => suggestSync(context, prefix), () => suggestAsync(context, prefix));
    },
    getDocFragments(state, upperDefaultValue) {
      const innerState = state.kind === "unavailable" ? { kind: "unavailable" } : state.state === undefined ? { kind: "unavailable" } : {
        kind: "available",
        state: state.state[0]
      };
      let docDefault = getDocDefaultValue(upperDefaultValue);
      if (docDefault != null && typeof parser.normalizeValue === "function")
        try {
          docDefault = parser.normalizeValue(docDefault);
        } catch {}
      const fragments = syncParser.getDocFragments(innerState, docDefault);
      if (options?.message) {
        const modifiedFragments = fragments.fragments.map((fragment) => {
          if (fragment.type === "entry")
            return {
              ...fragment,
              default: options.message
            };
          return fragment;
        });
        return withCommandDocMetadata({
          ...fragments,
          fragments: modifiedFragments
        }, getCommandDocMetadata(fragments));
      }
      return fragments;
    }
  };
  if ("placeholder" in parser)
    Object.defineProperty(withDefaultParser, "placeholder", {
      get() {
        return parser.placeholder;
      },
      configurable: true,
      enumerable: false
    });
  if (typeof parser.normalizeValue === "function") {
    const innerNormalize = parser.normalizeValue.bind(parser);
    Object.defineProperty(withDefaultParser, "normalizeValue", {
      value(v) {
        try {
          return innerNormalize(v);
        } catch {
          return v;
        }
      },
      configurable: true,
      enumerable: false
    });
  }
  if (typeof parser.validateValue === "function") {
    const innerValidate = parser.validateValue.bind(parser);
    Object.defineProperty(withDefaultParser, "validateValue", {
      value(v) {
        return innerValidate(v);
      },
      configurable: true,
      enumerable: false
    });
  }
  if (parser.dependencyMetadata != null) {
    const composed = composeDependencyMetadata(parser.dependencyMetadata, "withDefault", { defaultValue: () => {
      let v;
      try {
        v = typeof defaultValue === "function" ? defaultValue() : defaultValue;
      } catch (e) {
        const error = e instanceof WithDefaultError ? e.errorMessage : message`${e instanceof Error ? e.message : String(e)}`;
        return {
          success: false,
          error
        };
      }
      if (typeof parser.normalizeValue === "function")
        try {
          v = parser.normalizeValue(v);
        } catch {}
      return {
        success: true,
        value: v
      };
    } });
    if (composed != null) {
      const rebound = composed.source?.completeSource == null ? composed : composed.source.preservesSourceValue === false ? {
        ...composed,
        source: {
          ...composed.source,
          completeSource: undefined
        }
      } : {
        ...composed,
        source: {
          ...composed.source,
          completeSource: (state, exec) => Promise.resolve(withDefaultParser.complete(state, exec))
        }
      };
      withDefaultParser.dependencyMetadata = rebound;
    }
  }
  defineForwardedEffectfulSchedulingNodes(withDefaultParser, parser, (state) => Array.isArray(state) && state.length === 1 ? state[0] : state);
  defineParseLanes(withDefaultParser, adaptOptionalStyleParseLanes(parser));
  defineInheritedAnnotationParser(withDefaultParser);
  defineSourceBindingOnlyAnnotationCompletionParser(withDefaultParser);
  defineOptionMatch(withDefaultParser, (state, token) => getOptionMatch(parser, normalizeOptionalLikeSuggestState(state, parser.initialState, parser), token));
  definePassThroughPriority(withDefaultParser, [parser], (state, token) => getPassThroughPriority(parser, normalizeOptionalLikeSuggestState(state, parser.initialState, parser), token));
  defineKnownCompletionLookup(withDefaultParser, (state) => getKnownCompletion(parser, deriveOptionalInnerParseState(state, parser)));
  return fluent(withDefaultParser);
}
function map(parser, transform) {
  const complete = (state, exec) => {
    return mapModeValue(parser.mode, parser.complete(state, exec), (result) => {
      if (!result.success)
        return result;
      if (result.deferred)
        try {
          return {
            success: true,
            value: transform(result.value),
            deferred: true
          };
        } catch {
          return {
            success: true,
            value: undefined,
            deferred: true
          };
        }
      return {
        success: true,
        value: transform(result.value)
      };
    });
  };
  const mappedParser = {
    ...parser,
    $valueType: [],
    complete,
    [extractPhase2SeedKey](state, exec) {
      return mapModeValue(parser.mode, completeOrExtractPhase2Seed(parser, state, exec), (seed) => {
        if (seed == null)
          return null;
        if (seed.deferred)
          try {
            return {
              value: transform(seed.value),
              deferred: true
            };
          } catch {
            return {
              value: undefined,
              deferred: true
            };
          }
        return { value: transform(seed.value) };
      });
    },
    getSuggestRuntimeNodes(state, path) {
      if (mappedParser.dependencyMetadata?.source != null)
        return [{
          path,
          parser: mappedParser,
          state
        }];
      return parser.getSuggestRuntimeNodes?.(state, path) ?? (parser.dependencyMetadata?.source != null ? [{
        path,
        parser,
        state
      }] : []);
    },
    getDocFragments(state, _defaultValue) {
      return parser.getDocFragments(state, undefined);
    }
  };
  defineParseLanes(mappedParser, getOwnParseLanes(parser));
  delete mappedParser.normalizeValue;
  delete mappedParser.validateValue;
  if ("placeholder" in parser)
    Object.defineProperty(mappedParser, "placeholder", {
      get() {
        try {
          return transform(parser.placeholder);
        } catch {
          return;
        }
      },
      configurable: true,
      enumerable: false
    });
  if (parser.dependencyMetadata != null) {
    let composed = composeDependencyMetadata(parser.dependencyMetadata, "map");
    if (composed?.derived != null) {
      const innerReplay = composed.derived.replayParse;
      const applyMappedReplay = (r) => {
        if (!r.success)
          return r;
        if (r.deferred)
          try {
            return {
              success: true,
              value: transform(r.value),
              deferred: true
            };
          } catch {
            return {
              success: true,
              value: undefined,
              deferred: true
            };
          }
        return {
          success: true,
          value: transform(r.value)
        };
      };
      composed = {
        ...composed,
        derived: {
          ...composed.derived,
          replayParse: (rawInput, depValues) => {
            const result = innerReplay(rawInput, depValues);
            return isPromiseLike2(result) ? result.then(applyMappedReplay) : applyMappedReplay(result);
          }
        }
      };
    }
    if (composed != null)
      mappedParser.dependencyMetadata = composed;
  }
  defineForwardedEffectfulSchedulingNodes(mappedParser, parser);
  return fluent(mappedParser);
}
var deferredValueBrand = Symbol.for("@optique/core/deferredValue");
function brandDeferredValue(call, source) {
  Object.defineProperties(call, {
    [deferredValueBrand]: {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false
    },
    source: {
      value: source,
      enumerable: true,
      writable: false,
      configurable: false
    }
  });
  return call;
}
function makeSpecifiedDeferredValue(value) {
  return brandDeferredValue((_ctx) => value, "specified");
}
function makeFallbackDeferredValue(fallback, memoize) {
  if (!memoize)
    return brandDeferredValue((ctx) => fallback(ctx), "fallback");
  let settled = false;
  let settledValue;
  let inFlight;
  const call = (ctx) => {
    if (settled)
      return settledValue;
    if (inFlight != null)
      return inFlight;
    const result = fallback(ctx);
    if (!isPromiseLike2(result)) {
      settled = true;
      settledValue = result;
      return result;
    }
    const promise = Promise.resolve(result).then((resolved) => {
      settled = true;
      settledValue = resolved;
      inFlight = undefined;
      return resolved;
    }, (error) => {
      inFlight = undefined;
      throw error;
    });
    inFlight = promise;
    return promise;
  };
  return brandDeferredValue(call, "fallback");
}
function deferredValue(parser, fallback, options) {
  const memoize = options?.memoize ?? false;
  const base = optional(parser);
  const complete = (state, exec) => wrapForMode(base.mode, mapModeValue(base.mode, base.complete(state, exec), (result) => {
    if (!result.success)
      return result;
    const value = result.value === undefined ? makeFallbackDeferredValue(fallback, memoize) : makeSpecifiedDeferredValue(result.value);
    return result.deferred ? {
      success: true,
      value,
      deferred: true
    } : {
      success: true,
      value
    };
  }));
  const descriptors = Object.getOwnPropertyDescriptors(base);
  descriptors.complete = {
    value: complete,
    writable: true,
    enumerable: true,
    configurable: true
  };
  descriptors.$valueType = {
    value: [],
    writable: true,
    enumerable: true,
    configurable: true
  };
  delete descriptors.normalizeValue;
  delete descriptors.validateValue;
  delete descriptors[fluentParserMarker];
  if (descriptors.dependencyMetadata?.value != null)
    descriptors.dependencyMetadata = {
      ...descriptors.dependencyMetadata,
      value: composeDependencyMetadata(descriptors.dependencyMetadata.value, "map")
    };
  const deferredParser = Object.create(Object.getPrototypeOf(base), descriptors);
  return fluent(deferredParser);
}
function multiple(parser, options = {}) {
  const syncParser = parser;
  const { min = 0, max = Infinity } = options;
  const unwrapInjectedWrapper = unwrapInjectedAnnotationWrapper;
  const completeSyncWithUnwrappedFallback = (state, exec) => {
    try {
      const result = syncParser.complete(state, exec);
      if (!result.success && isInjectedAnnotationWrapper(state))
        return syncParser.complete(unwrapInjectedWrapper(state), exec);
      return result;
    } catch (error) {
      if (!isInjectedAnnotationWrapper(state))
        throw error;
      return syncParser.complete(unwrapInjectedWrapper(state), exec);
    }
  };
  const parseSyncWithUnwrappedFallback = (context) => {
    try {
      const result = syncParser.parse(context);
      if (result.success || result.consumed !== 0 || !isInjectedAnnotationWrapper(context.state))
        return result;
      return syncParser.parse({
        ...context,
        state: unwrapInjectedWrapper(context.state)
      });
    } catch (error) {
      if (!isInjectedAnnotationWrapper(context.state))
        throw error;
      return syncParser.parse({
        ...context,
        state: unwrapInjectedWrapper(context.state)
      });
    }
  };
  const completeAsyncWithUnwrappedFallback = async (state, exec) => {
    try {
      const result = await parser.complete(state, exec);
      if (!result.success && isInjectedAnnotationWrapper(state))
        return await parser.complete(unwrapInjectedWrapper(state), exec);
      return result;
    } catch (error) {
      if (!isInjectedAnnotationWrapper(state))
        throw error;
      return await parser.complete(unwrapInjectedWrapper(state), exec);
    }
  };
  const parseAsyncWithUnwrappedFallback = async (context) => {
    try {
      const result = await parser.parse(context);
      if (result.success || result.consumed !== 0 || !isInjectedAnnotationWrapper(context.state))
        return result;
      return await parser.parse({
        ...context,
        state: unwrapInjectedWrapper(context.state)
      });
    } catch (error) {
      if (!isInjectedAnnotationWrapper(context.state))
        throw error;
      return await parser.parse({
        ...context,
        state: unwrapInjectedWrapper(context.state)
      });
    }
  };
  const extractPhase2SeedSyncWithUnwrappedFallback = (state, exec) => {
    try {
      const seed = completeOrExtractPhase2Seed(syncParser, state, exec);
      if (seed == null && isInjectedAnnotationWrapper(state))
        return completeOrExtractPhase2Seed(syncParser, unwrapInjectedWrapper(state), exec);
      return seed;
    } catch (error) {
      if (!isInjectedAnnotationWrapper(state))
        throw error;
      return completeOrExtractPhase2Seed(syncParser, unwrapInjectedWrapper(state), exec);
    }
  };
  const extractPhase2SeedAsyncWithUnwrappedFallback = async (state, exec) => {
    try {
      const seed = await completeOrExtractPhase2Seed(parser, state, exec);
      if (seed == null && isInjectedAnnotationWrapper(state))
        return await completeOrExtractPhase2Seed(parser, unwrapInjectedWrapper(state), exec);
      return seed;
    } catch (error) {
      if (!isInjectedAnnotationWrapper(state))
        throw error;
      return await completeOrExtractPhase2Seed(parser, unwrapInjectedWrapper(state), exec);
    }
  };
  const getInnerSuggestRuntimeNodes = (state, path) => parser.getSuggestRuntimeNodes?.(state, path) ?? (parser.dependencyMetadata?.source != null ? [{
    path,
    parser,
    state
  }] : []);
  const canExtendMultipleItem = (state, itemIndex, exec) => state != null && !isTerminalMultipleItemState(state) && (isMatchedCommandParserState(parser, state) || parser.canSkip?.(state, withChildExecPath(exec, itemIndex)) !== true);
  const parseSync = (context) => {
    const currentItemState = context.state.at(-1);
    const currentItemIndex = context.state.length - 1;
    const canExtendCurrent = canExtendMultipleItem(currentItemState, currentItemIndex, context.exec);
    const canOpenFreshItem = context.state.length < max;
    if (!canExtendCurrent && !canOpenFreshItem)
      return {
        success: true,
        next: context,
        consumed: []
      };
    let added = !canExtendCurrent;
    let itemIndex = canExtendCurrent ? context.state.length - 1 : context.state.length;
    const currentItemStateWithAnnotations = canExtendCurrent ? currentItemState : inheritAnnotations(context.state, syncParser.initialState);
    let result = parseSyncWithUnwrappedFallback(withChildContext(context, itemIndex, currentItemStateWithAnnotations));
    if (!result.success) {
      if (result.consumed !== 0)
        return result;
      if (!added && canOpenFreshItem) {
        const nextInitialState = inheritAnnotations(context.state, syncParser.initialState);
        itemIndex = context.state.length;
        result = parseSyncWithUnwrappedFallback(withChildContext(context, itemIndex, nextInitialState));
        if (!result.success) {
          if (min === 0 && context.buffer.length === 0 && result.consumed === 0)
            return {
              success: true,
              next: context,
              consumed: []
            };
          return result;
        }
        added = true;
      } else if (min === 0 && context.buffer.length === 0)
        return {
          success: true,
          next: context,
          consumed: []
        };
      else
        return result;
    }
    const mergedExec = mergeChildExec(context.exec, result.next.exec);
    if (added && result.consumed.length === 0 && result.next.optionsTerminated === context.optionsTerminated && isUnstartedMultipleItemState(result.next.state, currentItemStateWithAnnotations))
      return {
        success: true,
        next: {
          ...result.next,
          state: context.state,
          ...mergedExec != null ? {
            trace: mergedExec.trace,
            exec: mergedExec,
            dependencyRegistry: mergedExec.dependencyRegistry
          } : {}
        },
        consumed: result.consumed
      };
    const itemAnnotationSource = added ? context.state : currentItemStateWithAnnotations;
    if (result.next.state === currentItemStateWithAnnotations && result.consumed.length > 0 && (!added || result.next.optionsTerminated !== context.optionsTerminated))
      return {
        success: true,
        ...result.provisional ? { provisional: true } : {},
        next: {
          ...result.next,
          state: context.state,
          ...mergedExec != null ? {
            trace: mergedExec.trace,
            exec: mergedExec,
            dependencyRegistry: mergedExec.dependencyRegistry
          } : {}
        },
        consumed: result.consumed
      };
    const nextItemState = inheritAnnotations(itemAnnotationSource, result.next.state);
    return {
      success: true,
      ...result.provisional ? { provisional: true } : {},
      next: {
        ...result.next,
        state: annotateFreshArray(context.state, [...added ? context.state : context.state.slice(0, -1), nextItemState]),
        ...mergedExec != null ? {
          trace: mergedExec.trace,
          exec: mergedExec,
          dependencyRegistry: mergedExec.dependencyRegistry
        } : {}
      },
      consumed: result.consumed
    };
  };
  const parseAsync = async (context) => {
    const currentItemState = context.state.at(-1);
    const currentItemIndex = context.state.length - 1;
    const canExtendCurrent = canExtendMultipleItem(currentItemState, currentItemIndex, context.exec);
    const canOpenFreshItem = context.state.length < max;
    if (!canExtendCurrent && !canOpenFreshItem)
      return {
        success: true,
        next: context,
        consumed: []
      };
    let added = !canExtendCurrent;
    let itemIndex = canExtendCurrent ? context.state.length - 1 : context.state.length;
    const currentItemStateWithAnnotations = canExtendCurrent ? currentItemState : inheritAnnotations(context.state, parser.initialState);
    let result = await parseAsyncWithUnwrappedFallback(withChildContext(context, itemIndex, currentItemStateWithAnnotations));
    if (!result.success) {
      if (result.consumed !== 0)
        return result;
      if (!added && canOpenFreshItem) {
        const nextInitialState = inheritAnnotations(context.state, parser.initialState);
        itemIndex = context.state.length;
        result = await parseAsyncWithUnwrappedFallback(withChildContext(context, itemIndex, nextInitialState));
        if (!result.success) {
          if (min === 0 && context.buffer.length === 0 && result.consumed === 0)
            return {
              success: true,
              next: context,
              consumed: []
            };
          return result;
        }
        added = true;
      } else if (min === 0 && context.buffer.length === 0)
        return {
          success: true,
          next: context,
          consumed: []
        };
      else
        return result;
    }
    const mergedExec = mergeChildExec(context.exec, result.next.exec);
    if (added && result.consumed.length === 0 && result.next.optionsTerminated === context.optionsTerminated && isUnstartedMultipleItemState(result.next.state, currentItemStateWithAnnotations))
      return {
        success: true,
        next: {
          ...result.next,
          state: context.state,
          ...mergedExec != null ? {
            trace: mergedExec.trace,
            exec: mergedExec,
            dependencyRegistry: mergedExec.dependencyRegistry
          } : {}
        },
        consumed: result.consumed
      };
    const itemAnnotationSource = added ? context.state : currentItemStateWithAnnotations;
    if (result.next.state === currentItemStateWithAnnotations && result.consumed.length > 0 && (!added || result.next.optionsTerminated !== context.optionsTerminated))
      return {
        success: true,
        ...result.provisional ? { provisional: true } : {},
        next: {
          ...result.next,
          state: context.state,
          ...mergedExec != null ? {
            trace: mergedExec.trace,
            exec: mergedExec,
            dependencyRegistry: mergedExec.dependencyRegistry
          } : {}
        },
        consumed: result.consumed
      };
    const nextItemState = inheritAnnotations(itemAnnotationSource, result.next.state);
    return {
      success: true,
      ...result.provisional ? { provisional: true } : {},
      next: {
        ...result.next,
        state: annotateFreshArray(context.state, [...added ? context.state : context.state.slice(0, -1), nextItemState]),
        ...mergedExec != null ? {
          trace: mergedExec.trace,
          exec: mergedExec,
          dependencyRegistry: mergedExec.dependencyRegistry
        } : {}
      },
      consumed: result.consumed
    };
  };
  const resultParser = {
    mode: parser.mode,
    $valueType: [],
    $stateType: [],
    priority: parser.priority,
    usage: [{
      type: "multiple",
      terms: parser.usage,
      min
    }],
    leadingNames: parser.leadingNames,
    acceptingAnyToken: min > 0 && (parser.acceptingAnyToken ?? false),
    initialState: [],
    canSkip(state, exec) {
      if (state.length < min)
        return false;
      const currentItemState = state.at(-1);
      return !canExtendMultipleItem(currentItemState, state.length - 1, exec);
    },
    getSuggestRuntimeNodes(state, path) {
      const innerNodes = state.flatMap((item, i) => [...getInnerSuggestRuntimeNodes(item, [...path, i])]);
      return resultParser.dependencyMetadata?.source != null ? [{
        path,
        parser: resultParser,
        state
      }, ...innerNodes] : innerNodes;
    },
    parse(context) {
      return dispatchByMode(parser.mode, () => parseSync(context), () => parseAsync(context));
    },
    complete(state, exec) {
      return dispatchByMode(parser.mode, () => {
        const result = [];
        const deferredIndices = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        for (let i = 0;i < state.length; i++) {
          const valueResult = completeSyncWithUnwrappedFallback(state[i], withChildExecPath(exec, i));
          if (valueResult.success) {
            const unwrappedValue = unwrapInjectedWrapper(valueResult.value);
            result.push(unwrappedValue);
            if (valueResult.deferred)
              if (valueResult.deferredKeys)
                deferredIndices.set(i, valueResult.deferredKeys);
              else if (unwrappedValue == null || typeof unwrappedValue !== "object")
                deferredIndices.set(i, null);
              else
                hasDeferred = true;
          } else
            return {
              success: false,
              error: valueResult.error
            };
        }
        return validateMultipleResult(result, deferredIndices, hasDeferred);
      }, async () => {
        const values = [];
        const deferredIndices = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        for (let i = 0;i < state.length; i++) {
          const valueResult = await completeAsyncWithUnwrappedFallback(state[i], withChildExecPath(exec, i));
          if (valueResult.success) {
            const unwrappedValue = unwrapInjectedWrapper(valueResult.value);
            values.push(unwrappedValue);
            if (valueResult.deferred)
              if (valueResult.deferredKeys)
                deferredIndices.set(i, valueResult.deferredKeys);
              else if (unwrappedValue == null || typeof unwrappedValue !== "object")
                deferredIndices.set(i, null);
              else
                hasDeferred = true;
          } else
            return {
              success: false,
              error: valueResult.error
            };
        }
        return validateMultipleResult(values, deferredIndices, hasDeferred);
      });
    },
    [extractPhase2SeedKey](state, exec) {
      return dispatchByMode(parser.mode, () => {
        const values = [];
        const deferredIndices = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        let hasAnySeed = false;
        for (let i = 0;i < state.length; i++) {
          const seed = extractPhase2SeedSyncWithUnwrappedFallback(state[i], withChildExecPath(exec, i));
          if (seed == null)
            continue;
          hasAnySeed = true;
          values[i] = seed.value;
          if (seed.deferred)
            if (seed.deferredKeys)
              deferredIndices.set(i, seed.deferredKeys);
            else if (seed.value == null || typeof seed.value !== "object")
              deferredIndices.set(i, null);
            else
              hasDeferred = true;
        }
        if (!hasAnySeed)
          return null;
        return {
          value: values,
          ...deferredIndices.size > 0 || hasDeferred ? {
            deferred: true,
            ...deferredIndices.size > 0 ? { deferredKeys: deferredIndices } : {}
          } : {}
        };
      }, async () => {
        const values = [];
        const deferredIndices = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        let hasAnySeed = false;
        for (let i = 0;i < state.length; i++) {
          const seed = await extractPhase2SeedAsyncWithUnwrappedFallback(state[i], withChildExecPath(exec, i));
          if (seed == null)
            continue;
          hasAnySeed = true;
          values[i] = seed.value;
          if (seed.deferred)
            if (seed.deferredKeys)
              deferredIndices.set(i, seed.deferredKeys);
            else if (seed.value == null || typeof seed.value !== "object")
              deferredIndices.set(i, null);
            else
              hasDeferred = true;
        }
        if (!hasAnySeed)
          return null;
        return {
          value: values,
          ...deferredIndices.size > 0 || hasDeferred ? {
            deferred: true,
            ...deferredIndices.size > 0 ? { deferredKeys: deferredIndices } : {}
          } : {}
        };
      });
    },
    suggest(context, prefix) {
      const currentItemState = context.state.at(-1);
      const currentItemIndex = context.state.length - 1;
      const canExtendCurrent = canExtendMultipleItem(currentItemState, currentItemIndex, context.exec);
      const canOpenNew = context.state.length < max;
      if (!canExtendCurrent && !canOpenNew)
        return dispatchIterableByMode(parser.mode, function* () {}, async function* () {});
      const itemIndex = canExtendCurrent ? context.state.length - 1 : context.state.length;
      const suggestInitialState = canExtendCurrent ? currentItemState : inheritAnnotations(context.state, parser.initialState);
      const suggestFallbackState = unwrapInjectedWrapper(suggestInitialState);
      const hasSuggestFallbackState = suggestFallbackState !== suggestInitialState;
      const collectSelectedValuesSync = () => {
        const selectedValues = /* @__PURE__ */ new Set;
        for (let i = 0;i < context.state.length; i++) {
          const childContext = withChildContext(context, i, context.state[i]);
          const completed = completeSyncWithUnwrappedFallback(childContext.state, childContext.exec);
          if (completed.success)
            selectedValues.add(String(unwrapInjectedWrapper(completed.value)));
        }
        return selectedValues;
      };
      const collectSelectedValuesAsync = async () => {
        const selectedValues = /* @__PURE__ */ new Set;
        for (let i = 0;i < context.state.length; i++) {
          const childContext = withChildContext(context, i, context.state[i]);
          const completed = await completeAsyncWithUnwrappedFallback(childContext.state, childContext.exec);
          if (completed.success)
            selectedValues.add(String(unwrapInjectedWrapper(completed.value)));
        }
        return selectedValues;
      };
      const shouldInclude = (selectedValues, suggestion) => {
        if (suggestion.kind === "literal")
          return !selectedValues.has(suggestion.text);
        return true;
      };
      const suggestionKey = (suggestion) => {
        const description = suggestion.description == null ? "" : formatMessage(suggestion.description);
        if (suggestion.kind === "literal")
          return JSON.stringify([
            "literal",
            suggestion.text,
            description
          ]);
        return JSON.stringify([
          "file",
          suggestion.type,
          suggestion.pattern ?? "",
          suggestion.prefix ?? "",
          suggestion.includeHidden === true,
          suggestion.extensions == null ? "" : suggestion.extensions.toSorted().join("\x00"),
          description
        ]);
      };
      return dispatchIterableByMode(parser.mode, function* () {
        const selectedValues = collectSelectedValuesSync();
        const emitted = /* @__PURE__ */ new Map;
        const yieldUnique = function* (suggestions) {
          for (const s of suggestions) {
            const key = suggestionKey(s);
            if (!shouldInclude(selectedValues, s))
              continue;
            const existing = emitted.get(key);
            if (existing === undefined) {
              emitted.set(key, s);
              yield s;
            } else
              mergeJoinedFileSuggestions(existing, s);
          }
        };
        let shouldTryFallback = false;
        try {
          yield* yieldUnique(syncParser.suggest(withChildContext(context, itemIndex, suggestInitialState), prefix));
        } catch (error) {
          if (!hasSuggestFallbackState)
            throw error;
          shouldTryFallback = true;
        }
        if (shouldTryFallback)
          yield* yieldUnique(syncParser.suggest(withChildContext(context, itemIndex, suggestFallbackState), prefix));
      }, async function* () {
        const selectedValues = await collectSelectedValuesAsync();
        const emitted = /* @__PURE__ */ new Map;
        const yieldUnique = async function* (suggestions) {
          for await (const s of suggestions) {
            const key = suggestionKey(s);
            if (!shouldInclude(selectedValues, s))
              continue;
            const existing = emitted.get(key);
            if (existing === undefined) {
              emitted.set(key, s);
              yield s;
            } else
              mergeJoinedFileSuggestions(existing, s);
          }
        };
        let shouldTryFallback = false;
        try {
          yield* yieldUnique(parser.suggest(withChildContext(context, itemIndex, suggestInitialState), prefix));
        } catch (error) {
          if (!hasSuggestFallbackState)
            throw error;
          shouldTryFallback = true;
        }
        if (shouldTryFallback)
          yield* yieldUnique(parser.suggest(withChildContext(context, itemIndex, suggestFallbackState), prefix));
      });
    },
    getDocFragments(state, defaultValue) {
      const latestState = state.kind === "available" && state.state.length > 0 ? state.state.at(-1) : undefined;
      const latestInnerState = latestState != null && isInjectedAnnotationWrapper(latestState) ? unwrapInjectedWrapper(latestState) : latestState;
      const innerState = state.kind === "unavailable" ? { kind: "unavailable" } : latestInnerState !== undefined ? {
        kind: "available",
        state: latestInnerState
      } : { kind: "unavailable" };
      return syncParser.getDocFragments(innerState, defaultValue != null && defaultValue.length > 0 ? defaultValue[0] : undefined);
    }
  };
  function validateMultipleResult(result, deferredIndices, hasDeferred = false) {
    if (result.length < min) {
      const customMessage = options.errors?.tooFew;
      return {
        success: false,
        error: customMessage ? typeof customMessage === "function" ? customMessage(min, result.length) : customMessage : message`Expected at least ${text(min.toLocaleString("en"))} values, but got only ${text(result.length.toLocaleString("en"))}.`
      };
    } else if (result.length > max) {
      const customMessage = options.errors?.tooMany;
      return {
        success: false,
        error: customMessage ? typeof customMessage === "function" ? customMessage(max, result.length) : customMessage : message`Expected at most ${text(max.toLocaleString("en"))} values, but got ${text(result.length.toLocaleString("en"))}.`
      };
    }
    const isDeferred = deferredIndices.size > 0 || hasDeferred;
    return {
      success: true,
      value: result,
      ...isDeferred ? {
        deferred: true,
        ...deferredIndices.size > 0 ? { deferredKeys: deferredIndices } : {}
      } : {}
    };
  }
  Object.defineProperty(resultParser, "placeholder", {
    get() {
      try {
        if (min > 0 && "placeholder" in parser)
          return Array.from({ length: min }, () => parser.placeholder);
      } catch {}
      return [];
    },
    configurable: true,
    enumerable: false
  });
  if (typeof parser.normalizeValue === "function") {
    const innerNormalize = parser.normalizeValue.bind(parser);
    Object.defineProperty(resultParser, "normalizeValue", {
      value(values) {
        if (!Array.isArray(values))
          return values;
        let changed = false;
        const result = values.map((v) => {
          try {
            const n = innerNormalize(v);
            if (n !== v)
              changed = true;
            return n;
          } catch {
            return v;
          }
        });
        return changed ? result : values;
      },
      configurable: true,
      enumerable: false
    });
  }
  {
    const innerValidate = typeof parser.validateValue === "function" ? parser.validateValue.bind(parser) : undefined;
    const validateArity = (values) => {
      if (values.length < min) {
        const customMessage = options.errors?.tooFew;
        return {
          success: false,
          error: customMessage ? typeof customMessage === "function" ? customMessage(min, values.length) : customMessage : message`Expected at least ${text(min.toLocaleString("en"))} values, but got only ${text(values.length.toLocaleString("en"))}.`
        };
      }
      if (values.length > max) {
        const customMessage = options.errors?.tooMany;
        return {
          success: false,
          error: customMessage ? typeof customMessage === "function" ? customMessage(max, values.length) : customMessage : message`Expected at most ${text(max.toLocaleString("en"))} values, but got ${text(values.length.toLocaleString("en"))}.`
        };
      }
      return {
        success: true,
        value: values
      };
    };
    Object.defineProperty(resultParser, "validateValue", {
      value(values) {
        if (!Array.isArray(values)) {
          const actualType = values === null ? "null" : typeof values;
          return wrapForMode(parser.mode, {
            success: false,
            error: message`Expected an array of values, but received ${actualType}.`
          });
        }
        const arity = validateArity(values);
        if (!arity.success)
          return wrapForMode(parser.mode, arity);
        if (innerValidate == null)
          return wrapForMode(parser.mode, arity);
        return dispatchByMode(parser.mode, () => {
          let changed = false;
          const normalized = [];
          for (const v of values) {
            const r = innerValidate(v);
            if (!r.success)
              return r;
            normalized.push(r.value);
            if (r.value !== v)
              changed = true;
          }
          return {
            success: true,
            value: changed ? normalized : values
          };
        }, async () => {
          let changed = false;
          const normalized = [];
          for (const v of values) {
            const r = await innerValidate(v);
            if (!r.success)
              return r;
            normalized.push(r.value);
            if (r.value !== v)
              changed = true;
          }
          return {
            success: true,
            value: changed ? normalized : values
          };
        });
      },
      configurable: true,
      enumerable: false
    });
  }
  if (parser.dependencyMetadata?.source != null) {
    const innerSource = parser.dependencyMetadata.source;
    Object.defineProperty(resultParser, "dependencyMetadata", {
      value: {
        ...parser.dependencyMetadata,
        source: {
          ...innerSource,
          preservesSourceValue: false,
          completeSource: undefined,
          extractSourceValue: (state) => {
            if (!Array.isArray(state))
              return innerSource.extractSourceValue(state);
            const scan = (index) => {
              for (let i = index;i >= 0; i--) {
                const result = innerSource.extractSourceValue(state[i]);
                if (result == null)
                  continue;
                if (isPromiseLike2(result))
                  return Promise.resolve(result).then((resolved) => resolved ?? scan(i - 1));
                return result;
              }
              return;
            };
            return scan(state.length - 1);
          }
        }
      },
      configurable: true,
      enumerable: false
    });
  }
  const matchingItem = (state) => {
    const current = state.at(-1);
    if (current != null && !isTerminalMultipleItemState(current))
      return { state: unwrapInjectedWrapper(current) };
    return state.length < max ? { state: parser.initialState } : undefined;
  };
  defineOptionMatch(resultParser, (state, token) => {
    const item = matchingItem(state);
    return item == null ? undefined : getOptionMatch(parser, item.state, token);
  });
  definePassThroughPriority(resultParser, [parser], (state, token) => {
    const item = matchingItem(state);
    return item == null ? undefined : getPassThroughPriority(parser, item.state, token);
  });
  return fluent(resultParser);
}
function nonEmpty(parser) {
  const syncParser = parser;
  const initialState = parser.initialState;
  const consumptionGroup = {};
  const processNonEmptyResult = (result) => {
    if (!result.success)
      return result;
    if (result.consumed.length === 0)
      return {
        success: false,
        consumed: 0,
        error: message`Parser must consume at least one token.`
      };
    return result;
  };
  const parseSync = (context) => {
    const result = syncParser.parse(context);
    return processNonEmptyResult(result);
  };
  const parseAsync = async (context) => {
    const result = await parser.parse(context);
    return processNonEmptyResult(result);
  };
  const nonEmptyParser = {
    mode: parser.mode,
    $valueType: parser.$valueType,
    $stateType: parser.$stateType,
    priority: parser.priority,
    usage: parser.usage,
    leadingNames: parser.leadingNames,
    acceptingAnyToken: parser.acceptingAnyToken,
    initialState,
    ...typeof parser.canSkip === "function" ? { canSkip(state, exec) {
      const unwrappedState = unwrapInjectedAnnotationWrapper(state);
      if (unwrappedState === initialState)
        return false;
      return parser.canSkip?.(unwrappedState, exec) === true;
    } } : {},
    ...typeof parser.shouldDeferCompletion === "function" ? { shouldDeferCompletion: parser.shouldDeferCompletion.bind(parser) } : {},
    getSuggestRuntimeNodes(state, path) {
      return parser.getSuggestRuntimeNodes?.(state, path) ?? (parser.dependencyMetadata?.source != null ? [{
        path,
        parser,
        state
      }] : []);
    },
    parse(context) {
      return dispatchByMode(parser.mode, () => parseSync(context), () => parseAsync(context));
    },
    complete(state, exec) {
      return parser.complete(state, exec);
    },
    suggest(context, prefix) {
      return parser.suggest(context, prefix);
    },
    getDocFragments(state, defaultValue) {
      return syncParser.getDocFragments(state, defaultValue);
    }
  };
  defineParseLanes(nonEmptyParser, getOwnParseLanes(parser)?.map((lane) => ({
    priority: lane.priority,
    zeroConsumptionGroup: lane.zeroConsumptionGroup,
    settlesZeroConsumption: lane.settlesZeroConsumption,
    leadingNames: lane.leadingNames,
    acceptingAnyToken: lane.acceptingAnyToken,
    requiredConsumptionGroups: [...lane.requiredConsumptionGroups ?? [], { id: consumptionGroup }],
    parse(context) {
      return lane.parse(context);
    }
  })));
  if (parser.dependencyMetadata != null)
    Object.defineProperty(nonEmptyParser, "dependencyMetadata", {
      value: parser.dependencyMetadata,
      configurable: true,
      enumerable: false
    });
  if ("placeholder" in parser)
    Object.defineProperty(nonEmptyParser, "placeholder", {
      get() {
        return parser.placeholder;
      },
      configurable: true,
      enumerable: false
    });
  Object.defineProperty(nonEmptyParser, extractPhase2SeedKey, {
    value(state, exec) {
      return extractPhase2Seed(parser, state, exec);
    },
    configurable: true,
    enumerable: false
  });
  if (typeof parser.normalizeValue === "function")
    Object.defineProperty(nonEmptyParser, "normalizeValue", {
      value: parser.normalizeValue.bind(parser),
      configurable: true,
      enumerable: false
    });
  if (typeof parser.validateValue === "function")
    Object.defineProperty(nonEmptyParser, "validateValue", {
      value: parser.validateValue.bind(parser),
      configurable: true,
      enumerable: false
    });
  defineForwardedEffectfulSchedulingNodes(nonEmptyParser, parser);
  defineOptionMatch(nonEmptyParser, (state, token) => getOptionMatch(parser, state, token));
  definePassThroughPriority(nonEmptyParser, [parser], (state, token) => getPassThroughPriority(parser, state, token));
  return fluent(nonEmptyParser);
}
var fluentParserMarker = Symbol.for("@optique/core/fluent");
function fluent(parser) {
  const fluentParser = parser;
  if (fluentParserMarker in fluentParser)
    return fluentParser;
  Object.defineProperties(fluentParser, {
    [fluentParserMarker]: {
      value: true,
      configurable: true,
      enumerable: false
    },
    map: {
      value(transform) {
        return map(parser, transform);
      },
      configurable: true,
      enumerable: false
    },
    optional: {
      value() {
        return optional(parser);
      },
      configurable: true,
      enumerable: false
    },
    withDefault: {
      value(defaultValue, options) {
        return withDefault(parser, defaultValue, options);
      },
      configurable: true,
      enumerable: false
    },
    multiple: {
      value(options) {
        return multiple(parser, options);
      },
      configurable: true,
      enumerable: false
    },
    nonEmpty: {
      value() {
        return nonEmpty(parser);
      },
      configurable: true,
      enumerable: false
    },
    deferredValue: {
      value(fallback, options) {
        return deferredValue(parser, fallback, options);
      },
      configurable: true,
      enumerable: false
    }
  });
  return fluentParser;
}

// node_modules/@optique/core/dist/internal/command-alias.js
var allowDuplicateLeadingCommandNamesKey = Symbol("allowDuplicateLeadingCommandNames");
var hiddenCommandAliasesKey = Symbol("hiddenCommandAliases");

// node_modules/@optique/core/dist/suggestion.js
function levenshteinDistance(source, target) {
  if (source.length === 0)
    return target.length;
  if (target.length === 0)
    return source.length;
  if (source.length > target.length)
    [source, target] = [target, source];
  let previousRow = new Array(source.length + 1);
  let currentRow = new Array(source.length + 1);
  for (let i = 0;i <= source.length; i++)
    previousRow[i] = i;
  for (let j = 1;j <= target.length; j++) {
    currentRow[0] = j;
    for (let i = 1;i <= source.length; i++) {
      const cost = source[i - 1] === target[j - 1] ? 0 : 1;
      currentRow[i] = Math.min(currentRow[i - 1] + 1, previousRow[i] + 1, previousRow[i - 1] + cost);
    }
    [previousRow, currentRow] = [currentRow, previousRow];
  }
  return previousRow[source.length];
}
var DEFAULT_FIND_SIMILAR_OPTIONS = {
  maxDistance: 3,
  maxDistanceRatio: 0.5,
  maxSuggestions: 3,
  caseSensitive: false
};
function findSimilar(input, candidates, options = {}) {
  const maxDistance = options.maxDistance ?? DEFAULT_FIND_SIMILAR_OPTIONS.maxDistance;
  const maxDistanceRatio = options.maxDistanceRatio ?? DEFAULT_FIND_SIMILAR_OPTIONS.maxDistanceRatio;
  const maxSuggestions = options.maxSuggestions ?? DEFAULT_FIND_SIMILAR_OPTIONS.maxSuggestions;
  const caseSensitive = options.caseSensitive ?? DEFAULT_FIND_SIMILAR_OPTIONS.caseSensitive;
  if (input.length === 0)
    return [];
  const normalizedInput = caseSensitive ? input : input.toLowerCase();
  const matches = [];
  const seen = /* @__PURE__ */ new Set;
  for (const candidate of candidates) {
    const normalizedCandidate = caseSensitive ? candidate : candidate.toLowerCase();
    if (seen.has(candidate))
      continue;
    seen.add(candidate);
    if (normalizedInput === normalizedCandidate)
      return [candidate];
    const minimumDistance = Math.abs(normalizedInput.length - normalizedCandidate.length);
    if (minimumDistance > maxDistance || minimumDistance / input.length > maxDistanceRatio)
      continue;
    const distance = levenshteinDistance(normalizedInput, normalizedCandidate);
    const distanceRatio = distance / input.length;
    if (distance <= maxDistance && distanceRatio <= maxDistanceRatio)
      matches.push({
        candidate,
        distance
      });
  }
  matches.sort((a, b) => {
    if (a.distance !== b.distance)
      return a.distance - b.distance;
    const lengthDiffA = Math.abs(a.candidate.length - input.length);
    const lengthDiffB = Math.abs(b.candidate.length - input.length);
    if (lengthDiffA !== lengthDiffB)
      return lengthDiffA - lengthDiffB;
    return a.candidate.localeCompare(b.candidate);
  });
  return matches.slice(0, maxSuggestions).map((m) => m.candidate);
}
function createSuggestionMessage(suggestions) {
  if (suggestions.length === 0)
    return [];
  if (suggestions.length === 1)
    return message`Did you mean ${optionName(suggestions[0])}?`;
  const messageParts = [text("Did you mean one of these?")];
  for (const suggestion of suggestions) {
    messageParts.push(text(`
  `));
    messageParts.push(optionName(suggestion));
  }
  return messageParts;
}
function expandCommandAliasSuggestions(usage, suggestions) {
  if (suggestions.length === 0)
    return suggestions;
  const commandAliasTargets = collectCommandAliasTargets(usage);
  const expanded = [];
  const seen = /* @__PURE__ */ new Set;
  for (const suggestion of suggestions) {
    const targets = commandAliasTargets.get(suggestion) ?? [suggestion];
    for (const target of targets) {
      if (seen.has(target))
        continue;
      seen.add(target);
      expanded.push(target);
    }
  }
  return expanded;
}
function collectCommandAliasTargets(usage) {
  const targets = /* @__PURE__ */ new Map;
  function traverse(terms) {
    if (!terms || !Array.isArray(terms))
      return true;
    for (const term of terms) {
      if (term.type === "option")
        continue;
      if (term.type === "argument")
        return false;
      if (term.type === "command") {
        if (isSuggestionHidden(term.hidden))
          return false;
        if (!targets.has(term.name))
          targets.set(term.name, [term.name]);
        for (const alias of term.aliases ?? [])
          if (!targets.has(alias))
            targets.set(alias, [term.name, alias]);
        for (const alias of term.hiddenAliases ?? [])
          if (!targets.has(alias))
            targets.set(alias, [term.name]);
        return false;
      }
      if (term.type === "optional") {
        traverse(term.terms);
        continue;
      }
      if (term.type === "multiple") {
        const termsSkippable = traverse(term.terms);
        if (term.min === 0 || termsSkippable)
          continue;
        return false;
      }
      if (term.type === "sequence") {
        if (traverse(term.terms))
          continue;
        return false;
      }
      if (term.type === "exclusive") {
        let anySkippable = false;
        for (const branch of term.terms) {
          const branchSkippable = traverse(branch);
          anySkippable = anySkippable || branchSkippable;
        }
        if (anySkippable)
          continue;
        return false;
      }
      return false;
    }
    return true;
  }
  traverse(usage);
  return targets;
}
function createErrorWithSuggestions(baseError, invalidInput, usage, type = "both", customFormatter) {
  const candidates = /* @__PURE__ */ new Set;
  if (type === "option" || type === "both")
    for (const name of extractOptionNames(usage))
      candidates.add(name);
  if (type === "command" || type === "both")
    for (const name of extractCommandNames(usage))
      candidates.add(name);
  const suggestions = findSimilar(invalidInput, candidates, DEFAULT_FIND_SIMILAR_OPTIONS);
  const displaySuggestions = type === "option" ? suggestions : expandCommandAliasSuggestions(usage, suggestions);
  const suggestionMsg = customFormatter ? customFormatter(displaySuggestions) : createSuggestionMessage(displaySuggestions);
  return suggestionMsg.length > 0 ? [
    ...baseError,
    text(`

`),
    ...suggestionMsg
  ] : baseError;
}
function appendValueSuggestions(base, suggestions) {
  if (suggestions.length === 0)
    return base;
  let suggestionMsg;
  if (suggestions.length === 1)
    suggestionMsg = message`Did you mean ${value(suggestions[0])}?`;
  else {
    const parts = [text("Did you mean one of these?")];
    for (const suggestion of suggestions)
      parts.push(lineBreak(), text("  "), value(suggestion));
    suggestionMsg = parts;
  }
  return base.length > 0 ? [
    ...base,
    lineBreak(),
    lineBreak(),
    ...suggestionMsg
  ] : suggestionMsg;
}
function appendValueHint(base, input, candidates, options) {
  const suggestions = findSimilar(input, candidates, options != null ? {
    maxDistance: options.maxDistance ?? DEFAULT_FIND_SIMILAR_OPTIONS.maxDistance,
    maxDistanceRatio: DEFAULT_FIND_SIMILAR_OPTIONS.maxDistanceRatio,
    maxSuggestions: options.maxSuggestions ?? DEFAULT_FIND_SIMILAR_OPTIONS.maxSuggestions
  } : undefined);
  return appendValueSuggestions(base, suggestions);
}
function getSuggestionKey(suggestion) {
  if (suggestion.kind === "literal")
    return `literal:${suggestion.text}`;
  return `file:${JSON.stringify([
    suggestion.type,
    suggestion.extensions?.toSorted().join(",") ?? "",
    suggestion.pattern ?? "",
    suggestion.prefix ?? ""
  ])}`;
}
function deduplicateSuggestions(suggestions) {
  const entries = /* @__PURE__ */ new Map;
  const order = [];
  for (const suggestion of suggestions) {
    const key = getSuggestionKey(suggestion);
    const existing = entries.get(key);
    if (existing == null) {
      entries.set(key, suggestion);
      order.push(key);
    } else if (suggestion.kind === "literal" && existing.kind === "literal")
      mergeJoinedFileSuggestions(existing, suggestion);
    else if (suggestion.kind === "file" && existing.kind === "file" && suggestion.includeHidden === true && existing.includeHidden !== true)
      entries.set(key, {
        ...existing,
        includeHidden: true
      });
  }
  return order.map((key) => entries.get(key));
}

// node_modules/@optique/core/dist/usage-internals.js
function collectLeadingCandidates(terms, optionNames, commandNames, includeHidden = false) {
  if (!terms || !Array.isArray(terms))
    return true;
  for (const term of terms) {
    if (term.type === "option") {
      if (includeHidden || !isSuggestionHidden(term.hidden))
        for (const name of term.names)
          optionNames.add(name);
      return false;
    }
    if (term.type === "command") {
      if (includeHidden || !isSuggestionHidden(term.hidden)) {
        commandNames.add(term.name);
        for (const alias of term.aliases ?? [])
          commandNames.add(alias);
        for (const alias of term.hiddenAliases ?? [])
          commandNames.add(alias);
      }
      return false;
    }
    if (term.type === "argument")
      return false;
    if (term.type === "optional") {
      collectLeadingCandidates(term.terms, optionNames, commandNames, includeHidden);
      continue;
    }
    if (term.type === "multiple") {
      collectLeadingCandidates(term.terms, optionNames, commandNames, includeHidden);
      if (term.min === 0)
        continue;
      return false;
    }
    if (term.type === "sequence") {
      if (collectLeadingCandidates(term.terms, optionNames, commandNames, includeHidden))
        continue;
      return false;
    }
    if (term.type === "exclusive") {
      let allSkippable = true;
      for (const branch of term.terms) {
        const branchSkippable = collectLeadingCandidates(branch, optionNames, commandNames, includeHidden);
        allSkippable = allSkippable && branchSkippable;
      }
      if (allSkippable)
        continue;
      return false;
    }
  }
  return true;
}
function extractLeadingCommandNames(usage) {
  const options = /* @__PURE__ */ new Set;
  const commands = /* @__PURE__ */ new Set;
  collectLeadingCandidates(usage, options, commands);
  return commands;
}

// node_modules/@optique/core/dist/constructs.js
var EMPTY_LEADING_NAMES = /* @__PURE__ */ new Set;
function isNonCliBoundSourceState(state, parser) {
  return parser[unmatchedNonCliDependencySourceStateMarker] === true && state != null && typeof state === "object" && Object.hasOwn(state, "hasCliValue") && state.hasCliValue === false;
}
function withDependencyRuntimeExec(usage, exec, runtime) {
  if (exec == null)
    return {
      usage,
      phase: "complete",
      path: [],
      trace: undefined,
      dependencyRuntime: runtime,
      dependencyRegistry: runtime.registry
    };
  return {
    ...exec,
    dependencyRuntime: runtime,
    dependencyRegistry: runtime.registry
  };
}
function withChildContext$1(context, segment, state, parser, usage) {
  const childState = parser == null ? state : getWrappedChildParseState(context.state, state, parser);
  return withChildContext(context, segment, childState, usage);
}
function isUnmatchedDependencyState(state, parser) {
  if (state === undefined)
    return true;
  if (Array.isArray(state) && state.length === 1 && isPendingDependencySourceState(state[0]))
    return true;
  if (isPendingDependencySourceState(state))
    return true;
  if (isNonCliBoundSourceState(state, parser))
    return true;
  return state === parser.initialState;
}
function filterPreCompletedRuntimeNodes(nodes, preCompletedKeys) {
  if (preCompletedKeys.size < 1)
    return nodes;
  return nodes.filter((node) => {
    const segment = node.path.at(-1);
    if (typeof segment === "number")
      return !preCompletedKeys.has(String(segment));
    return segment == null || !preCompletedKeys.has(segment);
  });
}
function filterSchedulableRuntimeNodes(nodes, preCompleted) {
  const settledKeys = settledPreCompletedKeys(preCompleted);
  if (settledKeys.size < 1)
    return nodes;
  return nodes.filter((node) => {
    if (node.parser.dependencyMetadata?.source?.completeSource == null)
      return true;
    const segment = node.path.at(-1);
    if (typeof segment === "number")
      return !settledKeys.has(String(segment));
    return segment == null || !settledKeys.has(segment);
  });
}
var preExpandedBranchNodes = /* @__PURE__ */ new WeakSet;
function expandEffectfulRuntimeNodes(nodes, options) {
  const expanded = [];
  const visit = (node) => {
    const meta = node.parser.dependencyMetadata;
    const optedIntoCollection = node.parser[sourceCollectionExpansionKey] === true;
    if (options?.structuralOnly === true && !optedIntoCollection && exclusiveSourceScopeKey in node.parser) {
      expanded.push(node);
      return;
    }
    const schedulingNodes = node.parser[effectfulSchedulingNodesKey];
    const expandsThroughHook = schedulingNodes != null && meta?.derived == null && optedIntoCollection;
    if (!expandsThroughHook && (meta?.source?.completeSource != null || meta?.derived != null)) {
      expanded.push(node);
      return;
    }
    if (schedulingNodes != null) {
      const children = schedulingNodes(node.state, node.path, options);
      if (children.length === 0 && meta?.source != null) {
        expanded.push(node);
        return;
      }
      for (const child of children)
        visit(child);
      return;
    }
    const pairs = node.parser[fieldParsersKey];
    if (pairs == null || node.state == null || typeof node.state !== "object") {
      expanded.push(node);
      return;
    }
    const duplicateFieldNames = collectDuplicateFieldNames(pairs);
    const state = node.state;
    for (const [field, childParser] of pairs) {
      if (duplicateFieldNames.has(field))
        continue;
      const segment = Array.isArray(state) && typeof field === "string" ? Number(field) : field;
      const childState = Array.isArray(state) ? state[segment] : state[field];
      const annotatedChildState = getWrappedChildState(state, childState, childParser);
      const isDerived = childParser.dependencyMetadata?.derived != null;
      const rawInput = isDerived ? extractRawInputFromState(annotatedChildState) : undefined;
      const defaultDependencyValues = isDerived ? getDefaultDependencySnapshot(annotatedChildState) : undefined;
      visit({
        path: [...node.path, segment],
        parser: childParser,
        state: annotatedChildState,
        ...rawInput != null ? { rawInput } : {},
        ...defaultDependencyValues != null ? { defaultDependencyValues } : {}
      });
    }
  };
  for (const node of nodes)
    visit(node);
  return expanded;
}
function expandSourceCollectionNodes(nodes) {
  let expanded;
  for (let i = 0;i < nodes.length; i++) {
    const node = nodes[i];
    const optedIn = node.parser[sourceCollectionExpansionKey] === true;
    if (optedIn) {
      if (expanded == null)
        expanded = nodes.slice(0, i);
      expanded.push(...expandEffectfulRuntimeNodes([node]));
      continue;
    }
    const nested = nestedCommandLineSourceNodes(node);
    if (nested.length < 1) {
      expanded?.push(node);
      continue;
    }
    if (expanded == null)
      expanded = nodes.slice(0, i);
    expanded.push(node, ...nested);
  }
  return expanded ?? nodes;
}
function nestedCommandLineSourceNodes(node) {
  const nested = [];
  for (const descendant of expandEffectfulRuntimeNodes([node], { structuralOnly: true })) {
    if (descendant === node)
      continue;
    if (descendant.parser.dependencyMetadata?.source == null)
      continue;
    if (((exclusiveSourceScopeKey in descendant.parser) || descendant.parser.dependencyMetadata?.source?.exclusiveOccurrence === true) && descendant.parser[sourceCollectionExpansionKey] !== true)
      continue;
    if (!hasCommandLineSourceInput(descendant))
      continue;
    nested.push({
      ...descendant,
      matched: true
    });
  }
  return nested;
}
function isEmptySourceState(state) {
  if (state == null)
    return true;
  if (Array.isArray(state))
    return state.length < 1;
  if (typeof state !== "object")
    return false;
  return Object.getOwnPropertyNames(state).length < 1;
}
function hasCommandLineSourceInput(node) {
  const parser = node.parser;
  if (!isMatchedState(node.state, parser))
    return false;
  const innerState = Array.isArray(node.state) && node.state.length === 1 ? node.state[0] : node.state;
  if (isEmptySourceState(innerState))
    return false;
  if (parser[unmatchedNonCliDependencySourceStateMarker] !== true)
    return true;
  return innerState != null && typeof innerState === "object" && innerState.hasCliValue === true;
}
function isDeferredCompletionResult(result) {
  return typeof result === "object" && result !== null && "success" in result && result.success === true && "deferred" in result && result.deferred === true;
}
function settledPreCompletedKeys(preCompleted) {
  const keys = /* @__PURE__ */ new Set;
  for (const [key, result] of preCompleted) {
    const completion = isDependencySourceState(result) ? result.result : result;
    if (isDeferredCompletionResult(completion))
      continue;
    keys.add(key);
  }
  return keys;
}
function firstPreCompletedFailure(preCompleted) {
  for (const result of preCompleted.values()) {
    const completion = isDependencySourceState(result) ? result.result : result;
    if (typeof completion === "object" && completion !== null && "success" in completion && completion.success === false && "error" in completion)
      return completion.error;
  }
  return;
}
async function scheduleEffectfulSourceCompletions(nodes, state, runtime, exec, preCompleted, demandNodes) {
  const preCompletedFailure = firstPreCompletedFailure(preCompleted);
  if (preCompletedFailure != null)
    return {
      success: false,
      error: preCompletedFailure
    };
  const direct = new Set(nodes.filter((node) => !preExpandedBranchNodes.has(node)));
  const collected = /* @__PURE__ */ new Set;
  const expandedNodes = [];
  for (const node of nodes) {
    const optedIn = node.parser[sourceCollectionExpansionKey] === true;
    const preExpanded = preExpandedBranchNodes.has(node);
    const nestedPaths = optedIn || preExpanded ? undefined : new Set(nestedCommandLineSourceNodes(node).map((nested) => serializeSchedulingPath(nested.path)));
    for (const expandedNode of expandEffectfulRuntimeNodes([node])) {
      expandedNodes.push(expandedNode);
      if (preExpanded)
        continue;
      if (optedIn || expandedNode === node || nestedPaths?.has(serializeSchedulingPath(expandedNode.path)) === true)
        collected.add(expandedNode);
    }
  }
  const republish = exec?.republishCachedCompletions === true;
  const publishedSourceIds = /* @__PURE__ */ new Set;
  const effectful = await completeEffectfulSourcesAsync(expandedNodes, state, runtime, exec, {
    ...demandNodes != null ? { demandNodes: expandEffectfulRuntimeNodes(demandNodes) } : {},
    onPublish: (id) => {
      publishedSourceIds.add(id);
    },
    isReusable: (node) => direct.has(node),
    isCollected: republish ? () => true : (node) => collected.has(node),
    ...republish ? { includeStructural: true } : {}
  });
  if (!effectful.success)
    return {
      success: false,
      error: effectful.error
    };
  for (const { key, result } of effectful.completed) {
    const cacheKey = typeof key === "number" ? String(key) : key;
    preCompleted.set(cacheKey, result);
  }
  recordSourceScope(runtime, publishedSourceIds, [...collected].flatMap((node) => {
    const source = node.parser.dependencyMetadata?.source;
    return source == null ? [] : [{
      sourceId: source.sourceId,
      path: node.path
    }];
  }));
  return;
}
function unionLeadingNames(parsers) {
  const names = /* @__PURE__ */ new Set;
  for (const p of parsers)
    for (const name of p.leadingNames)
      names.add(name);
  return names.size === 0 ? EMPTY_LEADING_NAMES : names;
}
function sharedBufferLeadingNames(parsers) {
  const sorted = parsers.toSorted((a, b) => b.priority - a.priority);
  const names = /* @__PURE__ */ new Set;
  let positionalBlocked = false;
  for (const p of sorted) {
    if (p.leadingNames)
      for (const name of p.leadingNames) {
        if (positionalBlocked && !name.startsWith("-"))
          continue;
        names.add(name);
      }
    if (p.acceptingAnyToken)
      positionalBlocked = true;
  }
  return names.size === 0 ? EMPTY_LEADING_NAMES : names;
}
function orderBeforePassThrough(pairs, context, getParser, getState, passThroughParsers) {
  const token = context.buffer[0];
  if (passThroughParsers.size === 0 || context.optionsTerminated || token == null || token === "--" || !/^[-/+]/.test(token))
    return pairs;
  const matches = new Map(pairs.map((pair) => [pair, getOptionMatch(getParser(pair), getState(pair), token)]));
  const normalizedOptions = /* @__PURE__ */ new Map;
  const captures = new Map(pairs.flatMap((pair) => {
    if (!passThroughParsers.has(getParser(pair)))
      return [];
    const priority = getPassThroughPriority(getParser(pair), getState(pair), token);
    const match = matches.get(pair);
    if (match != null && (priority == null || match.priority >= priority)) {
      const unfiltered = getPassThroughPriority(getParser(pair), getState(pair));
      if (priority == null || unfiltered != null && unfiltered > match.priority)
        normalizedOptions.set(pair, match.priority);
      return [];
    }
    return priority == null ? [] : [[pair, priority]];
  }));
  const matching = pairs.filter((pair) => !captures.has(pair)).flatMap((pair) => {
    const match = matches.get(pair);
    return match == null ? [] : [match];
  });
  const orderedCaptures = [...captures].sort((a, b) => b[1] - a[1]);
  if (matching.length === 0) {
    let captureIndex = 0;
    return pairs.map((pair) => captures.has(pair) ? orderedCaptures[captureIndex++][0] : pair);
  }
  const matchingPriority = Math.max(...matching.map((match) => match.priority));
  const ordinary = pairs.filter((pair) => !captures.has(pair) && !normalizedOptions.has(pair));
  const positions = new Map(pairs.map((pair, index) => [pair, index]));
  for (const [pair, priority] of [...normalizedOptions].sort((a, b) => b[1] - a[1])) {
    let insertion = ordinary.findIndex((candidate) => {
      const match = matches.get(candidate);
      return match != null && (match.priority < priority || match.priority === priority && positions.get(pair) < positions.get(candidate));
    });
    if (insertion < 0) {
      const lastMatch = ordinary.findLastIndex((candidate) => matches.get(candidate) != null);
      insertion = lastMatch >= 0 ? lastMatch + 1 : ordinary.findIndex((candidate) => positions.get(candidate) > positions.get(pair));
      if (insertion < 0)
        insertion = ordinary.length;
    }
    ordinary.splice(insertion, 0, pair);
  }
  const first = ordinary.findIndex((pair) => matches.get(pair) != null);
  const last = ordinary.findLastIndex((pair) => matches.get(pair) != null);
  const before = orderedCaptures.filter(([, priority]) => priority > matchingPriority).map(([pair]) => pair);
  const after = orderedCaptures.filter(([, priority]) => priority <= matchingPriority).map(([pair]) => pair);
  return [
    ...ordinary.slice(0, first),
    ...before,
    ...ordinary.slice(first, last + 1),
    ...after,
    ...ordinary.slice(last + 1)
  ];
}
var fieldParsersKey = Symbol("fieldParsers");
function containsAnnotationView(value, seen = /* @__PURE__ */ new WeakSet) {
  if (value == null || typeof value !== "object")
    return false;
  const candidate = value;
  if (annotationViewTargets.has(candidate))
    return true;
  const source = unwrapAnnotationView(candidate);
  if (seen.has(source))
    return false;
  seen.add(source);
  if (Array.isArray(source))
    return source.some((item) => containsAnnotationView(item, seen));
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null)
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  return Reflect.ownKeys(descriptors).some((key) => {
    const descriptor = descriptors[key];
    return descriptor != null && "value" in descriptor ? containsAnnotationView(descriptor.value, seen) : false;
  });
}
function unwrapNestedAnnotationViews(value, seen = /* @__PURE__ */ new WeakMap) {
  if (value == null || typeof value !== "object")
    return value;
  const source = unwrapAnnotationView(value);
  if (seen.has(source))
    return seen.get(source);
  if (Array.isArray(source)) {
    let changed$1 = false;
    const clone$1 = [...source];
    seen.set(source, clone$1);
    for (let i = 0;i < source.length; i++) {
      const nextValue = unwrapNestedAnnotationViews(source[i], seen);
      if (nextValue !== source[i]) {
        clone$1[i] = nextValue;
        changed$1 = true;
      }
    }
    if (!changed$1) {
      seen.set(source, source);
      return source;
    }
    return clone$1;
  }
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null)
    return source;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  let changed = false;
  const clone = Object.create(proto);
  seen.set(source, clone);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor != null && "value" in descriptor) {
      const nextValue = unwrapNestedAnnotationViews(descriptor.value, seen);
      if (nextValue !== descriptor.value) {
        descriptors[key] = {
          ...descriptor,
          value: nextValue
        };
        changed = true;
      }
    }
  }
  if (!changed) {
    seen.set(source, source);
    return source;
  }
  Object.defineProperties(clone, descriptors);
  return clone;
}
function unwrapCompleteResult(result) {
  const unwrappedResult = isDependencySourceState(result) ? result.result : result;
  if (!unwrappedResult.success || !containsAnnotationView(unwrappedResult.value))
    return unwrappedResult;
  const value = unwrapNestedAnnotationViews(unwrappedResult.value);
  return value === unwrappedResult.value ? unwrappedResult : {
    ...unwrappedResult,
    value
  };
}
function reusePreCompletedPhase2Seed(parser, state, preCompletedResult, exec) {
  const result = unwrapCompleteResult(preCompletedResult);
  return result.success ? phase2SeedFromValueResult(result) : extractPhase2Seed(parser, state, exec);
}
async function reusePreCompletedPhase2SeedAsync(parser, state, preCompletedResult, exec) {
  const result = unwrapCompleteResult(preCompletedResult);
  return result.success ? phase2SeedFromValueResult(result) : await extractPhase2Seed(parser, state, exec);
}
function extractOrCompletePhase2SeedSync(parser, state, exec) {
  const extracted = extractPhase2Seed(parser, state, exec);
  if (extracted != null)
    return extracted;
  const result = parser.complete(state, exec);
  return result.success ? phase2SeedFromValueResult(result) : null;
}
async function extractOrCompletePhase2SeedAsync(parser, state, exec) {
  const extracted = await extractPhase2Seed(parser, state, exec);
  if (extracted != null)
    return extracted;
  const result = await parser.complete(state, exec);
  return result.success ? phase2SeedFromValueResult(result) : null;
}
function getAnnotatedFieldState(parentState, field, parser) {
  const sourceState = parentState != null && typeof parentState === "object" && field in parentState ? parentState[field] : parser.initialState;
  return getWrappedChildState(parentState, sourceState, parser);
}
function getObjectParseChildState(parentState, childState, _parser) {
  return reconcileObjectChildState(parentState, childState);
}
function buildSuggestRuntimeNodesFromPairs(pairs, state, parentPath) {
  const prefix = parentPath ?? [];
  const nodes = [];
  for (const [field, parser] of pairs) {
    const fieldState = Object.hasOwn(state, field) ? state[field] : parser.initialState;
    nodes.push(...getParserSuggestRuntimeNodes(parser, getWrappedChildState(state, fieldState, parser), [...prefix, field]));
  }
  return nodes;
}
function createUnexpectedInputErrorWithScopedSuggestions(baseError, invalidInput, parsers, customFormatter) {
  const options = /* @__PURE__ */ new Set;
  const commands = /* @__PURE__ */ new Set;
  for (const parser of parsers)
    collectLeadingCandidates(parser.usage, options, commands);
  const candidates = new Set([...options, ...commands]);
  const suggestions = findSimilar(invalidInput, candidates, DEFAULT_FIND_SIMILAR_OPTIONS);
  const aliasUsage = [{
    type: "exclusive",
    terms: parsers.map((parser) => parser.usage)
  }];
  const displaySuggestions = expandCommandAliasSuggestions(aliasUsage, suggestions);
  const suggestionMsg = customFormatter ? customFormatter(displaySuggestions) : createSuggestionMessage(displaySuggestions);
  return suggestionMsg.length > 0 ? [
    ...baseError,
    text(`

`),
    ...suggestionMsg
  ] : baseError;
}
function applyHiddenToUsageTerm(term, hidden) {
  if (hidden == null)
    return term;
  if (term.type === "optional")
    return {
      type: "optional",
      terms: applyHiddenToUsage(term.terms, hidden)
    };
  if (term.type === "multiple")
    return {
      type: "multiple",
      terms: applyHiddenToUsage(term.terms, hidden),
      min: term.min
    };
  if (term.type === "sequence")
    return {
      type: "sequence",
      terms: applyHiddenToUsage(term.terms, hidden)
    };
  if (term.type === "exclusive")
    return {
      type: "exclusive",
      terms: term.terms.map((u) => applyHiddenToUsage(u, hidden))
    };
  if (term.type === "argument" || term.type === "option" || term.type === "command" || term.type === "passthrough")
    return {
      ...term,
      hidden: mergeHidden(term.hidden, hidden)
    };
  return term;
}
function applyHiddenToUsage(usage, hidden) {
  if (hidden == null)
    return usage;
  return usage.map((term) => applyHiddenToUsageTerm(term, hidden));
}
function applyHiddenToDocEntry(entry, hidden) {
  const mergedTerm = applyHiddenToUsageTerm(entry.term, hidden);
  if ((mergedTerm.type === "argument" || mergedTerm.type === "option" || mergedTerm.type === "command" || mergedTerm.type === "passthrough") && isDocHidden(mergedTerm.hidden))
    return;
  return {
    ...entry,
    term: mergedTerm
  };
}
function applyHiddenToDocFragments(fragments, hidden) {
  if (hidden == null)
    return fragments;
  const result = [];
  for (const fragment of fragments) {
    if (fragment.type === "entry") {
      const entry = applyHiddenToDocEntry(fragment, hidden);
      if (entry != null)
        result.push({
          ...entry,
          type: "entry"
        });
      continue;
    }
    const entries = fragment.entries.map((entry) => applyHiddenToDocEntry(entry, hidden)).filter((entry) => entry != null);
    result.push({
      type: "section",
      title: fragment.title,
      entries
    });
  }
  return result;
}
function isOptionRequiringValue(usage, token) {
  function traverse(terms) {
    if (!terms || !Array.isArray(terms))
      return false;
    for (const term of terms)
      if (term.type === "option") {
        if (term.metavar && term.names.includes(token))
          return true;
      } else if (term.type === "optional" || term.type === "multiple" || term.type === "sequence") {
        if (traverse(term.terms))
          return true;
      } else if (term.type === "exclusive") {
        for (const exclusiveUsage of term.terms)
          if (traverse(exclusiveUsage))
            return true;
      }
    return false;
  }
  return traverse(usage);
}
function extractRequiredUsage(usage) {
  const required = [];
  for (const term of usage)
    if (term.type === "optional")
      continue;
    else if (term.type === "exclusive") {
      const requiredBranches = term.terms.map((branch) => extractRequiredUsage(branch)).filter((branch) => branch.length > 0);
      if (requiredBranches.length > 0)
        required.push({
          type: "exclusive",
          terms: requiredBranches
        });
    } else if (term.type === "multiple") {
      if (term.min > 0) {
        const requiredTerms = extractRequiredUsage(term.terms);
        if (requiredTerms.length > 0)
          required.push({
            type: "multiple",
            terms: requiredTerms,
            min: term.min
          });
      }
    } else
      required.push(term);
  return required;
}
function assertParsers(parsers, callerName) {
  for (let i = 0;i < parsers.length; i++) {
    const p = parsers[i];
    const r = p;
    if (p == null || typeof p !== "object" && typeof p !== "function" || !(r.mode === "sync" || r.mode === "async") || !Array.isArray(r.usage) || typeof r.priority !== "number" || Number.isNaN(r.priority) || !("initialState" in p) || typeof r.parse !== "function" || typeof r.complete !== "function" || typeof r.suggest !== "function" || typeof r.getDocFragments !== "function")
      throw new TypeError(`${callerName} argument at index ${i} is not a valid Parser.`);
  }
}
function analyzeNoMatchContext(parsers) {
  const combinedUsage = [{
    type: "exclusive",
    terms: parsers.map((p) => p.usage)
  }];
  const requiredUsage = extractRequiredUsage(combinedUsage);
  return {
    hasOptions: extractOptionNames(requiredUsage).size > 0,
    hasCommands: extractCommandNames(requiredUsage).size > 0,
    hasArguments: extractArgumentMetavars(requiredUsage).size > 0
  };
}
var DuplicateOptionError = class extends Error {
  optionName;
  sources;
  constructor(optionName$1, sources) {
    const sourceNames = sources.map((s) => typeof s === "symbol" ? s.description ?? s.toString() : s);
    super(`Duplicate option name "${optionName$1}" found in fields: ${sourceNames.join(", ")}. Each option name must be unique within a parser combinator.`);
    this.name = "DuplicateOptionError";
    this.optionName = optionName$1;
    this.sources = sources;
  }
};
var DuplicateCommandNameError = class extends TypeError {
  commandName;
  sources;
  constructor(commandName, sources) {
    const sourceNames = sources.map((s) => typeof s === "symbol" ? s.description ?? s.toString() : s);
    super(`Duplicate command name "${commandName}" found in parsers: ${sourceNames.join(", ")}. Each command name or alias must be unique within active parser alternatives.`);
    this.commandName = commandName;
    this.sources = sources;
  }
};
function checkDuplicateOptionNames(parserSources) {
  const optionNameSources = /* @__PURE__ */ new Map;
  for (const [source, usage] of parserSources) {
    const names = extractParsableOptionNames(usage);
    for (const name of names) {
      if (!optionNameSources.has(name))
        optionNameSources.set(name, []);
      optionNameSources.get(name).push(source);
    }
  }
  for (const [name, sources] of optionNameSources)
    if (sources.length > 1)
      throw new DuplicateOptionError(name, sources);
}
function checkDuplicateLeadingCommandNames(parserSources) {
  const commandNameSources = /* @__PURE__ */ new Map;
  for (const [source, parser] of parserSources) {
    const commandNames = extractCommandNames(parser.usage, true);
    for (const name of parser.leadingNames) {
      if (!commandNames.has(name))
        continue;
      const sources = commandNameSources.get(name);
      commandNameSources.set(name, sources == null ? [source] : [...sources, source]);
    }
  }
  for (const [name, sources] of commandNameSources)
    if (sources.length > 1)
      throw new DuplicateCommandNameError(name, sources);
}
function checkDuplicateReachableLeadingCommandNames(parserSources) {
  const commandNameSources = /* @__PURE__ */ new Map;
  const sortedSources = [...parserSources].sort(([, parserA], [, parserB]) => parserB.priority - parserA.priority);
  const blockedNames = /* @__PURE__ */ new Set;
  let positionalBlocked = false;
  for (let i = 0;i < sortedSources.length; ) {
    const priority = sortedSources[i][1].priority;
    const priorityGroup = [];
    while (i < sortedSources.length && sortedSources[i][1].priority === priority) {
      priorityGroup.push(sortedSources[i]);
      i++;
    }
    const groupNames = /* @__PURE__ */ new Set;
    let groupAcceptsAnyToken = false;
    for (const [source, parser] of priorityGroup) {
      if (parser.acceptingAnyToken)
        groupAcceptsAnyToken = true;
      const commandNames = extractCommandNames(parser.usage, true);
      for (const name of parser.leadingNames) {
        if (!commandNames.has(name))
          continue;
        if (positionalBlocked || blockedNames.has(name))
          continue;
        groupNames.add(name);
        const sources = commandNameSources.get(name);
        commandNameSources.set(name, sources == null ? [source] : [...sources, source]);
      }
    }
    for (const name of groupNames)
      blockedNames.add(name);
    if (groupAcceptsAnyToken)
      positionalBlocked = true;
  }
  for (const [name, sources] of commandNameSources)
    if (sources.length > 1)
      throw new DuplicateCommandNameError(name, sources);
}
function extractParsableOptionNames(usage) {
  return extractOptionNames(usage, true);
}
function generateNoMatchError(context) {
  const { hasOptions, hasCommands, hasArguments } = context;
  if (hasArguments && !hasOptions && !hasCommands)
    return message`Missing required argument.`;
  else if (hasCommands && !hasOptions && !hasArguments)
    return message`No matching command found.`;
  else if (hasOptions && !hasCommands && !hasArguments)
    return message`No matching option found.`;
  else if (hasCommands && hasOptions && !hasArguments)
    return message`No matching option or command found.`;
  else if (hasArguments && hasOptions && !hasCommands)
    return message`No matching option or argument found.`;
  else if (hasArguments && hasCommands && !hasOptions)
    return message`No matching command or argument found.`;
  else if (hasOptions && hasCommands && hasArguments)
    return message`No matching option, command, or argument found.`;
  else
    return message`No value provided.`;
}
function normalizeExclusiveState(state) {
  if (!Array.isArray(state) || state.length !== 2 || typeof state[0] !== "number")
    return;
  return state;
}
function annotateExclusiveParserResult(parentState, parser, result) {
  if (!result.success)
    return result;
  const annotatedState = getWrappedChildState(parentState, result.next.state, parser);
  if (annotatedState === result.next.state)
    return result;
  return {
    ...result,
    next: {
      ...result.next,
      state: annotatedState
    }
  };
}
function createExclusiveState(parentState, index, parser, result) {
  const annotatedResult = annotateExclusiveParserResult(parentState, parser, result);
  return annotateFreshArray(parentState, [index, annotatedResult]);
}
function isOptionsTerminatorOnlyResult(context, result) {
  return !context.optionsTerminated && context.buffer[0] === "--" && result.success && result.next.optionsTerminated && result.consumed.length === 1 && result.consumed[0] === "--";
}
function isUnselectedBooleanOptionState(state) {
  return state != null && typeof state === "object" && "success" in state && state.success === true && "value" in state && state.value === false;
}
function preserveExclusiveStateAfterOptionsTerminator(context, result) {
  const mergedExec = mergeChildExec(context.exec, result.next.exec);
  return {
    success: true,
    next: {
      ...context,
      ...getPassThroughFailureHint(result.next),
      buffer: result.next.buffer,
      optionsTerminated: true,
      state: context.state,
      ...mergedExec != null ? {
        exec: mergedExec,
        dependencyRegistry: mergedExec.dependencyRegistry
      } : {}
    },
    consumed: result.consumed
  };
}
function createExclusiveComplete(parsers, options, noMatchContext, mode) {
  const syncParsers = parsers;
  return (state, exec) => {
    const activeState = normalizeExclusiveState(state);
    if (activeState == null)
      return dispatchByMode(mode, () => {
        const candidate = findExclusiveZeroInputCandidateSync(syncParsers, state, exec);
        if (candidate != null) {
          const p = syncParsers[candidate.index];
          const annotatedState = getWrappedChildState(state, candidate.parseResult.next.state, p);
          return p.complete(annotatedState, withChildExecPath(exec, candidate.index));
        }
        return {
          success: false,
          error: getNoMatchError(options, noMatchContext)
        };
      }, async () => {
        const candidate = await findExclusiveZeroInputCandidateAsync(parsers, state, exec);
        if (candidate != null && (parsers[candidate.index].mode === "sync" || exec?.phase !== "parse" && exec?.phase !== "suggest")) {
          const p = parsers[candidate.index];
          const annotatedState = getWrappedChildState(state, candidate.parseResult.next.state, p);
          return await p.complete(annotatedState, withChildExecPath(exec, candidate.index));
        }
        return {
          success: false,
          error: getNoMatchError(options, noMatchContext)
        };
      });
    const [i, result] = activeState;
    if (!result.success)
      return {
        success: false,
        error: result.error
      };
    return dispatchByMode(mode, () => syncParsers[i].complete(result.next.state, withChildExecPath(exec, i)), async () => {
      const completeResult = await parsers[i].complete(result.next.state, withChildExecPath(exec, i));
      return completeResult;
    });
  };
}
function createExclusiveSuggest(parsers, mode) {
  const syncParsers = parsers;
  return (context, prefix) => {
    return dispatchIterableByMode(mode, function* () {
      const suggestions = [];
      const activeState = normalizeExclusiveState(context.state);
      if (activeState == null || activeState[1].success && activeState[1].consumed.length === 0)
        for (let i = 0;i < syncParsers.length; i++) {
          const parser = syncParsers[i];
          const parserSuggestions = parser.suggest(withChildContext$1(context, i, parser.initialState, parser), prefix);
          suggestions.push(...parserSuggestions);
        }
      else {
        const [index, parserResult] = activeState;
        if (parserResult.success) {
          const parser = syncParsers[index];
          const parserSuggestions = parser.suggest(withChildContext$1(context, index, parserResult.next.state, parser), prefix);
          suggestions.push(...parserSuggestions);
        }
      }
      yield* deduplicateSuggestions(suggestions);
    }, async function* () {
      const suggestions = [];
      const activeState = normalizeExclusiveState(context.state);
      if (activeState == null || activeState[1].success && activeState[1].consumed.length === 0)
        for (let i = 0;i < parsers.length; i++) {
          const parser = parsers[i];
          const parserSuggestions = parser.suggest(withChildContext$1(context, i, parser.initialState, parser), prefix);
          if (parser.mode === "async")
            for await (const s of parserSuggestions)
              suggestions.push(s);
          else
            suggestions.push(...parserSuggestions);
        }
      else {
        const [index, parserResult] = activeState;
        if (parserResult.success) {
          const parser = parsers[index];
          const parserSuggestions = parser.suggest(withChildContext$1(context, index, parserResult.next.state, parser), prefix);
          if (parser.mode === "async")
            for await (const s of parserSuggestions)
              suggestions.push(s);
          else
            suggestions.push(...parserSuggestions);
        }
      }
      yield* deduplicateSuggestions(suggestions);
    });
  };
}
function getExclusiveSuggestRuntimeNodes(parsers, state, path) {
  const activeState = normalizeExclusiveState(state);
  if (activeState == null)
    return [];
  const [index, parserResult] = activeState;
  if (!parserResult?.success || index < 0 || index >= parsers.length)
    return [];
  const parser = parsers[index];
  return getParserSuggestRuntimeNodes(parser, parserResult.next.state, [...path, index]);
}
function findExclusiveZeroInputCandidateSync(parsers, state, exec) {
  const emptyCtx = {
    buffer: [],
    optionsTerminated: false,
    usage: [],
    exec,
    dependencyRegistry: exec?.dependencyRegistry
  };
  let candidateIndex = -1;
  let candidateCount = 0;
  let candidateParseResult;
  for (let i = 0;i < parsers.length; i++) {
    const parser = parsers[i];
    if (parser.leadingNames.size > 0 || parser.acceptingAnyToken)
      continue;
    const parseResult = parser.parse({
      ...emptyCtx,
      state: getWrappedChildState(state, parser.initialState, parser)
    });
    if (!parseResult.success || parseResult.provisional)
      continue;
    candidateCount++;
    if (candidateIndex < 0) {
      candidateIndex = i;
      candidateParseResult = parseResult;
    }
    if (candidateCount > 1)
      break;
  }
  return candidateCount === 1 && candidateIndex >= 0 && candidateParseResult != null ? {
    index: candidateIndex,
    parseResult: candidateParseResult
  } : null;
}
async function findExclusiveZeroInputCandidateAsync(parsers, state, exec) {
  const emptyCtx = {
    buffer: [],
    optionsTerminated: false,
    usage: [],
    exec,
    dependencyRegistry: exec?.dependencyRegistry
  };
  let candidateIndex = -1;
  let candidateCount = 0;
  let candidateParseResult;
  for (let i = 0;i < parsers.length; i++) {
    const parser = parsers[i];
    if (parser.leadingNames.size > 0 || parser.acceptingAnyToken)
      continue;
    const parseResult = await parser.parse({
      ...emptyCtx,
      state: getWrappedChildState(state, parser.initialState, parser)
    });
    if (!parseResult.success || parseResult.provisional)
      continue;
    candidateCount++;
    if (candidateIndex < 0) {
      candidateIndex = i;
      candidateParseResult = parseResult;
    }
    if (candidateCount > 1)
      break;
  }
  return candidateCount === 1 && candidateIndex >= 0 && candidateParseResult != null ? {
    index: candidateIndex,
    parseResult: candidateParseResult
  } : null;
}
function extractExclusivePhase2Seed(parsers, state, exec, mode) {
  const activeState = normalizeExclusiveState(state);
  if (activeState == null)
    return dispatchByMode(mode, () => {
      const candidate = findExclusiveZeroInputCandidateSync(parsers, state, exec);
      if (candidate == null)
        return null;
      return extractOrCompletePhase2SeedSync(parsers[candidate.index], candidate.parseResult.next.state, withChildExecPath(exec, candidate.index));
    }, async () => {
      const candidate = await findExclusiveZeroInputCandidateAsync(parsers, state, exec);
      if (candidate == null)
        return null;
      return await extractOrCompletePhase2SeedAsync(parsers[candidate.index], candidate.parseResult.next.state, withChildExecPath(exec, candidate.index));
    });
  if (!activeState[1].success)
    return dispatchByMode(mode, () => null, () => Promise.resolve(null));
  const [index, parserResult] = activeState;
  return completeOrExtractPhase2Seed(parsers[index], parserResult.next.state, withChildExecPath(exec, index));
}
function getNoMatchError(options, noMatchContext) {
  const customNoMatch = options?.errors?.noMatch;
  return customNoMatch ? typeof customNoMatch === "function" ? customNoMatch(noMatchContext) : customNoMatch : generateNoMatchError(noMatchContext);
}
function defineExclusiveSchedulingNodes(exclusiveParser, parsers) {
  if (parsers.some((parser) => parser[sourceCollectionExpansionKey] === true))
    Object.defineProperty(exclusiveParser, sourceCollectionExpansionKey, {
      value: true,
      configurable: true,
      enumerable: false
    });
  Object.defineProperty(exclusiveParser, exclusiveSourceScopeKey, {
    value: parsers,
    configurable: true,
    enumerable: false
  });
  Object.defineProperty(exclusiveParser, effectfulSchedulingNodesKey, {
    value: (state, parentPath) => {
      const active = normalizeExclusiveState(state);
      if (active == null)
        return [];
      const [index, result] = active;
      if (result?.success !== true)
        return [];
      return [{
        path: [...parentPath ?? [], index],
        parser: parsers[index],
        state: result.next.state
      }];
    },
    configurable: true,
    enumerable: false
  });
}
function composeExclusiveDependencyMetadata(parsers) {
  const sourceBranches = parsers.filter((parser) => parser.dependencyMetadata?.source != null);
  if (sourceBranches.length < 1)
    return;
  const sourceIds = new Set(sourceBranches.map((parser) => parser.dependencyMetadata.source.sourceId));
  if (sourceIds.size !== 1)
    return;
  const sharedSource = sourceBranches[0].dependencyMetadata.source;
  const everyBranchPreserves = sourceBranches.length === parsers.length && sourceBranches.every((parser) => parser.dependencyMetadata?.source?.preservesSourceValue !== false);
  return { source: {
    ...sharedSource,
    getMissingSourceValue: undefined,
    completesWhenMissing: false,
    exclusiveOccurrence: true,
    preservesSourceValue: everyBranchPreserves,
    extractSourceValue(state) {
      if (!Array.isArray(state) || state.length !== 2 || typeof state[0] !== "number")
        return;
      const [index, parserResult] = state;
      if (!parserResult?.success)
        return;
      const branchSource = parsers[index].dependencyMetadata?.source;
      if (branchSource?.extractSourceValue == null)
        return;
      return branchSource.extractSourceValue(parserResult.next.state);
    },
    completeSource(state, exec) {
      if (!Array.isArray(state) || state.length !== 2 || typeof state[0] !== "number")
        return Promise.resolve(undefined);
      const [index, parserResult] = state;
      if (!parserResult?.success)
        return Promise.resolve(undefined);
      const branchSource = parsers[index].dependencyMetadata?.source;
      if (branchSource?.completeSource == null)
        return Promise.resolve(undefined);
      return branchSource.completeSource(parserResult.next.state, exec);
    }
  } };
}
function or(...args) {
  let parsers;
  let options;
  if (args.length > 0 && args[args.length - 1] && typeof args[args.length - 1] === "object" && !("$valueType" in args[args.length - 1])) {
    options = args[args.length - 1];
    parsers = args.slice(0, -1);
  } else {
    parsers = args;
    options = undefined;
  }
  if (parsers.length < 1)
    throw new TypeError("or() requires at least one parser argument.");
  assertParsers(parsers, "or()");
  checkDuplicateLeadingCommandNames(parsers.map((parser, index) => [String(index), parser]));
  const noMatchContext = analyzeNoMatchContext(parsers);
  const combinedMode = parsers.some((p) => p.mode === "async") ? "async" : "sync";
  const syncParsers = parsers;
  const getInitialError = (context) => ({
    consumed: 0,
    error: context.buffer.length < 1 ? getNoMatchError(options, noMatchContext) : (() => {
      const token = context.buffer[0];
      const defaultMsg = message`Unexpected option or subcommand: ${optionName(token)}.`;
      if (options?.errors?.unexpectedInput != null)
        return typeof options.errors.unexpectedInput === "function" ? options.errors.unexpectedInput(token) : options.errors.unexpectedInput;
      return createUnexpectedInputErrorWithScopedSuggestions(defaultMsg, token, parsers, options?.errors?.suggestions);
    })()
  });
  const parseSync = (context) => {
    let error = getInitialError(context);
    const activeState = normalizeExclusiveState(context.state);
    const orderedParsers = syncParsers.map((p, i) => [p, i]);
    orderedParsers.sort(([_, a], [__, b]) => activeState?.[0] === a ? -1 : activeState?.[0] === b ? 1 : a - b);
    let zeroConsumedBranch = null;
    let zeroConsumedCount = 0;
    let provisionalConsuming = null;
    let optionsTerminatorResult = null;
    let provisionalAmbiguous = false;
    for (const [parser, i] of orderedParsers) {
      const result = parser.parse(withChildContext$1(context, i, activeState == null || activeState[0] !== i || !activeState[1].success ? parser.initialState : activeState[1].next.state, parser));
      if (isOptionsTerminatorOnlyResult(context, result)) {
        if (activeState?.[0] === i && activeState[1].success && activeState[1].consumed.length > 0 && result.next.buffer.length < 1)
          return preserveExclusiveStateAfterOptionsTerminator(context, result);
        optionsTerminatorResult ??= result;
        continue;
      }
      if (result.success && result.consumed.length > 0) {
        if (result.provisional) {
          const activeBranchLocked = activeState != null && activeState[1].success && activeState[1].consumed.length > 0;
          if (activeBranchLocked && activeState[0] === i) {
            provisionalConsuming = {
              index: i,
              parser,
              result
            };
            continue;
          }
          if (activeBranchLocked && provisionalConsuming != null && provisionalConsuming.index === activeState[0])
            continue;
          if (provisionalConsuming == null && !provisionalAmbiguous)
            provisionalConsuming = {
              index: i,
              parser,
              result
            };
          else {
            provisionalConsuming = null;
            provisionalAmbiguous = true;
          }
          continue;
        }
        if (activeState?.[0] !== i && activeState?.[1].success) {
          if (activeState[1].consumed.length === 0) {
            const mergedExec$2 = mergeChildExec(context.exec, result.next.exec);
            return {
              success: true,
              next: {
                ...context,
                ...getPassThroughFailureHint(result.next),
                buffer: result.next.buffer,
                optionsTerminated: result.next.optionsTerminated,
                state: createExclusiveState(context.state, i, parser, result),
                ...mergedExec$2 != null ? {
                  exec: mergedExec$2,
                  dependencyRegistry: mergedExec$2.dependencyRegistry
                } : {}
              },
              consumed: result.consumed
            };
          }
          const previouslyConsumed = activeState[1].consumed;
          const checkResult = parser.parse({
            ...withChildContext$1(context, i, parser.initialState, parser),
            buffer: previouslyConsumed
          });
          const canConsumeShared = checkResult.success && checkResult.consumed.length === previouslyConsumed.length && checkResult.consumed.every((c, idx) => c === previouslyConsumed[idx]);
          if (!canConsumeShared)
            return {
              success: false,
              consumed: context.buffer.length - result.next.buffer.length,
              error: message`${values(activeState[1].consumed)} and ${values(result.consumed)} cannot be used together.`
            };
          const replayExec = mergeChildExec(context.exec, checkResult.next.exec);
          const replayedResult = parser.parse(withChildContext$1({
            ...context,
            ...replayExec != null ? {
              exec: replayExec,
              dependencyRegistry: replayExec.dependencyRegistry
            } : {}
          }, i, checkResult.next.state, parser));
          if (!replayedResult.success)
            return replayedResult;
          const mergedExec$1 = mergeChildExec(replayExec, replayedResult.next.exec);
          return {
            success: true,
            next: {
              ...context,
              ...getPassThroughFailureHint(replayedResult.next),
              buffer: replayedResult.next.buffer,
              optionsTerminated: replayedResult.next.optionsTerminated,
              state: createExclusiveState(context.state, i, parser, {
                ...replayedResult,
                consumed: [...previouslyConsumed, ...replayedResult.consumed]
              }),
              ...mergedExec$1 != null ? {
                exec: mergedExec$1,
                dependencyRegistry: mergedExec$1.dependencyRegistry
              } : {}
            },
            consumed: replayedResult.consumed
          };
        }
        const mergedExec = mergeChildExec(context.exec, result.next.exec);
        return {
          success: true,
          next: {
            ...context,
            ...getPassThroughFailureHint(result.next),
            buffer: result.next.buffer,
            optionsTerminated: result.next.optionsTerminated,
            state: createExclusiveState(context.state, i, parser, result),
            ...mergedExec != null ? {
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          },
          consumed: result.consumed
        };
      } else if (result.success && result.consumed.length === 0 && !result.provisional && parser.leadingNames.size === 0 && !parser.acceptingAnyToken) {
        if (zeroConsumedBranch === null)
          zeroConsumedBranch = {
            index: i,
            parser,
            result
          };
        zeroConsumedCount++;
      } else if (!result.success && error.consumed < result.consumed)
        error = result;
    }
    if (zeroConsumedBranch !== null && zeroConsumedCount === 1 && error.consumed === 0 && context.buffer.length === 0) {
      const mergedExec = mergeChildExec(context.exec, zeroConsumedBranch.result.next.exec);
      return {
        success: true,
        ...zeroConsumedBranch.result.provisional ? { provisional: true } : {},
        next: {
          ...context,
          state: createExclusiveState(context.state, zeroConsumedBranch.index, zeroConsumedBranch.parser, zeroConsumedBranch.result),
          ...mergedExec != null ? {
            exec: mergedExec,
            dependencyRegistry: mergedExec.dependencyRegistry
          } : {}
        },
        consumed: []
      };
    }
    if (provisionalConsuming !== null) {
      const activeIsLockedDifferent = activeState != null && activeState[1].success && activeState[1].consumed.length > 0 && activeState[0] !== provisionalConsuming.index;
      if (!activeIsLockedDifferent) {
        const mergedExec = mergeChildExec(context.exec, provisionalConsuming.result.next.exec);
        return {
          success: true,
          provisional: true,
          next: {
            ...context,
            ...getPassThroughFailureHint(provisionalConsuming.result.next),
            buffer: provisionalConsuming.result.next.buffer,
            optionsTerminated: provisionalConsuming.result.next.optionsTerminated,
            state: createExclusiveState(context.state, provisionalConsuming.index, provisionalConsuming.parser, provisionalConsuming.result),
            ...mergedExec != null ? {
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          },
          consumed: provisionalConsuming.result.consumed
        };
      }
      if (activeState != null && activeState[1].success) {
        const previouslyConsumed = activeState[1].consumed;
        const checkResult = provisionalConsuming.parser.parse({
          ...withChildContext$1(context, provisionalConsuming.index, provisionalConsuming.parser.initialState, provisionalConsuming.parser),
          buffer: previouslyConsumed
        });
        const canConsumeShared = checkResult.success && checkResult.consumed.length === previouslyConsumed.length && checkResult.consumed.every((c, idx) => c === previouslyConsumed[idx]);
        if (canConsumeShared && checkResult.success) {
          const replayExec = mergeChildExec(context.exec, checkResult.next.exec);
          const replayedResult = provisionalConsuming.parser.parse(withChildContext$1({
            ...context,
            ...replayExec != null ? {
              exec: replayExec,
              dependencyRegistry: replayExec.dependencyRegistry
            } : {}
          }, provisionalConsuming.index, checkResult.next.state, provisionalConsuming.parser));
          if (!replayedResult.success)
            return replayedResult;
          const mergedExec = mergeChildExec(replayExec, replayedResult.next.exec);
          return {
            success: true,
            provisional: true,
            next: {
              ...context,
              ...getPassThroughFailureHint(replayedResult.next),
              buffer: replayedResult.next.buffer,
              optionsTerminated: replayedResult.next.optionsTerminated,
              state: createExclusiveState(context.state, provisionalConsuming.index, provisionalConsuming.parser, {
                ...replayedResult,
                provisional: true,
                consumed: [...previouslyConsumed, ...replayedResult.consumed]
              }),
              ...mergedExec != null ? {
                exec: mergedExec,
                dependencyRegistry: mergedExec.dependencyRegistry
              } : {}
            },
            consumed: replayedResult.consumed
          };
        }
      }
    }
    if (optionsTerminatorResult != null)
      return preserveExclusiveStateAfterOptionsTerminator(context, optionsTerminatorResult);
    return {
      ...error,
      success: false
    };
  };
  const parseAsync = async (context) => {
    let error = getInitialError(context);
    const activeState = normalizeExclusiveState(context.state);
    const orderedParsers = parsers.map((p, i) => [p, i]);
    orderedParsers.sort(([_, a], [__, b]) => activeState?.[0] === a ? -1 : activeState?.[0] === b ? 1 : a - b);
    let zeroConsumedBranch = null;
    let zeroConsumedCount = 0;
    let provisionalConsuming = null;
    let optionsTerminatorResult = null;
    let provisionalAmbiguous = false;
    for (const [parser, i] of orderedParsers) {
      const resultOrPromise = parser.parse(withChildContext$1(context, i, activeState == null || activeState[0] !== i || !activeState[1].success ? parser.initialState : activeState[1].next.state, parser));
      const result = await resultOrPromise;
      if (isOptionsTerminatorOnlyResult(context, result)) {
        if (activeState?.[0] === i && activeState[1].success && activeState[1].consumed.length > 0 && result.next.buffer.length < 1)
          return preserveExclusiveStateAfterOptionsTerminator(context, result);
        optionsTerminatorResult ??= result;
        continue;
      }
      if (result.success && result.consumed.length > 0) {
        if (result.provisional) {
          const activeBranchLocked = activeState != null && activeState[1].success && activeState[1].consumed.length > 0;
          if (activeBranchLocked && activeState[0] === i) {
            provisionalConsuming = {
              index: i,
              parser,
              result
            };
            continue;
          }
          if (activeBranchLocked && provisionalConsuming != null && provisionalConsuming.index === activeState[0])
            continue;
          if (provisionalConsuming == null && !provisionalAmbiguous)
            provisionalConsuming = {
              index: i,
              parser,
              result
            };
          else {
            provisionalConsuming = null;
            provisionalAmbiguous = true;
          }
          continue;
        }
        if (activeState?.[0] !== i && activeState?.[1].success) {
          if (activeState[1].consumed.length === 0) {
            const mergedExec$2 = mergeChildExec(context.exec, result.next.exec);
            return {
              success: true,
              next: {
                ...context,
                ...getPassThroughFailureHint(result.next),
                buffer: result.next.buffer,
                optionsTerminated: result.next.optionsTerminated,
                state: createExclusiveState(context.state, i, parser, result),
                ...mergedExec$2 != null ? {
                  exec: mergedExec$2,
                  dependencyRegistry: mergedExec$2.dependencyRegistry
                } : {}
              },
              consumed: result.consumed
            };
          }
          const previouslyConsumed = activeState[1].consumed;
          const checkResultOrPromise = parser.parse({
            ...withChildContext$1(context, i, parser.initialState, parser),
            buffer: previouslyConsumed
          });
          const checkResult = await checkResultOrPromise;
          const canConsumeShared = checkResult.success && checkResult.consumed.length === previouslyConsumed.length && checkResult.consumed.every((c, idx) => c === previouslyConsumed[idx]);
          if (!canConsumeShared)
            return {
              success: false,
              consumed: context.buffer.length - result.next.buffer.length,
              error: message`${values(activeState[1].consumed)} and ${values(result.consumed)} cannot be used together.`
            };
          const replayExec = mergeChildExec(context.exec, checkResult.next.exec);
          const replayedResultOrPromise = parser.parse(withChildContext$1({
            ...context,
            ...replayExec != null ? {
              exec: replayExec,
              dependencyRegistry: replayExec.dependencyRegistry
            } : {}
          }, i, checkResult.next.state, parser));
          const replayedResult = await replayedResultOrPromise;
          if (!replayedResult.success)
            return replayedResult;
          const mergedExec$1 = mergeChildExec(replayExec, replayedResult.next.exec);
          return {
            success: true,
            next: {
              ...context,
              ...getPassThroughFailureHint(replayedResult.next),
              buffer: replayedResult.next.buffer,
              optionsTerminated: replayedResult.next.optionsTerminated,
              state: createExclusiveState(context.state, i, parser, {
                ...replayedResult,
                consumed: [...previouslyConsumed, ...replayedResult.consumed]
              }),
              ...mergedExec$1 != null ? {
                exec: mergedExec$1,
                dependencyRegistry: mergedExec$1.dependencyRegistry
              } : {}
            },
            consumed: replayedResult.consumed
          };
        }
        const mergedExec = mergeChildExec(context.exec, result.next.exec);
        return {
          success: true,
          next: {
            ...context,
            ...getPassThroughFailureHint(result.next),
            buffer: result.next.buffer,
            optionsTerminated: result.next.optionsTerminated,
            state: createExclusiveState(context.state, i, parser, result),
            ...mergedExec != null ? {
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          },
          consumed: result.consumed
        };
      } else if (result.success && result.consumed.length === 0 && !result.provisional && parser.leadingNames.size === 0 && !parser.acceptingAnyToken) {
        if (zeroConsumedBranch === null)
          zeroConsumedBranch = {
            index: i,
            parser,
            result
          };
        zeroConsumedCount++;
      } else if (!result.success && error.consumed < result.consumed)
        error = result;
    }
    if (zeroConsumedBranch !== null && zeroConsumedCount === 1 && error.consumed === 0 && context.buffer.length === 0) {
      const mergedExec = mergeChildExec(context.exec, zeroConsumedBranch.result.next.exec);
      return {
        success: true,
        ...zeroConsumedBranch.result.provisional ? { provisional: true } : {},
        next: {
          ...context,
          state: createExclusiveState(context.state, zeroConsumedBranch.index, zeroConsumedBranch.parser, zeroConsumedBranch.result),
          ...mergedExec != null ? {
            exec: mergedExec,
            dependencyRegistry: mergedExec.dependencyRegistry
          } : {}
        },
        consumed: []
      };
    }
    if (provisionalConsuming !== null) {
      const activeIsLockedDifferent = activeState != null && activeState[1].success && activeState[1].consumed.length > 0 && activeState[0] !== provisionalConsuming.index;
      if (!activeIsLockedDifferent) {
        const mergedExec = mergeChildExec(context.exec, provisionalConsuming.result.next.exec);
        return {
          success: true,
          provisional: true,
          next: {
            ...context,
            ...getPassThroughFailureHint(provisionalConsuming.result.next),
            buffer: provisionalConsuming.result.next.buffer,
            optionsTerminated: provisionalConsuming.result.next.optionsTerminated,
            state: createExclusiveState(context.state, provisionalConsuming.index, provisionalConsuming.parser, provisionalConsuming.result),
            ...mergedExec != null ? {
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          },
          consumed: provisionalConsuming.result.consumed
        };
      }
      if (activeState != null && activeState[1].success) {
        const previouslyConsumed = activeState[1].consumed;
        const checkResult = await provisionalConsuming.parser.parse({
          ...withChildContext$1(context, provisionalConsuming.index, provisionalConsuming.parser.initialState, provisionalConsuming.parser),
          buffer: previouslyConsumed
        });
        const canConsumeShared = checkResult.success && checkResult.consumed.length === previouslyConsumed.length && checkResult.consumed.every((c, idx) => c === previouslyConsumed[idx]);
        if (canConsumeShared && checkResult.success) {
          const replayExec = mergeChildExec(context.exec, checkResult.next.exec);
          const replayedResult = await provisionalConsuming.parser.parse(withChildContext$1({
            ...context,
            ...replayExec != null ? {
              exec: replayExec,
              dependencyRegistry: replayExec.dependencyRegistry
            } : {}
          }, provisionalConsuming.index, checkResult.next.state, provisionalConsuming.parser));
          if (!replayedResult.success)
            return replayedResult;
          const mergedExec = mergeChildExec(replayExec, replayedResult.next.exec);
          return {
            success: true,
            provisional: true,
            next: {
              ...context,
              ...getPassThroughFailureHint(replayedResult.next),
              buffer: replayedResult.next.buffer,
              optionsTerminated: replayedResult.next.optionsTerminated,
              state: createExclusiveState(context.state, provisionalConsuming.index, provisionalConsuming.parser, {
                ...replayedResult,
                provisional: true,
                consumed: [...previouslyConsumed, ...replayedResult.consumed]
              }),
              ...mergedExec != null ? {
                exec: mergedExec,
                dependencyRegistry: mergedExec.dependencyRegistry
              } : {}
            },
            consumed: replayedResult.consumed
          };
        }
      }
    }
    if (optionsTerminatorResult != null)
      return preserveExclusiveStateAfterOptionsTerminator(context, optionsTerminatorResult);
    return {
      ...error,
      success: false
    };
  };
  const singleResult = {
    mode: combinedMode,
    $valueType: [],
    $stateType: [],
    priority: Math.max(...parsers.map((p) => p.priority)),
    usage: [{
      type: "exclusive",
      terms: parsers.map((p) => p.usage)
    }],
    leadingNames: unionLeadingNames(parsers),
    acceptingAnyToken: parsers.some((p) => p.acceptingAnyToken),
    initialState: undefined,
    canSkip(state, exec) {
      const activeState = normalizeExclusiveState(state);
      if (activeState != null) {
        const [index, result] = activeState;
        const parser = parsers[index];
        return result.success && parser?.canSkip?.(result.next.state, exec) === true;
      }
      return parsers.some((parser) => parser.canSkip?.(parser.initialState, exec) === true);
    },
    complete: createExclusiveComplete(parsers, options, noMatchContext, combinedMode),
    [extractPhase2SeedKey](state, exec) {
      return extractExclusivePhase2Seed(parsers, state, exec, combinedMode);
    },
    parse(context) {
      return dispatchByMode(combinedMode, () => parseSync(context), () => parseAsync(context));
    },
    getSuggestRuntimeNodes(state, path) {
      return getExclusiveSuggestRuntimeNodes(parsers, state, path);
    },
    suggest: createExclusiveSuggest(parsers, combinedMode),
    getDocFragments(state, _defaultValue) {
      let commandMetadata;
      let brief;
      let description;
      let footer;
      let fragments;
      if (state.kind === "unavailable" || state.state == null)
        fragments = parsers.flatMap((p) => p.getDocFragments({ kind: "unavailable" }, undefined).fragments);
      else {
        const [index, parserResult] = state.state;
        const innerState = parserResult.success ? {
          kind: "available",
          state: parserResult.next.state
        } : { kind: "unavailable" };
        const docFragments = parsers[index].getDocFragments(innerState, undefined);
        commandMetadata = getCommandDocMetadata(docFragments);
        brief = docFragments.brief;
        description = docFragments.description;
        footer = docFragments.footer;
        fragments = docFragments.fragments;
      }
      if (state.kind === "unavailable" || state.state == null)
        fragments = deduplicateDocFragments(fragments);
      return withCommandDocMetadata({
        brief,
        description,
        footer,
        fragments
      }, commandMetadata);
    }
  };
  const singleDependencyMetadata = composeExclusiveDependencyMetadata(parsers);
  if (singleDependencyMetadata != null)
    singleResult.dependencyMetadata = singleDependencyMetadata;
  defineExclusiveSchedulingNodes(singleResult, parsers);
  defineInheritedAnnotationParser(singleResult);
  defineOptionMatch(singleResult, (state, token) => combineOptionMatches(parsers.map((parser, index) => {
    const active = normalizeExclusiveState(state);
    return getOptionMatch(parser, active?.[0] === index && active[1].success ? active[1].next.state : parser.initialState, token);
  })));
  definePassThroughPriority(singleResult, parsers, (state, token) => {
    const active = normalizeExclusiveState(state);
    return combinePassThroughPriorities(parsers.map((parser, index) => getPassThroughPriority(parser, active?.[0] === index && active[1].success ? active[1].next.state : parser.initialState, token)));
  });
  return fluent(singleResult);
}
function longestMatch(...args) {
  return createLongestMatch(...args);
}
function createLongestMatch(...args) {
  let parsers;
  let options;
  if (args.length > 0 && args[args.length - 1] && typeof args[args.length - 1] === "object" && !("$valueType" in args[args.length - 1])) {
    options = args[args.length - 1];
    parsers = args.slice(0, -1);
  } else {
    parsers = args;
    options = undefined;
  }
  if (parsers.length < 1)
    throw new TypeError("longestMatch() requires at least one parser argument.");
  assertParsers(parsers, "longestMatch()");
  const allowDuplicateLeadingCommandNames = options?.[allowDuplicateLeadingCommandNamesKey] === true;
  if (!allowDuplicateLeadingCommandNames)
    checkDuplicateLeadingCommandNames(parsers.map((parser, index) => [String(index), parser]));
  const noMatchContext = analyzeNoMatchContext(parsers);
  const combinedMode = parsers.some((p) => p.mode === "async") ? "async" : "sync";
  const syncParsers = parsers;
  const getInitialError = (context) => ({
    consumed: 0,
    error: context.buffer.length < 1 ? getNoMatchError(options, noMatchContext) : (() => {
      const token = context.buffer[0];
      const defaultMsg = message`Unexpected option or subcommand: ${optionName(token)}.`;
      if (options?.errors?.unexpectedInput != null)
        return typeof options.errors.unexpectedInput === "function" ? options.errors.unexpectedInput(token) : options.errors.unexpectedInput;
      return createUnexpectedInputErrorWithScopedSuggestions(defaultMsg, token, parsers, options?.errors?.suggestions);
    })()
  });
  const commitLongestMatch = (context, match, optionsTerminatorResult, consumingFailure) => {
    const selectedResult = optionsTerminatorResult == null ? match.result : {
      ...match.result,
      next: {
        ...match.result.next,
        ...getPassThroughFailureHint(optionsTerminatorResult.next),
        buffer: optionsTerminatorResult.next.buffer,
        optionsTerminated: true
      },
      consumed: [...optionsTerminatorResult.consumed, ...match.result.consumed]
    };
    const next = selectedResult.consumed.length === 0 ? withPassThroughFailure(selectedResult.next, consumingFailure) : selectedResult.next;
    const parser = parsers[match.index];
    const mergedExec = mergeChildExec(context.exec, next.exec);
    return {
      success: true,
      next: {
        ...context,
        ...getPassThroughFailureHint(next),
        buffer: next.buffer,
        optionsTerminated: next.optionsTerminated,
        state: createExclusiveState(context.state, match.index, parser, selectedResult),
        ...mergedExec != null ? {
          exec: mergedExec,
          dependencyRegistry: mergedExec.dependencyRegistry
        } : {}
      },
      consumed: selectedResult.consumed
    };
  };
  const resolveLongestMatchOptionsTerminator = (context, bestMatch, optionsTerminatorMatches) => {
    if (optionsTerminatorMatches.length < 1)
      return null;
    if (bestMatch != null && bestMatch.consumed > 0)
      return null;
    const activeState = normalizeExclusiveState(context.state);
    if (activeState != null && activeState[1].success && activeState[1].consumed.length > 0)
      return preserveExclusiveStateAfterOptionsTerminator(context, optionsTerminatorMatches[0].result);
    let selected = bestMatch == null ? null : {
      match: bestMatch,
      fromTerminator: false
    };
    for (const match of optionsTerminatorMatches) {
      if (!match.selectedAfterTerminator && (extractRequiredUsage(parsers[match.index].usage).length > 0 || isUnselectedBooleanOptionState(match.result.next.state)))
        continue;
      const selectedIsProvisional = selected != null && !!selected.match.result.provisional;
      const matchIsProvisional = !!match.result.provisional;
      if (selected == null || selectedIsProvisional && !matchIsProvisional || selectedIsProvisional === matchIsProvisional && match.index < selected.match.index)
        selected = {
          match,
          fromTerminator: true
        };
    }
    if (selected != null)
      return commitLongestMatch(context, selected.match, selected.fromTerminator ? undefined : optionsTerminatorMatches[0].result);
    return preserveExclusiveStateAfterOptionsTerminator(context, optionsTerminatorMatches[0].result);
  };
  const parseSyncBranches = (context) => {
    let bestMatch = null;
    const optionsTerminatorMatches = [];
    let error = getInitialError(context);
    let consumingFailure;
    const activeState = normalizeExclusiveState(context.state);
    for (let i = 0;i < syncParsers.length; i++) {
      const parser = syncParsers[i];
      const childContext = withChildContext$1(context, i, activeState == null || activeState[0] !== i || !activeState[1].success ? parser.initialState : activeState[1].next.state, parser);
      const result = parser.parse(childContext);
      if (isOptionsTerminatorOnlyResult(context, result)) {
        optionsTerminatorMatches.push({
          index: i,
          result,
          consumed: 1,
          ...normalizeExclusiveState(result.next.state) != null ? { selectedAfterTerminator: true } : {}
        });
        continue;
      }
      if (result.success) {
        consumingFailure = retainConsumingFailureHint(consumingFailure, context, result.next);
        const consumed = context.buffer.length - result.next.buffer.length;
        const bestIsProvisional = bestMatch != null && bestMatch.result.success && !!bestMatch.result.provisional;
        if (bestMatch === null || consumed > bestMatch.consumed || consumed === bestMatch.consumed && bestIsProvisional && !result.provisional)
          bestMatch = {
            index: i,
            result,
            consumed
          };
      } else {
        const match = getOptionMatch(parser, childContext.state, context.buffer[0]);
        if (result.consumed > 0 && match != null)
          consumingFailure = retainConsumingFailure(consumingFailure, result, match.priority);
        if (error.consumed < result.consumed)
          error = result;
      }
    }
    const optionsTerminatorResolution = resolveLongestMatchOptionsTerminator(context, bestMatch, optionsTerminatorMatches);
    if (optionsTerminatorResolution != null)
      return optionsTerminatorResolution;
    if (bestMatch != null)
      return commitLongestMatch(context, bestMatch, undefined, consumingFailure);
    return {
      ...error,
      success: false
    };
  };
  const parseAsyncBranches = async (context) => {
    let bestMatch = null;
    const optionsTerminatorMatches = [];
    let error = getInitialError(context);
    let consumingFailure;
    const activeState = normalizeExclusiveState(context.state);
    for (let i = 0;i < parsers.length; i++) {
      const parser = parsers[i];
      const childContext = withChildContext$1(context, i, activeState == null || activeState[0] !== i || !activeState[1].success ? parser.initialState : activeState[1].next.state, parser);
      const resultOrPromise = parser.parse(childContext);
      const result = await resultOrPromise;
      if (isOptionsTerminatorOnlyResult(context, result)) {
        optionsTerminatorMatches.push({
          index: i,
          result,
          consumed: 1,
          ...normalizeExclusiveState(result.next.state) != null ? { selectedAfterTerminator: true } : {}
        });
        continue;
      }
      if (result.success) {
        consumingFailure = retainConsumingFailureHint(consumingFailure, context, result.next);
        const consumed = context.buffer.length - result.next.buffer.length;
        const bestIsProvisional = bestMatch != null && bestMatch.result.success && !!bestMatch.result.provisional;
        if (bestMatch === null || consumed > bestMatch.consumed || consumed === bestMatch.consumed && bestIsProvisional && !result.provisional)
          bestMatch = {
            index: i,
            result,
            consumed
          };
      } else {
        const match = getOptionMatch(parser, childContext.state, context.buffer[0]);
        if (result.consumed > 0 && match != null)
          consumingFailure = retainConsumingFailure(consumingFailure, result, match.priority);
        if (error.consumed < result.consumed)
          error = result;
      }
    }
    const optionsTerminatorResolution = resolveLongestMatchOptionsTerminator(context, bestMatch, optionsTerminatorMatches);
    if (optionsTerminatorResolution != null)
      return optionsTerminatorResolution;
    if (bestMatch != null)
      return commitLongestMatch(context, bestMatch, undefined, consumingFailure);
    return {
      ...error,
      success: false
    };
  };
  const multiResult = {
    mode: combinedMode,
    $valueType: [],
    $stateType: [],
    priority: Math.max(...parsers.map((p) => p.priority)),
    usage: [{
      type: "exclusive",
      terms: parsers.map((p) => p.usage)
    }],
    leadingNames: unionLeadingNames(parsers),
    acceptingAnyToken: parsers.some((p) => p.acceptingAnyToken),
    initialState: undefined,
    complete: createExclusiveComplete(parsers, options, noMatchContext, combinedMode),
    [extractPhase2SeedKey](state, exec) {
      return extractExclusivePhase2Seed(parsers, state, exec, combinedMode);
    },
    parse(context) {
      return dispatchByMode(combinedMode, () => parseSyncBranches(context), () => parseAsyncBranches(context));
    },
    getSuggestRuntimeNodes(state, path) {
      return getExclusiveSuggestRuntimeNodes(parsers, state, path);
    },
    suggest: createExclusiveSuggest(parsers, combinedMode),
    getDocFragments(state, _defaultValue) {
      let commandMetadata;
      let brief;
      let description;
      let footer;
      let fragments;
      let shouldDeduplicate;
      if (state.kind === "unavailable" || state.state == null) {
        fragments = parsers.flatMap((p) => p.getDocFragments({ kind: "unavailable" }).fragments);
        shouldDeduplicate = true;
      } else {
        const [i, result] = state.state;
        if (result.success) {
          const docResult = parsers[i].getDocFragments({
            kind: "available",
            state: result.next.state
          });
          commandMetadata = getCommandDocMetadata(docResult);
          brief = docResult.brief;
          description = docResult.description;
          footer = docResult.footer;
          fragments = docResult.fragments;
          shouldDeduplicate = false;
        } else {
          fragments = parsers.flatMap((p) => p.getDocFragments({ kind: "unavailable" }).fragments);
          shouldDeduplicate = true;
        }
      }
      return withCommandDocMetadata({
        brief,
        description,
        fragments: shouldDeduplicate ? deduplicateDocFragments(fragments) : fragments,
        footer
      }, commandMetadata);
    }
  };
  const multiDependencyMetadata = composeExclusiveDependencyMetadata(parsers);
  if (multiDependencyMetadata != null)
    multiResult.dependencyMetadata = multiDependencyMetadata;
  defineExclusiveSchedulingNodes(multiResult, parsers);
  defineInheritedAnnotationParser(multiResult);
  defineOptionMatch(multiResult, (state, token) => combineOptionMatches(parsers.map((parser, index) => {
    const active = normalizeExclusiveState(state);
    return getOptionMatch(parser, active?.[0] === index && active[1].success ? active[1].next.state : parser.initialState, token);
  })));
  definePassThroughPriority(multiResult, parsers, (state, token) => {
    const active = normalizeExclusiveState(state);
    return combinePassThroughPriorities(parsers.map((parser, index) => getPassThroughPriority(parser, active?.[0] === index && active[1].success ? active[1].next.state : parser.initialState, token)));
  });
  return fluent(multiResult);
}
function createObjectLikeInitialError(context, noMatchContext, errors) {
  if (context.buffer.length < 1) {
    const customEndOfInput = errors?.endOfInput;
    return {
      consumed: 0,
      error: customEndOfInput ? typeof customEndOfInput === "function" ? customEndOfInput(noMatchContext) : customEndOfInput : generateNoMatchError(noMatchContext)
    };
  }
  const token = context.buffer[0];
  const customMessage = errors?.unexpectedInput;
  if (customMessage)
    return {
      consumed: 0,
      error: typeof customMessage === "function" ? customMessage(token) : customMessage
    };
  const baseError = message`Unexpected option or argument: ${token}.`;
  return {
    consumed: 0,
    error: createErrorWithSuggestions(baseError, token, context.usage, "both", errors?.suggestions)
  };
}
function* suggestObjectSync(context, prefix, parserPairs) {
  const runtime = createDependencyRuntimeContext(context.dependencyRegistry?.clone());
  const sourceParserPairs = filterExcludedFieldParsers(parserPairs, context.exec?.excludedSourceFields);
  const nodes = buildRuntimeNodesFromPairs(sourceParserPairs, context.state && typeof context.state === "object" ? context.state : {}, context.exec?.path);
  collectExplicitSourceValues(expandSourceCollectionNodes(nodes), runtime);
  if (context.state && typeof context.state === "object")
    collectSourcesFromState(context.state, runtime, /* @__PURE__ */ new WeakSet, context.exec?.excludedSourceFields);
  completeDependencySourceDefaults(context, sourceParserPairs, runtime, context.exec);
  const contextWithRegistry = {
    ...context,
    dependencyRegistry: runtime.registry,
    ...context.exec != null ? { exec: {
      ...context.exec,
      dependencyRuntime: runtime,
      dependencyRegistry: runtime.registry
    } } : {}
  };
  if (context.buffer.length > 0) {
    const lastToken = context.buffer[context.buffer.length - 1];
    for (const [field, parser] of parserPairs)
      if (isOptionRequiringValue(parser.usage, lastToken)) {
        const annotatedFieldState = getAnnotatedFieldState(context.state, field, parser);
        yield* parser.suggest(withChildContext$1(contextWithRegistry, field, annotatedFieldState, parser), prefix);
        return;
      }
  }
  const suggestions = [];
  for (const [field, parser] of parserPairs) {
    const annotatedFieldState = getAnnotatedFieldState(context.state, field, parser);
    const fieldSuggestions = parser.suggest(withChildContext$1(contextWithRegistry, field, annotatedFieldState, parser), prefix);
    suggestions.push(...fieldSuggestions);
  }
  yield* deduplicateSuggestions(suggestions);
}
async function* suggestObjectAsync(context, prefix, parserPairs) {
  const runtime = createDependencyRuntimeContext(context.dependencyRegistry?.clone());
  const sourceParserPairs = filterExcludedFieldParsers(parserPairs, context.exec?.excludedSourceFields);
  const nodes = buildRuntimeNodesFromPairs(sourceParserPairs, context.state && typeof context.state === "object" ? context.state : {}, context.exec?.path);
  await collectExplicitSourceValuesAsync(expandSourceCollectionNodes(nodes), runtime);
  if (context.state && typeof context.state === "object")
    collectSourcesFromState(context.state, runtime, /* @__PURE__ */ new WeakSet, context.exec?.excludedSourceFields);
  await completeDependencySourceDefaultsAsync(context, sourceParserPairs, runtime, context.exec);
  const contextWithRegistry = {
    ...context,
    dependencyRegistry: runtime.registry,
    ...context.exec != null ? { exec: {
      ...context.exec,
      dependencyRuntime: runtime,
      dependencyRegistry: runtime.registry
    } } : {}
  };
  if (context.buffer.length > 0) {
    const lastToken = context.buffer[context.buffer.length - 1];
    for (const [field, parser] of parserPairs)
      if (isOptionRequiringValue(parser.usage, lastToken)) {
        const annotatedFieldState = getAnnotatedFieldState(context.state, field, parser);
        const suggestions$1 = parser.suggest(withChildContext$1(contextWithRegistry, field, annotatedFieldState, parser), prefix);
        for await (const s of suggestions$1)
          yield s;
        return;
      }
  }
  const suggestions = [];
  for (const [field, parser] of parserPairs) {
    const annotatedFieldState = getAnnotatedFieldState(context.state, field, parser);
    const fieldSuggestions = parser.suggest(withChildContext$1(contextWithRegistry, field, annotatedFieldState, parser), prefix);
    for await (const s of fieldSuggestions)
      suggestions.push(s);
  }
  yield* deduplicateSuggestions(suggestions);
}
function registerCompletedDependency(completed, registry, exec) {
  if (!isDependencySourceState(completed) || !completed.result.success)
    return;
  const sourceId = completed[dependencyId];
  const effectful = exec?.effectfulCompletionSession?.effectfulSources.has(sourceId) === true;
  if (effectful || !registry.has(sourceId))
    registry.set(sourceId, completed.result.value);
}
function* pendingDependencyDefaults(context, parserPairs, registry) {
  for (const [field, fieldParser] of parserPairs) {
    const sourceId = fieldParser.dependencyMetadata?.source?.sourceId ?? (isWrappedDependencySource(fieldParser) ? fieldParser[wrappedDependencySourceMarker][dependencyId] : isPendingDependencySourceState(fieldParser.initialState) ? fieldParser.initialState[dependencyId] : undefined);
    if (sourceId != null && registry?.has(sourceId))
      continue;
    const fieldState = context.state != null && typeof context.state === "object" && field in context.state ? context.state[field] : undefined;
    const annotatedFieldState = getAnnotatedFieldState(context.state, field, fieldParser);
    if (fieldParser.dependencyMetadata?.source?.getMissingSourceValue != null && isUnmatchedDependencyState(fieldState, fieldParser)) {
      yield {
        parser: fieldParser,
        state: annotatedFieldState
      };
      continue;
    }
    if (fieldParser.dependencyMetadata?.source != null && isUnmatchedDependencyState(fieldState, fieldParser) && (annotatedFieldState !== fieldState || isNonCliBoundSourceState(fieldState, fieldParser))) {
      yield {
        parser: fieldParser,
        state: annotatedFieldState
      };
      continue;
    }
    if (fieldState != null) {
      if (!Array.isArray(fieldState) && !isDependencySourceState(fieldState) && (isWrappedDependencySource(fieldParser) || isPendingDependencySourceState(fieldParser.initialState)))
        yield {
          parser: fieldParser,
          state: getAnnotatedFieldState(context.state, field, fieldParser)
        };
      continue;
    }
    if (isPendingDependencySourceState(fieldParser.initialState))
      yield {
        parser: fieldParser,
        state: fieldParser.initialState
      };
    else if (isWrappedDependencySource(fieldParser))
      yield {
        parser: fieldParser,
        state: [fieldParser[wrappedDependencySourceMarker]]
      };
  }
}
function completeDependencySourceDefaults(context, parserPairs, runtime, exec) {
  for (const { parser, state } of pendingDependencyDefaults(context, parserPairs, runtime.registry)) {
    const completed = parser.complete(state, exec);
    const depState = wrapAsDependencySourceState(completed, parser);
    if (depState)
      registerCompletedDependency(depState, runtime.registry);
  }
  const stateRecord = context.state != null && typeof context.state === "object" ? context.state : {};
  resolveDerivedSourceValues(expandSourceCollectionNodes(buildRuntimeNodesFromPairs(parserPairs, stateRecord, exec?.path)), runtime, { effectfulProviders: "inactive" });
}
function wrapAsDependencySourceState(completed, parser) {
  if (isDependencySourceState(completed))
    return completed;
  const metadataSource = parser.dependencyMetadata?.source;
  if (metadataSource?.preservesSourceValue === false)
    return;
  const hasDep = metadataSource != null || isWrappedDependencySource(parser) || isPendingDependencySourceState(parser.initialState);
  if (isDeferredCompletionResult(completed))
    return;
  if (hasDep && typeof completed === "object" && completed !== null && "success" in completed && completed.success && "value" in completed && completed.value !== undefined) {
    const depId = metadataSource?.sourceId ?? (isWrappedDependencySource(parser) ? parser[wrappedDependencySourceMarker][dependencyId] : parser.initialState[dependencyId]);
    return createDependencySourceState(completed, depId);
  }
  return;
}
async function completeDependencySourceDefaultsAsync(context, parserPairs, runtime, exec) {
  for (const { parser, state } of pendingDependencyDefaults(context, parserPairs, runtime.registry)) {
    const completed = await parser.complete(state, exec);
    const depState = wrapAsDependencySourceState(completed, parser);
    if (depState)
      registerCompletedDependency(depState, runtime.registry);
  }
  const stateRecord = context.state != null && typeof context.state === "object" ? context.state : {};
  await resolveDerivedSourceValuesAsync(expandSourceCollectionNodes(buildRuntimeNodesFromPairs(parserPairs, stateRecord, exec?.path)), runtime, { effectfulProviders: "inactive" });
}
function collectDuplicateFieldNames(pairs) {
  const counts = /* @__PURE__ */ new Map;
  for (const [field] of pairs)
    counts.set(field, (counts.get(field) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([field]) => field));
}
function filterExcludedFieldParsers(pairs, excludedFields) {
  if (excludedFields == null || excludedFields.size < 1)
    return pairs;
  return pairs.filter(([field]) => !excludedFields.has(field));
}
function preCompleteAndRegisterDependencies(state, fieldParserPairs, registry, exec) {
  if (exec?.dependencyRuntime != null)
    releaseUncollectedSourceValues(expandSourceCollectionNodes(buildRuntimeNodesFromPairs(fieldParserPairs, state, exec.path)), exec.dependencyRuntime);
  const preCompleted = /* @__PURE__ */ new Map;
  const parentResults = exec?.preCompletedByParser;
  for (const [field, fieldParser] of fieldParserPairs) {
    const cached = parentResults?.get(field);
    if (cached !== undefined) {
      preCompleted.set(field, cached);
      registerCompletedDependency(cached, registry);
      continue;
    }
    const fieldState = state[field];
    const annotatedFieldState = getAnnotatedFieldState(state, field, fieldParser);
    if (fieldParser.dependencyMetadata?.source?.getMissingSourceValue != null && isUnmatchedDependencyState(fieldState, fieldParser)) {
      const completed = fieldParser.complete(annotatedFieldState, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      const depState = wrapAsDependencySourceState(completed, fieldParser);
      if (depState)
        registerCompletedDependency(depState, registry);
      continue;
    }
    if (fieldParser.dependencyMetadata?.source != null && isUnmatchedDependencyState(fieldState, fieldParser) && (annotatedFieldState !== fieldState || isNonCliBoundSourceState(fieldState, fieldParser))) {
      const completed = fieldParser.complete(annotatedFieldState, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      const depState = wrapAsDependencySourceState(completed, fieldParser);
      if (depState)
        registerCompletedDependency(depState, registry);
      continue;
    }
    if (Array.isArray(fieldState) && fieldState.length === 1 && isPendingDependencySourceState(fieldState[0])) {
      const completed = fieldParser.complete(fieldState, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      if (isDependencySourceState(completed))
        registerCompletedDependency(completed, registry);
    } else if (fieldState === undefined && isPendingDependencySourceState(fieldParser.initialState)) {
      const completed = fieldParser.complete([fieldParser.initialState], withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      if (isDependencySourceState(completed))
        registerCompletedDependency(completed, registry);
    } else if (fieldState === undefined && isWrappedDependencySource(fieldParser)) {
      const pendingState = fieldParser[wrappedDependencySourceMarker];
      const completed = fieldParser.complete([pendingState], withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      if (isDependencySourceState(completed))
        registerCompletedDependency(completed, registry);
    } else if (fieldState != null && !Array.isArray(fieldState) && !isDependencySourceState(fieldState) && (isWrappedDependencySource(fieldParser) || isPendingDependencySourceState(fieldParser.initialState))) {
      const annotatedFieldState$1 = getAnnotatedFieldState(state, field, fieldParser);
      const completed = fieldParser.complete(annotatedFieldState$1, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      const depState = wrapAsDependencySourceState(completed, fieldParser);
      if (depState)
        registerCompletedDependency(depState, registry);
    }
  }
  return preCompleted;
}
async function preCompleteAndRegisterDependenciesAsync(state, fieldParserPairs, registry, exec) {
  if (exec?.dependencyRuntime != null)
    releaseUncollectedSourceValues(expandSourceCollectionNodes(buildRuntimeNodesFromPairs(fieldParserPairs, state, exec.path)), exec.dependencyRuntime);
  const preCompleted = /* @__PURE__ */ new Map;
  const parentResults = exec?.preCompletedByParser;
  for (const [field, fieldParser] of fieldParserPairs) {
    if (firstPreCompletedFailure(preCompleted) != null)
      break;
    const cached = parentResults?.get(field);
    if (cached !== undefined) {
      preCompleted.set(field, cached);
      registerCompletedDependency(cached, registry, exec);
      continue;
    }
    if (fieldParser.dependencyMetadata?.source?.completeSource != null)
      continue;
    const fieldState = state[field];
    const annotatedFieldState = getAnnotatedFieldState(state, field, fieldParser);
    if (exec?.effectfulCompletionSession?.policy === "demand-only" && typeof fieldParser.shouldDeferCompletion === "function" && fieldParser.shouldDeferCompletion(annotatedFieldState, withChildExecPath(exec, field)) === true)
      continue;
    if (fieldParser.dependencyMetadata?.source?.getMissingSourceValue != null && isUnmatchedDependencyState(fieldState, fieldParser)) {
      const completed = await fieldParser.complete(annotatedFieldState, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      const depState = wrapAsDependencySourceState(completed, fieldParser);
      if (depState)
        registerCompletedDependency(depState, registry, exec);
      continue;
    }
    if (fieldParser.dependencyMetadata?.source != null && isUnmatchedDependencyState(fieldState, fieldParser) && (annotatedFieldState !== fieldState || isNonCliBoundSourceState(fieldState, fieldParser))) {
      const completed = await fieldParser.complete(annotatedFieldState, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      const depState = wrapAsDependencySourceState(completed, fieldParser);
      if (depState)
        registerCompletedDependency(depState, registry, exec);
      continue;
    }
    if (Array.isArray(fieldState) && fieldState.length === 1 && isPendingDependencySourceState(fieldState[0])) {
      const completed = await fieldParser.complete(fieldState, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      if (isDependencySourceState(completed))
        registerCompletedDependency(completed, registry, exec);
    } else if (fieldState === undefined && isPendingDependencySourceState(fieldParser.initialState)) {
      const completed = await fieldParser.complete([fieldParser.initialState], withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      if (isDependencySourceState(completed))
        registerCompletedDependency(completed, registry, exec);
    } else if (fieldState === undefined && isWrappedDependencySource(fieldParser)) {
      const pendingState = fieldParser[wrappedDependencySourceMarker];
      const completed = await fieldParser.complete([pendingState], withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      if (isDependencySourceState(completed))
        registerCompletedDependency(completed, registry, exec);
    } else if (fieldState != null && !Array.isArray(fieldState) && !isDependencySourceState(fieldState) && (isWrappedDependencySource(fieldParser) || isPendingDependencySourceState(fieldParser.initialState))) {
      const annotatedFieldState$1 = getAnnotatedFieldState(state, field, fieldParser);
      const completed = await fieldParser.complete(annotatedFieldState$1, withChildExecPath(exec, field));
      preCompleted.set(field, completed);
      const depState = wrapAsDependencySourceState(completed, fieldParser);
      if (depState)
        registerCompletedDependency(depState, registry, exec);
    }
  }
  return preCompleted;
}
function object(labelOrParsers, maybeParsersOrOptions, maybeOptions) {
  const label = typeof labelOrParsers === "string" ? labelOrParsers : undefined;
  if (label != null)
    validateLabel(label);
  let parsers;
  let options = {};
  if (typeof labelOrParsers === "string") {
    parsers = maybeParsersOrOptions;
    options = maybeOptions ?? {};
  } else {
    parsers = labelOrParsers;
    options = maybeParsersOrOptions ?? {};
  }
  const parserKeys = Reflect.ownKeys(parsers);
  const parserPairs = parserKeys.map((k) => [k, parsers[k]]);
  parserPairs.sort(([_, parserA], [__, parserB]) => parserB.priority - parserA.priority);
  const passThroughParsers = new Set(parserPairs.map(([, parser]) => parser).filter((parser) => hasPassThroughUsage(parser.usage)));
  const createInitialState = () => {
    const state = {};
    for (const key of parserKeys)
      state[key] = parsers[key].initialState;
    return state;
  };
  const inheritedFieldStateCache = /* @__PURE__ */ new WeakMap;
  const createFieldStateGetter = (parentState, annotateChildState = getWrappedChildState) => {
    return (field, parser) => {
      const fieldKey = field;
      const cache = parentState != null && typeof parentState === "object" ? (() => {
        const annotatorCaches = inheritedFieldStateCache.get(parentState) ?? (() => {
          const nextCaches = /* @__PURE__ */ new WeakMap;
          inheritedFieldStateCache.set(parentState, nextCaches);
          return nextCaches;
        })();
        return annotatorCaches.get(annotateChildState) ?? (() => {
          const stateCache = /* @__PURE__ */ new Map;
          annotatorCaches.set(annotateChildState, stateCache);
          return stateCache;
        })();
      })() : undefined;
      if (cache?.has(fieldKey))
        return cache.get(fieldKey);
      const sourceState = parentState != null && typeof parentState === "object" && fieldKey in parentState ? parentState[fieldKey] : parser.initialState;
      const inheritedState = annotateChildState(parentState, sourceState, parser);
      cache?.set(fieldKey, inheritedState);
      return inheritedState;
    };
  };
  if (!options.allowDuplicates)
    checkDuplicateOptionNames(parserPairs.map(([field, parser]) => [field, parser.usage]));
  checkDuplicateReachableLeadingCommandNames(parserPairs.map(([field, parser]) => [field, parser]));
  const noMatchContext = analyzeNoMatchContext(parserKeys.map((k) => parsers[k]));
  const combinedMode = parserKeys.some((k) => parsers[k].mode === "async") ? "async" : "sync";
  const getInitialError = (context) => createObjectLikeInitialError(context, noMatchContext, options.errors);
  const adaptFieldLaneResult = (context, field, parser, fieldState, result) => {
    if (!result.success)
      return result;
    if (result.consumed.length === 0 && result.next.state === fieldState)
      return {
        success: true,
        next: context,
        consumed: []
      };
    const mergedExec = mergeChildExec(context.exec, result.next.exec);
    const nextState = result.next.state === fieldState ? context.state : {
      ...context.state,
      [field]: getWrappedChildState(context.state, result.next.state, parser)
    };
    return {
      success: true,
      next: {
        ...context,
        ...getPassThroughFailureHint(result.next),
        buffer: result.next.buffer,
        optionsTerminated: result.next.optionsTerminated,
        state: nextState,
        ...mergedExec != null ? {
          trace: mergedExec.trace,
          exec: mergedExec,
          dependencyRegistry: mergedExec.dependencyRegistry
        } : {}
      },
      consumed: result.consumed
    };
  };
  const objectZeroConsumptionGroup = {};
  const objectParseLanes = parserPairs.map(([field, parser]) => ({
    priority: parser.priority,
    zeroConsumptionGroup: objectZeroConsumptionGroup,
    settlesZeroConsumption: false,
    leadingNames: parser.leadingNames,
    acceptingAnyToken: parser.acceptingAnyToken,
    parse(context) {
      const fieldState = createFieldStateGetter(context.state, getObjectParseChildState)(field, parser);
      return dispatchByMode(combinedMode, () => {
        const result = parser.parse(withChildContext$1(context, field, fieldState, parser));
        return adaptFieldLaneResult(context, field, parser, fieldState, result);
      }, async () => {
        const result = await parser.parse(withChildContext$1(context, field, fieldState, parser));
        return adaptFieldLaneResult(context, field, parser, fieldState, result);
      });
    }
  }));
  const parseSync = (context) => {
    let error = getInitialError(context);
    let currentContext = context;
    let anySuccess = false;
    const allConsumed = [];
    const consumedFields = /* @__PURE__ */ new Set;
    let consumingFailure;
    let madeProgress = true;
    while (madeProgress && currentContext.buffer.length > 0) {
      madeProgress = false;
      consumingFailure = undefined;
      const getFieldState = createFieldStateGetter(currentContext.state, getObjectParseChildState);
      for (const [field, parser] of orderBeforePassThrough(parserPairs, currentContext, ([, parser$1]) => parser$1, ([field$1, parser$1]) => getFieldState(field$1, parser$1), passThroughParsers)) {
        const result = parser.parse(withPassThroughFailure(withChildContext$1(currentContext, field, getFieldState(field, parser), parser), consumingFailure, getPassThroughPriority(parser, getFieldState(field, parser), currentContext.buffer[0])));
        if (result.success && result.consumed.length > 0) {
          const mergedExec = mergeChildExec(currentContext.exec, result.next.exec);
          currentContext = {
            ...currentContext,
            ...getPassThroughFailureHint(result.next),
            buffer: result.next.buffer,
            optionsTerminated: result.next.optionsTerminated,
            state: {
              ...currentContext.state,
              [field]: getWrappedChildState(currentContext.state, result.next.state, parser)
            },
            ...mergedExec != null ? {
              trace: mergedExec.trace,
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          };
          allConsumed.push(...result.consumed);
          anySuccess = true;
          madeProgress = true;
          consumedFields.add(field);
          break;
        } else if (result.success)
          consumingFailure = retainConsumingFailureHint(consumingFailure, currentContext, result.next);
        else {
          const match = getOptionMatch(parser, getFieldState(field, parser), currentContext.buffer[0]);
          if (result.consumed > 0 && match != null)
            consumingFailure = retainConsumingFailure(consumingFailure, result, match.priority);
          if (error.consumed < result.consumed)
            error = result;
        }
      }
    }
    {
      const getFieldState = createFieldStateGetter(currentContext.state, getObjectParseChildState);
      for (const [field, parser] of parserPairs) {
        if (consumedFields.has(field))
          continue;
        const typedParser = parser;
        if (parser.leadingNames.size > 0 || typedParser.acceptingAnyToken)
          continue;
        const fieldState = getFieldState(field, parser);
        const result = typedParser.parse(withPassThroughFailure(withChildContext$1(currentContext, field, fieldState, parser), consumingFailure, getPassThroughPriority(parser, getFieldState(field, parser), currentContext.buffer[0])));
        if (result.success && result.consumed.length === 0 && result.next.state !== fieldState) {
          const mergedExec = mergeChildExec(currentContext.exec, result.next.exec);
          currentContext = {
            ...currentContext,
            state: {
              ...currentContext.state,
              [field]: getWrappedChildState(currentContext.state, result.next.state, parser)
            },
            ...mergedExec != null ? {
              trace: mergedExec.trace,
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          };
        }
      }
    }
    if (anySuccess)
      return {
        success: true,
        next: withPassThroughFailure(currentContext, consumingFailure),
        consumed: allConsumed
      };
    if (currentContext.buffer.length === 0) {
      let allCanComplete = true;
      const getFieldState = createFieldStateGetter(currentContext.state);
      const probeExec = currentContext.exec ? {
        ...currentContext.exec,
        phase: "parse"
      } : {
        usage: [],
        path: [],
        trace: undefined,
        phase: "parse"
      };
      let probeError;
      for (const [field, parser] of parserPairs) {
        const fieldState = getFieldState(field, parser);
        const completeResult = parser.complete(fieldState, withChildExecPath(probeExec, field));
        if (!completeResult.success) {
          allCanComplete = false;
          probeError = {
            consumed: 0,
            error: completeResult.error
          };
          break;
        }
      }
      if (allCanComplete)
        return {
          success: true,
          next: currentContext,
          consumed: []
        };
      if (probeError !== undefined && options.errors?.endOfInput === undefined && !noMatchContext.hasOptions && !noMatchContext.hasCommands && !noMatchContext.hasArguments)
        return {
          ...probeError,
          success: false
        };
    }
    return {
      ...error,
      success: false
    };
  };
  const parseAsync = async (context) => {
    let error = getInitialError(context);
    let currentContext = context;
    let anySuccess = false;
    const allConsumed = [];
    const consumedFields = /* @__PURE__ */ new Set;
    let consumingFailure;
    let madeProgress = true;
    while (madeProgress && currentContext.buffer.length > 0) {
      madeProgress = false;
      consumingFailure = undefined;
      const getFieldState = createFieldStateGetter(currentContext.state, getObjectParseChildState);
      for (const [field, parser] of orderBeforePassThrough(parserPairs, currentContext, ([, parser$1]) => parser$1, ([field$1, parser$1]) => getFieldState(field$1, parser$1), passThroughParsers)) {
        const resultOrPromise = parser.parse(withPassThroughFailure(withChildContext$1(currentContext, field, getFieldState(field, parser), parser), consumingFailure, getPassThroughPriority(parser, getFieldState(field, parser), currentContext.buffer[0])));
        const result = await resultOrPromise;
        if (result.success && result.consumed.length > 0) {
          const mergedExec = mergeChildExec(currentContext.exec, result.next.exec);
          currentContext = {
            ...currentContext,
            ...getPassThroughFailureHint(result.next),
            buffer: result.next.buffer,
            optionsTerminated: result.next.optionsTerminated,
            state: {
              ...currentContext.state,
              [field]: getWrappedChildState(currentContext.state, result.next.state, parser)
            },
            ...mergedExec != null ? {
              trace: mergedExec.trace,
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          };
          allConsumed.push(...result.consumed);
          anySuccess = true;
          madeProgress = true;
          consumedFields.add(field);
          break;
        } else if (result.success)
          consumingFailure = retainConsumingFailureHint(consumingFailure, currentContext, result.next);
        else {
          const match = getOptionMatch(parser, getFieldState(field, parser), currentContext.buffer[0]);
          if (result.consumed > 0 && match != null)
            consumingFailure = retainConsumingFailure(consumingFailure, result, match.priority);
          if (error.consumed < result.consumed)
            error = result;
        }
      }
    }
    {
      const getFieldState = createFieldStateGetter(currentContext.state, getObjectParseChildState);
      for (const [field, parser] of parserPairs) {
        if (consumedFields.has(field))
          continue;
        if (parser.leadingNames.size > 0 || parser.acceptingAnyToken)
          continue;
        const fieldState = getFieldState(field, parser);
        const resultOrPromise = parser.parse(withPassThroughFailure(withChildContext$1(currentContext, field, fieldState, parser), consumingFailure, getPassThroughPriority(parser, getFieldState(field, parser), currentContext.buffer[0])));
        const result = await resultOrPromise;
        if (result.success && result.consumed.length === 0 && result.next.state !== fieldState) {
          const mergedExec = mergeChildExec(currentContext.exec, result.next.exec);
          currentContext = {
            ...currentContext,
            state: {
              ...currentContext.state,
              [field]: getWrappedChildState(currentContext.state, result.next.state, parser)
            },
            ...mergedExec != null ? {
              trace: mergedExec.trace,
              exec: mergedExec,
              dependencyRegistry: mergedExec.dependencyRegistry
            } : {}
          };
        }
      }
    }
    if (anySuccess)
      return {
        success: true,
        next: withPassThroughFailure(currentContext, consumingFailure),
        consumed: allConsumed
      };
    if (currentContext.buffer.length === 0) {
      let allCanComplete = true;
      const getFieldState = createFieldStateGetter(currentContext.state);
      const probeExec = currentContext.exec ? {
        ...currentContext.exec,
        phase: "parse"
      } : {
        usage: [],
        path: [],
        trace: undefined,
        phase: "parse"
      };
      let probeError;
      for (const [field, parser] of parserPairs) {
        const fieldState = getFieldState(field, parser);
        const completeResult = await parser.complete(fieldState, withChildExecPath(probeExec, field));
        if (!completeResult.success) {
          allCanComplete = false;
          probeError = {
            consumed: 0,
            error: completeResult.error
          };
          break;
        }
      }
      if (allCanComplete)
        return {
          success: true,
          next: currentContext,
          consumed: []
        };
      if (probeError !== undefined && options.errors?.endOfInput === undefined && !noMatchContext.hasOptions && !noMatchContext.hasCommands && !noMatchContext.hasArguments)
        return {
          ...probeError,
          success: false
        };
    }
    return {
      ...error,
      success: false
    };
  };
  const objectParser = {
    mode: combinedMode,
    $valueType: [],
    $stateType: [],
    [fieldParsersKey]: parserPairs,
    priority: Math.max(...parserKeys.map((k) => parsers[k].priority)),
    usage: applyHiddenToUsage(parserPairs.flatMap(([_, p]) => p.usage), options.hidden),
    leadingNames: sharedBufferLeadingNames(parserPairs.map(([_, p]) => p)),
    acceptingAnyToken: parserPairs.some(([_, p]) => p.acceptingAnyToken),
    canSkip(state, exec) {
      const getFieldState = createFieldStateGetter(state);
      return parserKeys.every((field) => {
        const parser = parsers[field];
        return parser.canSkip?.(getFieldState(field, parser), withChildExecPath(exec, field)) === true;
      });
    },
    get initialState() {
      return createInitialState();
    },
    parse(context) {
      return dispatchByMode(combinedMode, () => parseSync(context), () => parseAsync(context));
    },
    getSuggestRuntimeNodes(state, path) {
      const stateRecord = state != null && typeof state === "object" ? state : objectParser.initialState;
      return buildSuggestRuntimeNodesFromPairs(parserPairs, stateRecord, path);
    },
    complete(state, exec) {
      return dispatchByMode(combinedMode, () => {
        const runtime = exec?.dependencyRuntime ?? createDependencyRuntimeContext(exec?.dependencyRegistry);
        const childExec = {
          ...exec,
          dependencyRuntime: runtime
        };
        const typedParserPairs = filterExcludedFieldParsers(parserPairs, exec?.excludedSourceFields);
        const preCompleted = preCompleteAndRegisterDependencies(state, typedParserPairs, runtime.registry, childExec);
        const phase3Exec = {
          ...childExec,
          preCompletedByParser: undefined,
          republishCachedCompletions: undefined
        };
        const getFieldState = createFieldStateGetter(state);
        const annotatedState = {};
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          annotatedState[fieldKey] = getFieldState(field, fieldParser);
        }
        collectExplicitSourceValues(expandSourceCollectionNodes(filterPreCompletedRuntimeNodes(buildRuntimeNodesFromPairs(typedParserPairs, annotatedState, exec?.path), new Set(preCompleted.keys()))), runtime);
        const resolvedFieldStates = resolveStateWithRuntime(annotatedState, runtime);
        const result = {};
        const deferredKeys = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          let valueResult;
          const preCompletedResult = preCompleted.get(fieldKey);
          if (preCompletedResult !== undefined)
            valueResult = unwrapCompleteResult(preCompletedResult);
          else {
            const fieldState = resolvedFieldStates[fieldKey];
            valueResult = unwrapCompleteResult(fieldParser.complete(fieldState, withChildExecPath(phase3Exec, fieldKey)));
          }
          if (valueResult.success) {
            result[fieldKey] = valueResult.value;
            if (valueResult.deferred)
              if (valueResult.deferredKeys)
                deferredKeys.set(fieldKey, valueResult.deferredKeys);
              else if (valueResult.value == null || typeof valueResult.value !== "object")
                deferredKeys.set(fieldKey, null);
              else
                hasDeferred = true;
          } else
            return {
              success: false,
              error: valueResult.error
            };
        }
        const isDeferred = deferredKeys.size > 0 || hasDeferred;
        return {
          success: true,
          value: result,
          ...isDeferred ? {
            deferred: true,
            ...deferredKeys.size > 0 ? { deferredKeys } : {}
          } : {}
        };
      }, async () => {
        const runtime = exec?.dependencyRuntime ?? createDependencyRuntimeContext(exec?.dependencyRegistry);
        const childExec = {
          ...exec,
          dependencyRuntime: runtime
        };
        const asyncParserPairs = filterExcludedFieldParsers(parserPairs, exec?.excludedSourceFields);
        const preCompleted = await preCompleteAndRegisterDependenciesAsync(state, asyncParserPairs, runtime.registry, childExec);
        const phase3Exec = {
          ...childExec,
          preCompletedByParser: undefined,
          republishCachedCompletions: undefined
        };
        const getFieldState = createFieldStateGetter(state);
        const annotatedState = {};
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          annotatedState[fieldKey] = getFieldState(field, fieldParser);
        }
        const allRuntimeNodes = buildRuntimeNodesFromPairs(asyncParserPairs, annotatedState, exec?.path);
        const runtimeNodes = filterPreCompletedRuntimeNodes(allRuntimeNodes, new Set(preCompleted.keys()));
        await collectExplicitSourceValuesAsync(expandSourceCollectionNodes(runtimeNodes), runtime);
        const effectfulFailure = await scheduleEffectfulSourceCompletions(filterSchedulableRuntimeNodes(allRuntimeNodes, preCompleted), annotatedState, runtime, childExec, preCompleted);
        if (effectfulFailure != null)
          return effectfulFailure;
        const resolvedFieldStates = await resolveStateWithRuntimeAsync(annotatedState, runtime);
        const result = {};
        const deferredKeys = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        const applyValueResult = (fieldKey, valueResult) => {
          if (valueResult.success) {
            result[fieldKey] = valueResult.value;
            if (valueResult.deferred)
              if (valueResult.deferredKeys)
                deferredKeys.set(fieldKey, valueResult.deferredKeys);
              else if (valueResult.value == null || typeof valueResult.value !== "object")
                deferredKeys.set(fieldKey, null);
              else
                hasDeferred = true;
          } else
            return {
              success: false,
              error: valueResult.error
            };
          return;
        };
        const concurrentFields = [];
        const deferredFields = [];
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          const preCompletedResult = preCompleted.get(fieldKey);
          if (preCompletedResult !== undefined) {
            const failure = applyValueResult(fieldKey, unwrapCompleteResult(preCompletedResult));
            if (failure != null)
              return failure;
            continue;
          }
          if (typeof fieldParser.shouldDeferCompletion === "function" && fieldParser.shouldDeferCompletion(resolvedFieldStates[fieldKey], withChildExecPath(phase3Exec, fieldKey)) === true)
            deferredFields.push(field);
          else
            concurrentFields.push(field);
        }
        const concurrentResults = await Promise.all(concurrentFields.map(async (field) => {
          const fieldKey = field;
          const fieldParser = parsers[field];
          const valueResult = unwrapCompleteResult(await fieldParser.complete(resolvedFieldStates[fieldKey], withChildExecPath(phase3Exec, fieldKey)));
          return {
            fieldKey,
            valueResult
          };
        }));
        for (const { fieldKey, valueResult } of concurrentResults) {
          const failure = applyValueResult(fieldKey, valueResult);
          if (failure != null)
            return failure;
        }
        for (const field of deferredFields) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          const valueResult = unwrapCompleteResult(await fieldParser.complete(resolvedFieldStates[fieldKey], withChildExecPath(phase3Exec, fieldKey)));
          const failure = applyValueResult(fieldKey, valueResult);
          if (failure != null)
            return failure;
        }
        const isDeferred = deferredKeys.size > 0 || hasDeferred;
        return {
          success: true,
          value: result,
          ...isDeferred ? {
            deferred: true,
            ...deferredKeys.size > 0 ? { deferredKeys } : {}
          } : {}
        };
      });
    },
    [extractPhase2SeedKey](state, exec) {
      return dispatchByMode(combinedMode, () => {
        const runtime = exec?.dependencyRuntime ?? createDependencyRuntimeContext(exec?.dependencyRegistry);
        const childExec = withDependencyRuntimeExec(objectParser.usage, exec, runtime);
        const typedParserPairs = filterExcludedFieldParsers(parserPairs, exec?.excludedSourceFields);
        const preCompleted = preCompleteAndRegisterDependencies(state, typedParserPairs, runtime.registry, childExec);
        const phase3Exec = {
          ...childExec,
          preCompletedByParser: undefined,
          republishCachedCompletions: undefined
        };
        const getFieldState = createFieldStateGetter(state);
        const annotatedState = {};
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          annotatedState[fieldKey] = getFieldState(field, fieldParser);
        }
        collectExplicitSourceValues(expandSourceCollectionNodes(filterPreCompletedRuntimeNodes(buildRuntimeNodesFromPairs(typedParserPairs, annotatedState, exec?.path), new Set(preCompleted.keys()))), runtime);
        const resolvedFieldStates = resolveStateWithRuntime(annotatedState, runtime);
        const result = {};
        const deferredKeys = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        let hasAnySeed = false;
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          const childExec$1 = withChildExecPath(phase3Exec, fieldKey);
          const preCompletedResult = preCompleted.get(fieldKey);
          const seed = preCompletedResult !== undefined ? reusePreCompletedPhase2Seed(fieldParser, resolvedFieldStates[fieldKey], preCompletedResult, childExec$1) : completeOrExtractPhase2Seed(fieldParser, resolvedFieldStates[fieldKey], childExec$1);
          if (seed == null)
            continue;
          hasAnySeed = true;
          result[fieldKey] = seed.value;
          if (seed.deferred)
            if (seed.deferredKeys)
              deferredKeys.set(fieldKey, seed.deferredKeys);
            else if (seed.value == null || typeof seed.value !== "object")
              deferredKeys.set(fieldKey, null);
            else
              hasDeferred = true;
        }
        if (!hasAnySeed)
          return null;
        return {
          value: result,
          ...deferredKeys.size > 0 || hasDeferred ? {
            deferred: true,
            ...deferredKeys.size > 0 ? { deferredKeys } : {}
          } : {}
        };
      }, async () => {
        const runtime = exec?.dependencyRuntime ?? createDependencyRuntimeContext(exec?.dependencyRegistry);
        const childExec = withDependencyRuntimeExec(objectParser.usage, exec, runtime);
        const asyncParserPairs = filterExcludedFieldParsers(parserPairs, exec?.excludedSourceFields);
        const preCompleted = await preCompleteAndRegisterDependenciesAsync(state, asyncParserPairs, runtime.registry, childExec);
        const phase3Exec = {
          ...childExec,
          preCompletedByParser: undefined,
          republishCachedCompletions: undefined
        };
        const getFieldState = createFieldStateGetter(state);
        const annotatedState = {};
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          annotatedState[fieldKey] = getFieldState(field, fieldParser);
        }
        const allRuntimeNodes = buildRuntimeNodesFromPairs(asyncParserPairs, annotatedState, exec?.path);
        const runtimeNodes = filterPreCompletedRuntimeNodes(allRuntimeNodes, new Set(preCompleted.keys()));
        await collectExplicitSourceValuesAsync(expandSourceCollectionNodes(runtimeNodes), runtime);
        const effectfulFailure = await scheduleEffectfulSourceCompletions(filterSchedulableRuntimeNodes(allRuntimeNodes, preCompleted), annotatedState, runtime, childExec, preCompleted);
        if (effectfulFailure != null)
          return null;
        const resolvedFieldStates = await resolveStateWithRuntimeAsync(annotatedState, runtime);
        const result = {};
        const deferredKeys = /* @__PURE__ */ new Map;
        let hasDeferred = false;
        let hasAnySeed = false;
        for (const field of parserKeys) {
          const fieldKey = field;
          const fieldParser = parsers[field];
          const childExec$1 = withChildExecPath(phase3Exec, fieldKey);
          const preCompletedResult = preCompleted.get(fieldKey);
          const seed = preCompletedResult !== undefined ? await reusePreCompletedPhase2SeedAsync(fieldParser, resolvedFieldStates[fieldKey], preCompletedResult, childExec$1) : await completeOrExtractPhase2Seed(fieldParser, resolvedFieldStates[fieldKey], childExec$1);
          if (seed == null)
            continue;
          hasAnySeed = true;
          result[fieldKey] = seed.value;
          if (seed.deferred)
            if (seed.deferredKeys)
              deferredKeys.set(fieldKey, seed.deferredKeys);
            else if (seed.value == null || typeof seed.value !== "object")
              deferredKeys.set(fieldKey, null);
            else
              hasDeferred = true;
        }
        if (!hasAnySeed)
          return null;
        return {
          value: result,
          ...deferredKeys.size > 0 || hasDeferred ? {
            deferred: true,
            ...deferredKeys.size > 0 ? { deferredKeys } : {}
          } : {}
        };
      });
    },
    suggest(context, prefix) {
      if (options.hidden === true)
        return dispatchIterableByMode(combinedMode, function* () {}, async function* () {});
      return dispatchIterableByMode(combinedMode, () => {
        const syncParserPairs = parserPairs;
        return suggestObjectSync(context, prefix, syncParserPairs);
      }, () => suggestObjectAsync(context, prefix, parserPairs));
    },
    getDocFragments(state, defaultValue) {
      let commandMetadata;
      const fragments = parserPairs.flatMap(([field, p]) => {
        const fieldState = state.kind === "unavailable" ? { kind: "unavailable" } : {
          kind: "available",
          state: state.state[field]
        };
        const docs = p.getDocFragments(fieldState, defaultValue?.[field]);
        commandMetadata = collectCommandDocMetadata(commandMetadata, docs);
        return docs.fragments;
      });
      const hiddenAwareFragments = applyHiddenToDocFragments(fragments, options.hidden);
      const entries = hiddenAwareFragments.filter((d) => d.type === "entry");
      const sections = [];
      for (const fragment of hiddenAwareFragments) {
        if (fragment.type !== "section")
          continue;
        if (fragment.title == null)
          entries.push(...fragment.entries);
        else
          sections.push(fragment);
      }
      const section = {
        title: label,
        entries
      };
      sections.push(section);
      return withCommandDocMetadata({
        ...commandMetadata,
        fragments: sections.map((s) => ({
          ...s,
          type: "section"
        }))
      }, commandMetadata);
    }
  };
  const fieldNormalizers = [];
  for (const [key, fieldParser] of parserPairs)
    if (typeof fieldParser.normalizeValue === "function")
      fieldNormalizers.push([key, fieldParser.normalizeValue.bind(fieldParser)]);
  if (fieldNormalizers.length > 0)
    Object.defineProperty(objectParser, "normalizeValue", {
      value(obj) {
        if (typeof obj !== "object" || obj == null)
          return obj;
        let changed = false;
        let result;
        for (const [key, normalize] of fieldNormalizers)
          if (Object.hasOwn(obj, key))
            try {
              const original = obj[key];
              const normalized = normalize(original);
              if (normalized !== original) {
                if (!result)
                  result = { ...obj };
                result[key] = normalized;
                changed = true;
              }
            } catch {}
        return changed ? result : obj;
      },
      configurable: true,
      enumerable: false
    });
  defineParseLanes(objectParser, objectParseLanes);
  defineInheritedAnnotationParser(objectParser);
  defineOptionMatch(objectParser, (state, token) => combineOptionMatches(parserPairs.map(([field, parser]) => getOptionMatch(parser, getAnnotatedFieldState(state, typeof field === "number" ? String(field) : field, parser), token))));
  definePassThroughPriority(objectParser, parserPairs.map(([, parser]) => parser), (state, token) => combinePassThroughPriorities(parserPairs.map(([field, parser]) => getPassThroughPriority(parser, getAnnotatedFieldState(state, typeof field === "number" ? String(field) : field, parser), token))));
  return fluent(objectParser);
}
function group(label, parser, options = {}) {
  validateLabel(label);
  const groupParser = {
    mode: parser.mode,
    $valueType: parser.$valueType,
    $stateType: parser.$stateType,
    priority: parser.priority,
    usage: applyHiddenToUsage(parser.usage, options.hidden),
    leadingNames: parser.leadingNames,
    acceptingAnyToken: parser.acceptingAnyToken,
    initialState: parser.initialState,
    ...fieldParsersKey in parser ? { [fieldParsersKey]: parser[fieldParsersKey] } : {},
    ...effectfulSchedulingNodesKey in parser ? { [effectfulSchedulingNodesKey]: parser[effectfulSchedulingNodesKey] } : {},
    ...sourceCollectionExpansionKey in parser ? { [sourceCollectionExpansionKey]: parser[sourceCollectionExpansionKey] } : {},
    ...exclusiveSourceScopeKey in parser ? { [exclusiveSourceScopeKey]: parser[exclusiveSourceScopeKey] } : {},
    ...typeof parser.shouldDeferCompletion === "function" ? { shouldDeferCompletion: parser.shouldDeferCompletion.bind(parser) } : {},
    ...typeof parser.canSkip === "function" ? { canSkip: parser.canSkip.bind(parser) } : {},
    getSuggestRuntimeNodes(state, path) {
      return parser.getSuggestRuntimeNodes?.(state, path) ?? (parser.dependencyMetadata?.source != null ? [{
        path,
        parser,
        state
      }] : []);
    },
    parse: (context) => parser.parse(context),
    complete: (state, exec) => parser.complete(state, exec),
    suggest: (context, prefix) => {
      if (options.hidden === true)
        return dispatchIterableByMode(parser.mode, function* () {}, async function* () {});
      return parser.suggest(context, prefix);
    },
    getDocFragments: (state, defaultValue) => {
      const docs = parser.getDocFragments(state, defaultValue);
      const { brief, description, footer, fragments } = docs;
      const hiddenAwareFragments = applyHiddenToDocFragments(fragments, options.hidden);
      const allEntries = [];
      const titledSections = [];
      for (const fragment of hiddenAwareFragments)
        if (fragment.type === "entry")
          allEntries.push(fragment);
        else if (fragment.type === "section")
          if (fragment.title)
            titledSections.push(fragment);
          else
            allEntries.push(...fragment.entries);
      const initialFragments = parser.getDocFragments({
        kind: "available",
        state: parser.initialState
      }, undefined);
      const initialCommandNames = /* @__PURE__ */ new Set;
      for (const f of initialFragments.fragments)
        if (f.type === "entry" && f.term.type === "command")
          initialCommandNames.add(f.term.name);
        else if (f.type === "section") {
          for (const e of f.entries)
            if (e.term.type === "command")
              initialCommandNames.add(e.term.name);
        }
      const initialHasCommands = initialCommandNames.size > 0;
      const currentCommandsAreGroupOwn = allEntries.some((e) => e.term.type === "command" && initialCommandNames.has(e.term.name));
      const applyLabel = !initialHasCommands || currentCommandsAreGroupOwn;
      const labeledSection = applyLabel ? {
        title: label,
        entries: allEntries
      } : { entries: allEntries };
      return withCommandDocMetadata({
        brief,
        description,
        footer,
        fragments: [...titledSections.map((s) => ({
          ...s,
          type: "section"
        })), {
          type: "section",
          ...labeledSection
        }]
      }, getCommandDocMetadata(docs));
    }
  };
  defineParseLanes(groupParser, getOwnParseLanes(parser));
  Object.defineProperty(groupParser, staticSourceScopeKey, {
    value: [parser],
    configurable: true,
    enumerable: false
  });
  Object.defineProperty(groupParser, extractPhase2SeedKey, {
    value(state, exec) {
      return extractPhase2Seed(parser, state, exec);
    },
    configurable: true,
    enumerable: false
  });
  if (parser.dependencyMetadata != null)
    Object.defineProperty(groupParser, "dependencyMetadata", {
      value: parser.dependencyMetadata,
      configurable: true,
      enumerable: false
    });
  if (parser[unmatchedNonCliDependencySourceStateMarker] === true)
    Object.defineProperty(groupParser, unmatchedNonCliDependencySourceStateMarker, {
      value: true,
      configurable: true,
      enumerable: true
    });
  if ("placeholder" in parser)
    Object.defineProperty(groupParser, "placeholder", {
      get() {
        return parser.placeholder;
      },
      configurable: true,
      enumerable: false
    });
  if (typeof parser.normalizeValue === "function")
    Object.defineProperty(groupParser, "normalizeValue", {
      value: parser.normalizeValue.bind(parser),
      configurable: true,
      enumerable: false
    });
  if (typeof parser.validateValue === "function")
    Object.defineProperty(groupParser, "validateValue", {
      value: parser.validateValue.bind(parser),
      configurable: true,
      enumerable: false
    });
  delegateKnownCompletion(groupParser, parser);
  defineOptionMatch(groupParser, (state, token) => getOptionMatch(parser, state, token));
  definePassThroughPriority(groupParser, [parser], (state, token) => getPassThroughPriority(parser, state, token));
  return fluent(groupParser);
}
// node_modules/@optique/core/dist/nonempty.js
function ensureNonEmptyString(value) {
  if (value === "")
    throw new TypeError("Expected a non-empty string.");
}

// node_modules/@optique/core/dist/valueparser.js
function isValueParser(object) {
  if (typeof object !== "object" || object == null || !("mode" in object) || object.mode !== "sync" && object.mode !== "async")
    return false;
  const hasMetavar = "metavar" in object && typeof object.metavar === "string";
  const hasParse = "parse" in object && typeof object.parse === "function";
  const hasFormat = "format" in object && typeof object.format === "function";
  const hasPlaceholder = "placeholder" in object;
  if (hasMetavar && hasParse && hasFormat && !hasPlaceholder)
    throw new TypeError("Value parser is missing the required placeholder property. All value parsers must define a placeholder value.");
  return hasMetavar && hasParse && hasFormat && hasPlaceholder;
}
function choice(choices, options = {}) {
  if (choices.length < 1)
    throw new TypeError("Expected at least one choice, but got an empty array.");
  if (choices.some((c) => c === ""))
    throw new TypeError("Empty strings are not allowed as choices.");
  for (const c of choices)
    if (typeof c !== "string" && typeof c !== "number")
      throw new TypeError(`Expected every choice to be a string or number, but got ${typeof c}.`);
  const isNumber = typeof choices[0] === "number";
  for (const c of choices)
    if (isNumber ? typeof c !== "number" : typeof c !== "string")
      throw new TypeError(`Expected every choice to be the same type, but got both ${isNumber ? "number" : "string"} and ${typeof c}.`);
  if (isNumber && choices.some((v) => Number.isNaN(v)))
    throw new TypeError("NaN is not allowed in number choices.");
  const metavar$1 = options.metavar ?? "TYPE";
  ensureNonEmptyString(metavar$1);
  if (isNumber) {
    const numberChoices = (() => {
      const seen = /* @__PURE__ */ new Set;
      let hasPositiveZero = false;
      let hasNegativeZero = false;
      const result = [];
      for (const v of choices) {
        if (Object.is(v, -0)) {
          if (hasNegativeZero)
            continue;
          hasNegativeZero = true;
        } else if (Object.is(v, 0)) {
          if (hasPositiveZero)
            continue;
          hasPositiveZero = true;
        } else {
          if (seen.has(v))
            continue;
          seen.add(v);
        }
        result.push(v);
      }
      return result;
    })();
    const numberInvalidChoice = options.errors?.invalidChoice;
    const numberStrings = numberChoices.map((v) => Object.is(v, -0) ? "-0" : String(v));
    const frozenNumberChoices = Object.freeze(numberChoices);
    return {
      mode: "sync",
      metavar: metavar$1,
      placeholder: choices[0],
      choices: frozenNumberChoices,
      parse(input) {
        const index = numberStrings.indexOf(input);
        if (index >= 0)
          return {
            success: true,
            value: numberChoices[index]
          };
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(input)) {
          const parsed = Number(input);
          if (Number.isFinite(parsed)) {
            const canonical = Object.is(parsed, -0) ? "-0" : String(parsed);
            const normalizedInput = normalizeDecimal(input);
            const normalizedCanonical = normalizeDecimal(expandScientific(canonical));
            if (normalizedInput === normalizedCanonical) {
              const fallbackIndex = numberChoices.findIndex((v) => Object.is(v, parsed));
              if (fallbackIndex >= 0)
                return {
                  success: true,
                  value: numberChoices[fallbackIndex]
                };
            }
            if (parsed === 0 && normalizedInput.replace(/^-/, "") === "0" && !numberChoices.some((v) => Object.is(v, -0))) {
              const zeroIndex = numberChoices.indexOf(0);
              if (zeroIndex >= 0)
                return {
                  success: true,
                  value: numberChoices[zeroIndex]
                };
            }
          }
        }
        if (/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(input)) {
          const parsed = Number(input);
          if (Number.isFinite(parsed)) {
            const canonical = Object.is(parsed, -0) ? "-0" : String(parsed);
            if (/[eE]/.test(canonical)) {
              const normalizedInput = normalizeDecimal(expandScientific(input));
              const normalizedCanonical = normalizeDecimal(expandScientific(canonical));
              if (normalizedInput === normalizedCanonical) {
                const fallbackIndex = numberChoices.findIndex((v) => Object.is(v, parsed));
                if (fallbackIndex >= 0)
                  return {
                    success: true,
                    value: numberChoices[fallbackIndex]
                  };
              }
            }
          }
        }
        return {
          success: false,
          error: formatNumberChoiceError(input, numberChoices, numberChoices, numberInvalidChoice)
        };
      },
      format(value) {
        return Object.is(value, -0) ? "-0" : String(value);
      },
      suggest(prefix) {
        return numberStrings.filter((valueStr, i) => !Number.isNaN(numberChoices[i]) && valueStr.startsWith(prefix)).map((valueStr) => ({
          kind: "literal",
          text: valueStr
        }));
      }
    };
  }
  const stringChoices = Object.freeze([...new Set(choices)]);
  const stringOptions = options;
  checkBooleanOption(stringOptions, "caseInsensitive");
  const caseInsensitive = stringOptions.caseInsensitive ?? false;
  const normalizedValues = caseInsensitive ? stringChoices.map((v) => v.toLowerCase()) : stringChoices;
  if (caseInsensitive) {
    const seen = /* @__PURE__ */ new Map;
    for (let i = 0;i < stringChoices.length; i++) {
      const nv = normalizedValues[i];
      const original = stringChoices[i];
      const prev = seen.get(nv);
      if (prev !== undefined && prev !== original)
        throw new TypeError(`Ambiguous choices for case-insensitive matching: ${JSON.stringify(prev)} and ${JSON.stringify(original)} both normalize to ${JSON.stringify(nv)}.`);
      seen.set(nv, original);
    }
  }
  const stringInvalidChoice = stringOptions.errors?.invalidChoice;
  const stringSuggest = stringOptions.suggest;
  if (stringSuggest !== undefined) {
    const isValidString = stringSuggest === "nearest" || stringSuggest === "never";
    const isArray = Array.isArray(stringSuggest);
    const isValidObject = typeof stringSuggest === "object" && stringSuggest !== null && !isArray;
    const isValidFunction = typeof stringSuggest === "function";
    if (!isValidString && !isValidObject && !isValidFunction) {
      const actualType = isArray ? "array" : stringSuggest === null ? "null" : typeof stringSuggest;
      throw new TypeError(`Expected suggest to be "nearest", "never", an object, or a function, but got ${actualType}: ${String(stringSuggest)}.`);
    }
    if (isValidObject) {
      const obj = stringSuggest;
      if (obj.maxDistance !== undefined && (typeof obj.maxDistance !== "number" || !Number.isInteger(obj.maxDistance) || obj.maxDistance < 0))
        throw new TypeError(`Expected suggest.maxDistance to be a non-negative integer, but got ${typeof obj.maxDistance}: ${String(obj.maxDistance)}.`);
      if (obj.maxSuggestions !== undefined && (typeof obj.maxSuggestions !== "number" || !Number.isInteger(obj.maxSuggestions) || obj.maxSuggestions < 1))
        throw new TypeError(`Expected suggest.maxSuggestions to be a positive integer, but got ${typeof obj.maxSuggestions}: ${String(obj.maxSuggestions)}.`);
    }
  }
  const snapshotSuggest = typeof stringSuggest === "object" && stringSuggest !== null ? {
    maxDistance: stringSuggest.maxDistance,
    maxSuggestions: stringSuggest.maxSuggestions
  } : stringSuggest;
  return {
    mode: "sync",
    metavar: metavar$1,
    placeholder: choices[0],
    choices: stringChoices,
    parse(input) {
      const normalizedInput = caseInsensitive ? input.toLowerCase() : input;
      const index = normalizedValues.indexOf(normalizedInput);
      if (index < 0)
        return {
          success: false,
          error: formatStringChoiceError(input, stringChoices, stringInvalidChoice, snapshotSuggest)
        };
      return {
        success: true,
        value: stringChoices[index]
      };
    },
    format(value) {
      return String(value);
    },
    suggest(prefix) {
      const normalizedPrefix = caseInsensitive ? prefix.toLowerCase() : prefix;
      return stringChoices.filter((value) => {
        const normalizedValue = caseInsensitive ? value.toLowerCase() : value;
        return normalizedValue.startsWith(normalizedPrefix);
      }).map((value) => ({
        kind: "literal",
        text: value
      }));
    }
  };
}
function checkBooleanOption(options, key) {
  const value = options?.[key];
  if (value !== undefined && typeof value !== "boolean")
    throw new TypeError(`Expected ${String(key)} to be a boolean, but got ${typeof value}: ${String(value)}.`);
}
function expandScientific(s) {
  const match = /^([+-]?)(\d+\.?\d*|\.\d+)[eE]([+-]?\d+)$/.exec(s);
  if (!match)
    return s;
  const [, rawSign, mantissa, expStr] = match;
  const sign = rawSign === "-" ? "-" : "";
  const exp = parseInt(expStr, 10);
  const dotPos = mantissa.indexOf(".");
  const digits = mantissa.replace(".", "");
  const intLen = dotPos >= 0 ? dotPos : digits.length;
  const newIntLen = intLen + exp;
  let result;
  if (newIntLen >= digits.length)
    result = digits + "0".repeat(newIntLen - digits.length);
  else if (newIntLen <= 0)
    result = "0." + "0".repeat(-newIntLen) + digits;
  else
    result = digits.slice(0, newIntLen) + "." + digits.slice(newIntLen);
  return sign + result;
}
function normalizeDecimal(s) {
  let sign = "";
  let str = s;
  if (str.startsWith("-") || str.startsWith("+")) {
    if (str[0] === "-")
      sign = "-";
    str = str.slice(1);
  }
  const dot = str.indexOf(".");
  let int;
  let frac;
  if (dot >= 0) {
    int = str.slice(0, dot);
    frac = str.slice(dot + 1);
  } else {
    int = str;
    frac = "";
  }
  int = int.replace(/^0+/, "") || "0";
  frac = frac.replace(/0+$/, "");
  return sign + (frac ? int + "." + frac : int);
}
function formatStringChoiceError(input, choices, invalidChoice, suggest) {
  const base = invalidChoice ? typeof invalidChoice === "function" ? invalidChoice(input, choices) : invalidChoice : formatDefaultChoiceError(input, choices);
  if (suggest == null || suggest === "never")
    return base;
  if (suggest === "nearest")
    return appendValueHint(base, input, choices);
  if (typeof suggest === "function") {
    const hints = suggest(input, choices);
    if (!Array.isArray(hints))
      return base;
    return appendValueSuggestions(base, hints);
  }
  return appendValueHint(base, input, choices, suggest);
}
function formatNumberChoiceError(input, validChoices, allChoices, invalidChoice) {
  if (invalidChoice)
    return typeof invalidChoice === "function" ? invalidChoice(input, validChoices) : invalidChoice;
  return formatDefaultChoiceError(input, allChoices);
}
function formatDefaultChoiceError(input, choices) {
  const choiceStrings = choices.filter((c) => typeof c === "string" || !Number.isNaN(c)).map((c) => Object.is(c, -0) ? "-0" : String(c));
  if (choiceStrings.length === 0 && choices.length > 0)
    return message`No valid choices are configured, but got ${input}.`;
  return message`Expected one of ${valueSet(choiceStrings, {
    fallback: "",
    locale: "en-US"
  })}, but got ${input}.`;
}
function string(options = {}) {
  if (options.pattern != null && !(options.pattern instanceof RegExp))
    throw new TypeError(`Expected pattern to be a RegExp, but got: ${Object.prototype.toString.call(options.pattern)}`);
  const metavar$1 = options.metavar ?? "STRING";
  ensureNonEmptyString(metavar$1);
  const patternSource = options.pattern?.source ?? null;
  const patternFlags = options.pattern?.flags ?? null;
  const patternMismatch = options.errors?.patternMismatch;
  return {
    mode: "sync",
    metavar: metavar$1,
    placeholder: options.placeholder ?? "",
    parse(input) {
      if (patternSource != null && patternFlags != null) {
        const pattern = new RegExp(patternSource, patternFlags);
        if (pattern.test(input))
          return {
            success: true,
            value: input
          };
        return {
          success: false,
          error: patternMismatch ? typeof patternMismatch === "function" ? patternMismatch(input, pattern) : patternMismatch : message`Expected a string matching pattern ${text(patternSource)}, but got ${input}.`
        };
      }
      return {
        success: true,
        value: input
      };
    },
    format(value) {
      return value;
    }
  };
}
var IEC_MULTIPLIERS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
  eb: 1024 ** 6,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
  eib: 1024 ** 6
};
var IEC_ONLY_MULTIPLIERS = {
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
  eib: 1024 ** 6
};
var FORMAT_UNITS_DEFAULT = [
  ["EiB", 1024 ** 6],
  ["PiB", 1024 ** 5],
  ["TiB", 1024 ** 4],
  ["GiB", 1024 ** 3],
  ["MiB", 1024 ** 2],
  ["KiB", 1024],
  ["EB", 1000000000000000000],
  ["PB", 1000000000000000],
  ["TB", 1000000000000],
  ["GB", 1e9],
  ["MB", 1e6],
  ["KB", 1000]
];
var FORMAT_UNITS_SI_AS_BINARY = [
  ["EB", 1024 ** 6],
  ["PB", 1024 ** 5],
  ["TB", 1024 ** 4],
  ["GB", 1024 ** 3],
  ["MB", 1024 ** 2],
  ["KB", 1024]
];
var BIGINT_IEC_MULTIPLIERS = {
  b: 1n,
  kb: 1024n,
  mb: 1024n ** 2n,
  gb: 1024n ** 3n,
  tb: 1024n ** 4n,
  pb: 1024n ** 5n,
  eb: 1024n ** 6n,
  kib: 1024n,
  mib: 1024n ** 2n,
  gib: 1024n ** 3n,
  tib: 1024n ** 4n,
  pib: 1024n ** 5n,
  eib: 1024n ** 6n
};
var BIGINT_IEC_ONLY_MULTIPLIERS = {
  kib: 1024n,
  mib: 1024n ** 2n,
  gib: 1024n ** 3n,
  tib: 1024n ** 4n,
  pib: 1024n ** 5n,
  eib: 1024n ** 6n
};
var BIGINT_FORMAT_UNITS_DEFAULT = [
  ["EiB", 1024n ** 6n],
  ["PiB", 1024n ** 5n],
  ["TiB", 1024n ** 4n],
  ["GiB", 1024n ** 3n],
  ["MiB", 1024n ** 2n],
  ["KiB", 1024n],
  ["EB", 1000000000000000000n],
  ["PB", 1000000000000000n],
  ["TB", 1000000000000n],
  ["GB", 1000000000n],
  ["MB", 1000000n],
  ["KB", 1000n]
];
var BIGINT_FORMAT_UNITS_SI_AS_BINARY = [
  ["EB", 1024n ** 6n],
  ["PB", 1024n ** 5n],
  ["TB", 1024n ** 4n],
  ["GB", 1024n ** 3n],
  ["MB", 1024n ** 2n],
  ["KB", 1024n]
];
var CSS_NAMED_COLORS = {
  aliceblue: {
    r: 240,
    g: 248,
    b: 255,
    a: 1
  },
  antiquewhite: {
    r: 250,
    g: 235,
    b: 215,
    a: 1
  },
  aqua: {
    r: 0,
    g: 255,
    b: 255,
    a: 1
  },
  aquamarine: {
    r: 127,
    g: 255,
    b: 212,
    a: 1
  },
  azure: {
    r: 240,
    g: 255,
    b: 255,
    a: 1
  },
  beige: {
    r: 245,
    g: 245,
    b: 220,
    a: 1
  },
  bisque: {
    r: 255,
    g: 228,
    b: 196,
    a: 1
  },
  black: {
    r: 0,
    g: 0,
    b: 0,
    a: 1
  },
  blanchedalmond: {
    r: 255,
    g: 235,
    b: 205,
    a: 1
  },
  blue: {
    r: 0,
    g: 0,
    b: 255,
    a: 1
  },
  blueviolet: {
    r: 138,
    g: 43,
    b: 226,
    a: 1
  },
  brown: {
    r: 165,
    g: 42,
    b: 42,
    a: 1
  },
  burlywood: {
    r: 222,
    g: 184,
    b: 135,
    a: 1
  },
  cadetblue: {
    r: 95,
    g: 158,
    b: 160,
    a: 1
  },
  chartreuse: {
    r: 127,
    g: 255,
    b: 0,
    a: 1
  },
  chocolate: {
    r: 210,
    g: 105,
    b: 30,
    a: 1
  },
  coral: {
    r: 255,
    g: 127,
    b: 80,
    a: 1
  },
  cornflowerblue: {
    r: 100,
    g: 149,
    b: 237,
    a: 1
  },
  cornsilk: {
    r: 255,
    g: 248,
    b: 220,
    a: 1
  },
  crimson: {
    r: 220,
    g: 20,
    b: 60,
    a: 1
  },
  cyan: {
    r: 0,
    g: 255,
    b: 255,
    a: 1
  },
  darkblue: {
    r: 0,
    g: 0,
    b: 139,
    a: 1
  },
  darkcyan: {
    r: 0,
    g: 139,
    b: 139,
    a: 1
  },
  darkgoldenrod: {
    r: 184,
    g: 134,
    b: 11,
    a: 1
  },
  darkgray: {
    r: 169,
    g: 169,
    b: 169,
    a: 1
  },
  darkgreen: {
    r: 0,
    g: 100,
    b: 0,
    a: 1
  },
  darkgrey: {
    r: 169,
    g: 169,
    b: 169,
    a: 1
  },
  darkkhaki: {
    r: 189,
    g: 183,
    b: 107,
    a: 1
  },
  darkmagenta: {
    r: 139,
    g: 0,
    b: 139,
    a: 1
  },
  darkolivegreen: {
    r: 85,
    g: 107,
    b: 47,
    a: 1
  },
  darkorange: {
    r: 255,
    g: 140,
    b: 0,
    a: 1
  },
  darkorchid: {
    r: 153,
    g: 50,
    b: 204,
    a: 1
  },
  darkred: {
    r: 139,
    g: 0,
    b: 0,
    a: 1
  },
  darksalmon: {
    r: 233,
    g: 150,
    b: 122,
    a: 1
  },
  darkseagreen: {
    r: 143,
    g: 188,
    b: 143,
    a: 1
  },
  darkslateblue: {
    r: 72,
    g: 61,
    b: 139,
    a: 1
  },
  darkslategray: {
    r: 47,
    g: 79,
    b: 79,
    a: 1
  },
  darkslategrey: {
    r: 47,
    g: 79,
    b: 79,
    a: 1
  },
  darkturquoise: {
    r: 0,
    g: 206,
    b: 209,
    a: 1
  },
  darkviolet: {
    r: 148,
    g: 0,
    b: 211,
    a: 1
  },
  deeppink: {
    r: 255,
    g: 20,
    b: 147,
    a: 1
  },
  deepskyblue: {
    r: 0,
    g: 191,
    b: 255,
    a: 1
  },
  dimgray: {
    r: 105,
    g: 105,
    b: 105,
    a: 1
  },
  dimgrey: {
    r: 105,
    g: 105,
    b: 105,
    a: 1
  },
  dodgerblue: {
    r: 30,
    g: 144,
    b: 255,
    a: 1
  },
  firebrick: {
    r: 178,
    g: 34,
    b: 34,
    a: 1
  },
  floralwhite: {
    r: 255,
    g: 250,
    b: 240,
    a: 1
  },
  forestgreen: {
    r: 34,
    g: 139,
    b: 34,
    a: 1
  },
  fuchsia: {
    r: 255,
    g: 0,
    b: 255,
    a: 1
  },
  gainsboro: {
    r: 220,
    g: 220,
    b: 220,
    a: 1
  },
  ghostwhite: {
    r: 248,
    g: 248,
    b: 255,
    a: 1
  },
  gold: {
    r: 255,
    g: 215,
    b: 0,
    a: 1
  },
  goldenrod: {
    r: 218,
    g: 165,
    b: 32,
    a: 1
  },
  gray: {
    r: 128,
    g: 128,
    b: 128,
    a: 1
  },
  green: {
    r: 0,
    g: 128,
    b: 0,
    a: 1
  },
  greenyellow: {
    r: 173,
    g: 255,
    b: 47,
    a: 1
  },
  grey: {
    r: 128,
    g: 128,
    b: 128,
    a: 1
  },
  honeydew: {
    r: 240,
    g: 255,
    b: 240,
    a: 1
  },
  hotpink: {
    r: 255,
    g: 105,
    b: 180,
    a: 1
  },
  indianred: {
    r: 205,
    g: 92,
    b: 92,
    a: 1
  },
  indigo: {
    r: 75,
    g: 0,
    b: 130,
    a: 1
  },
  ivory: {
    r: 255,
    g: 255,
    b: 240,
    a: 1
  },
  khaki: {
    r: 240,
    g: 230,
    b: 140,
    a: 1
  },
  lavender: {
    r: 230,
    g: 230,
    b: 250,
    a: 1
  },
  lavenderblush: {
    r: 255,
    g: 240,
    b: 245,
    a: 1
  },
  lawngreen: {
    r: 124,
    g: 252,
    b: 0,
    a: 1
  },
  lemonchiffon: {
    r: 255,
    g: 250,
    b: 205,
    a: 1
  },
  lightblue: {
    r: 173,
    g: 216,
    b: 230,
    a: 1
  },
  lightcoral: {
    r: 240,
    g: 128,
    b: 128,
    a: 1
  },
  lightcyan: {
    r: 224,
    g: 255,
    b: 255,
    a: 1
  },
  lightgoldenrodyellow: {
    r: 250,
    g: 250,
    b: 210,
    a: 1
  },
  lightgray: {
    r: 211,
    g: 211,
    b: 211,
    a: 1
  },
  lightgreen: {
    r: 144,
    g: 238,
    b: 144,
    a: 1
  },
  lightgrey: {
    r: 211,
    g: 211,
    b: 211,
    a: 1
  },
  lightpink: {
    r: 255,
    g: 182,
    b: 193,
    a: 1
  },
  lightsalmon: {
    r: 255,
    g: 160,
    b: 122,
    a: 1
  },
  lightseagreen: {
    r: 32,
    g: 178,
    b: 170,
    a: 1
  },
  lightskyblue: {
    r: 135,
    g: 206,
    b: 250,
    a: 1
  },
  lightslategray: {
    r: 119,
    g: 136,
    b: 153,
    a: 1
  },
  lightslategrey: {
    r: 119,
    g: 136,
    b: 153,
    a: 1
  },
  lightsteelblue: {
    r: 176,
    g: 196,
    b: 222,
    a: 1
  },
  lightyellow: {
    r: 255,
    g: 255,
    b: 224,
    a: 1
  },
  lime: {
    r: 0,
    g: 255,
    b: 0,
    a: 1
  },
  limegreen: {
    r: 50,
    g: 205,
    b: 50,
    a: 1
  },
  linen: {
    r: 250,
    g: 240,
    b: 230,
    a: 1
  },
  magenta: {
    r: 255,
    g: 0,
    b: 255,
    a: 1
  },
  maroon: {
    r: 128,
    g: 0,
    b: 0,
    a: 1
  },
  mediumaquamarine: {
    r: 102,
    g: 205,
    b: 170,
    a: 1
  },
  mediumblue: {
    r: 0,
    g: 0,
    b: 205,
    a: 1
  },
  mediumorchid: {
    r: 186,
    g: 85,
    b: 211,
    a: 1
  },
  mediumpurple: {
    r: 147,
    g: 112,
    b: 219,
    a: 1
  },
  mediumseagreen: {
    r: 60,
    g: 179,
    b: 113,
    a: 1
  },
  mediumslateblue: {
    r: 123,
    g: 104,
    b: 238,
    a: 1
  },
  mediumspringgreen: {
    r: 0,
    g: 250,
    b: 154,
    a: 1
  },
  mediumturquoise: {
    r: 72,
    g: 209,
    b: 204,
    a: 1
  },
  mediumvioletred: {
    r: 199,
    g: 21,
    b: 133,
    a: 1
  },
  midnightblue: {
    r: 25,
    g: 25,
    b: 112,
    a: 1
  },
  mintcream: {
    r: 245,
    g: 255,
    b: 250,
    a: 1
  },
  mistyrose: {
    r: 255,
    g: 228,
    b: 225,
    a: 1
  },
  moccasin: {
    r: 255,
    g: 228,
    b: 181,
    a: 1
  },
  navajowhite: {
    r: 255,
    g: 222,
    b: 173,
    a: 1
  },
  navy: {
    r: 0,
    g: 0,
    b: 128,
    a: 1
  },
  oldlace: {
    r: 253,
    g: 245,
    b: 230,
    a: 1
  },
  olive: {
    r: 128,
    g: 128,
    b: 0,
    a: 1
  },
  olivedrab: {
    r: 107,
    g: 142,
    b: 35,
    a: 1
  },
  orange: {
    r: 255,
    g: 165,
    b: 0,
    a: 1
  },
  orangered: {
    r: 255,
    g: 69,
    b: 0,
    a: 1
  },
  orchid: {
    r: 218,
    g: 112,
    b: 214,
    a: 1
  },
  palegoldenrod: {
    r: 238,
    g: 232,
    b: 170,
    a: 1
  },
  palegreen: {
    r: 152,
    g: 251,
    b: 152,
    a: 1
  },
  paleturquoise: {
    r: 175,
    g: 238,
    b: 238,
    a: 1
  },
  palevioletred: {
    r: 219,
    g: 112,
    b: 147,
    a: 1
  },
  papayawhip: {
    r: 255,
    g: 239,
    b: 213,
    a: 1
  },
  peachpuff: {
    r: 255,
    g: 218,
    b: 185,
    a: 1
  },
  peru: {
    r: 205,
    g: 133,
    b: 63,
    a: 1
  },
  pink: {
    r: 255,
    g: 192,
    b: 203,
    a: 1
  },
  plum: {
    r: 221,
    g: 160,
    b: 221,
    a: 1
  },
  powderblue: {
    r: 176,
    g: 224,
    b: 230,
    a: 1
  },
  purple: {
    r: 128,
    g: 0,
    b: 128,
    a: 1
  },
  rebeccapurple: {
    r: 102,
    g: 51,
    b: 153,
    a: 1
  },
  red: {
    r: 255,
    g: 0,
    b: 0,
    a: 1
  },
  rosybrown: {
    r: 188,
    g: 143,
    b: 143,
    a: 1
  },
  royalblue: {
    r: 65,
    g: 105,
    b: 225,
    a: 1
  },
  saddlebrown: {
    r: 139,
    g: 69,
    b: 19,
    a: 1
  },
  salmon: {
    r: 250,
    g: 128,
    b: 114,
    a: 1
  },
  sandybrown: {
    r: 244,
    g: 164,
    b: 96,
    a: 1
  },
  seagreen: {
    r: 46,
    g: 139,
    b: 87,
    a: 1
  },
  seashell: {
    r: 255,
    g: 245,
    b: 238,
    a: 1
  },
  sienna: {
    r: 160,
    g: 82,
    b: 45,
    a: 1
  },
  silver: {
    r: 192,
    g: 192,
    b: 192,
    a: 1
  },
  skyblue: {
    r: 135,
    g: 206,
    b: 235,
    a: 1
  },
  slateblue: {
    r: 106,
    g: 90,
    b: 205,
    a: 1
  },
  slategray: {
    r: 112,
    g: 128,
    b: 144,
    a: 1
  },
  slategrey: {
    r: 112,
    g: 128,
    b: 144,
    a: 1
  },
  snow: {
    r: 255,
    g: 250,
    b: 250,
    a: 1
  },
  springgreen: {
    r: 0,
    g: 255,
    b: 127,
    a: 1
  },
  steelblue: {
    r: 70,
    g: 130,
    b: 180,
    a: 1
  },
  tan: {
    r: 210,
    g: 180,
    b: 140,
    a: 1
  },
  teal: {
    r: 0,
    g: 128,
    b: 128,
    a: 1
  },
  thistle: {
    r: 216,
    g: 191,
    b: 216,
    a: 1
  },
  tomato: {
    r: 255,
    g: 99,
    b: 71,
    a: 1
  },
  transparent: {
    r: 0,
    g: 0,
    b: 0,
    a: 0
  },
  turquoise: {
    r: 64,
    g: 224,
    b: 208,
    a: 1
  },
  violet: {
    r: 238,
    g: 130,
    b: 238,
    a: 1
  },
  wheat: {
    r: 245,
    g: 222,
    b: 179,
    a: 1
  },
  white: {
    r: 255,
    g: 255,
    b: 255,
    a: 1
  },
  whitesmoke: {
    r: 245,
    g: 245,
    b: 245,
    a: 1
  },
  yellow: {
    r: 255,
    g: 255,
    b: 0,
    a: 1
  },
  yellowgreen: {
    r: 154,
    g: 205,
    b: 50,
    a: 1
  }
};
var CSS_NAMED_COLOR_KEYS = Object.keys(CSS_NAMED_COLORS);
var COLOR_NUM_PATTERN = "(?:\\d+(?:\\.\\d*)?|\\d*\\.\\d+)";
var COLOR_HUE_PATTERN = `(?:-?${COLOR_NUM_PATTERN})`;
var COLOR_RGB_REGEX = new RegExp(`^rgba?\\(\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*(?:,\\s*(${COLOR_NUM_PATTERN}))?\\s*\\)$`, "i");
var COLOR_HSL_REGEX = new RegExp(`^hsla?\\(\\s*(${COLOR_HUE_PATTERN})\\s*,\\s*(${COLOR_NUM_PATTERN})%\\s*,\\s*(${COLOR_NUM_PATTERN})%\\s*(?:,\\s*(${COLOR_NUM_PATTERN}))?\\s*\\)$`, "i");
var SPECIAL_URL_SCHEMES = new Set([
  "ftp",
  "file",
  "http",
  "https",
  "ws",
  "wss"
]);
var SEMVER_SUGGESTIONS = Object.freeze([
  "0.0.0",
  "1.0.0",
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0+build.1",
  "1.0.0-alpha.1+build.1"
]);
var SEMVER_SUGGESTIONS_WITH_PREFIX = Object.freeze([...SEMVER_SUGGESTIONS, ...SEMVER_SUGGESTIONS.map((s) => `v${s}`)]);
var CRON_MONTH_NAMES = new Map([
  ["JAN", 1],
  ["FEB", 2],
  ["MAR", 3],
  ["APR", 4],
  ["MAY", 5],
  ["JUN", 6],
  ["JUL", 7],
  ["AUG", 8],
  ["SEP", 9],
  ["OCT", 10],
  ["NOV", 11],
  ["DEC", 12]
]);
var CRON_DAY_NAMES = new Map([
  ["SUN", 0],
  ["MON", 1],
  ["TUE", 2],
  ["WED", 3],
  ["THU", 4],
  ["FRI", 5],
  ["SAT", 6]
]);

// node_modules/@optique/core/dist/primitives.js
var EMPTY_LEADING_NAMES2 = /* @__PURE__ */ new Set;
function hasParsedOptionValue(state, valueParser) {
  if (valueParser != null)
    return state != null && typeof state === "object" && "success" in state && typeof state.success === "boolean";
  return state != null && "success" in state && state.success && state.value === true;
}
function isTerminalValueState(state) {
  return state != null && typeof state === "object" && "success" in state && typeof state.success === "boolean";
}
function createOptionParseState(parseResult, rawInput, valueParser) {
  if (isDerivedValueParser(valueParser))
    recordDerivedRawInput(parseResult, rawInput);
  return parseResult;
}
function buildTraceEntry(kind, rawInput, consumed, valueParser, parseResult, optionNames$1) {
  const entry = {
    kind,
    rawInput,
    consumed,
    preliminaryResult: parseResult,
    ...optionNames$1 != null ? { optionNames: optionNames$1 } : {},
    metavar: valueParser.metavar
  };
  if (isDerivedValueParser(valueParser)) {
    const defaults = getSnapshottedDefaultDependencyValues(parseResult);
    if (defaults != null)
      return {
        ...entry,
        defaultDependencyValues: defaults
      };
  }
  return entry;
}
function recordTrace(context, entry) {
  if (context.exec?.trace == null)
    return context;
  const trace = context.exec.trace.set(context.exec.path, entry);
  return {
    ...context,
    trace,
    exec: {
      ...context.exec,
      trace
    }
  };
}
function resolveDerivedCompletionSync(derivedMetadata, state, exec) {
  if (derivedMetadata?.derived == null || exec?.dependencyRuntime == null)
    return state;
  const traceEntry = exec.trace?.get(exec.path);
  if (traceEntry?.rawInput == null)
    return traceEntry?.preliminaryResult ?? state;
  if (traceEntry.preliminaryResult != null) {
    const resolution = exec.dependencyRuntime.resolveDependencies({
      dependencyIds: derivedMetadata.derived.dependencyIds,
      defaultValues: traceEntry.defaultDependencyValues
    });
    if (resolution.kind === "resolved" && resolution.usedDefaults.length > 0 && resolution.usedDefaults.every((used) => used))
      return traceEntry.preliminaryResult;
  }
  const replayed = replayDerivedParser({
    path: exec.path,
    parser: { dependencyMetadata: { derived: derivedMetadata.derived } },
    state,
    defaultDependencyValues: traceEntry.defaultDependencyValues
  }, traceEntry.rawInput, exec.dependencyRuntime);
  return replayed ?? traceEntry.preliminaryResult ?? state;
}
function includeDependencyFailureChain(error, dependencyMetadata, exec) {
  const sourceId = dependencyMetadata?.source?.sourceId;
  if (sourceId == null || exec?.dependencyRuntime == null)
    return error;
  return includeSourceFailureChain(error, sourceId, exec.dependencyRuntime);
}
async function resolveDerivedCompletionAsync(derivedMetadata, state, exec) {
  if (derivedMetadata?.derived == null || exec?.dependencyRuntime == null)
    return state;
  const traceEntry = exec.trace?.get(exec.path);
  if (traceEntry?.rawInput == null)
    return traceEntry?.preliminaryResult ?? state;
  if (traceEntry.preliminaryResult != null) {
    const resolution = exec.dependencyRuntime.resolveDependencies({
      dependencyIds: derivedMetadata.derived.dependencyIds,
      defaultValues: traceEntry.defaultDependencyValues
    });
    if (resolution.kind === "resolved" && resolution.usedDefaults.length > 0 && resolution.usedDefaults.every((used) => used))
      return traceEntry.preliminaryResult;
  }
  const replayed = await replayDerivedParserAsync({
    path: exec.path,
    parser: { dependencyMetadata: { derived: derivedMetadata.derived } },
    state,
    defaultDependencyValues: traceEntry.defaultDependencyValues
  }, traceEntry.rawInput, exec.dependencyRuntime);
  return replayed ?? traceEntry.preliminaryResult ?? state;
}
function constant(value) {
  const result = {
    $valueType: [],
    $stateType: [],
    mode: "sync",
    priority: 0,
    usage: [],
    leadingNames: EMPTY_LEADING_NAMES2,
    acceptingAnyToken: false,
    initialState: value,
    canSkip() {
      return true;
    },
    parse(context) {
      return {
        success: true,
        next: context,
        consumed: []
      };
    },
    complete(state, _exec) {
      return {
        success: true,
        value: state
      };
    },
    suggest(_context, _prefix) {
      return [];
    },
    getDocFragments(_state, _defaultValue) {
      return { fragments: [] };
    }
  };
  defineKnownCompletion(result, (state) => normalizeInjectedAnnotationState(state));
  Object.defineProperty(result, "placeholder", {
    value,
    configurable: true,
    enumerable: false,
    writable: false
  });
  return fluent(result);
}
function* getSuggestionsWithDependency(valueParser, prefix, dependencyRegistry, exec) {
  if (!valueParser.suggest)
    return;
  if (isDerivedValueParser(valueParser) && suggestWithDependency in valueParser) {
    const derived = valueParser;
    const suggestWithDep = derived[suggestWithDependency];
    if (suggestWithDep && dependencyRegistry) {
      const dependencyRuntime = exec?.dependencyRuntime;
      const depIds = getDependencyIds(derived);
      const defaultsFn = getDefaultValuesFunction(derived);
      const defaults = defaultsFn?.();
      const dependencyValues = [];
      let hasAnyValue = false;
      for (let i = 0;i < depIds.length; i++) {
        const depId = depIds[i];
        if (dependencyRegistry.has(depId)) {
          dependencyValues.push(dependencyRegistry.get(depId));
          hasAnyValue = true;
        } else if (dependencyRuntime?.isSourceFailed(depId))
          return;
        else if (defaults && i < defaults.length)
          dependencyValues.push(defaults[i]);
        else {
          yield* valueParser.suggest(prefix);
          return;
        }
      }
      if (hasAnyValue) {
        const depValue = depIds.length === 1 ? dependencyValues[0] : dependencyValues;
        yield* suggestWithDep(prefix, depValue);
        return;
      }
    }
  }
  yield* valueParser.suggest(prefix);
}
function joinedOptionPrefix(names, input) {
  return names.filter((name) => name.startsWith("--") || name.startsWith("/") || name.startsWith("-") && name.length > 2).map((name) => name + (name.startsWith("/") ? ":" : "=")).find((prefix) => input.startsWith(prefix));
}
function* suggestOptionSync(optionNames$1, valueParser, hidden, description, context, prefix) {
  if (hidden || context.optionsTerminated)
    return;
  const expectingValue = context.buffer.length > 0 && optionNames$1.includes(context.buffer[context.buffer.length - 1]);
  const joinedPrefix = joinedOptionPrefix(optionNames$1, prefix);
  if (joinedPrefix !== undefined && !expectingValue) {
    const optionPart = joinedPrefix.slice(0, -1);
    const valuePart = prefix.slice(joinedPrefix.length);
    if (optionNames$1.includes(optionPart)) {
      if (valueParser && valueParser.suggest) {
        const valueSuggestions = getSuggestionsWithDependency(valueParser, valuePart, context.dependencyRegistry, context.exec);
        for (const suggestion of valueSuggestions)
          if (suggestion.kind === "literal")
            yield {
              kind: "literal",
              text: `${joinedPrefix}${suggestion.text}`,
              description: suggestion.description
            };
          else
            yield joinedFileSuggestion(joinedPrefix, suggestion, valuePart);
      }
    }
  } else {
    if (!expectingValue && (prefix.startsWith("--") || prefix.startsWith("-") || prefix.startsWith("/") || prefix.startsWith("+"))) {
      for (const optionName$1 of optionNames$1)
        if (optionName$1.startsWith(prefix)) {
          if (prefix === "-" && optionName$1.length !== 2)
            continue;
          yield {
            kind: "literal",
            text: optionName$1,
            ...description && { description }
          };
        }
    }
    if (valueParser && valueParser.suggest) {
      let shouldSuggestValues = false;
      if (context.buffer.length > 0) {
        const lastToken = context.buffer[context.buffer.length - 1];
        if (optionNames$1.includes(lastToken))
          shouldSuggestValues = true;
      } else if (isAnnotationWrappedInitialState(context.state) && context.buffer.length === 0 && (context.exec?.path?.length ?? 0) === 0 && !(prefix.startsWith("--") || prefix.startsWith("-") || prefix.startsWith("/") || prefix.startsWith("+")))
        shouldSuggestValues = true;
      if (shouldSuggestValues)
        yield* getSuggestionsWithDependency(valueParser, prefix, context.dependencyRegistry, context.exec);
    }
  }
}
async function* getSuggestionsWithDependencyAsync(valueParser, prefix, dependencyRegistry, exec) {
  if (!valueParser.suggest)
    return;
  if (isDerivedValueParser(valueParser) && suggestWithDependency in valueParser) {
    const derived = valueParser;
    const suggestWithDep = derived[suggestWithDependency];
    if (suggestWithDep && dependencyRegistry) {
      const dependencyRuntime = exec?.dependencyRuntime;
      const depIds = getDependencyIds(derived);
      const defaultsFn = getDefaultValuesFunction(derived);
      const defaults = defaultsFn?.();
      const dependencyValues = [];
      let hasAnyValue = false;
      for (let i = 0;i < depIds.length; i++) {
        const depId = depIds[i];
        if (dependencyRegistry.has(depId)) {
          dependencyValues.push(dependencyRegistry.get(depId));
          hasAnyValue = true;
        } else if (dependencyRuntime?.isSourceFailed(depId))
          return;
        else if (defaults && i < defaults.length)
          dependencyValues.push(defaults[i]);
        else {
          for await (const suggestion of valueParser.suggest(prefix))
            yield suggestion;
          return;
        }
      }
      if (hasAnyValue) {
        const depValue = depIds.length === 1 ? dependencyValues[0] : dependencyValues;
        for await (const suggestion of suggestWithDep(prefix, depValue))
          yield suggestion;
        return;
      }
    }
  }
  for await (const suggestion of valueParser.suggest(prefix))
    yield suggestion;
}
async function* suggestOptionAsync(optionNames$1, valueParser, hidden, description, context, prefix) {
  if (hidden || context.optionsTerminated)
    return;
  const expectingValue = context.buffer.length > 0 && optionNames$1.includes(context.buffer[context.buffer.length - 1]);
  const joinedPrefix = joinedOptionPrefix(optionNames$1, prefix);
  if (joinedPrefix !== undefined && !expectingValue) {
    const optionPart = joinedPrefix.slice(0, -1);
    const valuePart = prefix.slice(joinedPrefix.length);
    if (optionNames$1.includes(optionPart)) {
      if (valueParser && valueParser.suggest) {
        const valueSuggestions = getSuggestionsWithDependencyAsync(valueParser, valuePart, context.dependencyRegistry, context.exec);
        for await (const suggestion of valueSuggestions)
          if (suggestion.kind === "literal")
            yield {
              kind: "literal",
              text: `${joinedPrefix}${suggestion.text}`,
              description: suggestion.description
            };
          else
            yield joinedFileSuggestion(joinedPrefix, suggestion, valuePart);
      }
    }
  } else {
    if (!expectingValue && (prefix.startsWith("--") || prefix.startsWith("-") || prefix.startsWith("/") || prefix.startsWith("+"))) {
      for (const optionName$1 of optionNames$1)
        if (optionName$1.startsWith(prefix)) {
          if (prefix === "-" && optionName$1.length !== 2)
            continue;
          yield {
            kind: "literal",
            text: optionName$1,
            ...description && { description }
          };
        }
    }
    if (valueParser && valueParser.suggest) {
      let shouldSuggestValues = false;
      if (context.buffer.length > 0) {
        const lastToken = context.buffer[context.buffer.length - 1];
        if (optionNames$1.includes(lastToken))
          shouldSuggestValues = true;
      } else if (isAnnotationWrappedInitialState(context.state) && context.buffer.length === 0 && (context.exec?.path?.length ?? 0) === 0 && !(prefix.startsWith("--") || prefix.startsWith("-") || prefix.startsWith("/") || prefix.startsWith("+")))
        shouldSuggestValues = true;
      if (shouldSuggestValues)
        for await (const suggestion of getSuggestionsWithDependencyAsync(valueParser, prefix, context.dependencyRegistry, context.exec))
          yield suggestion;
    }
  }
}
function* suggestArgumentSync(valueParser, hidden, prefix, dependencyRegistry, exec) {
  if (hidden)
    return;
  if (valueParser.suggest)
    yield* getSuggestionsWithDependency(valueParser, prefix, dependencyRegistry, exec);
}
async function* suggestArgumentAsync(valueParser, hidden, prefix, dependencyRegistry, exec) {
  if (hidden)
    return;
  if (valueParser.suggest)
    yield* getSuggestionsWithDependencyAsync(valueParser, prefix, dependencyRegistry, exec);
}
function option(...args) {
  const lastArg = args.at(-1);
  const secondLastArg = args.at(-2);
  let valueParser;
  let optionNames$1;
  let options = {};
  if (isValueParser(lastArg)) {
    valueParser = lastArg;
    optionNames$1 = args.slice(0, -1);
  } else if (typeof lastArg === "object" && lastArg != null) {
    options = lastArg;
    if (isValueParser(secondLastArg)) {
      valueParser = secondLastArg;
      optionNames$1 = args.slice(0, -2);
    } else {
      valueParser = undefined;
      optionNames$1 = args.slice(0, -1);
    }
  } else {
    optionNames$1 = args;
    valueParser = undefined;
  }
  validateOptionNames(optionNames$1, "Option");
  const mode = valueParser?.mode ?? "sync";
  const isAsync = mode === "async";
  const syncValueParser = valueParser;
  const dependencyMetadata = valueParser != null ? extractDependencyMetadata(valueParser) : undefined;
  const formatInvalidValueError = (error) => options.errors?.invalidValue ? typeof options.errors.invalidValue === "function" ? options.errors.invalidValue(error) : options.errors.invalidValue : message`${optionNames(optionNames$1)}: ${error}`;
  const result = {
    mode,
    $valueType: [],
    $stateType: [],
    priority: 10,
    usage: [valueParser == null ? {
      type: "optional",
      terms: [{
        type: "option",
        names: optionNames$1,
        ...options.hidden != null && { hidden: options.hidden }
      }]
    } : {
      type: "option",
      names: optionNames$1,
      metavar: valueParser.metavar,
      ...options.hidden != null && { hidden: options.hidden }
    }],
    leadingNames: new Set(optionNames$1),
    acceptingAnyToken: false,
    initialState: valueParser == null ? {
      success: true,
      value: false
    } : undefined,
    canSkip(state) {
      return valueParser == null || isTerminalValueState(state);
    },
    parse(context) {
      if (context.optionsTerminated)
        return {
          success: false,
          consumed: 0,
          error: options.errors?.optionsTerminated ?? message`No more options can be parsed.`
        };
      else if (context.buffer.length < 1)
        return {
          success: false,
          consumed: 0,
          error: options.errors?.endOfInput ?? message`Expected an option, but got end of input.`
        };
      if (context.buffer[0] === "--")
        return {
          success: true,
          next: {
            ...context,
            buffer: context.buffer.slice(1),
            state: context.state,
            optionsTerminated: true
          },
          consumed: context.buffer.slice(0, 1)
        };
      if (optionNames$1.includes(context.buffer[0])) {
        if (hasParsedOptionValue(context.state, valueParser))
          return {
            success: false,
            consumed: 1,
            error: options.errors?.duplicate ? typeof options.errors.duplicate === "function" ? options.errors.duplicate(context.buffer[0]) : options.errors.duplicate : message`${optionName(context.buffer[0])} cannot be used multiple times.`
          };
        if (valueParser == null)
          return {
            success: true,
            next: {
              ...context,
              state: {
                success: true,
                value: true
              },
              buffer: context.buffer.slice(1)
            },
            consumed: context.buffer.slice(0, 1)
          };
        if (context.buffer.length < 2)
          return {
            success: false,
            consumed: 1,
            error: options.errors?.endOfInput ?? message`${optionName(context.buffer[0])} requires ${metavar(valueParser.metavar)}.`
          };
        const rawInput = context.buffer[1];
        return dispatchByMode(mode, () => {
          const parseResult = syncValueParser.parse(rawInput);
          const next = recordTrace(context, buildTraceEntry("option-value", rawInput, context.buffer.slice(0, 2), syncValueParser, parseResult, optionNames$1));
          return {
            success: true,
            next: {
              ...next,
              state: createOptionParseState(parseResult, rawInput, syncValueParser),
              buffer: context.buffer.slice(2)
            },
            consumed: context.buffer.slice(0, 2)
          };
        }, async () => {
          const parseResult = await valueParser.parse(rawInput);
          const next = recordTrace(context, buildTraceEntry("option-value", rawInput, context.buffer.slice(0, 2), valueParser, parseResult, optionNames$1));
          return {
            success: true,
            next: {
              ...next,
              state: createOptionParseState(parseResult, rawInput, valueParser),
              buffer: context.buffer.slice(2)
            },
            consumed: context.buffer.slice(0, 2)
          };
        });
      }
      const prefixes = optionNames$1.filter((name) => name.startsWith("--") || name.startsWith("/") || name.startsWith("-") && name.length > 2).map((name) => name.startsWith("/") ? `${name}:` : `${name}=`);
      for (const prefix of prefixes) {
        if (!context.buffer[0].startsWith(prefix))
          continue;
        const optionName$1 = prefix.slice(0, -1);
        if (hasParsedOptionValue(context.state, valueParser))
          return {
            success: false,
            consumed: 1,
            error: options.errors?.duplicate ? typeof options.errors.duplicate === "function" ? options.errors.duplicate(prefix) : options.errors.duplicate : message`${optionName(optionName$1)} cannot be used multiple times.`
          };
        const rawInput = context.buffer[0].slice(prefix.length);
        if (valueParser == null)
          return {
            success: false,
            consumed: 1,
            error: options.errors?.unexpectedValue ? typeof options.errors.unexpectedValue === "function" ? options.errors.unexpectedValue(rawInput) : options.errors.unexpectedValue : message`Option ${optionName(optionName$1)} is a Boolean flag, but got a value: ${rawInput}.`
          };
        return dispatchByMode(mode, () => {
          const parseResult = syncValueParser.parse(rawInput);
          const next = recordTrace(context, buildTraceEntry("option-value", rawInput, context.buffer.slice(0, 1), syncValueParser, parseResult, optionNames$1));
          return {
            success: true,
            next: {
              ...next,
              state: createOptionParseState(parseResult, rawInput, syncValueParser),
              buffer: context.buffer.slice(1)
            },
            consumed: context.buffer.slice(0, 1)
          };
        }, async () => {
          const parseResult = await valueParser.parse(rawInput);
          const next = recordTrace(context, buildTraceEntry("option-value", rawInput, context.buffer.slice(0, 1), valueParser, parseResult, optionNames$1));
          return {
            success: true,
            next: {
              ...next,
              state: createOptionParseState(parseResult, rawInput, valueParser),
              buffer: context.buffer.slice(1)
            },
            consumed: context.buffer.slice(0, 1)
          };
        });
      }
      if (valueParser == null) {
        const shortOptions = optionNames$1.filter((name) => name.match(/^-[^-]$/));
        for (const shortOption of shortOptions) {
          if (!context.buffer[0].startsWith(shortOption))
            continue;
          if (hasParsedOptionValue(context.state, valueParser))
            return {
              success: false,
              consumed: 1,
              error: options.errors?.duplicate ? typeof options.errors.duplicate === "function" ? options.errors.duplicate(shortOption) : options.errors.duplicate : message`${optionName(shortOption)} cannot be used multiple times.`
            };
          return {
            success: true,
            next: {
              ...context,
              state: {
                success: true,
                value: true
              },
              buffer: [`-${context.buffer[0].slice(2)}`, ...context.buffer.slice(1)]
            },
            consumed: [context.buffer[0].slice(0, 2)]
          };
        }
      }
      const invalidOption = context.buffer[0];
      if (options.errors?.noMatch) {
        if (typeof options.errors.noMatch !== "function")
          return {
            success: false,
            consumed: 0,
            error: options.errors.noMatch
          };
        const candidates = /* @__PURE__ */ new Set;
        for (const name of extractOptionNames(context.usage))
          candidates.add(name);
        const suggestions = findSimilar(invalidOption, candidates, DEFAULT_FIND_SIMILAR_OPTIONS);
        const errorMessage = options.errors.noMatch(invalidOption, suggestions);
        return {
          success: false,
          consumed: 0,
          error: errorMessage
        };
      }
      const baseError = message`No matched option for ${optionName(invalidOption)}.`;
      return {
        success: false,
        consumed: 0,
        error: createErrorWithSuggestions(baseError, invalidOption, context.usage, "option")
      };
    },
    complete(state, exec) {
      const missing = valueParser == null ? {
        success: true,
        value: false
      } : {
        success: false,
        error: options.errors?.missing ? typeof options.errors.missing === "function" ? options.errors.missing(optionNames$1) : options.errors.missing : message`Missing option ${optionNames(optionNames$1)}.`
      };
      const completeSync = () => {
        if (state == null)
          return missing;
        const resolvedState = valueParser != null && dependencyMetadata?.derived != null ? resolveDerivedCompletionSync(dependencyMetadata, state, exec) : state;
        return resolvedState.success ? resolvedState : {
          success: false,
          error: formatInvalidValueError(includeDependencyFailureChain(resolvedState.error, dependencyMetadata, exec))
        };
      };
      const completeAsync = async () => {
        if (state == null)
          return missing;
        if (valueParser == null || dependencyMetadata?.derived == null)
          return completeSync();
        const resolved = await resolveDerivedCompletionAsync(dependencyMetadata, state, exec);
        return resolved.success ? resolved : {
          success: false,
          error: formatInvalidValueError(includeDependencyFailureChain(resolved.error, dependencyMetadata, exec))
        };
      };
      return dispatchByMode(mode, completeSync, completeAsync);
    },
    suggest(context, prefix) {
      if (isAsync)
        return suggestOptionAsync(optionNames$1, valueParser, isSuggestionHidden(options.hidden), options.description, context, prefix);
      return suggestOptionSync(optionNames$1, valueParser, isSuggestionHidden(options.hidden), options.description, context, prefix);
    },
    getDocFragments(_state, defaultValue) {
      if (isDocHidden(options.hidden))
        return withCommandDocMetadata({
          fragments: [],
          description: options.description
        }, {});
      const choicesMessage = valueParser?.choices != null && valueParser.choices.length > 0 ? valueSet(valueParser.choices.map((c) => valueParser.format(c)), {
        fallback: "",
        type: "unit"
      }) : undefined;
      const fragments = [{
        type: "entry",
        term: {
          type: "option",
          names: optionNames$1,
          metavar: valueParser?.metavar
        },
        description: options.description,
        default: defaultValue != null && valueParser != null ? message`${valueParser.format(defaultValue)}` : undefined,
        choices: choicesMessage
      }];
      return withCommandDocMetadata({
        fragments,
        description: options.description
      }, {});
    },
    [Symbol.for("Deno.customInspect")]() {
      return `option(${optionNames$1.map((o) => JSON.stringify(o)).join(", ")})`;
    }
  };
  if (valueParser != null && typeof valueParser.normalize === "function") {
    const normalize = valueParser.normalize.bind(valueParser);
    Object.defineProperty(result, "normalizeValue", {
      value(v) {
        try {
          return normalize(v);
        } catch {
          return v;
        }
      },
      configurable: true,
      enumerable: false
    });
  }
  if (valueParser == null)
    Object.defineProperty(result, "validateValue", {
      value(v) {
        if (typeof v !== "boolean") {
          const actualType = v === null ? "null" : typeof v;
          return wrapForMode(mode, {
            success: false,
            error: formatInvalidValueError(message`Expected a boolean value, but received ${actualType}.`)
          });
        }
        return wrapForMode(mode, {
          success: true,
          value: v
        });
      },
      configurable: true,
      enumerable: false
    });
  else if (!isDerivedValueParser(valueParser)) {
    const vp = valueParser;
    const wrapParseResult = (parsed) => parsed.success ? parsed : {
      success: false,
      error: formatInvalidValueError(parsed.error)
    };
    Object.defineProperty(result, "validateValue", {
      value(v) {
        if (typeof vp.validate === "function")
          return wrapForMode(mode, wrapParseResult(vp.validate(v)));
        let stringified;
        try {
          stringified = vp.format(v);
        } catch {
          return wrapForMode(mode, {
            success: true,
            value: v
          });
        }
        if (typeof stringified !== "string")
          return wrapForMode(mode, {
            success: true,
            value: v
          });
        return dispatchByMode(mode, () => wrapParseResult(vp.parse(stringified)), async () => wrapParseResult(await vp.parse(stringified)));
      },
      configurable: true,
      enumerable: false
    });
  }
  if (valueParser != null)
    Object.defineProperty(result, "placeholder", {
      get() {
        try {
          return valueParser.placeholder;
        } catch {
          return;
        }
      },
      configurable: true,
      enumerable: false
    });
  else
    Object.defineProperty(result, "placeholder", {
      value: false,
      configurable: true,
      enumerable: false,
      writable: false
    });
  if (dependencyMetadata != null)
    Object.defineProperty(result, "dependencyMetadata", {
      value: dependencyMetadata,
      configurable: true,
      enumerable: false
    });
  return fluent(result);
}
function flag(...args) {
  const lastArg = args.at(-1);
  let optionNames$1;
  let options = {};
  if (typeof lastArg === "object" && lastArg != null && !Array.isArray(lastArg)) {
    options = lastArg;
    optionNames$1 = args.slice(0, -1);
  } else
    optionNames$1 = args;
  validateOptionNames(optionNames$1, "Flag");
  const result = {
    $valueType: [],
    $stateType: [],
    mode: "sync",
    priority: 10,
    usage: [{
      type: "option",
      names: optionNames$1,
      ...options.hidden != null && { hidden: options.hidden }
    }],
    leadingNames: new Set(optionNames$1),
    acceptingAnyToken: false,
    initialState: undefined,
    canSkip(state) {
      return isTerminalValueState(state);
    },
    parse(context) {
      if (context.optionsTerminated)
        return {
          success: false,
          consumed: 0,
          error: options.errors?.optionsTerminated ?? message`No more options can be parsed.`
        };
      else if (context.buffer.length < 1)
        return {
          success: false,
          consumed: 0,
          error: options.errors?.endOfInput ?? message`Expected an option, but got end of input.`
        };
      if (context.buffer[0] === "--")
        return {
          success: true,
          next: {
            ...context,
            buffer: context.buffer.slice(1),
            state: context.state,
            optionsTerminated: true
          },
          consumed: context.buffer.slice(0, 1)
        };
      if (optionNames$1.includes(context.buffer[0])) {
        if (context.state?.success)
          return {
            success: false,
            consumed: 1,
            error: options.errors?.duplicate ? typeof options.errors.duplicate === "function" ? options.errors.duplicate(context.buffer[0]) : options.errors.duplicate : message`${optionName(context.buffer[0])} cannot be used multiple times.`
          };
        return {
          success: true,
          next: {
            ...context,
            state: {
              success: true,
              value: true
            },
            buffer: context.buffer.slice(1)
          },
          consumed: context.buffer.slice(0, 1)
        };
      }
      const prefixes = optionNames$1.filter((name) => name.startsWith("--") || name.startsWith("/") || name.startsWith("-") && name.length > 2).map((name) => name.startsWith("/") ? `${name}:` : `${name}=`);
      for (const prefix of prefixes)
        if (context.buffer[0].startsWith(prefix)) {
          const value = context.buffer[0].slice(prefix.length);
          return {
            success: false,
            consumed: 1,
            error: message`Flag ${optionName(prefix.slice(0, -1))} does not accept a value, but got: ${value}.`
          };
        }
      const shortOptions = optionNames$1.filter((name) => name.match(/^-[^-]$/));
      for (const shortOption of shortOptions) {
        if (!context.buffer[0].startsWith(shortOption))
          continue;
        if (context.state?.success)
          return {
            success: false,
            consumed: 1,
            error: options.errors?.duplicate ? typeof options.errors.duplicate === "function" ? options.errors.duplicate(shortOption) : options.errors.duplicate : message`${optionName(shortOption)} cannot be used multiple times.`
          };
        return {
          success: true,
          next: {
            ...context,
            state: {
              success: true,
              value: true
            },
            buffer: [`-${context.buffer[0].slice(2)}`, ...context.buffer.slice(1)]
          },
          consumed: [context.buffer[0].slice(0, 2)]
        };
      }
      const invalidOption = context.buffer[0];
      if (options.errors?.noMatch) {
        if (typeof options.errors.noMatch !== "function")
          return {
            success: false,
            consumed: 0,
            error: options.errors.noMatch
          };
        const candidates = /* @__PURE__ */ new Set;
        for (const name of extractOptionNames(context.usage))
          candidates.add(name);
        const suggestions = findSimilar(invalidOption, candidates, DEFAULT_FIND_SIMILAR_OPTIONS);
        const errorMessage = options.errors.noMatch(invalidOption, suggestions);
        return {
          success: false,
          consumed: 0,
          error: errorMessage
        };
      }
      const baseError = message`No matched option for ${optionName(invalidOption)}.`;
      return {
        success: false,
        consumed: 0,
        error: createErrorWithSuggestions(baseError, invalidOption, context.usage, "option")
      };
    },
    complete(state, _exec) {
      if (state == null)
        return {
          success: false,
          error: options.errors?.missing ? typeof options.errors.missing === "function" ? options.errors.missing(optionNames$1) : options.errors.missing : message`Required flag ${optionNames(optionNames$1)} is missing.`
        };
      if (state.success)
        return {
          success: true,
          value: true
        };
      return {
        success: false,
        error: message`${optionNames(optionNames$1)}: ${state.error}`
      };
    },
    suggest(context, prefix) {
      if (isSuggestionHidden(options.hidden) || context.optionsTerminated)
        return [];
      const suggestions = [];
      if (prefix.startsWith("--") || prefix.startsWith("-") || prefix.startsWith("/") || prefix.startsWith("+")) {
        for (const optionName$1 of optionNames$1)
          if (optionName$1.startsWith(prefix)) {
            if (prefix === "-" && optionName$1.length !== 2)
              continue;
            suggestions.push({
              kind: "literal",
              text: optionName$1,
              ...options.description && { description: options.description }
            });
          }
      }
      return suggestions;
    },
    getDocFragments(_state, _defaultValue) {
      if (isDocHidden(options.hidden))
        return withCommandDocMetadata({
          fragments: [],
          description: options.description
        }, {});
      const fragments = [{
        type: "entry",
        term: {
          type: "option",
          names: optionNames$1
        },
        description: options.description
      }];
      return withCommandDocMetadata({
        fragments,
        description: options.description
      }, {});
    },
    [Symbol.for("Deno.customInspect")]() {
      return `flag(${optionNames$1.map((o) => JSON.stringify(o)).join(", ")})`;
    }
  };
  Object.defineProperty(result, "placeholder", {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false
  });
  return fluent(result);
}
function argument(valueParser, options = {}) {
  const isAsync = valueParser.mode === "async";
  const syncValueParser = valueParser;
  const dependencyMetadata = extractDependencyMetadata(valueParser);
  const formatInvalidValueError = (error) => options.errors?.invalidValue ? typeof options.errors.invalidValue === "function" ? options.errors.invalidValue(error) : options.errors.invalidValue : message`${metavar(valueParser.metavar)}: ${error}`;
  const optionPattern = /^(?!--=)(--?[a-z0-9-]+)(?:=|$)/i;
  const term = {
    type: "argument",
    metavar: valueParser.metavar,
    ...options.hidden != null && { hidden: options.hidden }
  };
  const result = {
    mode: valueParser.mode,
    $valueType: [],
    $stateType: [],
    priority: 5,
    usage: [term],
    leadingNames: EMPTY_LEADING_NAMES2,
    acceptingAnyToken: true,
    initialState: undefined,
    canSkip(state) {
      return isTerminalValueState(state);
    },
    parse(context) {
      const localState = normalizeInjectedAnnotationState(context.state);
      if (context.buffer.length < 1)
        return {
          success: false,
          consumed: 0,
          error: options.errors?.endOfInput ?? message`Expected an argument, but got end of input.`
        };
      let i = 0;
      let optionsTerminated = context.optionsTerminated;
      if (!optionsTerminated)
        if (context.buffer[i] === "--") {
          optionsTerminated = true;
          i++;
        } else {
          const optionMatch = context.buffer[i].match(optionPattern);
          if (optionMatch != null)
            return {
              success: false,
              consumed: i,
              error: message`Expected an argument, but got an option: ${optionName(optionMatch[1])}.`
            };
        }
      if (context.buffer.length < i + 1)
        return {
          success: false,
          consumed: i,
          error: message`Expected an argument, but got end of input.`
        };
      if (localState != null)
        return {
          success: false,
          consumed: i,
          error: options.errors?.multiple ? typeof options.errors.multiple === "function" ? options.errors.multiple(valueParser.metavar) : options.errors.multiple : message`The argument ${metavar(valueParser.metavar)} cannot be used multiple times.`
        };
      const rawInput = context.buffer[i];
      return dispatchByMode(valueParser.mode, () => {
        const parseResult = syncValueParser.parse(rawInput);
        const next = recordTrace(context, buildTraceEntry("argument-value", rawInput, context.buffer.slice(0, i + 1), syncValueParser, parseResult));
        return {
          success: true,
          next: {
            ...next,
            buffer: context.buffer.slice(i + 1),
            state: createOptionParseState(parseResult, rawInput, syncValueParser),
            optionsTerminated
          },
          consumed: context.buffer.slice(0, i + 1)
        };
      }, async () => {
        const parseResult = await valueParser.parse(rawInput);
        const next = recordTrace(context, buildTraceEntry("argument-value", rawInput, context.buffer.slice(0, i + 1), valueParser, parseResult));
        return {
          success: true,
          next: {
            ...next,
            buffer: context.buffer.slice(i + 1),
            state: createOptionParseState(parseResult, rawInput, valueParser),
            optionsTerminated
          },
          consumed: context.buffer.slice(0, i + 1)
        };
      });
    },
    complete(state, exec) {
      const missing = {
        success: false,
        error: options.errors?.endOfInput ?? message`Expected a ${metavar(valueParser.metavar)}, but too few arguments.`
      };
      const completeSync = () => {
        if (state == null)
          return missing;
        const resolvedState = dependencyMetadata?.derived != null ? resolveDerivedCompletionSync(dependencyMetadata, state, exec) : state;
        return resolvedState.success ? resolvedState : {
          success: false,
          error: formatInvalidValueError(includeDependencyFailureChain(resolvedState.error, dependencyMetadata, exec))
        };
      };
      const completeAsync = async () => {
        if (state == null)
          return missing;
        if (dependencyMetadata?.derived == null)
          return completeSync();
        const resolved = await resolveDerivedCompletionAsync(dependencyMetadata, state, exec);
        return resolved.success ? resolved : {
          success: false,
          error: formatInvalidValueError(includeDependencyFailureChain(resolved.error, dependencyMetadata, exec))
        };
      };
      return dispatchByMode(valueParser.mode, completeSync, completeAsync);
    },
    suggest(context, prefix) {
      if (normalizeInjectedAnnotationState(context.state) != null)
        return dispatchIterableByMode(valueParser.mode, function* () {}, async function* () {});
      if (isAsync)
        return suggestArgumentAsync(valueParser, isSuggestionHidden(options.hidden), prefix, context.dependencyRegistry, context.exec);
      return suggestArgumentSync(valueParser, isSuggestionHidden(options.hidden), prefix, context.dependencyRegistry, context.exec);
    },
    getDocFragments(_state, defaultValue) {
      if (isDocHidden(options.hidden))
        return withCommandDocMetadata({
          fragments: [],
          description: options.description
        }, {});
      const choicesMessage = valueParser.choices != null && valueParser.choices.length > 0 ? valueSet(valueParser.choices.map((c) => valueParser.format(c)), {
        fallback: "",
        type: "unit"
      }) : undefined;
      const fragments = [{
        type: "entry",
        term,
        description: options.description,
        default: defaultValue == null ? undefined : message`${valueParser.format(defaultValue)}`,
        choices: choicesMessage
      }];
      return withCommandDocMetadata({
        fragments,
        description: options.description
      }, {});
    },
    [Symbol.for("Deno.customInspect")]() {
      return `argument()`;
    }
  };
  if (typeof valueParser.normalize === "function") {
    const normalize = valueParser.normalize.bind(valueParser);
    Object.defineProperty(result, "normalizeValue", {
      value(v) {
        try {
          return normalize(v);
        } catch {
          return v;
        }
      },
      configurable: true,
      enumerable: false
    });
  }
  if (!isDerivedValueParser(valueParser)) {
    const vp = valueParser;
    const vpMode = valueParser.mode;
    const wrapParseResult = (parsed) => parsed.success ? parsed : {
      success: false,
      error: formatInvalidValueError(parsed.error)
    };
    Object.defineProperty(result, "validateValue", {
      value(v) {
        if (typeof vp.validate === "function")
          return wrapForMode(vpMode, wrapParseResult(vp.validate(v)));
        let stringified;
        try {
          stringified = vp.format(v);
        } catch {
          return wrapForMode(vpMode, {
            success: true,
            value: v
          });
        }
        if (typeof stringified !== "string")
          return wrapForMode(vpMode, {
            success: true,
            value: v
          });
        return dispatchByMode(vpMode, () => wrapParseResult(syncValueParser.parse(stringified)), async () => wrapParseResult(await vp.parse(stringified)));
      },
      configurable: true,
      enumerable: false
    });
  }
  Object.defineProperty(result, "placeholder", {
    get() {
      try {
        return valueParser.placeholder;
      } catch {
        return;
      }
    },
    configurable: true,
    enumerable: false
  });
  if (dependencyMetadata != null)
    Object.defineProperty(result, "dependencyMetadata", {
      value: dependencyMetadata,
      configurable: true,
      enumerable: false
    });
  return fluent(result);
}
function normalizeCommandState(state) {
  return normalizeInjectedAnnotationState(state);
}
function getCommandParseChildState(commandState, childState, parser) {
  return getWrappedChildParseState(commandState, childState, parser);
}
function getCommandChildState(commandState, childState, parser) {
  return getWrappedChildState(commandState, childState, parser);
}
function createCommandState(sourceState, state) {
  return annotateFreshArray(sourceState, state);
}
function appendCommandPath(exec, name) {
  if (exec == null)
    return;
  return {
    ...exec,
    commandPath: [...exec.commandPath ?? [], name]
  };
}
function getCommandNames(name, options) {
  return [
    name,
    ...getVisibleCommandAliases(options),
    ...getHiddenCommandAliases(options)
  ];
}
function getVisibleCommandAliases(options) {
  const aliases = options.aliases;
  if (aliases == null)
    return [];
  if (!isNonEmptyStringArray(aliases))
    throw new TypeError("Command aliases must be a non-empty array of strings.");
  return aliases;
}
function getHiddenCommandAliases(options) {
  const hiddenAliases = options[hiddenCommandAliasesKey];
  if (hiddenAliases == null)
    return [];
  if (!isNonEmptyStringArray(hiddenAliases))
    throw new TypeError("Hidden command aliases must be a non-empty array of strings.");
  return hiddenAliases;
}
function isNonEmptyStringArray(value) {
  if (!Array.isArray(value) || value.length === 0)
    return false;
  for (let i = 0;i < value.length; i++)
    if (typeof value[i] !== "string")
      return false;
  return true;
}
function validateUniqueCommandNames(names) {
  const seen = /* @__PURE__ */ new Set;
  for (const name of names) {
    if (seen.has(name))
      throw new TypeError(`Command has a duplicate name: "${name}".`);
    seen.add(name);
  }
}
function* suggestCommandSync(context, prefix, name, aliases, parser, options) {
  if (isSuggestionHidden(options.hidden))
    return;
  const state = normalizeCommandState(context.state);
  if (state === undefined) {
    const description = options.brief ?? options.description;
    for (const commandName of [name, ...aliases])
      if (commandName.startsWith(prefix))
        yield {
          kind: "literal",
          text: commandName,
          ...description && { description }
        };
  } else if (state[0] === "matched")
    yield* parser.suggest(withChildContext(context, name, getCommandChildState(context.state, parser.initialState, parser), parser.usage), prefix);
  else if (state[0] === "parsing")
    yield* parser.suggest(withChildContext(context, name, getCommandChildState(context.state, state[1], parser), parser.usage), prefix);
}
async function* suggestCommandAsync(context, prefix, name, aliases, parser, options) {
  if (isSuggestionHidden(options.hidden))
    return;
  const state = normalizeCommandState(context.state);
  if (state === undefined) {
    const description = options.brief ?? options.description;
    for (const commandName of [name, ...aliases])
      if (commandName.startsWith(prefix))
        yield {
          kind: "literal",
          text: commandName,
          ...description && { description }
        };
  } else if (state[0] === "matched") {
    const suggestions = parser.suggest(withChildContext(context, name, getCommandChildState(context.state, parser.initialState, parser), parser.usage), prefix);
    for await (const s of suggestions)
      yield s;
  } else if (state[0] === "parsing") {
    const suggestions = parser.suggest(withChildContext(context, name, getCommandChildState(context.state, state[1], parser), parser.usage), prefix);
    for await (const s of suggestions)
      yield s;
  }
}
function command(name, parser, options = {}) {
  const commandNames = getCommandNames(name, options);
  const aliases = getVisibleCommandAliases(options);
  const hiddenAliases = getHiddenCommandAliases(options);
  validateCommandNames(commandNames, "Command");
  validateUniqueCommandNames(commandNames);
  const isAsync = parser.mode === "async";
  const syncInnerParser = parser;
  const asyncInnerParser = parser;
  const result = {
    [Symbol.for("@optique/core/commandParser")]: true,
    mode: parser.mode,
    $valueType: [],
    $stateType: [],
    priority: 15,
    usage: [{
      type: "command",
      name,
      ...aliases.length > 0 && { aliases },
      ...hiddenAliases.length > 0 && { hiddenAliases },
      ...options.usageLine != null && { usageLine: options.usageLine },
      ...options.hidden != null && { hidden: options.hidden }
    }, ...parser.usage],
    leadingNames: new Set(commandNames),
    acceptingAnyToken: false,
    initialState: undefined,
    canSkip(state, exec) {
      const normalizedState = normalizeCommandState(state);
      if (normalizedState === undefined)
        return false;
      if (normalizedState[0] === "matched")
        return parser.canSkip?.(getCommandChildState(state, parser.initialState, parser), withChildExecPath(exec, name)) === true;
      return parser.canSkip?.(getCommandChildState(state, normalizedState[1], parser), withChildExecPath(exec, name)) === true;
    },
    getSuggestRuntimeNodes(state, path) {
      const normalizedState = normalizeCommandState(state);
      if (normalizedState === undefined)
        return [];
      const childState = normalizedState[0] === "matched" ? getCommandChildState(state, parser.initialState, parser) : getCommandChildState(state, normalizedState[1], parser);
      const childPath = [...path, name];
      return parser.getSuggestRuntimeNodes?.(childState, childPath) ?? (parser.dependencyMetadata?.source != null ? [{
        path: childPath,
        parser,
        state: childState
      }] : []);
    },
    parse(context) {
      const state = normalizeCommandState(context.state);
      if (state === undefined) {
        if (context.buffer.length < 1 || !commandNames.includes(context.buffer[0])) {
          const actual = context.buffer.length > 0 ? context.buffer[0] : null;
          const leadingCmds = extractLeadingCommandNames(context.usage);
          const rawSuggestions = actual ? findSimilar(actual, leadingCmds, DEFAULT_FIND_SIMILAR_OPTIONS) : [];
          const suggestions = expandCommandAliasSuggestions(context.usage, rawSuggestions);
          if (options.errors?.notMatched) {
            const errorMessage = options.errors.notMatched;
            return {
              success: false,
              consumed: 0,
              error: typeof errorMessage === "function" ? errorMessage(name, actual, suggestions) : errorMessage
            };
          }
          if (actual == null)
            return {
              success: false,
              consumed: 0,
              error: message`Expected command ${optionName(name)}, but got end of input.`
            };
          const baseError = message`Expected command ${optionName(name)}, but got ${actual}.`;
          const suggestionMsg = createSuggestionMessage(suggestions);
          return {
            success: false,
            consumed: 0,
            error: suggestionMsg.length > 0 ? [
              ...baseError,
              text(`

`),
              ...suggestionMsg
            ] : baseError
          };
        }
        return {
          success: true,
          next: {
            ...context,
            buffer: context.buffer.slice(1),
            state: createCommandState(context.state, ["matched", name]),
            ...context.exec != null ? { exec: appendCommandPath(context.exec, name) } : {}
          },
          consumed: context.buffer.slice(0, 1)
        };
      } else if (state[0] === "matched" || state[0] === "parsing") {
        const innerState = state[0] === "matched" ? getCommandParseChildState(context.state, parser.initialState, parser) : getCommandParseChildState(context.state, state[1], parser);
        const wrapState = (parseResult) => {
          if (parseResult.success) {
            const mergedExec = mergeChildExec(context.exec, parseResult.next.exec);
            return {
              success: true,
              next: {
                ...parseResult.next,
                state: createCommandState(context.state, ["parsing", parseResult.next.state]),
                ...mergedExec != null ? {
                  exec: mergedExec,
                  dependencyRegistry: mergedExec.dependencyRegistry
                } : {}
              },
              consumed: parseResult.consumed
            };
          }
          return parseResult;
        };
        return dispatchByMode(parser.mode, () => wrapState(syncInnerParser.parse(withChildContext(context, name, innerState, parser.usage))), async () => wrapState(await parser.parse(withChildContext(context, name, innerState, parser.usage))));
      }
      return {
        success: false,
        consumed: 0,
        error: options.errors?.invalidState ?? message`Invalid command state.`
      };
    },
    complete(state, exec) {
      const normalizedState = normalizeCommandState(state);
      if (typeof normalizedState === "undefined")
        return {
          success: false,
          error: options.errors?.notFound ?? message`Command ${optionName(name)} was not matched.`
        };
      else if (normalizedState[0] === "matched") {
        const childExec = withChildExecPath(exec, name);
        const childContext = {
          buffer: [],
          optionsTerminated: false,
          usage: parser.usage,
          state: getCommandParseChildState(state, parser.initialState, parser),
          ...childExec != null ? {
            exec: childExec,
            trace: childExec.trace,
            dependencyRegistry: childExec.dependencyRegistry
          } : {}
        };
        return dispatchByMode(parser.mode, () => {
          const parseResult = syncInnerParser.parse(childContext);
          const nextExec = parseResult.success ? mergeChildExec(childExec, parseResult.next.exec) : childExec;
          return syncInnerParser.complete(parseResult.success ? getCommandChildState(state, parseResult.next.state, parser) : getCommandChildState(state, syncInnerParser.initialState, parser), nextExec);
        }, async () => {
          const parseResult = await asyncInnerParser.parse(childContext);
          const nextExec = parseResult.success ? mergeChildExec(childExec, parseResult.next.exec) : childExec;
          return asyncInnerParser.complete(parseResult.success ? getCommandChildState(state, parseResult.next.state, parser) : getCommandChildState(state, parser.initialState, parser), nextExec);
        });
      } else if (normalizedState[0] === "parsing") {
        const childExec = withChildExecPath(exec, name);
        return dispatchByMode(parser.mode, () => syncInnerParser.complete(getCommandChildState(state, normalizedState[1], parser), childExec), async () => await asyncInnerParser.complete(getCommandChildState(state, normalizedState[1], parser), childExec));
      }
      return {
        success: false,
        error: options.errors?.invalidState ?? message`Invalid command state during completion.`
      };
    },
    [extractPhase2SeedKey](state, exec) {
      const normalizedState = normalizeCommandState(state);
      if (typeof normalizedState === "undefined")
        return wrapForMode(parser.mode, null);
      if (normalizedState[0] === "matched") {
        const childExec = withChildExecPath(exec, name);
        const childContext = {
          buffer: [],
          optionsTerminated: false,
          usage: parser.usage,
          state: getCommandParseChildState(state, parser.initialState, parser),
          ...childExec != null ? {
            exec: childExec,
            trace: childExec.trace,
            dependencyRegistry: childExec.dependencyRegistry
          } : {}
        };
        return dispatchByMode(parser.mode, () => {
          const parseResult = syncInnerParser.parse(childContext);
          const nextExec = parseResult.success ? mergeChildExec(childExec, parseResult.next.exec) : childExec;
          return completeOrExtractPhase2Seed(syncInnerParser, parseResult.success ? getCommandChildState(state, parseResult.next.state, parser) : getCommandChildState(state, syncInnerParser.initialState, parser), nextExec);
        }, async () => {
          const parseResult = await asyncInnerParser.parse(childContext);
          const nextExec = parseResult.success ? mergeChildExec(childExec, parseResult.next.exec) : childExec;
          return await completeOrExtractPhase2Seed(asyncInnerParser, parseResult.success ? getCommandChildState(state, parseResult.next.state, parser) : getCommandChildState(state, parser.initialState, parser), nextExec);
        });
      }
      if (normalizedState[0] === "parsing")
        return completeOrExtractPhase2Seed(parser, getCommandChildState(state, normalizedState[1], parser), withChildExecPath(exec, name));
      return wrapForMode(parser.mode, null);
    },
    suggest(context, prefix) {
      if (isAsync)
        return suggestCommandAsync(context, prefix, name, aliases, parser, options);
      return suggestCommandSync(context, prefix, name, aliases, parser, options);
    },
    getDocFragments(state, defaultValue) {
      const commandState = state.kind === "available" ? normalizeCommandState(state.state) : undefined;
      if (state.kind === "unavailable" || typeof commandState === "undefined") {
        if (isDocHidden(options.hidden))
          return withCommandDocMetadata({
            fragments: [],
            description: options.description
          }, {});
        return withCommandDocMetadata({
          description: options.description,
          fragments: [{
            type: "entry",
            term: {
              type: "command",
              name
            },
            description: options.brief ?? options.description
          }]
        }, {});
      }
      const innerState = commandState[0] === "parsing" ? {
        kind: "available",
        state: getCommandChildState(state.state, commandState[1], parser)
      } : {
        kind: "available",
        state: getCommandChildState(state.state, parser.initialState, parser)
      };
      const innerFragments = parser.getDocFragments(innerState, defaultValue);
      const innerMetadata = getCommandDocMetadata(innerFragments) ?? innerFragments;
      return withCommandDocMetadata({
        ...innerFragments,
        brief: innerFragments.brief ?? options.brief,
        description: innerFragments.description ?? options.description,
        footer: innerFragments.footer ?? options.footer
      }, {
        origin: "command",
        brief: innerMetadata?.brief ?? options.brief,
        description: innerMetadata?.description ?? options.description,
        footer: innerMetadata?.footer ?? options.footer
      });
    },
    [Symbol.for("Deno.customInspect")]() {
      return `command(${JSON.stringify(name)})`;
    }
  };
  if (typeof parser.normalizeValue === "function")
    Object.defineProperty(result, "normalizeValue", {
      value: parser.normalizeValue.bind(parser),
      configurable: true,
      enumerable: false
    });
  if (typeof parser.validateValue === "function")
    Object.defineProperty(result, "validateValue", {
      value: parser.validateValue.bind(parser),
      configurable: true,
      enumerable: false
    });
  Object.defineProperty(result, effectfulSchedulingNodesKey, {
    value: (state, parentPath) => {
      const normalizedState = normalizeCommandState(state);
      if (normalizedState == null)
        return [];
      const innerState = normalizedState[0] === "parsing" ? normalizedState[1] : parser.initialState;
      return [{
        path: [...parentPath ?? [], name],
        parser,
        state: getCommandChildState(state, innerState, parser)
      }];
    },
    configurable: true,
    enumerable: false
  });
  Object.defineProperty(result, sourceCollectionExpansionKey, {
    value: true,
    configurable: true,
    enumerable: false
  });
  Object.defineProperty(result, exclusiveSourceScopeKey, {
    value: [parser],
    configurable: true,
    enumerable: false
  });
  definePassThroughPriority(result, [parser], (state, token) => {
    const active = normalizeCommandState(state);
    if (active == null)
      return;
    const childState = active[0] === "matched" ? parser.initialState : active[1];
    return getPassThroughPriority(parser, getCommandParseChildState(state, childState, parser), token);
  });
  defineOptionMatch(result, (state, token) => {
    const active = normalizeCommandState(state);
    if (active == null)
      return;
    const childState = active[0] === "matched" ? parser.initialState : active[1];
    const match = getOptionMatch(parser, getCommandParseChildState(state, childState, parser), token);
    return match == null ? undefined : {
      ...match,
      continuesCommand: true
    };
  });
  return fluent(result);
}

// node_modules/@optique/core/dist/completion.js
var SAFE_PROGRAM_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
function validateProgramName2(programName) {
  if (!SAFE_PROGRAM_NAME_PATTERN.test(programName))
    throw new Error(`Invalid program name for shell completion: "${programName}". Program names must start with an alphanumeric character or underscore, and contain only alphanumeric characters, underscores, hyphens, and dots.`);
}
function encodePattern(pattern) {
  return pattern.replace(/%/g, "%25").replace(/:/g, "%3A");
}
function encodeFilePrefix(suggestion) {
  const prefix = suggestion.prefix ?? "";
  if (prefix === "" || !(suggestion.pattern ?? "").startsWith(prefix) || sanitizeForTransport(prefix) !== prefix)
    return "";
  return `:${encodePattern(prefix)}`;
}
function encodeBashLiteral(value) {
  const text = sanitizeForTransport(value);
  return /^(?:__FILE__|__JOINED_FILE__|__LITERAL__):/.test(text) ? `__LITERAL__:${text}` : text;
}
function encodeExtensions(extensions) {
  return extensions?.map((ext) => ext.replace(/^\./, "")).join(",") ?? "";
}
function sanitizeForTransport(text) {
  return text.replace(/[\t\n\r\0]/g, " ");
}
function encodeLiteral(text) {
  const sanitized = sanitizeForTransport(text);
  return sanitized.startsWith("__FILE__:") || sanitized.startsWith("__LITERAL__:") ? `__LITERAL__:${sanitized}` : sanitized;
}
var bash = {
  name: "bash",
  generateScript(programName, args = []) {
    validateProgramName2(programName);
    const escapedArgs = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    return `
function _${programName} () {
  COMPREPLY=()
  local __raw_current="\${COMP_WORDS[COMP_CWORD]}"
  local current="" __quote="" __char __next __index __quote_offset=0
  local __file_mode=0
  if [[ $(type -t compopt) == builtin ]]; then
    compopt +o filenames 2>/dev/null || true
  fi
  # Dequote the shell word without evaluating filename contents.  Readline
  # returns escaped words after Tab, and users may start with an open quote.
  for ((__index=0; __index<\${#__raw_current}; __index++)); do
    __char="\${__raw_current:__index:1}"
    if [[ -z "$__quote" ]]; then
      case "$__char" in
        \\\\) ((++__index)); current+="\${__raw_current:__index:1}" ;;
        \\'|\\") __quote="$__char"; __quote_offset=\${#current} ;;
        *) current+="$__char" ;;
      esac
    elif [[ "$__quote" == "'" ]]; then
      if [[ "$__char" == "'" ]]; then
        __quote=""
      else
        current+="$__char"
      fi
    else
      case "$__char" in
        \\") __quote="" ;;
        \\\\)
          __next="\${__raw_current:__index+1:1}"
          case "$__next" in
            \\$|\\\`|\\"|\\\\)
              ((++__index)); current+="$__next" ;;
            *) current+="$__char" ;;
          esac ;;
        *) current+="$__char" ;;
      esac
    fi
  done
  local __tilde_pattern='^(~[a-zA-Z0-9_.+-]*)(/.*)?$'
  local __tilde_glob_pattern='^(~[a-zA-Z0-9_.+-]*)(/.*)?$'
  local prev=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  # Bash splits unquoted '=' at its default word breaks. Reassemble only
  # adjacent fragments, including further word breaks inside a joined value,
  # leaving whitespace-separated arguments intact.
  local __plain_current="$current" __remove="" __word __joined=0
  local __raw_joined_current="$__raw_current"
  local -a __raw_offsets=() __raw_quotes=()
  if [[ \${COMP_LINE+x} ]]; then
    local -a __words=()
    local __rest="$COMP_LINE" __previous="" __space __valid=1 __i __j=0
    local __shell_quote="" __shell_escape=0 __boundary=0 __previous_boundary=0 __scan __symbol __shell_dollar=0
    # Reconstruct the prefix at the cursor, leaving any suffix to Readline.
    if [[ \${COMP_POINT+x} ]]; then
      __rest="\${COMP_LINE:0:COMP_POINT}"
    fi
    for ((__i=0; __i<=COMP_CWORD; __i++)); do
      __word="\${COMP_WORDS[__i]}"
      __space=0
      while [[ "$__rest" == [[:space:]]* ]]; do
        __space=1
        __rest="\${__rest:1}"
      done
      if (( __i == COMP_CWORD && \${#__rest} < \${#__word} )); then
        __word="\${__word:0:\${#__rest}}"
      fi
      if [[ "\${__rest:0:\${#__word}}" != "$__word" ]]; then
        __valid=0
        break
      fi
      # Quoted or escaped operators belong to words; bare operators separate
      # shell syntax even when no whitespace surrounds a redirection.
      __boundary=0
      for ((__scan=0; __scan<\${#__word}; __scan++)); do
        __symbol="\${__word:__scan:1}"
        if (( __shell_escape )); then
          __shell_escape=0
        elif [[ "$__shell_quote" == ansi ]]; then
          if [[ "$__symbol" == '\\' ]]; then __shell_escape=1
          elif [[ "$__symbol" == "'" ]]; then __shell_quote=""; fi
        elif [[ "$__shell_quote" == "'" ]]; then
          [[ "$__symbol" == "'" ]] && __shell_quote=""
        elif [[ "$__symbol" == '\\' ]]; then
          __shell_escape=1
        elif [[ -n "$__shell_quote" ]]; then
          [[ "$__symbol" == "$__shell_quote" ]] && __shell_quote=""
        else
          case "$__symbol" in
            "'")
              if (( __shell_dollar )); then __shell_quote=ansi
              else __shell_quote="'"; fi ;;
            '"') __shell_quote='"' ;;
            '$') __shell_dollar=1 ;;
            '>'|'<'|'|'|'&'|';'|'('|')') __boundary=1 ;;
          esac
        fi
        [[ "$__symbol" == '$' && -z "$__shell_quote" ]] || __shell_dollar=0
      done
      if (( __i > 1 && !__space && !__boundary && !__previous_boundary )) &&
          { [[ -n "$__word" && -z "\${__word//=/}" ]] ||
            [[ -n "$__previous" && -z "\${__previous//=/}" ]] ||
            [[ "\${__words[__j-1]}" == [-/+]* ]] ||
            [[ "$__word" == =* && "\${__words[__j-1]}" == [-/+]* ]]; }; then
        __words[__j-1]+="$__word"
      else
        __words[__j]="$__word"
        ((++__j))
      fi
      __rest="\${__rest:\${#__word}}"
      __previous="$__word"
      __previous_boundary=$__boundary
    done
    if (( __valid )); then
      current="\${__words[__j-1]}"
      __raw_joined_current="$current"
      prev=("\${__words[@]:1:__j-2}")
      # Bash passes the fragment Readline will replace as the second argument,
      # which is empty when the cursor follows a word-break character.
      if [[ \${2+x} ]]; then
        __remove="\${current:0:\${#current}-\${#2}}"
      elif [[ -n "$__raw_current" && -z "\${__raw_current//=/}" ]]; then
        __remove="$current"
      else
        __remove="\${current:0:\${#current}-\${#__raw_current}}"
      fi
      # Decode joined shell words without evaluating substitutions. Keep quote
      # state across the reassembled fragments and decode the preserved prefix
      # separately so trimming uses the same representation as suggestions.
      __words[__j]="$__remove"
      local __decoded __decoded_option=0 __before_quote __join_quote __char __next __k __ansi __part __digits __code __join_quote_offset
      for ((__i=1; __i<=__j; __i++)); do
        __word="\${__words[__i]}"
        __decoded=""; __join_quote=""; __join_quote_offset=0
        for ((__k=0; __k<\${#__word}; __k++)); do
          __char="\${__word:__k:1}"
          __before_quote="$__join_quote"
          if [[ -z "$__join_quote" ]]; then
            case "$__char" in
              '\\') ((++__k)); __decoded+="\${__word:__k:1}" ;;
              '$')
                if [[ "\${__word:__k+1:1}" == "'" ]]; then
                  __join_quote=ansi; __join_quote_offset=\${#__decoded}; __ansi=""; ((++__k))
                elif [[ "\${__word:__k+1:1}" == '"' ]]; then
                  __join_quote='"'; __join_quote_offset=\${#__decoded}; ((++__k))
                else __decoded+="$__char"; fi ;;
              "'"|'"') __join_quote="$__char"; __join_quote_offset=\${#__decoded} ;;
              *) __decoded+="$__char" ;;
            esac
          elif [[ "$__join_quote" == ansi ]]; then
            if [[ "$__char" == "'" ]]; then
              printf -v __part '%b' "$__ansi"
              __decoded+="$__part"; __join_quote=""
            elif [[ "$__char" == '\\' ]]; then
              ((++__k)); __next="\${__word:__k:1}"
              case "$__next" in
                [0-7])
                  __digits="$__next"
                  while (( \${#__digits} < 3 )) && [[ "\${__word:__k+1:1}" == [0-7] ]]; do
                    ((++__k)); __digits+="\${__word:__k:1}"
                  done
                  __ansi+='\\0'"$__digits" ;;
                c)
                  __next="\${__word:__k+1:1}"
                  if [[ -n "$__next" && "$__next" != "'" ]]; then
                    ((++__k)); printf -v __code '%d' "'$__next"
                    if [[ "$__next" == '?' ]]; then __code=127
                    else __code=$((__code & 31)); fi
                    printf -v __part '\\\\%03o' "$__code"
                    __ansi+="$__part"
                  else __ansi+='\\\\c'; fi ;;
                "'"|'"'|'?') __ansi+="$__next" ;;
                *) __ansi+='\\'"$__next" ;;
              esac
            else __ansi+="$__char"; fi
          elif [[ "$__join_quote" == "'" ]]; then
            if [[ "$__char" == "'" ]]; then __join_quote=""
            else __decoded+="$__char"; fi
          else
            case "$__char" in
              '"') __join_quote="" ;;
              '\\')
                __next="\${__word:__k+1:1}"
                case "$__next" in
                  '$'|'\`'|'"'|'\\') ((++__k)); __decoded+="$__next" ;;
                  *) __decoded+="$__char" ;;
                esac ;;
              *) __decoded+="$__char" ;;
            esac
          fi
          if (( __i == __j - 1 )) &&
              { [[ ! \${__raw_offsets[\${#__decoded}]+x} ]] ||
                [[ -n "$__before_quote" && -z "$__join_quote" ]]; }; then
            __raw_offsets[\${#__decoded}]=$((__k + 1))
            __raw_quotes[\${#__decoded}]="$__join_quote"
          fi
        done
        if [[ "$__join_quote" == ansi ]]; then
          printf -v __part '%b' "$__ansi"
          __decoded+="$__part"
        fi
        # Shell syntax may precede the option prefix. Decide from decoded text,
        # retaining the existing native-file handling for non-option words.
        if [[ "$__decoded" == [-/+]* ]] || (( __i == __j && __decoded_option )); then
          if (( __i == __j - 1 )); then
            __decoded_option=1
            __quote="$__join_quote"
            [[ "$__quote" == ansi ]] && __quote="'"
            __quote_offset=$__join_quote_offset
          fi
          __words[__i]="$__decoded"
        fi
      done
      if [[ "\${__words[__j-1]}" == -*=* || "\${__words[__j-1]}" == /*:* || "\${__words[__j-1]}" != "$__raw_current" ]]; then
        current="\${__words[__j-1]}"
        __joined=1
      else
        current="$__plain_current"
        __words[__j]=""
      fi
      prev=("\${__words[@]:1:__j-2}")
      __remove="\${__words[__j]}"
    fi
  fi

  # Joined file directives retain the exact option prefix and metadata chosen
  # by the parser; do not infer option boundaries through speculative retries.
  local __protocol_current="$__raw_current"
  (( __joined )) && __protocol_current="$current"
  local -a __lines=() __replies=()
  local line __reply_prefix="" __file_current="$current" __literal=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] && __lines+=("$line")
  done < <(${programName} ${escapedArgs} "\${prev[@]}" "$__protocol_current" 2>/dev/null)
  for line in "\${__lines[@]}"; do
    COMPREPLY=()
    __reply_prefix=""
    __file_current="$current"
    __literal=0
    # Protocol tags are case-sensitive even when nocasematch is enabled.
    if [ "\${line:0:12}" = '__LITERAL__:' ]; then
      line="\${line#__LITERAL__:}"
      __literal=1
    elif [ "\${line:0:16}" = '__JOINED_FILE__:' ]; then
      line="\${line#__JOINED_FILE__:}"
      __reply_prefix="\${line%%:*}"
      __reply_prefix="\${__reply_prefix//%3A/:}"
      __reply_prefix="\${__reply_prefix//%25/%}"
      line="__FILE__:\${line#*:}"
      __file_current="\${current:\${#__reply_prefix}}"
    fi
    local __raw_file_current="$__raw_current" __file_quote_offset=$__quote_offset __file_tilde_quoted=0
    if [[ -n "$__reply_prefix" ]]; then
      local __raw_offset="\${__raw_offsets[\${#__reply_prefix}]:-\${#__reply_prefix}}"
      __raw_file_current="\${__raw_joined_current:__raw_offset}"
      # Quoting may start before the option name and remain active at the
      # delimiter. Keep that context when deciding whether tilde is literal.
      if [[ -n "\${__raw_quotes[\${#__reply_prefix}]-}" ]]; then
        __file_tilde_quoted=1
      fi
      if (( __file_quote_offset >= \${#__reply_prefix} )); then
        __file_quote_offset=$((__file_quote_offset - \${#__reply_prefix}))
      fi
    fi
    if [ "$__literal" = 0 ] && [ "\${line:0:9}" = '__FILE__:' ]; then
      # Parse file completion directive:
      # __FILE__:type:extensions:pattern:hidden[:insertion_prefix]
      local insertion_prefix="" __key_current="$__file_current"
      IFS=':' read -r _ type extensions pattern hidden insertion_prefix <<< "$line"
      extensions="\${extensions//,\\./,}"; extensions="\${extensions#.}"
      pattern="\${pattern//%3A/:}"; pattern="\${pattern//%25/%}"
      insertion_prefix="\${insertion_prefix//%3A/:}"; insertion_prefix="\${insertion_prefix//%25/%}"
      local __reply_start=\${#COMPREPLY[@]}

      # Inserted keys are not filesystem paths.  Match only the value part,
      # then restore the key once the file candidates have been filtered.
      if [[ -n "$insertion_prefix" ]] &&
          [ "\${pattern:0:\${#insertion_prefix}}" = "$insertion_prefix" ] &&
          [ "\${__file_current:0:\${#insertion_prefix}}" = "$insertion_prefix" ]; then
        pattern="\${pattern:\${#insertion_prefix}}"
        __file_current="\${__file_current:\${#insertion_prefix}}"
        if [ "\${__raw_file_current:0:\${#insertion_prefix}}" = "$insertion_prefix" ]; then
          __raw_file_current="\${__raw_file_current:\${#insertion_prefix}}"
        fi
      else
        insertion_prefix=""
      fi

      # path() echoes the raw shell word as its pattern.  Once dequoted,
      # use the literal current-word prefix instead of the escaped pattern.
      if [[ "$pattern" == "$__raw_file_current" && "$__file_current" != "$__raw_file_current" ]] ||
          { [[ -n "$__reply_prefix" ]] && [ "$pattern" = "$__file_current" ] &&
            { [[ "$pattern" != *[*?]* ]] || [ "$__raw_file_current" != "$__file_current" ]; }; }; then
        pattern=""
      fi

      # Save and adjust glob/shell options for safe file completion
      local __dotglob_was_set=0 __failglob_was_set=0 __noglob_was_set=0
      local __globignore_was_set=0 __saved_globignore="\${GLOBIGNORE-}"
      [[ \${GLOBIGNORE+x} == x ]] && __globignore_was_set=1
      shopt -q dotglob && __dotglob_was_set=1
      shopt -q failglob && __failglob_was_set=1
      [[ $- == *f* ]] && __noglob_was_set=1
      # Unset GLOBIGNORE before enabling dotglob because unsetting
      # GLOBIGNORE implicitly clears dotglob in Bash
      shopt -u failglob 2>/dev/null
      set +f
      unset GLOBIGNORE

      # Expand tilde prefix for file globbing
      local __glob_current="$__file_current" __tilde_prefix="" __tilde_expanded=""
      if [[ $__file_tilde_quoted == 0 && "$__raw_file_current" == "~"* && "$__file_current" =~ $__tilde_pattern ]]; then
        __tilde_prefix="\${BASH_REMATCH[1]}"
        eval "__tilde_expanded=$__tilde_prefix" 2>/dev/null || true
        if [[ -n "$__tilde_expanded" && "$__tilde_expanded" != "$__tilde_prefix" ]]; then
          __glob_current="\${__tilde_expanded}\${__file_current#$__tilde_prefix}"
        else
          __tilde_prefix=""
        fi
      fi

      # When a pattern is specified, use it as the glob base instead of the
      # current word so that completions enumerate the pattern's directory.
      # However, if the user has already typed beyond the pattern (e.g.,
      # pattern="src/" and current="src/ma"), preserve the typed suffix
      # for incremental filtering.
      local __from_pattern=0 __filter_pattern=0 __pattern_prefix=""
      local __pattern_tilde_prefix="" __pattern_tilde_expanded=""
      if [[ -n "$pattern" ]]; then
        # Normalize leading ./ so that ./src/ma matches pattern src/
        local __norm_current="\${__file_current#./}"
        local __norm_pattern="\${pattern#./}"
        # For wildcard patterns, compare only the directory prefix before
        # any wildcards so that typing src/ma narrows src/*.ts correctly
        local __compare_pattern="$__norm_pattern"
        if [[ "$__compare_pattern" == *[*?]* ]]; then
          __compare_pattern="\${__compare_pattern%%[*?]*}"
          [[ "$__compare_pattern" == */* ]] && __compare_pattern="\${__compare_pattern%/*}/" || __compare_pattern=""
        fi
        local __extends_pattern=0
        if [[ ( -n "$__compare_pattern" || -n "$__norm_current" ) && \${#__norm_current} -ge \${#__compare_pattern} && "\${__norm_current:0:\${#__compare_pattern}}" == "$__compare_pattern" && "$__file_current" != "$pattern" ]]; then
          __extends_pattern=1
        fi
        if (( __extends_pattern )) && [[ "$__norm_pattern" != *[*?]* ]]; then
          # User has typed beyond or an equivalent form of the pattern
          true
        else
          # Wildcards keep their file filter while the typed prefix narrows
          # the resulting paths. Save the expanded prefix before using pattern.
          if [[ "$__norm_pattern" == *[*?]* ]]; then
            __filter_pattern=1
            __pattern_prefix="$__glob_current"
            # An unquoted value equal to its wildcard is a complete search
            # pattern, not a literal filename prefix to filter against.
            if [ "$__file_current" = "$pattern" ] && [ "$__raw_file_current" = "$__file_current" ]; then
              __pattern_prefix=""
            fi
            __pattern_tilde_prefix="$__tilde_prefix"
            __pattern_tilde_expanded="$__tilde_expanded"
          fi
          __from_pattern=1
          # Reset tilde state from the current-word expansion so that a
          # non-tilde pattern is not rewritten through stale tilde state
          __tilde_prefix=""
          __tilde_expanded=""
          __glob_current="$pattern"
          if [[ "$pattern" =~ $__tilde_glob_pattern ]]; then
            __tilde_prefix="\${BASH_REMATCH[1]}"
            eval "__tilde_expanded=$__tilde_prefix" 2>/dev/null || true
            if [[ -n "$__tilde_expanded" && "$__tilde_expanded" != "$__tilde_prefix" ]]; then
              __glob_current="\${__tilde_expanded}\${pattern#$__tilde_prefix}"
            else
              __tilde_prefix=""
            fi
          fi
          # If the glob base is a directory without a trailing slash,
          # append one so that the glob enumerates its contents
          if [[ -d "$__glob_current" && "$__glob_current" != */ ]]; then
            __glob_current="$__glob_current/"
          fi
        fi
      fi

      # Enable dotglob when hidden files are requested, or when the user
      # is already navigating inside a hidden directory (e.g., ~/.config/nvim/)
      # This runs after tilde expansion so that paths like ~/.config/ are
      # checked against the expanded path, not the literal ~ string.
      local __inside_hidden_path=0
      local __hidden_directory_pattern='/[.]([^./][^/]*|[.][^/]+)/'
      if [[ "/\${__glob_current%/}/" =~ $__hidden_directory_pattern ||
            "/\${__pattern_prefix%/}/" =~ $__hidden_directory_pattern ]]; then
        __inside_hidden_path=1
      fi
      # Also check if the current prefix explicitly targets hidden entries
      # (e.g., user typed "." or ".e" to complete .env)
      local __prefix_targets_hidden=0
      local __prefix_base="\${__glob_current##*/}"
      if [[ -n "$__pattern_prefix" ]]; then __prefix_base="\${__pattern_prefix##*/}"; fi
      [[ "$__prefix_base" == .* ]] && __prefix_targets_hidden=1
      if [[ "$hidden" == "1" || "$__inside_hidden_path" == "1" || "$__prefix_targets_hidden" == "1" ]]; then shopt -s dotglob; fi

      # Pre-expand file candidates.  When the glob base came from the
      # program's pattern and contains wildcard characters (* or ?),
      # expand it as data with shell globbing. Empty IFS avoids splitting paths;
      # NUL records preserve spaces and newlines without requiring mapfile.
      # Shell expansion respects dotglob on older Bash versions as well.
      # Otherwise append * to treat it as a prefix.
      # Only * and ? are wildcard syntax; escape brackets, backslashes, and
      # extended-glob operators so other pattern characters stay literal.
      local -a __candidates=()
      if [[ "$__from_pattern" == "1" && "$__glob_current" == *[*?]* ]]; then
        local __pathname_glob="" __glob_char __glob_index
        for ((__glob_index=0; __glob_index<\${#__glob_current}; __glob_index++)); do
          __glob_char="\${__glob_current:__glob_index:1}"
          case "$__glob_char" in
            '['|']'|'\\'|'('|')'|'|'|'+'|'@'|'!')
              __pathname_glob+="\\\\$__glob_char" ;;
            *) __pathname_glob+="$__glob_char" ;;
          esac
        done
        [[ "$type" == "directory" ]] && __pathname_glob="\${__pathname_glob%/}"
        local __glob_dir="\${__pathname_glob%/*}"
        [[ "$__glob_dir" == "$__pathname_glob" ]] && __glob_dir="."
        [[ -z "$__glob_dir" ]] && __glob_dir="/"
        local __navigation_dir="" __basename_glob="\${__pathname_glob##*/}"
        # Once an offered directory is entered, keep the basename filter but
        # enumerate there. Only descendants of matching pattern bases qualify.
        if [[ "$__pattern_prefix" == */* ]]; then
          local __typed_dir="\${__pattern_prefix%/*}" __base_dir __norm_base __norm_dir
          # Resolve directory ancestry in subshells, preserving the typed spelling
          # for insertion. The trailing slash also preserves newline-ending names.
          if __norm_dir=$(CDPATH= builtin cd -P -- "$__typed_dir" >/dev/null 2>&1 && printf '%s/' "\${PWD%/}"); then
            while IFS= read -r -d '' __base_dir; do
              [[ -d "$__base_dir" ]] || continue
              __norm_base=$(CDPATH= builtin cd -P -- "$__base_dir" >/dev/null 2>&1 && printf '%s/' "\${PWD%/}") || continue
              if [ "\${__norm_dir:0:\${#__norm_base}}" = "$__norm_base" ]; then
                __navigation_dir="$__typed_dir"
                break
              fi
            done < <(IFS=; printf '%s\\0' $__glob_dir)
          fi
        fi
        local __candidate
        while IFS= read -r -d '' __candidate; do
          if [[ -e "$__candidate" || -L "$__candidate" ]]; then
            [[ -d "$__candidate" ]] && __candidate="\${__candidate%/}"
            __candidates+=("$__candidate")
          fi
        done < <(
          IFS=
          if [[ -n "$__navigation_dir" ]]; then
            printf '%s\\0' "$__navigation_dir"/$__basename_glob
          else
            printf '%s\\0' $__pathname_glob
          fi
        )
        # For file/any modes, also include directories from the base
        # directory for navigation even when the glob itself does not
        # match directory names.  Skip this for directory mode so that
        # the pattern's basename filter is respected.
        if [[ "$type" != "directory" ]]; then
          local __d
          local __directory_pattern="\${__glob_dir%/}/*/"
          while IFS= read -r -d '' __d; do
            [[ -d "$__d" ]] || continue
            __d="\${__d%/}"
            __candidates+=("$__d")
          done < <(
            IFS=
            if [[ -n "$__navigation_dir" ]]; then
              printf '%s\\0' "$__navigation_dir"/*/
            else
              printf '%s\\0' $__directory_pattern
            fi
          )
        fi
      else
        __candidates=("$__glob_current"*)
        # Remove no-match sentinel (bash returns the literal pattern).
        # Also check -L for dangling symlinks which are valid candidates.
        if [[ \${#__candidates[@]} -eq 1 && ! -e "\${__candidates[0]}" && ! -L "\${__candidates[0]}" ]]; then
          __candidates=()
        fi
      fi

      if (( __filter_pattern )); then
        local __nocasematch_was_set=0
        shopt -q nocasematch && __nocasematch_was_set=1
        if shopt -q nocaseglob; then shopt -s nocasematch; else shopt -u nocasematch; fi
        local -a __filtered_candidates=()
        for __candidate in "\${__candidates[@]}"; do
          if [[ "$__candidate" == "$__pattern_prefix"* ||
              "\${__candidate#./}" == "\${__pattern_prefix#./}"* ]]; then
            if [[ "$__pattern_prefix" == ./* && "$__candidate" != ./* ]]; then
              __candidate="./$__candidate"
            elif [[ "$__pattern_prefix" != ./* && "$__pattern_prefix" != . ]]; then
              __candidate="\${__candidate#./}"
            fi
            __filtered_candidates+=("$__candidate")
          fi
        done
        if (( __nocasematch_was_set )); then shopt -s nocasematch; else shopt -u nocasematch; fi
        __candidates=("\${__filtered_candidates[@]}")
      fi

      # Generate file completions based on type
      case "$type" in
        file)
          # Complete files and directories (directories for navigation)
          if [[ -n "$extensions" ]]; then
            # Files with extension filtering + directories
            local ext_pattern="\${extensions//,/|}"
            ext_pattern='\\.('"$ext_pattern"')$'
            for item in "\${__candidates[@]}"; do
              if [[ -d "$item" ]]; then
                COMPREPLY+=("$item/")
              elif [[ -f "$item" && "$item" =~ $ext_pattern ]]; then
                COMPREPLY+=("$item")
              fi
            done
          else
            # Complete files and directories for navigation
            for item in "\${__candidates[@]}"; do
              if [[ -d "$item" ]]; then
                COMPREPLY+=("$item/")
              elif [[ -f "$item" ]]; then
                COMPREPLY+=("$item")
              fi
            done
          fi
          ;;
        directory)
          # Complete directories only
          for dir in "\${__candidates[@]}"; do
            [[ -d "$dir" ]] && COMPREPLY+=("$dir/")
          done
          ;;
        any)
          # Complete both files and directories
          if [[ -n "$extensions" ]]; then
            # Files with extension filtering + directories
            # Files with extension filtering
            local ext_pattern="\${extensions//,/|}"
            ext_pattern='\\.('"$ext_pattern"')$'
            for item in "\${__candidates[@]}"; do
              if [[ -d "$item" ]]; then
                COMPREPLY+=("$item/")
              elif [[ ( -e "$item" || -L "$item" ) && "$item" =~ $ext_pattern ]]; then
                COMPREPLY+=("$item")
              fi
            done
          else
            # Complete files and directories, add slash to directories
            for item in "\${__candidates[@]}"; do
              if [[ -d "$item" ]]; then
                COMPREPLY+=("$item/")
              # Use -e || -L to include non-regular files (sockets, FIFOs, dangling symlinks)
              elif [[ -e "$item" || -L "$item" ]]; then
                COMPREPLY+=("$item")
              fi
            done
          fi
          ;;
      esac

      # Restore tilde prefix in completion results
      if (( __filter_pattern )); then
        __tilde_prefix="$__pattern_tilde_prefix"
        __tilde_expanded="$__pattern_tilde_expanded"
      fi
      if [[ -n "$__tilde_prefix" &&
            ( -z "$__quote" || $__file_quote_offset -gt 0 ) ]]; then
        local __i
        for __i in "\${!COMPREPLY[@]}"; do
          COMPREPLY[$__i]="\${COMPREPLY[$__i]/#$__tilde_expanded/$__tilde_prefix}"
        done
      fi

      # Restore glob/shell options
      # Restore GLOBIGNORE before dotglob because assigning GLOBIGNORE
      # implicitly enables dotglob in Bash
      if [[ "$__globignore_was_set" == "1" ]]; then GLOBIGNORE="$__saved_globignore"; fi
      if [[ "$__dotglob_was_set" == "0" ]]; then shopt -u dotglob; else shopt -s dotglob; fi
      if [[ "$__failglob_was_set" == "1" ]]; then shopt -s failglob; fi
      if [[ "$__noglob_was_set" == "1" ]]; then set -f; fi

      # Readline appends directory separators when it receives the full path.
      # Midword quotes still need ours because replies omit the typed prefix.
      if [[ -n "$__quote" && $__file_quote_offset -eq 0 ]]; then
        local __reply_index
        for ((__reply_index=__reply_start; __reply_index<\${#COMPREPLY[@]}; __reply_index++)); do
          COMPREPLY[__reply_index]="\${COMPREPLY[__reply_index]%/}"
        done
      fi

      # Readline replaces only the text after an open quote.  Remove the
      # already typed prefix so it is not inserted a second time.
      # Joined replies are trimmed once against __remove after restoring option=,
      # and keyed replies once their key has been restored.
      if [[ -n "$__quote" && $__file_quote_offset -gt 0 && -z "$__reply_prefix" && -z "$insertion_prefix" ]]; then
        local __quote_prefix="\${__file_current:0:__file_quote_offset}"
        local __reply_index
        for ((__reply_index=__reply_start; __reply_index<\${#COMPREPLY[@]}; __reply_index++)); do
          COMPREPLY[__reply_index]="\${COMPREPLY[__reply_index]#"$__quote_prefix"}"
        done
      fi

      # Readline expands a leading tilde in a returned filename even when the
      # user did not type one.  Keep such local paths explicitly relative.
      if [[ ( "$__raw_file_current" != "~"* || $__file_tilde_quoted == 1 ) && -z "$__tilde_prefix" ]]; then
        local __reply_index
        for ((__reply_index=__reply_start; __reply_index<\${#COMPREPLY[@]}; __reply_index++)); do
          if [[ "\${COMPREPLY[__reply_index]}" =~ $__tilde_glob_pattern ]]; then
            COMPREPLY[__reply_index]="./\${COMPREPLY[__reply_index]}"
          fi
        done
      fi

      # Bash 5.3 leaves substitutions unescaped inside an open double quote.
      # Earlier versions already escape them during filename processing.
      if [[ "$__quote" == '"' &&
            ( \${BASH_VERSINFO[0]} -gt 5 ||
              ( \${BASH_VERSINFO[0]} -eq 5 && \${BASH_VERSINFO[1]} -ge 3 ) ) &&
            $(type -t compopt) == builtin ]]; then
        local __escaped_reply __escape_index __reply_index
        for ((__reply_index=__reply_start; __reply_index<\${#COMPREPLY[@]}; __reply_index++)); do
          __escaped_reply=""
          for ((__escape_index=0; __escape_index<\${#COMPREPLY[__reply_index]}; __escape_index++)); do
            __char="\${COMPREPLY[__reply_index]:__escape_index:1}"
            __next="\${COMPREPLY[__reply_index]:__escape_index+1:1}"
            if [[ "$__char" == '\\' &&
                  ( "$__next" == '$' || "$__next" == '\`' ) ]]; then
              __escaped_reply+="\\\\$__char"
            elif [[ "$__char" == '$' || "$__char" == '\`' ]]; then
              __escaped_reply+="\\\\$__char"
            else
              __escaped_reply+="$__char"
            fi
          done
          COMPREPLY[__reply_index]="$__escaped_reply"
        done
      fi

      # Filter out hidden files unless requested
      if [[ "$hidden" != "1" && "$__inside_hidden_path" == "0" && "$__prefix_targets_hidden" == "0" ]]; then
        local filtered=()
        local __name
        for item in "\${COMPREPLY[@]}"; do
          __name="\${item%/}"; __name="\${__name##*/}"
          if [[ "$__name" != .* ]]; then
            filtered+=("$item")
          fi
        done
        COMPREPLY=("\${filtered[@]}")
      fi
      if [[ -n "$insertion_prefix" ]]; then
        local __reply_index
        for ((__reply_index=__reply_start; __reply_index<\${#COMPREPLY[@]}; __reply_index++)); do
          COMPREPLY[__reply_index]="$insertion_prefix\${COMPREPLY[__reply_index]}"
        done
        if [[ -n "$__quote" && $__file_quote_offset -gt 0 && -z "$__reply_prefix" ]]; then
          local __quote_prefix="\${__key_current:0:__file_quote_offset}"
          for ((__reply_index=__reply_start; __reply_index<\${#COMPREPLY[@]}; __reply_index++)); do
            COMPREPLY[__reply_index]="\${COMPREPLY[__reply_index]#"$__quote_prefix"}"
          done
        fi
      fi
      if [[ \${#COMPREPLY[@]} -gt $__reply_start ]]; then __file_mode=1; fi
    else
      # Regular literal completion
      COMPREPLY+=("$line")
    fi
    for __word in "\${COMPREPLY[@]}"; do
      __replies+=("$__reply_prefix$__word")
    done
  done
  COMPREPLY=()
  for __word in "\${__replies[@]}"; do
    if [[ "\${__word:0:\${#__remove}}" == "$__remove" ]]; then
      COMPREPLY+=("\${__word:\${#__remove}}")
    fi
  done
  if (( \${#COMPREPLY[@]} > 1 )) && command -v sort >/dev/null 2>&1; then
    # Sort shell-escaped keys, not filenames: each key occupies one line even
    # when a candidate contains tabs or newlines. Keep the first occurrence's
    # index, then restore the original order without evaluating escaped data.
    # This works without associative arrays or NUL-aware sort on Bash 3.2.
    local -a __unique_replies=()
    local __index __key __last_key=""
    while IFS= read -r __index; do
      __unique_replies+=("\${COMPREPLY[__index]}")
    done < <(
      for ((__index=0; __index<\${#COMPREPLY[@]}; __index++)); do
        printf '%q\\t%d\\n' "\${COMPREPLY[__index]}" "$__index"
      done |
        LC_ALL=C sort -t $'\\t' -k1,1 -k2,2n |
        {
          while IFS=$'\\t' read -r __key __index; do
            if [ "$__key" != "$__last_key" ]; then
              printf '%s\\n' "$__index"
              __last_key="$__key"
            fi
          done
        } | LC_ALL=C sort -n
    )
    COMPREPLY=("\${__unique_replies[@]}")
  fi
  if [[ $__file_mode == 1 && $(type -t compopt) == builtin ]]; then
    compopt -o filenames 2>/dev/null || true
  fi
}

# Bash 3.2 has no compopt: use filename quoting for all candidates there.
if [[ $(type -t compopt) == builtin ]]; then
  complete -F _${programName} -- ${programName}
else
  complete -o filenames -F _${programName} -- ${programName}
fi
    `;
  },
  *encodeSuggestions(suggestions) {
    let i = 0;
    for (const suggestion of suggestions) {
      if (i > 0)
        yield `
`;
      const joined = getJoinedFileSuggestion(suggestion);
      if (joined !== undefined) {
        if (joined.literal && suggestion.kind === "literal") {
          yield encodeBashLiteral(suggestion.text);
          yield `
`;
        }
        for (const [index, { prefix, file }] of joined.files.entries()) {
          if (index > 0)
            yield `
`;
          yield `__JOINED_FILE__:${encodePattern(prefix)}:${file.type}:${encodeExtensions(file.extensions)}:${encodePattern(sanitizeForTransport(file.pattern ?? ""))}:${file.includeHidden ? "1" : "0"}${encodeFilePrefix(file)}`;
        }
      } else if (suggestion.kind === "literal")
        yield encodeBashLiteral(suggestion.text);
      else {
        const extensions = encodeExtensions(suggestion.extensions);
        const hidden = suggestion.includeHidden ? "1" : "0";
        const pattern = encodePattern(suggestion.pattern ?? "");
        yield `__FILE__:${suggestion.type}:${extensions}:${pattern}:${hidden}${encodeFilePrefix(suggestion)}`;
      }
      i++;
    }
  }
};
var zsh = {
  name: "zsh",
  generateScript(programName, args = []) {
    validateProgramName2(programName);
    const escapedArgs = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    const functionName = /[.-]/.test(programName) ? `_optique:${programName}` : `_${programName}`;
    const fixedGlobFunction = "__optique-fixed-glob-" + Array.from(programName, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    return `#compdef ${programName}
function ${functionName} () {
  # Completion fields omit surrounding quotes, unlike words[CURRENT].
  # Single-quoted fields are already literal; other fields retain escapes.
  local current="$IPREFIX$PREFIX$SUFFIX$ISUFFIX"
  local __logical_prefix="$IPREFIX$PREFIX"
  # Let zsh match the suffix when completing in the middle of a word.
  if [[ -o complete_in_word ]]; then
    current="$__logical_prefix"
  fi
  if [[ "$compstate[quote]" == '"' ]]; then
    # Restore the omitted quoting context before removing shell escapes.
    # In double quotes, a backslash before an ordinary character is literal.
    current="$QIPREFIX$current\${QISUFFIX:-$compstate[quote]}"
    __logical_prefix="$QIPREFIX$__logical_prefix$compstate[quote]"
    current="\${(Q)current}"
    __logical_prefix="\${(Q)__logical_prefix}"
  elif [[ "$compstate[quote]" != "'" ]]; then
    current="\${(Q)current}"
    __logical_prefix="\${(Q)__logical_prefix}"
  fi
  local -a prev
  # Extract previous arguments, skipping empty ones
  prev=()
  local i
  for (( i=2; i < CURRENT; i++ )); do
    if [[ -n "$words[i]" ]]; then
      prev+=("\${(Q)words[i]}")
    fi
  done

  # Call the completion function and capture output
  local output
  if (( \${#prev[@]} == 0 )); then
    output=$(${programName} ${escapedArgs} "$current" 2>/dev/null)
  else
    output=$(${programName} ${escapedArgs} "\${prev[@]}" "$current" 2>/dev/null)
  fi

  # Split output into lines and process each line
  local -a completions descriptions
  local line value desc
  local has_file_completion=0

  while IFS= read -r line; do
    if [[ -n "$line" ]]; then
      # Split by null character - first part is value, second is description
      value=\${line%%$'\\0'*}
      desc=\${line#*$'\\0'}
      desc=\${desc%%$'\\0'*}

      local __literal=0
      if [[ "$value" == __LITERAL__:* ]]; then
        value="\${value#__LITERAL__:}"
        __literal=1
      fi
      if [[ $__literal == 0 && "$value" == __FILE__:* ]]; then
        # Parse file completion directive: __FILE__:type:extensions:pattern:hidden
        local type extensions pattern hidden insertion_prefix
        IFS=':' read -r _ type extensions pattern hidden insertion_prefix <<< "$value"
        local __decoded_pattern="$pattern"
        __decoded_pattern="\${__decoded_pattern//\\%3A/:}"; __decoded_pattern="\${__decoded_pattern//\\%25/%}"
        insertion_prefix="\${insertion_prefix//\\%3A/:}"; insertion_prefix="\${insertion_prefix//\\%25/%}"
        local __saved_prefix="$PREFIX" __saved_iprefix="$IPREFIX"
        local __saved_current="$current" __saved_logical_prefix="$__logical_prefix"
        if [[ -n "$insertion_prefix" && "$__decoded_pattern" == "$insertion_prefix"* &&
              "$PREFIX" == "$insertion_prefix"* &&
              "$__logical_prefix" == "$insertion_prefix"* &&
              "$current" == "$insertion_prefix"* ]]; then
          pattern="\${__decoded_pattern#"$insertion_prefix"}"
          PREFIX="\${PREFIX#"$insertion_prefix"}"
          IPREFIX="$IPREFIX$insertion_prefix"
          # Compare file patterns with the value part, not the inserted key.
          current="\${current#"$insertion_prefix"}"
          __logical_prefix="\${__logical_prefix#"$insertion_prefix"}"
        else
          # Preserve legacy decoding for directives without active metadata.
          pattern="\${pattern//%3A/:}"; pattern="\${pattern//%25/%}"
        fi
        has_file_completion=1

        # Native completion helpers expect normal zsh glob grouping even if
        # the caller enabled SH_GLOB in their shell options.
        local __was_sh_glob=0
        [[ -o sh_glob ]] && __was_sh_glob=1
        unsetopt sh_glob
        local __was_extended_glob=0
        [[ -o extended_glob ]] && __was_extended_glob=1
        local __was_sh_word_split=0
        [[ -o sh_word_split ]] && __was_sh_word_split=1
        unsetopt sh_word_split

        # Enable glob_dots when hidden files are requested so that
        # _files and _directories include dot-prefixed entries
        local __was_glob_dots=0
        [[ -o glob_dots ]] && __was_glob_dots=1
        if [[ "$hidden" == "1" ]]; then setopt glob_dots; fi

        # When a pattern is specified, override PREFIX so that _files and
        # _directories enumerate the pattern's directory instead of the
        # current word.  If the user has already typed beyond the pattern,
        # keep PREFIX unchanged for incremental narrowing.
        local __fixed_glob=0
        local -a __fixed_matches
        local __initial_file_pattern="" __initial_directory="" __initial_leaf=""
        if [[ ( "$type" == "file" || "$type" == "any" || "$type" == "directory" ) &&
              -z "$current$PREFIX$SUFFIX" &&
              -z "\${compstate[pattern_match]}" &&
              "$pattern" != /* && "$pattern" != "~"* ]]; then
          if [[ "$pattern" == */* ]]; then
            __initial_directory="\${pattern%/*}/"
          fi
          __initial_leaf="\${pattern##*/}"
          # Native -g filters are split as shell words and use extended glob
          # syntax. Keep unsupported filename forms on the existing path.
          if [[ "$__initial_leaf" == *[*?]* &&
                "$__initial_directory" != *[*?]* &&
                "$__initial_directory" != *["[]()"]* &&
                "$__initial_leaf" != *["[]"]* &&
                "$__initial_leaf" != *'\\'* &&
                "$__initial_leaf" != *[[:space:]]* &&
                "$__initial_leaf" != *["#~^()|<>;&"]* &&
                "$__initial_leaf" != *"'"* && "$__initial_leaf" != *'"'* ]]; then
            __initial_file_pattern="$__initial_leaf"
            # Only the literal directory belongs in PREFIX. Quote it so
            # spaces and shell metacharacters remain literal path text.
            if [[ -n "$__initial_directory" ]]; then
              PREFIX="\${(q)__initial_directory}"
            fi
          fi
        fi
        local __saved_pattern_match="$compstate[pattern_match]"
        local __pattern_match_changed=0
        # path() echoes current as its pattern.  Keep zsh's escaped PREFIX
        # in that case instead of reinterpreting logical text as shell syntax.
        if [[ -n "$pattern" && "$pattern" != "$current" && -z "$__initial_file_pattern" ]]; then
          # Normalize leading ./ so that ./src/ma matches pattern src/
          local __norm_prefix="\${__logical_prefix#./}"
          local __norm_pattern="\${pattern#./}"
          local __compare_pattern="$__norm_pattern"
          if [[ "$__compare_pattern" == *[*?]* ]]; then
            __compare_pattern="\${__compare_pattern%%[*?]*}"
            [[ "$__compare_pattern" == */* ]] && __compare_pattern="\${__compare_pattern%/*}/" || __compare_pattern=""
          fi
          if [[ ( -n "$__compare_pattern" || -n "$__norm_prefix" ) && \${#__norm_prefix} -ge \${#__compare_pattern} && "\${__norm_prefix[1,\${#__compare_pattern}]}" == "$__compare_pattern" && "$__logical_prefix" != "$pattern" ]]; then
            # Keep the typed prefix, but retain a fixed file glob separately.
            if [[ "$type" != "directory" && "$__norm_pattern" == *[*?]* ]]; then
              __fixed_glob=1
              local __fixed_was_glob_dots=0
              [[ -o glob_dots ]] && __fixed_was_glob_dots=1
              if [[ "$PREFIX" == .* || "$PREFIX" == */.* ]]; then setopt glob_dots; fi
              # Keep qualifiers in a string so sourcing also works with SH_GLOB.
              local __fixed_pattern="" __glob_char="" __glob_previous=""
              local __glob_escaped=0
              local __glob_class=0 __glob_class_start=0 __glob_class_nested=""
              local -i __glob_index
              for (( __glob_index=1; __glob_index <= \${#pattern}; __glob_index++ )); do
                __glob_char="\${pattern[__glob_index]}"
                if [[ "$__glob_class" == "1" ]]; then
                  # Class members are already literal.  Preserve leading ]
                  # and nested POSIX classes without adding backslashes.
                  __fixed_pattern+="$__glob_char"
                  if [[ -n "$__glob_class_nested" ]]; then
                    if [[ "$__glob_char" == "]" && "$__glob_previous" == "$__glob_class_nested" ]]; then
                      __glob_class_nested=""
                    fi
                  elif [[ "$__glob_char" == "[" && "\${pattern[__glob_index+1]}" == ":" ]]; then
                    __glob_class_nested="\${pattern[__glob_index+1]}"
                    __glob_class_start=0
                  elif [[ "$__glob_char" == "]" && "$__glob_class_start" == "0" ]]; then
                    __glob_class=0
                  elif [[ "$__glob_class_start" == "1" && ( "$__glob_char" == "!" || "$__glob_char" == "^" ) &&
                          ( "\${pattern[__glob_index+1]}" != "]" || "\${pattern[__glob_index+2,-1]}" == *']'* ) ]]; then
                    __glob_class_start=2
                  else
                    __glob_class_start=0
                  fi
                  __glob_previous="$__glob_char"
                  continue
                fi
                if [[ "$__glob_escaped" == "1" ]]; then
                  __fixed_pattern+="$__glob_char"
                  __glob_escaped=0
                  __glob_previous=""
                  continue
                fi
                if [[ "$__glob_char" == "\\\\" ]]; then
                  __fixed_pattern+="$__glob_char"
                  __glob_escaped=1
                elif [[ "$__glob_char" == "[" ]]; then
                  __fixed_pattern+="$__glob_char"
                  __glob_class=1
                  __glob_class_start=1
                elif [[ "$__glob_char" == [#^~\\(\\)\\|\\<\\>] &&
                        ! ( "$__glob_char" == "~" && "$__glob_index" == "1" ) ]]; then
                  # Keep class negation and leading home expansion; escape
                  # extended-glob operators in literal pathname components.
                  __fixed_pattern+="\\\\$__glob_char"
                else
                  __fixed_pattern+="$__glob_char"
                fi
                __glob_previous="$__glob_char"
              done
              __fixed_pattern+="(#qN)"
              __fixed_matches=( \${~__fixed_pattern} )
              __fixed_matches=( "\${(@)__fixed_matches:a}" )
              # Hidden parents widen fixed matches, not native child suggestions.
              if [[ "$__fixed_was_glob_dots" == "0" && "\${PREFIX##*/}" != .* ]]; then unsetopt glob_dots; fi
            fi
          else
            local __native_pattern="$pattern"
            # Initial globs use the conservative native filters above.
            # Retained input and protected markers still need pattern matching.
            if [[ -n "$compstate[context]" && "$pattern" == *[\\*\\?\\[]* &&
                  ( -n "$current" || "$pattern" == *'$'* || "$pattern" == *'\`'* ) ]]; then
              compstate[pattern_match]='*'
              __pattern_match_changed=1
            fi
            # Native helpers expand substitutions, tilde names and executable
            # glob qualifiers.  Input-derived patterns must keep these literal.
            # Ordinary fixed glob/tilde patterns retain their native behavior.
            local __tilde_name="\${pattern#\\~}"
            __tilde_name="\${__tilde_name%%/*}"
            local -a match mbegin mend
            local __code_qualifier=0
            local __fixed_qualifier_base=""
            local __safe_qualifiers='([-/F.@=p*rwxAIERWXsStUG^MTNDn,]|[ugdl]<->|[amc]([Mwhmsd]|)([-+]|)<->|L([kKmMgGtTpP]|)([-+]|)<->|[oO][nLlamcdN])##'
            local __qualifier_pattern="$pattern" __qualifier
            while _have_glob_qual "$__qualifier_pattern" complete; do
              __qualifier="\${match[5]#\\#q}"
              __qualifier_pattern="$match[2]"
              # A numeric sense (+1) is not a function qualifier (+name).
              # Accept only bounded attribute/sort syntax in this exception.
              # Expand the pattern at runtime after unsetting SH_GLOB.
              if [[ "$__qualifier" == \${~__safe_qualifiers} ]]; then
                __fixed_qualifier_base="$__qualifier_pattern"
              elif [[ "$__qualifier" == *[e+]* ]]; then
                __code_qualifier=1
              fi
            done
            # Partial overlaps with complete backend classes/groups remain
            # syntax. A complete input-provided expression can be literal.
            local -a __syntax_starts=() __syntax_ends=() __group_stack=()
            local -i __scan_index __class_begin=0 __member_begin=0
            local __scan_char __nested_class=""
            for (( __scan_index=1; __scan_index <= \${#pattern}; __scan_index++ )); do
              __scan_char="\${pattern[__scan_index]}"
              if [[ "$__scan_char" == '\\' ]]; then
                (( __scan_index++ ))
              elif (( __class_begin )); then
                if [[ "$__scan_char" == '[' && "\${pattern[__scan_index+1]}" == [:.=] ]]; then
                  __nested_class="\${pattern[__scan_index+1]}"
                elif [[ -n "$__nested_class" && "$__scan_char" == "$__nested_class" && "\${pattern[__scan_index+1]}" == ']' ]]; then
                  (( __scan_index++ ))
                  __nested_class=""
                elif [[ -z "$__nested_class" && "$__scan_char" == ']' ]] && (( __scan_index > __member_begin )); then
                  __syntax_starts+=("$__class_begin")
                  __syntax_ends+=("$__scan_index")
                  __class_begin=0
                elif (( __scan_index == __member_begin )) &&
                     [[ "$__scan_char" == '!' || "$__scan_char" == '^' ]] &&
                     [[ "\${pattern[__scan_index+1]}" != ']' || "\${pattern[__scan_index+2,-1]}" == *']'* ]]; then
                  (( __member_begin++ ))
                fi
              elif [[ "$__scan_char" == '[' ]]; then
                __class_begin=$__scan_index
                __member_begin=$(( __scan_index + 1 ))
              elif [[ "$__scan_char" == '(' ]]; then
                __group_stack+=("$__scan_index")
              elif [[ "$__scan_char" == ')' ]] && (( \${#__group_stack} )); then
                __syntax_starts+=("\${__group_stack[-1]}")
                __syntax_ends+=("$__scan_index")
                __group_stack[-1]=()
              fi
            done
            # Search retained input only where it cannot split fixed syntax.
            local __input_part="$current"
            local __backend_prefix="$pattern" __backend_suffix=""
            local __search_pattern __candidate_prefix
            local -i __search_offset __overlap_start __overlap_end __range_index __syntax_overlap
            local -i __fixed_tilde_end=0
            local __tilde_expression='([+-]|[+-]<->|[[:alnum:]_.-]#)'
            if [[ "$pattern" == '~'* &&
                  "$__tilde_name" == \${~__tilde_expression} ]]; then
              __fixed_tilde_end=$(( \${#__tilde_name} + 1 ))
            fi
            while [[ -n "$__input_part" ]]; do
              __search_pattern="$pattern"
              __search_offset=0
              while [[ "$__search_pattern" == *"$__input_part"* ]]; do
                __candidate_prefix="\${__search_pattern%%"$__input_part"*}"
                __overlap_start=$(( __search_offset + \${#__candidate_prefix} + 1 ))
                __overlap_end=$(( __overlap_start + \${#__input_part} - 1 ))
                __syntax_overlap=0
                # Leading home/directory-stack/named-directory syntax belongs
                # to the fixed pattern, even when the input overlaps it.
                if (( __fixed_tilde_end && __overlap_start <= __fixed_tilde_end )); then
                  __syntax_overlap=1
                fi
                for (( __range_index=1; __range_index <= \${#__syntax_starts}; __range_index++ )); do
                  if (( __overlap_start <= __syntax_ends[__range_index] &&
                        __overlap_end >= __syntax_starts[__range_index] &&
                        ( __overlap_start > __syntax_starts[__range_index] ||
                          __overlap_end < __syntax_ends[__range_index] ) )); then
                    __syntax_overlap=1
                    break
                  fi
                done
                # Every position in a recognized fixed attribute qualifier
                # is backend syntax, including its closing parenthesis.
                if [[ "$__fixed_qualifier_base" == *[\\*\\?\\]] ]] &&
                   (( __overlap_end > \${#__fixed_qualifier_base} )); then
                  __syntax_overlap=1
                fi
                if (( ! __syntax_overlap )); then
                  if (( __overlap_start == 1 )); then
                    __backend_prefix=""
                  else
                    __backend_prefix="\${pattern[1,__overlap_start-1]}"
                  fi
                  __backend_suffix="\${pattern[__overlap_end+1,-1]}"
                  break 2
                fi
                __search_offset=$__overlap_start
                __search_pattern="\${pattern[__overlap_start+1,-1]}"
              done
              __input_part="\${__input_part[2,-1]}"
            done
            local __quoted_input="\${(q)__input_part}"
            # Pattern matching removes quoting differently from normal
            # completion.  Character classes keep these characters literal.
            if [[ -n "$compstate[pattern_match]" ]]; then
              __quoted_input="\${(b)__input_part}"
              __quoted_input="\${__quoted_input//\\$/[\\$]}"
              __quoted_input="\${__quoted_input//\\\`/[\\\`]}"
            fi
            if [[ "$pattern" == *'$'* || "$pattern" == *'\`'* ||
                  ( "$pattern" == '~'* && "$__tilde_name" == *[^[:alnum:]_.+-]* ) ]] ||
               (( __code_qualifier )); then
              __native_pattern="\${(q)pattern}"
              local __backend_pattern="$__backend_prefix$__backend_suffix"
              local __backend_tilde="\${__backend_pattern#\\~}"
              __backend_tilde="\${__backend_tilde%%/*}"
              local __unsafe_backend_qualifier=0
              __qualifier_pattern="$__backend_pattern"
              while _have_glob_qual "$__qualifier_pattern" complete; do
                __qualifier="\${match[5]#\\#q}"
                __qualifier_pattern="$match[2]"
                if [[ "$__qualifier" != \${~__safe_qualifiers} ]]; then
                  __unsafe_backend_qualifier=1
                fi
              done
              # Retain trusted wildcards and safe attribute qualifiers when
              # all executable syntax belongs to the quoted input.
              if [[ -n "$__input_part" &&
                    "$__backend_pattern" != *'$'* &&
                    "$__backend_pattern" != *'\`'* &&
                    ( "$__backend_pattern" != '~'* ||
                      "$__backend_tilde" != *[^[:alnum:]_.+-]* ) ]] &&
                 (( ! __unsafe_backend_qualifier )); then
                __native_pattern="$__backend_prefix$__quoted_input$__backend_suffix"
              elif [[ "$__backend_pattern" != *'$('* &&
                      "$__backend_pattern" != *'\${'* &&
                      "$__backend_pattern" != *'$['* &&
                      ( "$pattern" != '~'* ||
                        "$__tilde_name" != *[^[:alnum:]_.+-]* ) ]] &&
                   (( ! __unsafe_backend_qualifier )); then
                # Fixed patterns also need literal substitution markers,
                # without quoting their wildcards or safe qualifiers.
                local __dollar='\\$'
                local __backtick='\\\`'
                if [[ -n "$compstate[pattern_match]" ]]; then
                  __dollar='[$]'
                  __backtick='[\`]'
                fi
                # Existing glob classes already protect their markers.
                local -a __backend_parts=()
                local __part __escaped __char __class_kind
                local -i __index __in_class __class_start
                for __part in "$__backend_prefix" "$__backend_suffix"; do
                  __escaped=""
                  __in_class=0
                  __class_kind=""
                  for (( __index=1; __index <= \${#__part}; __index++ )); do
                    __char="\${__part[__index]}"
                    if [[ "$__char" == '\\' ]]; then
                      __escaped+="$__char\${__part[__index+1]}"
                      (( __index++ ))
                      continue
                    elif (( __in_class )); then
                      if [[ "$__char" == '[' && "\${__part[__index+1]}" == [:.=] ]]; then
                        __class_kind="\${__part[__index+1]}"
                      elif [[ -n "$__class_kind" && "$__char" == "$__class_kind" && "\${__part[__index+1]}" == ']' ]]; then
                        __escaped+="$__char]"
                        (( __index++ ))
                        __class_kind=""
                        continue
                      elif [[ -z "$__class_kind" && "$__char" == ']' ]] && (( __index > __class_start )); then
                        __in_class=0
                      elif (( __index == __class_start )) && [[ "$__char" == '!' || "$__char" == '^' ]]; then
                        (( __class_start++ ))
                      fi
                    elif [[ "$__char" == '[' ]]; then
                      __in_class=1
                      __class_start=$(( __index + 1 ))
                    elif [[ "$__char" == '$' ]]; then
                      __char="$__dollar"
                    elif [[ "$__char" == '\`' ]]; then
                      __char="$__backtick"
                    fi
                    __escaped+="$__char"
                  done
                  __backend_parts+=("$__escaped")
                done
                __backend_prefix="\${__backend_parts[1]}"
                __backend_suffix="\${__backend_parts[2]}"
                __native_pattern="$__backend_prefix$__quoted_input$__backend_suffix"
              fi
            else
              # Quote retained metacharacters, including segments made only
              # of them.  Wildcard-only overlap remains backend syntax.
              if [[ "$__input_part" == *[\\\\\\(\\)\\[\\#\\^\\|\\~\\<\\>\\*\\?]* &&
                    "$__input_part" != [\\*\\?]## ]]; then
                __native_pattern="$__backend_prefix$__quoted_input$__backend_suffix"
              fi
            fi
            PREFIX="$__native_pattern"
            # Match simple fixed tilde globs through native -g filters. The
            # pattern matcher otherwise treats the leading ~ as glob syntax,
            # even after _path_files has expanded it for filesystem lookup.
            if (( __fixed_tilde_end )) && [[ -z "$__input_part" &&
                  "$__native_pattern" == "$pattern" && "$pattern" == */* ]]; then
              __initial_directory="\${pattern%/*}/"
              __initial_leaf="\${pattern##*/}"
              if [[ "$__initial_leaf" == *[*?]* &&
                    "$__initial_directory" != *[*?]* &&
                    "$__initial_directory" != *["[]()"]* &&
                    "$__initial_leaf" != *["[]()#~^|<>;&"]* &&
                    "$__initial_leaf" != *'\\'* &&
                    "$__initial_leaf" != *[[:space:]]* &&
                    "$__initial_leaf" != *"'"* && "$__initial_leaf" != *'"'* ]]; then
                __initial_file_pattern="$__initial_leaf"
                PREFIX="$__initial_directory"
                compstate[pattern_match]=""
                __pattern_match_changed=1
              fi
            fi
          fi
        fi

        local ext_pattern=""
        if [[ -n "$extensions" ]]; then
          if [[ "$extensions" == *,* ]]; then
            ext_pattern="*.(\${extensions//,/|})"
          else
            ext_pattern="*.$extensions"
          fi
        fi
        # _wanted/_next_label write to the named explanation parameter.
        # Keep it local for every file directive, including directory/any.
        local -a expl=()
        # Use zsh's native file completion
        case "$type" in
          file|any)
            if [[ "$type" == "file" || -n "$__initial_file_pattern" ]]; then
              # Regular-file suggestions retain symlinked files; initial
              # any globs use a non-directory qualifier instead.
              local file_pattern="\${ext_pattern:-*}(#q-.)"
              if [[ "$__fixed_glob" == "1" ]]; then
                file_pattern="\${ext_pattern:-*}(#q-.e:${fixedGlobFunction}:)"
              fi
              if [[ -n "$__initial_file_pattern" ]]; then
                local __file_qualifier="-."
                [[ "$type" == "any" ]] && __file_qualifier="^-/"
                local -a __initial_file_patterns=()
                if [[ -n "$extensions" ]]; then
                  setopt extended_glob
                  local __initial_extension
                  for __initial_extension in "\${(@s:,:)extensions}"; do
                    __initial_file_patterns+=("(\${__initial_file_pattern}~^*.\${__initial_extension})(#q\${__file_qualifier})")
                  done
                else
                  __initial_file_patterns=("\${__initial_file_pattern}(#q\${__file_qualifier})")
                fi
                file_pattern="\${(j: :)__initial_file_patterns}"
              fi
              local file_pattern_prefix="$PREFIX"
              local -a match mbegin mend
              # Native qualifier copying concatenates flags with the explicit
              # regular-file group.  Keep backend attributes in their own group.
              if [[ -n "$compstate[pattern_match]" && -z "$SUFFIX" ]]; then
                local file_qualifier file_qualifiers=""
                while _have_glob_qual "$file_pattern_prefix" complete; do
                  file_qualifier="\${match[5]#\\#q}"
                  file_pattern_prefix="$match[2]"
                  file_qualifiers="(#q$file_qualifier)$file_qualifiers"
                done
                if [[ -n "$file_qualifiers" ]]; then
                  file_pattern+="$file_qualifiers"
                fi
              fi
              local file_subtree_pattern="**/*(#q/N)"
              local -a file_subtree=() file_recursive_patterns=()
              local -a file_tags=(files directories)
              local file_recursive_pattern file_directory file_prefix file_tag
              if [[ -n "$__initial_file_pattern" || -z "$ext_pattern" ]] &&
                 zstyle -t ":completion:\${curcontext}:" list-dirs-first; then
                file_tags=(directories files)
              fi
              _tags "\${file_tags[@]}"
              while _tags; do
                local file_matched=0
                for file_tag in "\${file_tags[@]}"; do
                  if [[ "$file_tag" == directories ]]; then
                    local file_tag_prefix="$PREFIX"
                    PREFIX="$file_pattern_prefix"
                    while _next_label directories expl directory; do
                      # File qualifiers constrain final results, not the
                      # directories needed to navigate to those results.
                      _path_files -/ "\${expl[@]}" && file_matched=1
                    done
                    PREFIX="$file_tag_prefix"
                  else
                    local file_tag_prefix="$PREFIX"
                    PREFIX="$file_pattern_prefix"
                    while _next_label files expl file; do
                      local -a file_ignore=() file_ignore_args=()
                      # Explicit globs bypass automatic fignore.  Apply it only
                      # when the tag has not supplied its own ignore patterns.
                      if [[ -z "$__initial_file_pattern" && -z "$ext_pattern" && ( "$__fixed_glob" != "1" || "$pattern" == "*" ) && -z "$_comp_no_ignore" && -n "$FIGNORE" ]] && (( \${#_comp_ignore[@]} == 0 )); then
                        file_ignore=("?*\${^fignore[@]}")
                        file_ignore_args=(-F file_ignore)
                      fi
                      if _path_files -g "\${file_pattern}" "\${expl[@]}" "\${file_ignore_args[@]}"; then
                        file_matched=1
                      elif [[ ( -n "$__initial_file_pattern" || -z "$ext_pattern" ) && "$PREFIX$SUFFIX" != */* ]] &&
                           zstyle -a ":completion:\${curcontext}:files" recursive-files file_recursive_patterns; then
                        # Match _files' recursive fallback, retaining the same
                        # file filter and tag-specific ignore options.
                        for file_recursive_pattern in "\${file_recursive_patterns[@]}"; do
                          if [[ "$PWD/" = \${~file_recursive_pattern} ]]; then
                            if (( \${#file_subtree[@]} == 0 )); then
                              file_subtree=(\${~file_subtree_pattern})
                            fi
                            for file_directory in "\${file_subtree[@]}"; do
                              file_prefix="$PREFIX"
                              PREFIX="$file_directory/$PREFIX"
                              _path_files -g "\${file_pattern}" "\${expl[@]}" "\${file_ignore_args[@]}" && file_matched=1
                              PREFIX="$file_prefix"
                            done
                            break
                          fi
                        done
                      fi
                    done
                    PREFIX="$file_tag_prefix"
                  fi
                done
                (( file_matched )) && break
              done
            elif [[ -n "$ext_pattern" || "$__fixed_glob" == "1" ]]; then
              local file_pattern="\${ext_pattern}(#q^-/)"
              if [[ "$__fixed_glob" == "1" ]]; then
                # Put the predicate before ^, which negates later qualifiers.
                file_pattern="\${ext_pattern:-*}(#qe:${fixedGlobFunction}:^-/)"
              fi
              _wanted files expl file _path_files -g "\${file_pattern}"
              _wanted directories expl directory _path_files -/
            else
              _files
            fi
            ;;
          directory)
            if [[ -n "$__initial_file_pattern" ]]; then
              # -/ would add every directory alongside the filtered glob.
              _wanted directories expl directory _path_files -g "\${__initial_file_pattern}(#q-/)"
            else
              _directories
            fi
            ;;
        esac
        # Restore PREFIX and glob_dots to their previous state
        PREFIX="$__saved_prefix"
        IPREFIX="$__saved_iprefix"
        current="$__saved_current"
        __logical_prefix="$__saved_logical_prefix"
        if [[ "$__was_extended_glob" == "1" ]]; then setopt extended_glob; else unsetopt extended_glob; fi
        if (( __pattern_match_changed )); then
          compstate[pattern_match]="$__saved_pattern_match"
        fi
        if [[ "$__was_sh_glob" == "1" ]]; then setopt sh_glob; else unsetopt sh_glob; fi
        if [[ "$__was_sh_word_split" == "1" ]]; then setopt sh_word_split; else unsetopt sh_word_split; fi
        if [[ "$__was_glob_dots" == "1" ]]; then setopt glob_dots; else unsetopt glob_dots; fi
      else
        # Regular literal completion
        if [[ -n "$value" ]]; then
          completions+=("$value")
          descriptions+=("$desc")
        fi
      fi
    fi
  done <<< "$output"

  # Add literal completions with descriptions if we have any
  if (( \${#completions[@]} > 0 )); then
    # Prepare completion with descriptions for _describe
    local -a matches
    local -i i
    local __match
    for (( i=1; i <= \${#completions[@]}; i++ )); do
      # _describe uses backslashes to escape its colon separator.
      __match="\${completions[i]//\\\\/\\\\\\\\}"
      __match="\${__match//:/\\\\:}"
      if [[ -n "\${descriptions[i]}" ]]; then
        matches+=("$__match:\${descriptions[i]}")
      else
        matches+=("$__match")
      fi
    done
    if [[ -n "$QISUFFIX" ]]; then
      # A closing quote already exists; do not append a space inside it.
      _describe 'commands' matches -S ''
    else
      _describe 'commands' matches
    fi
  fi
}

function ${fixedGlobFunction} () {
  local __fixed_candidate="\${REPLY:a}"
  (( \${__fixed_matches[(Ie)$__fixed_candidate]} ))
}

if (( $+functions[compdef] )); then
  compdef ${functionName} ${programName}
fi

# An autoloaded file runs as a function body.  Dispatch its initial request;
# sourcing the file only defines and registers the completion helper.
if [[ $ZSH_EVAL_CONTEXT == *:loadautofunc || $ZSH_EVAL_CONTEXT == *:shfunc ]]; then
  ${functionName} "$@"
fi
    `;
  },
  *encodeSuggestions(suggestions) {
    for (const suggestion of suggestions)
      if (suggestion.kind === "literal") {
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        yield `${encodeLiteral(suggestion.text)}\x00${description}\x00`;
      } else {
        const extensions = encodeExtensions(suggestion.extensions);
        const hidden = suggestion.includeHidden ? "1" : "0";
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        const pattern = encodePattern(suggestion.pattern ?? "");
        yield `__FILE__:${suggestion.type}:${extensions}:${pattern}:${hidden}${encodeFilePrefix(suggestion)}\x00${description}\x00`;
      }
  }
};
var fish = {
  name: "fish",
  generateScript(programName, args = []) {
    validateProgramName2(programName);
    const escapedArgs = args.map((arg) => `'${arg.replace(/'/g, "\\'")}'`).join(" ");
    const functionName = `__${programName}_complete`;
    return `
function ${functionName}
    set -l tokens (commandline -poc)
    set -l current (commandline -ct)

    # commandline -poc decodes previous tokens, but commandline -ct returns
    # the current token as typed.  Decode its quotes and escapes as well.
    # Keep the token as typed if decoding fails or yields a newline or tab,
    # which completion output cannot carry.
    set -l __raw_current "$current"
    set -l __decoded (string unescape -- "$current")
    or begin
        # string unescape rejects an unfinished trailing backslash.  fish
        # keeps it literally inside single quotes, which also keep a " as
        # is, and otherwise waits for the character it escapes.
        set -l __prefix (string replace -r '\\\\\\\\$' '' -- "$current")
        set -l __probe (string unescape -- "$__prefix\\"")
        set -l __plain (string unescape -- "$__prefix")
        if test "$__probe" = "$__plain\\""
            set __decoded (string unescape -- "$current\\\\")
        else
            set __decoded (string unescape -- "$__prefix")
        end
    end
    and test (count $__decoded) -eq 1
    and not string match -qr '\\t' -- "$__decoded"
    and set current "$__decoded"

    # Extract previous arguments (skip the command name)
    set -l prev
    set -l count (count $tokens)
    if test $count -gt 1
        set prev $tokens[2..$count]
    end

    # Call completion command and capture output
${escapedArgs ? `    set -l output (${programName} ${escapedArgs} $prev $current 2>/dev/null)
` : `    set -l output (${programName} $prev $current 2>/dev/null)
`}
    # Process each line of output
    for line in $output
        set -l literal 0
        if string match -q '__LITERAL__:*' -- $line
            set line (string sub -s 13 -- $line)
            set literal 1
        end
        if test $literal -eq 0; and string match -q '__FILE__:*' -- $line
            # Parse file completion directive: __FILE__:type:extensions:pattern:hidden
            set -l directive (string split \\t -- $line)[1]
            set -l parts (string split ':' -- $directive)
            set -l type $parts[2]
            set -l extensions $parts[3]
            set -l pattern (string replace -a '%25' '%' -- (string replace -a '%3A' ':' -- $parts[4]))
            set -l hidden $parts[5]
            set -l insertion_prefix ""
            if test (count $parts) -ge 6
                set insertion_prefix (string replace -a '%25' '%' -- (string replace -a '%3A' ':' -- $parts[6]))
            end
            set -l saved_current "$current"
            set -l saved_raw_current "$__raw_current"
            set -l prefix_length (string length -- "$insertion_prefix")
            if test $prefix_length -gt 0
                and test (string sub -l $prefix_length -- "$pattern") = "$insertion_prefix"
                and test (string sub -l $prefix_length -- "$current") = "$insertion_prefix"
                set -l start (math $prefix_length + 1)
                set pattern (string sub -s $start -- "$pattern")
                set current (string sub -s $start -- "$current")
                # Keep the raw word aligned so an unquoted key is not mistaken
                # for quoting when comparing it with the decoded value.
                if test (string sub -l $prefix_length -- "$__raw_current") = "$insertion_prefix"
                    set __raw_current (string sub -s $start -- "$__raw_current")
                end
            else
                set insertion_prefix ""
            end

            # path() echoes the current word as its pattern.  When that word
            # was quoted or escaped, treat the echo as the typed word rather
            # than as a pattern from the program.
            if test "$current" != "$__raw_current"; and test "$pattern" = "$current"
                set pattern ""
            end

            # When a pattern is specified, use it as the glob base instead
            # of the current word.  If the user has already typed beyond the
            # pattern (e.g., pattern="src/" and current="src/ma"), keep the
            # current word for incremental narrowing.
            set -l glob_base $current
            set -l __tilde_prefix ""
            set -l __from_pattern 0
            if test -n "$pattern"
                # Normalize leading ./ so that ./src/ma matches pattern src/
                set -l __norm_current (string replace -r '^\\./' '' -- "$current")
                set -l __norm_pattern (string replace -r '^\\./' '' -- "$pattern")
                # For wildcard patterns, compare only the directory prefix.
                # Use a regex: fish wildcards have no character classes.
                # Only the basename can hold wildcards; a ? or * in a
                # directory name such as What?/ is literal.
                set -l __compare_pattern "$__norm_pattern"
                if string match -qr '[*?][^/]*$' -- "$__compare_pattern"
                    set __compare_pattern (string replace -r '[^/]*$' '' -- "$__compare_pattern")
                end
                set -l __cp_len (string length -- "$__compare_pattern")
                set -l __nc_len (string length -- "$__norm_current")
                if begin; test -n "$__compare_pattern"; or test -n "$__norm_current"; end
                    and test $__nc_len -ge $__cp_len
                    and test (string sub -l $__cp_len -- "$__norm_current") = "$__compare_pattern"
                    and test "$current" != "$pattern"
                    set glob_base $current
                else
                    set glob_base $pattern
                    set __from_pattern 1
                end
            end

            # Expand tilde prefix for globbing \u2014 fish does not expand ~
            # inside variable substitutions, so replace it with $HOME.  Like
            # fish itself, keep a quoted or escaped tilde in the word literal.
            if test $__from_pattern -eq 1; or string match -q '~*' -- "$__raw_current"
                if string match -q '~/*' -- "$glob_base"
                    set __tilde_prefix "~"
                    set glob_base (string replace -r '^~' "$HOME" -- "$glob_base")
                else if string match -q '~' -- "$glob_base"
                    set __tilde_prefix "~"
                    set glob_base "$HOME/"
                end
            end

            # If the glob base is a directory without a trailing slash,
            # append one so that the glob enumerates its contents
            if test -d "$glob_base"; and not string match -q '*/' -- "$glob_base"
                set glob_base "$glob_base/"
            end

            # Pre-expand file candidates.  When the glob base came from
            # the program's pattern and its basename contains * or ?, use
            # it as the complete glob expression.  Otherwise append * as a
            # prefix, so a literal ? in a directory name such as What?/
            # still lists that directory.  A pattern equal to the current
            # word is the typed text echoed back (as path() does), so its
            # ? and * are literal characters, not wildcards.
            # Note: [ is NOT treated as a glob because it commonly
            # appears in literal filenames like [draft] or foo[1].txt.
            set -l __has_glob 0
            if test $__from_pattern -eq 1
                and string match -qr '[*?][^/]*$' -- "$glob_base"
                and test "$pattern" != "$current"
                set __has_glob 1
            end
            set -l __candidates
            if test $__has_glob -eq 1
                # Safe glob expansion without eval: split the pattern into
                # a directory prefix and a basename filter, list the
                # directory, then match basenames against a regex built
                # from the filter.  The prefix keeps one empty element for
                # bare patterns so that $__glob_prefix* still expands.
                set -l __glob_prefix ""
                if string match -q '*/*' -- "$glob_base"
                    set __glob_prefix (string replace -r '[^/]*$' '' -- "$glob_base")
                end
                set -l __glob_filter (string replace -r '.*/' '' -- "$glob_base")
                # Translate the filter into an anchored regex: * and ? are
                # wildcards and every other character is literal.  Fish's
                # own wildcards cannot be used here because ? is literal
                # when the qmark-noglob feature is enabled (fish 4 default).
                set -l __glob_regex '^'
                for __ch in (string split '' -- "$__glob_filter")
                    if test "$__ch" = '*'
                        set __glob_regex "$__glob_regex.*"
                    else if test "$__ch" = '?'
                        set __glob_regex "$__glob_regex."
                    else
                        set __glob_regex "$__glob_regex"(string escape --style=regex -- "$__ch")
                    end
                end
                set __glob_regex "$__glob_regex"'$'
                # Match files by the glob filter.  Fish's * does not match
                # dotfiles, so also scan .* when the filter targets them or
                # hidden files are requested.
                set -l __entries $__glob_prefix*
                if test "$hidden" = "1"; or string match -q '.*' -- "$__glob_filter"
                    set -a __entries $__glob_prefix.*
                end
                for __item in $__entries
                    if test -e "$__item"
                        set -l __bn (string replace -r '.*/' '' -- "$__item")
                        if contains -- "$__bn" . ..
                            continue
                        end
                        if string match -qr -- "$__glob_regex" "$__bn"
                            set -a __candidates "$__item"
                        end
                    end
                end
                # For file/any modes, also include directories for navigation.
                # Skip for directory mode so the pattern filter is respected.
                # Directories the filter already matched are not repeated.
                if test "$type" != "directory"
                    set -l __nav_dirs $__glob_prefix*/
                    if test "$hidden" = "1"
                        set -a __nav_dirs $__glob_prefix.*/
                    end
                    for __item in $__nav_dirs
                        set __item (string replace -r '/$' '' -- "$__item")
                        set -l __bn (string replace -r '.*/' '' -- "$__item")
                        if contains -- "$__bn" . ..
                            continue
                        end
                        if test -d "$__item"
                            and not string match -qr -- "$__glob_regex" "$__bn"
                            set -a __candidates "$__item"
                        end
                    end
                end
            else
                set __candidates $glob_base*
            end

            # Generate file completions based on type
            set -l items
            switch $type
                case file
                    # Complete files and directories (directories for navigation)
                    for item in $__candidates
                        if test -d $item
                            set -a items $item/
                        else if test -f $item
                            set -a items $item
                        end
                    end
                    # Fish's * glob does not match dotfiles; add them
                    # explicitly when the basename is empty (i.e., $glob_base
                    # is "" or ends with "/"), because only then are * and
                    # .* complementary.  When a non-empty basename is present
                    # (e.g., "foo"), foo* already covers foo.txt, so foo.*
                    # would just produce duplicates.
                    if test "$hidden" = "1" -a $__has_glob -eq 0
                        if test -z "$glob_base"; or string match -q '*/' -- "$glob_base"
                            for item in $glob_base.*
                                if test -d $item
                                    set -a items $item/
                                else if test -f $item
                                    set -a items $item
                                end
                            end
                        end
                    end
                case directory
                    # Complete directories only
                    for item in $__candidates
                        if test -d $item
                            set -a items $item/
                        end
                    end
                    if test "$hidden" = "1" -a $__has_glob -eq 0
                        if test -z "$glob_base"; or string match -q '*/' -- "$glob_base"
                            for item in $glob_base.*
                                if test -d $item
                                    set -a items $item/
                                end
                            end
                        end
                    end
                case any
                    # Complete both files and directories
                    for item in $__candidates
                        if test -d $item
                            set -a items $item/
                        else if test -f $item
                            set -a items $item
                        end
                    end
                    if test "$hidden" = "1" -a $__has_glob -eq 0
                        if test -z "$glob_base"; or string match -q '*/' -- "$glob_base"
                            for item in $glob_base.*
                                if test -d $item
                                    set -a items $item/
                                else if test -f $item
                                    set -a items $item
                                end
                            end
                        end
                    end
            end

            # Filter by extensions if specified
            if test -n "$extensions" -a "$type" != directory
                set -l filtered
                set -l ext_list (string replace -r '^\\.' '' -- (string split ',' -- $extensions))
                for item in $items
                    # Skip directories, they don't have extensions
                    if string match -q '*/' -- $item
                        set -a filtered $item
                        continue
                    end
                    # Check if file matches any extension
                    for ext in $ext_list
                        if string match -q "*.$ext" -- $item
                            set -a filtered $item
                            break
                        end
                    end
                end
                set items $filtered
            end

            # Filter out hidden files unless requested.
            # Check the basename of glob_base so that patterns like
            # "src/.e" correctly target hidden entries.
            set -l __glob_basename (string replace -r '.*/(.*)' '$1' -- $glob_base)
            if test "$hidden" != "1" -a (string sub -l 1 -- $__glob_basename) != "."
                set -l filtered
                for item in $items
                    set -l basename (basename -- "$item")
                    if not string match -q '.*' -- $basename
                        set -a filtered $item
                    end
                end
                set items $filtered
            end

            # Restore tilde prefix in completion results
            if test -n "$__tilde_prefix"
                set -l restored
                for item in $items
                    set -a restored (string replace "$HOME" "~" -- $item)
                end
                set items $restored
            end

            # Output file completions.  Use printf rather than echo, which
            # would take filenames like -n or -e as its own options.
            for item in $items
                printf '%s\\n' "$insertion_prefix$item"
            end
            set current "$saved_current"
            set __raw_current "$saved_raw_current"
        else
            # Regular literal completion - split by tab
            set -l parts (string split \\t -- $line)
            if test (count $parts) -ge 2
                # value	description format
                echo $parts[1]\\t$parts[2]
            else
                # Just value
                echo $line
            end
        end
    end
end

complete -c ${programName} -f -a '(${functionName})'
    `;
  },
  *encodeSuggestions(suggestions) {
    let i = 0;
    for (const suggestion of suggestions) {
      if (i > 0)
        yield `
`;
      if (suggestion.kind === "literal") {
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        yield `${encodeLiteral(suggestion.text)}	${description}`;
      } else {
        const extensions = encodeExtensions(suggestion.extensions);
        const hidden = suggestion.includeHidden ? "1" : "0";
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        const pattern = encodePattern(suggestion.pattern ?? "");
        yield `__FILE__:${suggestion.type}:${extensions}:${pattern}:${hidden}${encodeFilePrefix(suggestion)}	${description}`;
      }
      i++;
    }
  }
};
function quoteNuString(value) {
  if (!value.includes("'"))
    return `'${value}'`;
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}
var nu = {
  name: "nu",
  generateScript(programName, args = []) {
    validateProgramName2(programName);
    const escapedArgs = args.map(quoteNuString).join(" ");
    const safeName = programName.replace(/[^a-zA-Z0-9]+/g, "-");
    const functionName = `nu-complete-${safeName}`;
    return `
# Helper to split a command line into the arguments Nushell would pass to
# an external command.  Words are found the way Nushell's lexer finds them
# (quotes and raw strings may contain whitespace), then each word is decoded
# like an external argument.  A final empty argument is added when the line
# ends in unquoted whitespace, for the word about to be completed.
def args-split []: string -> list<string> {
  let WHITESPACES = [" " "\\t" "\\n" "\\r"]
  let QUOTES = ["'" '"' "\`"]

  # Decodes one word.  An unterminated word is the one still being typed,
  # so its open quote is taken as if it were closed.
  let decode = {|word: string, unterminated: bool|
    let hashes = if ($word | str starts-with "r#") {
      $word | str replace -r '(?s)^r(#+).*$' '$1'
    } else {
      ""
    }
    if ($hashes | is-not-empty) {
      let prefix = "r" + $hashes + "'"
      let suffix = "'" + $hashes
      let size = ($hashes | str length)
      if ($word | str starts-with $prefix) and ($word | str ends-with $suffix) and (($word | str length) >= ($size * 2 + 3)) {
        $word | str replace $prefix "" | str replace -r ($suffix + '$') ""
      } else if $unterminated and ($word | str starts-with $prefix) {
        $word | str replace $prefix ""
      } else {
        $word
      }
    } else {
      mut result = ""
      mut quote = ""
      mut quoted = ""
      mut escaped = false
      for char in ($word | split chars) {
        if $quote == "" {
          if ($char in $QUOTES) {
            $quote = $char
            $quoted = ""
          } else {
            $result = $result + $char
          }
        } else if $escaped {
          $quoted = $quoted + $char
          $escaped = false
        } else if $char == $quote {
          let body = $quoted
          $result = $result + (if $quote == '"' {
            try { '"' + $body + '"' | from nuon } catch { $body }
          } else {
            $body
          })
          $quote = ""
        } else {
          $quoted = $quoted + $char
          $escaped = ($quote == '"' and $char == '\\')
        }
      }
      if $quote != "" {
        let body = $quoted
        $result = $result + (if not $unterminated {
          $quote + $body
        } else if $quote == '"' {
          try { '"' + $body + '"' | from nuon } catch { $body }
        } else {
          $body
        })
      }
      $result
    }
  }

  mut words: list<string> = []
  mut word = ""
  mut in_word = false
  mut quote = ""
  mut escaped = false
  mut raw_hashes = ""
  mut raw_pending = ""
  mut prev = ""
  mut trailing_space = false

  for char in ($in | split chars) {
    $trailing_space = false
    if $quote == "#" and $char != "#" and $char != "'" {
      # Not a raw string after all; lex this character normally
      $quote = ""
    }
    if $quote == "r" {
      # Inside a raw string, which ends at ' followed by the same number of #
      if ($raw_pending | is-not-empty) and $char == "#" {
        $raw_pending = $raw_pending + $char
      } else if $char == "'" {
        $raw_pending = $char
      } else {
        $raw_pending = ""
      }
      if $raw_pending == ("'" + $raw_hashes) {
        $quote = ""
        $raw_pending = ""
      }
      $word = $word + $char
    } else if $quote == "#" {
      # Between r# and the opening ' of a raw string
      $word = $word + $char
      if $char == "#" {
        $raw_hashes = $raw_hashes + $char
      } else {
        $quote = "r"
      }
    } else if $quote != "" {
      $word = $word + $char
      if $escaped {
        $escaped = false
      } else if $char == $quote {
        $quote = ""
      } else {
        $escaped = ($quote == '"' and $char == '\\')
      }
    } else if ($char in $WHITESPACES) {
      if $in_word {
        $words = $words | append (do $decode $word false)
        $word = ""
        $in_word = false
      }
      $trailing_space = true
    } else {
      if ($char in $QUOTES) {
        $quote = $char
      } else if $char == "#" and $prev == "r" {
        $quote = "#"
        $raw_hashes = "#"
      }
      $word = $word + $char
      $in_word = true
    }
    $prev = $char
  }
  if $in_word {
    $words = $words | append (do $decode $word ($quote != ""))
  } else if $trailing_space {
    $words = $words | append ""
  }
  $words
}

# Helper to tell whether Nushell would not read a value back verbatim as a
# single argument.  A leading ! is included because the line editor expands
# history (e.g., !!) there.  With --allow-expansion, a leading tilde and n-dot
# path segments (e.g., ...) are allowed to expand.
def needs-quote [--allow-expansion]: string -> bool {
  let value = $in
  let special = ["'" '"' '\`' "#" "(" ")" "[" "]" "{" "}" "|" ";" "&" "$" "*" "?" "<" ">"]
  (
    ($value =~ '\\s')
    or ($special | any {|c| $value | str contains $c })
    or ($value =~ '^(\\+\\+|[-+*/])?=$')
    or ($value | str starts-with '!')
    or ((not $allow_expansion) and (
      ($value | str starts-with '~')
      or ($value | split row -r '[/\\\\]' | any {|s| $s =~ '^\\.{3,}$' })
    ))
  )
}

# Helper to quote a value so that Nushell reads it back verbatim as a
# single argument.  The line editor expands history at a ! that follows
# whitespace even inside quotes, so such a ! is put between two quoted parts,
# right after a quote, where it is left alone.
def quote-arg []: string -> string {
  let value = $in
  if ($value | is-empty) or not ($value | needs-quote) {
    $value
  } else if ($value | str contains "'") {
    '"' + ($value | str replace -a '\\' '\\\\' | str replace -a '"' '\\"' | str replace -ar '(\\s)!' '\${1}"!"') + '"'
  } else {
    "'" + ($value | str replace -ar '(\\s)!' "\${1}'!'") + "'"
  }
}

# Completion command that calls back to the CLI
export def "${functionName}" [context: string] {
  # Split context into the arguments Nushell would pass, including an empty
  # one for a new word when the context ends in unquoted whitespace
  let tokens = $context | args-split

  # Remove the command name (first token) to get arguments
  let args = if ($tokens | length) > 1 {
    $tokens | skip 1
  } else {
    []
  }

  # Ensure at least one argument (empty string) to get completions not script
  let final_args = if ($args | is-empty) {
    ['']
  } else {
    $args
  }

  let output = try {
${escapedArgs ? `    ^${programName} ${escapedArgs} ...$final_args | complete | get stdout
` : `    ^${programName} ...$final_args | complete | get stdout
`}  } catch {
    ""
  }

  # Process each line of output
  $output | lines | each {|raw_line|
    let literal = ($raw_line | str starts-with '__LITERAL__:')
    let line = if $literal { $raw_line | str substring 12.. } else { $raw_line }
    if (not $literal) and ($line | str starts-with '__FILE__:') {
      # Parse file completion directive: __FILE__:type:extensions:pattern:hidden
      let directive = ($line | split row "	" | first)
      let parts = ($directive | split row ':')
      let type = ($parts | get 1)
      let extensions = ($parts | get 2)
      let pattern = ($parts | get 3 | str replace -a '%3A' ':' | str replace -a '%25' '%')
      let hidden = ($parts | get 4) == '1'

      let insertion_prefix = if ($parts | length) > 5 {
        $parts | get 5 | str replace -a '%3A' ':' | str replace -a '%25' '%'
      } else { "" }

      # Extract prefix from the last argument if it exists
      let prefix = if ($final_args | length) > 0 {
        $final_args | last
      } else {
        ""
      }

      let insertion_prefix = if ($insertion_prefix | is-not-empty) and ($pattern | str starts-with $insertion_prefix) and ($prefix | str starts-with $insertion_prefix) { $insertion_prefix } else { "" }
      let prefix_length = ($insertion_prefix | str length)
      let pattern = if $prefix_length > 0 { $pattern | str substring $prefix_length.. } else { $pattern }
      let prefix = if $prefix_length > 0 { $prefix | str substring $prefix_length.. } else { $prefix }

      # When a pattern is specified, use it as the glob base instead of
      # the user-typed prefix.  If the user has already typed beyond the
      # pattern (e.g., pattern="src/" and prefix="src/ma"), keep the
      # prefix for incremental narrowing.  Normalize path separators
      # before comparing so that Windows backslashes match forward slashes
      # in the transported pattern.
      let is_win = (($nu.os-info.name | str downcase) == "windows")
      let glob_base = if ($pattern | is-not-empty) {
        # Normalize separators and leading ./; downcase only on Windows
        # where filesystems are typically case-insensitive
        let norm_prefix_raw = ($prefix | str replace -a '\\' '/' | str replace -r '^\\./' '')
        let norm_pattern_raw = ($pattern | str replace -a '\\' '/' | str replace -r '^\\./' '')
        let norm_prefix = (if $is_win { $norm_prefix_raw | str downcase } else { $norm_prefix_raw })
        let norm_pattern = (if $is_win { $norm_pattern_raw | str downcase } else { $norm_pattern_raw })
        # For wildcard patterns, compare only the directory prefix
        let compare_pattern = if ($norm_pattern =~ '[*?]') {
          let before_wild = ($norm_pattern | str replace -r '[*?].*' '')
          if ($before_wild =~ '/') { $before_wild | str replace -r '/[^/]*$' '/' } else { "" }
        } else {
          $norm_pattern
        }
        if (($compare_pattern | is-not-empty) or ($norm_prefix | is-not-empty)) and ($norm_prefix | str starts-with $compare_pattern) and (($norm_prefix | str length) >= ($compare_pattern | str length)) and ($prefix != $pattern) {
          $prefix
        } else {
          $pattern
        }
      } else {
        $prefix
      }

      # Intersect fixed glob matches with the narrowed prefix candidates.
      # Directory-only suggestions retain their existing navigation behavior.
      let narrow_fixed_glob = ($type != "directory") and ($pattern =~ '[*?]') and ($prefix != $pattern) and ($glob_base == $prefix)
      let fixed_matches = if $narrow_fixed_glob {
        try {
          let fixed_pattern = ($pattern | into glob)
          let include_hidden = $hidden or ($prefix | path basename | str starts-with '.')
          let matches = if $include_hidden { ls -a --directory $fixed_pattern } else { ls --directory $fixed_pattern }
          $matches | each {|item|
            let name = ($env.PWD | path join $item.name | path expand --no-symlink)
            if $is_win { $name | str downcase } else { $name }
          }
        } catch { [] }
      } else { [] }

      # If the glob base is a directory without a trailing slash (e.g., "src"),
      # append one so that ls enumerates its contents instead of matching
      # siblings like "src-old".  path expand follows symlinks, so that
      # a symlink to a directory is treated the same way; --no-symlink first
      # resolves .. against the logical $env.PWD as ls does
      let glob_base = if ($glob_base | is-not-empty) and ($glob_base | path expand --no-symlink | path expand | path type) == "dir" and (not ($glob_base | str ends-with "/")) {
        $glob_base + "/"
      } else {
        $glob_base
      }

      # Generate file completions based on type.
      # When the glob base contains wildcard characters, use it as-is;
      # otherwise append * to treat it as a prefix.
      # Note: into glob is required so that ls expands wildcards from a variable.
      # A literal prefix has its brackets wrapped as [[] and []] so that path
      # text like "report[1]" is not parsed as a glob character class; a
      # wildcard pattern is a glob as a whole, so its brackets stay classes.
      let has_glob = ($glob_base =~ '[*?]')
      let ls_pattern = if ($glob_base | is-empty) {
        "."
      } else if $has_glob {
        ($glob_base | into glob)
      } else {
        (($glob_base | str replace -a -r '([\\[\\]])' '[$1]') + "*" | into glob)
      }

      # When using a glob pattern, also compute a directory listing pattern
      # so that file/any modes can include directories for navigation; its
      # directory part is a literal path
      let glob_dir_pattern = if $has_glob {
        let dir_part = ($glob_base | path dirname)
        let dir = if ($dir_part | is-empty) or ($dir_part == $glob_base) { "." } else { $dir_part }
        (($dir | str replace -a -r '([\\[\\]])' '[$1]') + "/*" | into glob)
      } else {
        null
      }

      # List entries matching a pattern, using ls -a to include hidden
      # files when requested.  ls reports every symlink as type "symlink",
      # so classify each one by its target's type instead (path expand
      # follows symlinks); broken or looping symlinks stay "symlink".
      # Join the name to $env.PWD first so that a leading ~ in an entry
      # name is not expanded to a home directory, and resolve .. against
      # the logical $env.PWD (--no-symlink) before following the symlink
      let list_entries = {|pattern|
        (if $hidden { ls -a $pattern } else { ls $pattern }) | each {|item|
          if $item.type == symlink {
            $item | update type ($env.PWD | path join $item.name | path expand --no-symlink | path expand | path type)
          } else {
            $item
          }
        }
      }

      let items = try {
        match $type {
          "file" => {
            if ($extensions | is-empty) {
              (do $list_entries $ls_pattern) | where type == file or type == dir
            } else {
              let ext_list = ($extensions | split row ',' | each {|e| $e | str replace -r '^\\.' '' })
              let all_items = (do $list_entries $ls_pattern)
              let dirs = $all_items | where type == dir
              let files = $all_items | where type == file | where {|f|
                $ext_list | any {|ext|
                  $f.name | path basename | str ends-with ('.' + $ext)
                }
              }
              $dirs | append $files
            }
          },
          "directory" => {
            (do $list_entries $ls_pattern) | where type == dir
          },
          "any" => {
            if ($extensions | is-empty) {
              do $list_entries $ls_pattern
            } else {
              let ext_list = ($extensions | split row ',' | each {|e| $e | str replace -r '^\\.' '' })
              let all_items = (do $list_entries $ls_pattern)
              let dirs = $all_items | where type == dir
              let files = $all_items | where type == file | where {|f|
                $ext_list | any {|ext|
                  $f.name | path basename | str ends-with ('.' + $ext)
                }
              }
              $dirs | append $files
            }
          }
        }
      } catch {
        []
      }

      # When using a glob pattern, also add directories from the base
      # directory for navigation (file/any modes should list directories
      # even when the glob itself does not match directory names)
      let items = if ($glob_dir_pattern != null) and ($type != "directory") {
        let extra_dirs = try {
          (do $list_entries $glob_dir_pattern) | where type == dir
        } catch {
          []
        }
        $items | append $extra_dirs | uniq-by name
      } else {
        $items
      }

      # Filter out hidden files unless requested.
      # Check the basename of glob_base so that patterns like "src/.e"
      # correctly target hidden entries.
      let glob_basename = ($glob_base | path basename)
      let filtered = if $hidden or ($glob_basename | str starts-with '.') {
        $items
      } else {
        $items | where {|item|
          let basename = ($item.name | path basename)
          not ($basename | str starts-with '.')
        }
      }

      let filtered = if $narrow_fixed_glob {
        $filtered | where {|item|
          # Any-mode listings already include directory symlinks; keep them
          # navigable without changing their existing completion rendering.
          let navigation_dir = ($item.type == dir) or ($item.type == symlink and (try { ($item.name | path expand | path type) == "dir" } catch { false }))
          let name = ($env.PWD | path join $item.name | path expand --no-symlink)
          let normalized_name = if $is_win { $name | str downcase } else { $name }
          $navigation_dir or ($normalized_name in $fixed_matches)
        }
      } else { $filtered }

      # Extract directory prefix to preserve in completion text
      let dir_prefix = if ($glob_base | is-empty) {
        ""
      } else if ($glob_base | str ends-with "/") {
        $glob_base
      } else {
        let parsed = ($glob_base | path parse)
        if ($parsed.parent | is-empty) { "" } else if ($parsed.parent | str ends-with "/") { $parsed.parent } else { $parsed.parent + "/" }
      }

      # Format file completions, quoting names that Nushell would not read
      # back as a single argument
      $filtered | each {|item|
        let base = if $item.type == dir {
          ($item.name | path basename) + "/"
        } else {
          $item.name | path basename
        }
        let name = $dir_prefix + $base
        # Nushell expands a leading tilde even in a file name, but not after ./
        let spelled = if ($dir_prefix | is-empty) and ($base | str starts-with '~') {
          './' + $base
        } else {
          $name
        }
        # A tilde or n-dot prefix typed by the user is meant to be expanded
        # by Nushell, which quoting would prevent, so expand such a prefix
        # here when the value has to be quoted
        let literal_ndots = ($base | str replace -r '[/\\\\]$' '') =~ '^\\.{3,}$'
        let expandable = ($dir_prefix | str starts-with '~') or ($dir_prefix | split row -r '[/\\\\]' | any {|s| $s =~ '^\\.{3,}$' })
        let value = if not ($literal_ndots or ($spelled | needs-quote --allow-expansion)) {
          $spelled
        } else if $expandable {
          let expanded_prefix = ($dir_prefix | path expand --no-symlink)
          let expanded_prefix = if ($expanded_prefix | str ends-with "/") { $expanded_prefix } else { $expanded_prefix + "/" }
          ($expanded_prefix + $base) | quote-arg
        } else {
          $spelled | quote-arg
        }
        if ($insertion_prefix | is-not-empty) {
          # A key before the path keeps any tilde or n-dot segment from
          # being expanded, so quote the whole argument as written and show
          # the key in the menu as well.
          let keyed = $insertion_prefix + $name
          let keyed_value = ($keyed | quote-arg)
          if $keyed_value == $keyed {
            { value: $keyed_value }
          } else {
            { value: $keyed_value, display_override: $keyed }
          }
        } else if $value == $name {
          { value: $value }
        } else {
          { value: $value, display_override: $name }
        }
      }
    } else {
      # Regular literal completion - split by tab
      let parts = ($line | split row "	")
      let record = if ($parts | length) >= 2 {
        # value\\tdescription format
        { value: ($parts | get 0), description: ($parts | get 1) }
      } else if ($parts | length) == 1 and ($parts | get 0 | is-not-empty) {
        # Just value
        { value: ($parts | get 0) }
      } else {
        null
      }
      # Quote values that Nushell would not read back as a single argument,
      # while the menu keeps showing them as they are
      if $record == null {
        null
      } else {
        let value = ($record.value | quote-arg)
        if $value == $record.value {
          $record
        } else {
          $record | upsert value $value | insert display_override $record.value
        }
      }
    }
  } | flatten | compact
}

# Custom completer for external commands
# This function will be called by Nushell's completion system
def --env "${functionName}-external" [] {
  let existing_completer = $env.config.completions.external.completer

  $env.config.completions.external.completer = {|spans|
    # Check if this is for our program
    if ($spans.0 == "${programName}") {
      # Build context string from spans
      let context = $spans | str join ' '
      ${functionName} $context
    } else if ($existing_completer != null) {
      # Delegate to existing completer
      do $existing_completer $spans
    } else {
      # No completions
      null
    }
  }

  $env.config.completions.external.enable = true
}

# Auto-setup: register the completer when this module is imported
${functionName}-external
    `;
  },
  *encodeSuggestions(suggestions) {
    let i = 0;
    for (const suggestion of suggestions) {
      if (i > 0)
        yield `
`;
      if (suggestion.kind === "literal") {
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        yield `${encodeLiteral(suggestion.text)}	${description}`;
      } else {
        const extensions = encodeExtensions(suggestion.extensions);
        const hidden = suggestion.includeHidden ? "1" : "0";
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        const pattern = encodePattern(suggestion.pattern ?? "");
        yield `__FILE__:${suggestion.type}:${extensions}:${pattern}:${hidden}${encodeFilePrefix(suggestion)}	${description}`;
      }
      i++;
    }
  }
};
var pwsh = {
  name: "pwsh",
  generateScript(programName, args = []) {
    validateProgramName2(programName);
    const escapedArgs = args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(", ");
    return `
Register-ArgumentCompleter -Native -CommandName ${programName} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    # CompletionText is shell syntax; display labels remain unquoted.
    $quoteArgument = {
        param([string]$value)
        if ($value -cmatch '\\A[a-zA-Z0-9_./:\\\\-]+\\z' -and $value -cnotmatch '\\A-(?!-).*[.:]' -and $value -cnotmatch '\\A-?(?:[0-9]|\\.[0-9])') {
            return $value
        }
        return "'" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($value) + "'"
    }

    # Extract arguments from AST (handles quoted strings properly)
    $arguments = @()
    $commandElements = $commandAst.CommandElements
    $valuePrefix = $wordToComplete
    $quoteType = $null

    # Keep only complete arguments before the cursor.  The current word
    # (including a token ending exactly at the cursor) is appended below.
    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = $commandElements[$i]
        if ($element.Extent.EndOffset -ge $cursorPosition) {
            # wordToComplete has synthesized delimiters and decoded escapes.
            # Only the AST retains the literal value and original quote type.
            # PSReadLine leaves the cursor before a directory's closing quote.
            if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                ($element.Extent.EndOffset -eq $cursorPosition -or
                 ($element.Extent.EndOffset -eq ($cursorPosition + 1) -and
                  $element.StringConstantType -in @('SingleQuoted', 'DoubleQuoted')))) {
                if ($element.StringConstantType -in @('SingleQuoted', 'DoubleQuoted')) {
                    $valuePrefix = $element.Value
                    $quoteType = $element.StringConstantType
                } elseif ($element.Extent.Text -match "^[^=]+=['\\u2018-\\u201b]") {
                    # Joined values are BareWord constants despite their quotes.
                    # Quote the entire replacement to keep it one argument.
                    $valuePrefix = $element.Value
                    $quoteType = 'SingleQuoted'
                } elseif ($element.Extent.Text -match '^[^=]+=["\\u201c-\\u201e]') {
                    $valuePrefix = $element.Value
                    $quoteType = 'DoubleQuoted'
                }
            }
            break
        }

        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $arguments += $element.Value
        } else {
            $arguments += $element.Extent.Text
        }
    }

    # CompletionText replaces the whole token, including its opening quote.
    # Escape literals without evaluating variables or expressions.
    $quoteCompletion = {
        param($text)
        if ($quoteType -eq 'SingleQuoted') {
            "'" + ($text -replace "['\\u2018-\\u201b]", '$0$0') + "'"
        } elseif ($quoteType -eq 'DoubleQuoted') {
            '"' + ($text -replace '[\\x60$"\\u201c-\\u201e]', '\`$0') + '"'
        } else {
            & $quoteArgument $text
        }
    }

    # Build arguments array for completion command
    $completionArgs = @()
${escapedArgs ? `    $completionArgs += @(${escapedArgs})
` : ""}    $completionArgs += $arguments

    # Call completion command and capture output
    try {
        # Quote the prefix separately: array arguments expand a literal tilde
        # when passed to native programs on Unix.
        $output = & ${programName} $completionArgs "$valuePrefix" 2>$null
        if (-not $output) { return }

        # Parse tab-separated output and create CompletionResult objects
        $output -split "\`n" | ForEach-Object {
            $literal = $_.StartsWith('__LITERAL__:', [System.StringComparison]::Ordinal)
            # Quoted values preserve whitespace; only remove the CR of CRLF.
            # Keep the existing trimming for unquoted completions.
            $line = if ($null -ne $quoteType) { $_.TrimEnd([char]13) } else { $_.Trim() }
            if (-not $line) { return }
            if ($literal) { $line = $line.Substring(12) }

            if (-not $literal -and $_.StartsWith('__FILE__:', [System.StringComparison]::Ordinal)) {
                # Parse file completion directive: __FILE__:type:extensions:pattern:hidden
                $directive = ($line -split "\`t")[0]
                $parts = $directive -split ':', 6
                $type = $parts[1]
                $extensions = $parts[2]
                $pattern = $parts[3] -replace '%3A', ':' -replace '%25', '%'
                $hidden = $parts[4] -eq '1'
                $insertionPrefix = if ($parts.Length -gt 5) { $parts[5] -replace '%3A', ':' -replace '%25', '%' } else { '' }
                $matchingWord = $valuePrefix
                if ($insertionPrefix -and $pattern.StartsWith($insertionPrefix, [System.StringComparison]::Ordinal) -and $matchingWord.StartsWith($insertionPrefix, [System.StringComparison]::Ordinal)) {
                    $pattern = $pattern.Substring($insertionPrefix.Length)
                    $matchingWord = $matchingWord.Substring($insertionPrefix.Length)
                } else { $insertionPrefix = '' }

                # When a pattern is specified, use it as the file matching
                # prefix instead of the current word.  If the user has
                # already typed beyond the pattern, keep their input for
                # incremental narrowing.  Normalize path separators before
                # comparing so that Windows backslashes match forward slashes
                # in the transported pattern.
                $normalizedPattern = if ($pattern) { $pattern.Replace('\\', '/') -replace '^\\./','' } else { '' }
                $normalizedWord = if ($matchingWord) { $matchingWord.Replace('\\', '/') -replace '^\\./','' } else { '' }
                $comparison = if ($IsWindows) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
                # For wildcard patterns, compare only the directory prefix
                $comparePattern = $normalizedPattern
                if ($comparePattern -match '[*?]') {
                    $beforeWild = $comparePattern -replace '[*?].*', ''
                    if ($beforeWild.Contains('/')) {
                        $comparePattern = $beforeWild.Substring(0, $beforeWild.LastIndexOf('/') + 1)
                    } else {
                        $comparePattern = ''
                    }
                }
                # A quoted home-pattern directory inserts an absolute path.
                # Compare subsequent input against the same expanded prefix.
                # Detect home syntax before removing ./, which can target a
                # literal local tilde directory rather than the home directory.
                $homePattern = $pattern -and ($pattern -eq '~' -or $pattern.Replace('\\', '/').StartsWith('~/'))
                if ($homePattern) {
                    # Preserve the home root when the pattern is exactly ~.
                    $expandedPattern = if ($comparePattern -eq '~') { $HOME } else { $HOME.Replace('\\', '/').TrimEnd('/') + $comparePattern.Substring(1) }
                    $expandedPattern = [IO.Path]::GetFullPath($expandedPattern).Replace('\\', '/')
                    if ($normalizedWord.StartsWith($expandedPattern, $comparison)) {
                        $comparePattern = $expandedPattern
                    }
                }
                $prefix = if (($comparePattern -or $normalizedWord) -and $normalizedWord -and $normalizedWord.StartsWith($comparePattern, $comparison) -and $normalizedWord.Length -ge $comparePattern.Length -and $matchingWord -ne $pattern) {
                    $matchingWord
                } elseif ($pattern) {
                    $pattern
                } elseif ($matchingWord) {
                    $matchingWord
                } else { '' }

                # Use -Force to include hidden files when requested, or when
                # the prefix basename targets dotfiles (e.g., src/.e)
                $prefixBasename = if ($prefix) { Split-Path -Leaf $prefix } else { '' }
                $forceParam = if ($hidden -or ($prefixBasename -and $prefixBasename.StartsWith('.'))) { @{Force = $true} } else { @{} }

                # A quoted tilde is literal when passed to a native command.
                # Prevent PowerShell's file provider from expanding it to home.
                # Parser-provided home patterns still need home expansion.
                $prefixFromInput = $matchingWord -and $prefix -ceq $matchingWord
                $lookupPrefix = if ($prefixFromInput -and $null -ne $quoteType -and $prefix.StartsWith('~')) { './' + $prefix } else { $prefix }

                # Detect narrowing before directory normalization changes prefix.
                $narrowFixedGlob = $type -ne 'directory' -and $pattern -match '[*?]' -and $prefix -ceq $matchingWord -and $pattern -cne $matchingWord

                # If prefix is a directory without trailing slash, append
                # one so Get-ChildItem lists its contents
                if ($prefix -and (Test-Path -Path $lookupPrefix -PathType Container) -and -not $prefix.EndsWith('/') -and -not $prefix.EndsWith('\\')) {
                    $prefix = $prefix + '/'
                    $lookupPrefix = $lookupPrefix + '/'
                }

                # Build the glob path\u2014when the prefix contains wildcard
                # characters, use it as-is; otherwise append *
                $globPath = if ($lookupPrefix -match '[*?]') { $lookupPrefix } else { "\${lookupPrefix}*" }

                # Keep the original native glob as an independent file filter
                # when the current word narrows its candidates.
                $fixedMatches = @()
                if ($narrowFixedGlob) {
                    # Include hidden parents here; candidate enumeration still
                    # controls which hidden children can be suggested.
                    $fixedMatches = @(Get-Item -Force -Path $pattern -ErrorAction SilentlyContinue |
                        Select-Object -ExpandProperty FullName)
                }

                # Get file system items based on type
                $items = @()
                switch ($type) {
                    'file' {
                        if ($extensions) {
                            # Filter by extensions, always include directories
                            $extList = ($extensions -split ',') -replace '^\\.',''
                            $items = Get-ChildItem @forceParam -Path $globPath -ErrorAction SilentlyContinue |
                                Where-Object {
                                    $fileName = $_.Name
                                    $_.PSIsContainer -or (@($extList | Where-Object {
                                        $fileName.EndsWith('.' + $_, [System.StringComparison]::Ordinal)
                                    }).Count -gt 0)
                                }
                        } else {
                            $items = Get-ChildItem @forceParam -Path $globPath -ErrorAction SilentlyContinue
                        }
                    }
                    'directory' {
                        $items = Get-ChildItem @forceParam -Directory -Path $globPath -ErrorAction SilentlyContinue
                    }
                    'any' {
                        if ($extensions) {
                            # Filter by extensions, always include directories
                            $extList = ($extensions -split ',') -replace '^\\.',''
                            $items = Get-ChildItem @forceParam -Path $globPath -ErrorAction SilentlyContinue |
                                Where-Object {
                                    $fileName = $_.Name
                                    $_.PSIsContainer -or (@($extList | Where-Object {
                                        $fileName.EndsWith('.' + $_, [System.StringComparison]::Ordinal)
                                    }).Count -gt 0)
                                }
                        } else {
                            $items = Get-ChildItem @forceParam -Path $globPath -ErrorAction SilentlyContinue
                        }
                    }
                }

                # For file/any modes with glob patterns, also add directories
                # from the base directory for navigation
                if ($prefix -match '[*?]' -and $type -ne 'directory') {
                    $globDir = Split-Path -Parent $lookupPrefix
                    if (-not $globDir) { $globDir = '.' }
                    $extraDirs = Get-ChildItem @forceParam -Directory -Path "$globDir/*" -ErrorAction SilentlyContinue
                    if ($extraDirs) { $items = @($items) + @($extraDirs) | Select-Object -Unique }
                }

                # Filter hidden files unless requested or the prefix targets dotfiles
                if (-not $hidden -and -not ($prefixBasename -and $prefixBasename.StartsWith('.'))) {
                    $items = $items | Where-Object { -not $_.Attributes.HasFlag([System.IO.FileAttributes]::Hidden) }
                }

                if ($narrowFixedGlob) {
                    $items = $items | Where-Object {
                        if ($_.PSIsContainer) { $true }
                        elseif ($IsWindows) { $fixedMatches -contains $_.FullName }
                        else { $fixedMatches -ccontains $_.FullName }
                    }
                }

                # Extract directory prefix to preserve in completion text
                $dirPrefix = if ($prefix -and ($prefix.Contains('/') -or $prefix.Contains('\\'))) {
                    $slashIdx = [Math]::Max($prefix.LastIndexOf('/'), $prefix.LastIndexOf('\\'))
                    $prefix.Substring(0, $slashIdx + 1)
                } else { '' }

                # Create completion results for files
                $items | ForEach-Object {
                    $completionText = if ($_.PSIsContainer) { "$dirPrefix$($_.Name)/" } else { "$dirPrefix$($_.Name)" }
                    $itemType = if ($_.PSIsContainer) { 'Directory' } else { 'File' }
                    $resultType = if ($_.PSIsContainer) { 'ProviderContainer' } else { 'ParameterValue' }
                    # PSReadLine recognizes the platform separator for containers.
                    # Keep the display label's existing slash convention.
                    $directorySuffix = [IO.Path]::DirectorySeparatorChar
                    $pathText = if ($_.PSIsContainer) { "$dirPrefix$($_.Name)$directorySuffix" } else { $completionText }
                    # Quoting disables native tilde expansion.  A home pattern
                    # supplied by the parser must insert the discovered path.
                    $replacementText = if ($null -ne $quoteType -and -not $prefixFromInput -and $homePattern) {
                        if ($_.PSIsContainer) { $_.FullName + $directorySuffix } else { $_.FullName }
                    } else { $pathText }
                    # Quoting suppresses native tilde expansion.  Keep safe
                    # ~/ paths bare; otherwise use the enumerated full path.
                    # Keyed paths keep the typed spelling, including ~/, and
                    # always take the quoted argument form.
                    $insertionText = if ($null -ne $quoteType) {
                        & $quoteCompletion ($insertionPrefix + $replacementText)
                    } elseif (-not $insertionPrefix -and $completionText -cmatch '\\A~/[a-zA-Z0-9_./:\\\\-]*\\z') {
                        $pathText
                    } else {
                        $argumentText = if (-not $insertionPrefix -and ($completionText.StartsWith('~/') -or $completionText.StartsWith('~\\'))) {
                            if ($_.PSIsContainer) { $_.FullName + $directorySuffix } else { $_.FullName }
                        } else { $pathText }
                        & $quoteArgument ($insertionPrefix + $argumentText)
                    }
                    [System.Management.Automation.CompletionResult]::new(
                        $insertionText,
                        $completionText,
                        $resultType,
                        $itemType
                    )
                }
            } else {
                # Parse literal completion: text\\tlistItemText\\tdescription
                $parts = $line -split "\`t", 3
                $completionText = $parts[0]
                # Empty display text is invalid for CompletionResult.  Keep
                # ignoring empty suggestions without dropping later records.
                if (-not $completionText) { return }
                $listItemText = if ($parts.Length -gt 1 -and $parts[1]) { $parts[1] } else { $completionText }
                $toolTip = if ($parts.Length -gt 2 -and $parts[2]) { $parts[2] } else { $completionText }

                [System.Management.Automation.CompletionResult]::new(
                    (& $quoteCompletion $completionText),
                    $listItemText,
                    'ParameterValue',
                    $toolTip
                )
            }
        }
    } catch {
        # Silently ignore errors
    }
}
    `;
  },
  *encodeSuggestions(suggestions) {
    let i = 0;
    for (const suggestion of suggestions) {
      if (i > 0)
        yield `
`;
      if (suggestion.kind === "literal") {
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        const text = sanitizeForTransport(suggestion.text);
        yield `${encodeLiteral(suggestion.text)}	${text}	${description}`;
      } else {
        const extensions = encodeExtensions(suggestion.extensions);
        const hidden = suggestion.includeHidden ? "1" : "0";
        const description = suggestion.description == null ? "" : sanitizeForTransport(formatMessage(suggestion.description, { colors: false }));
        const pattern = encodePattern(suggestion.pattern ?? "");
        yield `__FILE__:${suggestion.type}:${extensions}:${pattern}:${hidden}${encodeFilePrefix(suggestion)}	[file]	${description}`;
      }
      i++;
    }
  }
};

// node_modules/@optique/core/dist/facade.js
function longestMatchForMetaCommands(...parsers) {
  const options = { [allowDuplicateLeadingCommandNamesKey]: true };
  return longestMatch(...parsers, options);
}
var SuppressedErrorCtor = typeof SuppressedError === "function" ? SuppressedError : (() => {

  class SuppressedErrorPolyfill extends Error {
    error;
    suppressed;
    constructor(error, suppressed, message$1) {
      super(message$1);
      this.name = "SuppressedError";
      this.error = error;
      this.suppressed = suppressed;
    }
  }
  return SuppressedErrorPolyfill;
})();
var effectfulSessionOptionsKey = Symbol("@optique/core/facade/effectfulSessionOptionsKey");
function getEffectfulSessionOption(options) {
  return options[effectfulSessionOptionsKey];
}
function getMetaCommandAliases(names) {
  const [, firstAlias, ...restAliases] = names;
  return firstAlias == null ? undefined : [firstAlias, ...restAliases];
}
function createHelpParser(commandConfig, optionConfig) {
  let helpCommand = null;
  let helpOption = null;
  if (commandConfig) {
    const names = commandConfig.names ?? ["help"];
    const innerParser = multiple(argument(string({ metavar: "COMMAND" }), { description: message`Command name to show help for.` }));
    const aliases = getMetaCommandAliases(names);
    helpCommand = command(names[0], innerParser, {
      description: message`Show help information.`,
      ...aliases != null ? { [hiddenCommandAliasesKey]: aliases } : {},
      hidden: commandConfig.hidden
    });
  }
  if (optionConfig) {
    const names = optionConfig.names ?? ["--help"];
    helpOption = flag(...names, {
      description: message`Show help information.`,
      hidden: optionConfig.hidden
    });
  }
  return {
    helpCommand,
    helpOption
  };
}
function createVersionParser(commandConfig, optionConfig) {
  let versionCommand = null;
  let versionOption = null;
  if (commandConfig) {
    const names = commandConfig.names ?? ["version"];
    const innerParser = object({});
    const aliases = getMetaCommandAliases(names);
    versionCommand = command(names[0], innerParser, {
      description: message`Show version information.`,
      ...aliases != null ? { [hiddenCommandAliasesKey]: aliases } : {},
      hidden: commandConfig.hidden
    });
  }
  if (optionConfig) {
    const names = optionConfig.names ?? ["--version"];
    versionOption = flag(...names, {
      description: message`Show version information.`,
      hidden: optionConfig.hidden
    });
  }
  return {
    versionCommand,
    versionOption
  };
}
var metaResultBrand = Symbol("@optique/core/facade/meta");
function createCompletionParser(programName, availableShells, commandConfig, optionConfig) {
  let completionCommand = null;
  let completionOption = null;
  const shellList = [];
  for (const shell in availableShells) {
    if (shellList.length > 0)
      shellList.push(text(", "));
    shellList.push(value(shell));
  }
  const completionInner = object({
    shell: optional(argument(string({ metavar: "SHELL" }), { description: message`Shell type (${shellList}). Generate completion script when used alone, or provide completions when followed by arguments.` })),
    args: multiple(argument(string({ metavar: "ARG" }), { description: message`Command line arguments for completion suggestions (used by shell integration; you usually don't need to provide this).` }))
  });
  if (commandConfig) {
    const names = commandConfig.names ?? ["completion"];
    const displayName = names[0];
    const completionCommandConfig = {
      brief: message`Generate shell completion script or provide completions.`,
      description: message`Generate shell completion script or provide completions.`,
      footer: message`Examples:${lineBreak()}  Bash:       ${commandLine(`eval "$(${programName} ${displayName} bash)"`)}${lineBreak()}  zsh:        ${commandLine(`eval "$(${programName} ${displayName} zsh)"`)}${lineBreak()}  fish:       ${commandLine(`eval "$(${programName} ${displayName} fish)"`)}${lineBreak()}  PowerShell: ${commandLine(`${programName} ${displayName} pwsh > ${programName}-completion.ps1; . ./${programName}-completion.ps1`)}${lineBreak()}  Nushell:    ${commandLine(`${programName} ${displayName} nu | save ${programName}-completion.nu; source ./${programName}-completion.nu`)}`
    };
    const aliases = getMetaCommandAliases(names);
    completionCommand = command(names[0], completionInner, {
      ...completionCommandConfig,
      ...aliases != null ? { [hiddenCommandAliasesKey]: aliases } : {},
      hidden: commandConfig.hidden
    });
  }
  if (optionConfig) {
    const names = optionConfig.names ?? ["--completion"];
    const completionOptions = [];
    for (const name of names)
      completionOptions.push(option(name, string({ metavar: "SHELL" }), {
        description: message`Generate shell completion script.`,
        hidden: optionConfig.hidden
      }));
    const completionOptionParser = completionOptions.length === 1 ? completionOptions[0] : longestMatch(...completionOptions);
    const argsParser = withDefault(multiple(argument(string({ metavar: "ARG" }), { description: message`Command line arguments for completion suggestions (used by shell integration; you usually don't need to provide this).` })), []);
    completionOption = object({
      shell: completionOptionParser,
      args: argsParser
    });
  }
  return {
    completionCommand,
    completionOption
  };
}
function createMetaOptionDocParser(source) {
  return {
    mode: "sync",
    $valueType: [],
    $stateType: [],
    priority: 200,
    usage: source.usage,
    leadingNames: source.leadingNames,
    acceptingAnyToken: false,
    initialState: null,
    parse: () => ({
      success: false,
      error: message`Documentation-only meta option.`,
      consumed: 0
    }),
    complete: (state) => ({
      success: true,
      value: state
    }),
    suggest: function* () {},
    getDocFragments: (_state, defaultValue) => source.getDocFragments({
      kind: "available",
      state: source.initialState
    }, defaultValue)
  };
}
function combineWithHelpVersion(originalParser, helpParsers, versionParsers, completionParsers, groups) {
  const parsers = [];
  if (helpParsers.helpOption) {
    const helpOptionDocParser = createMetaOptionDocParser(helpParsers.helpOption);
    const wrappedHelp = groups?.helpOptionGroup ? group(groups.helpOptionGroup, helpOptionDocParser) : helpOptionDocParser;
    parsers.push(wrappedHelp);
  }
  if (versionParsers.versionOption) {
    const versionOptionDocParser = createMetaOptionDocParser(versionParsers.versionOption);
    const wrappedVersion = groups?.versionOptionGroup ? group(groups.versionOptionGroup, versionOptionDocParser) : versionOptionDocParser;
    parsers.push(wrappedVersion);
  }
  if (versionParsers.versionCommand) {
    const versionParser = object({
      [metaResultBrand]: constant(true),
      help: constant(false),
      version: constant(true),
      completion: constant(false),
      result: versionParsers.versionCommand,
      helpFlag: helpParsers.helpOption ? optional(helpParsers.helpOption) : constant(false)
    });
    parsers.push(groups?.versionCommandGroup ? group(groups.versionCommandGroup, versionParser) : versionParser);
  }
  if (completionParsers.completionCommand) {
    const completionParser = object({
      [metaResultBrand]: constant(true),
      help: constant(false),
      version: constant(false),
      completion: constant(true),
      completionData: completionParsers.completionCommand,
      helpFlag: helpParsers.helpOption ? optional(helpParsers.helpOption) : constant(false)
    });
    parsers.push(groups?.completionCommandGroup ? group(groups.completionCommandGroup, completionParser) : completionParser);
  }
  if (helpParsers.helpCommand) {
    const helpParser = object({
      [metaResultBrand]: constant(true),
      help: constant(true),
      version: constant(false),
      completion: constant(false),
      commands: helpParsers.helpCommand
    });
    parsers.push(groups?.helpCommandGroup ? group(groups.helpCommandGroup, helpParser) : helpParser);
  }
  parsers.push(object({
    [metaResultBrand]: constant(true),
    help: constant(false),
    version: constant(false),
    completion: constant(false),
    result: originalParser
  }));
  const mainParserIndex = parsers.length - 1;
  if (parsers.length === 1)
    return parsers[0];
  let combined = longestMatchForMetaCommands(...parsers);
  const topUsage = combined.usage[0];
  if (topUsage?.type === "exclusive" && mainParserIndex > 0) {
    const terms = [...topUsage.terms];
    const [mainTerm] = terms.splice(mainParserIndex, 1);
    const lenientCount = (helpParsers.helpOption ? 1 : 0) + (versionParsers.versionOption ? 1 : 0);
    terms.splice(lenientCount, 0, mainTerm);
    combined = {
      ...combined,
      usage: [{
        ...topUsage,
        terms
      }]
    };
  }
  return combined;
}
function classifyOptionMeta(scanArgs, fullArgs, helpOptionNames, versionOptionNames, completionOptionNames) {
  let lastHelpVersion;
  for (let i = 0;i < scanArgs.length; i++) {
    const arg = scanArgs[i];
    if (helpOptionNames.includes(arg))
      lastHelpVersion = {
        index: i,
        kind: "help"
      };
    else if (versionOptionNames.includes(arg))
      lastHelpVersion = {
        index: i,
        kind: "version"
      };
    const equalsMatch = completionOptionNames.find((name) => arg.startsWith(name + "="));
    if (equalsMatch != null)
      return {
        lastHelpVersion,
        completion: {
          index: i,
          shell: arg.slice(equalsMatch.length + 1),
          args: fullArgs.slice(i + 1)
        }
      };
    if (completionOptionNames.includes(arg)) {
      const shell = scanArgs[i + 1] ?? "";
      return {
        lastHelpVersion,
        completion: {
          index: i,
          shell,
          args: shell === "" ? [] : fullArgs.slice(i + 2)
        }
      };
    }
  }
  return { lastHelpVersion };
}
function getHelpCommandContext(commandPath, args, helpIndex) {
  const commands = [...commandPath];
  for (let i = 0;i < helpIndex; i++) {
    const arg = args[i];
    if (!arg.startsWith("-"))
      commands.push(arg);
  }
  return commands;
}
function classifyParseFailure(failure, helpOptionNames, helpCommandNames, versionOptionNames, versionCommandNames, completionOptionNames, completionCommandNames) {
  if (failure.remainingArgs.length < 1)
    return {
      type: "error",
      error: failure.error,
      commandPath: failure.commandPath
    };
  const hasConsumedPrefix = failure.consumedCount > 0;
  const firstArg = failure.remainingArgs[0];
  if (!hasConsumedPrefix && completionCommandNames.includes(firstArg)) {
    const secondArg = failure.remainingArgs[1];
    if (helpOptionNames.includes(secondArg))
      return {
        type: "help",
        commands: [firstArg]
      };
    return {
      type: "completion",
      source: "command",
      shell: secondArg ?? "",
      args: failure.remainingArgs.slice(2)
    };
  }
  const optionArgs = failure.optionsTerminated ? [] : (() => {
    const terminatorIndex = failure.remainingArgs.indexOf("--");
    return terminatorIndex >= 0 ? failure.remainingArgs.slice(0, terminatorIndex) : failure.remainingArgs;
  })();
  const { lastHelpVersion, completion } = classifyOptionMeta(optionArgs, failure.remainingArgs, helpOptionNames, versionOptionNames, completionOptionNames);
  if (!hasConsumedPrefix && versionCommandNames.includes(firstArg)) {
    const secondArg = failure.remainingArgs[1];
    if (helpOptionNames.includes(secondArg))
      return {
        type: "help",
        commands: [firstArg]
      };
    const isCompletionImmediatelyAfter = completion?.index === 1;
    if (secondArg == null || isCompletionImmediatelyAfter || lastHelpVersion?.index === 1 && lastHelpVersion.kind === "version")
      return { type: "version" };
    return {
      type: "error",
      error: failure.error,
      commandPath: failure.commandPath
    };
  }
  let commandAction;
  if (!hasConsumedPrefix && helpCommandNames.includes(firstArg))
    commandAction = {
      index: 0,
      kind: "help"
    };
  const winner = lastHelpVersion == null ? commandAction : commandAction == null || lastHelpVersion.index >= commandAction.index ? lastHelpVersion : commandAction;
  if (winner?.kind === "help") {
    if (winner === commandAction)
      return {
        type: "help",
        commands: failure.remainingArgs.slice(1)
      };
    return {
      type: "help",
      commands: getHelpCommandContext(failure.commandPath, failure.remainingArgs, winner.index),
      preferUserCommandDocs: failure.commandPath.length > 0
    };
  }
  if (winner?.kind === "version")
    return { type: "version" };
  if (completion != null)
    return {
      type: "completion",
      source: "option",
      shell: completion.shell,
      commandPath: failure.commandPath,
      args: completion.args
    };
  return {
    type: "error",
    error: failure.error,
    commandPath: failure.commandPath
  };
}
function handleCompletion(completionArgs, programName, parser, completionParser, stdout, stderr, onCompletion, onError, availableShells, colors, maxWidth, termWidth, completionCommandDisplayName, completionOptionDisplayName, isOptionMode, sectionOrder, showUsage, rootOptionSuggestions = [], messageFormatter, theme, automaticWidth = false) {
  const errorOptions = (format) => automaticWidth ? withAutomaticWidth(format, (width) => {
    maxWidth = width;
  }) : format;
  const shellName = completionArgs[0] || "";
  const args = completionArgs.slice(1);
  const callOnError = (code, error) => onError(code, error);
  const callOnCompletion = (code) => onCompletion(code);
  if (!shellName) {
    const error = message`Missing shell name for completion.`;
    const writeError = () => stderr(renderErrorMessage(error, errorOptions({
      messageFormatter,
      theme,
      colors,
      quotes: !colors,
      maxWidth
    })) + `
`);
    if (!automaticWidth)
      writeError();
    let wroteError = !automaticWidth;
    const completionDocOptions = (format) => automaticWidth ? withAutomaticWidth(format, (width) => {
      maxWidth = width;
      writeError();
      wroteError = true;
    }) : format;
    if (completionParser) {
      const displayName = isOptionMode ? completionOptionDisplayName ?? "--completion" : completionCommandDisplayName ?? "completion";
      const doc = getDocPage(completionParser, [displayName]);
      if (doc)
        stderr(formatDocPage(programName, doc, completionDocOptions({
          messageFormatter,
          theme,
          colors,
          maxWidth,
          termWidth,
          sectionOrder,
          showUsage
        })));
    }
    if (!wroteError)
      writeError();
    return dispatchByMode(parser.mode, () => {
      const result = callOnError(1, error);
      if (result instanceof Promise)
        throw new RunParserError("Synchronous parser returned async result.");
      return result;
    }, async () => callOnError(1, error));
  }
  const shell = availableShells[shellName];
  if (!shell) {
    const available = [];
    for (const name in availableShells) {
      if (available.length > 0)
        available.push(text(", "));
      available.push(value(name));
    }
    const error = message`Unsupported shell ${shellName}. Available shells: ${available}.`;
    stderr(renderErrorMessage(error, errorOptions({
      messageFormatter,
      theme,
      colors,
      quotes: !colors,
      maxWidth
    })));
    return dispatchByMode(parser.mode, () => {
      const result = callOnError(1, error);
      if (result instanceof Promise)
        throw new RunParserError("Synchronous parser returned async result.");
      return result;
    }, async () => callOnError(1, error));
  }
  if (args.length === 0) {
    const completionArg = isOptionMode ? completionOptionDisplayName ?? "--completion" : completionCommandDisplayName ?? "completion";
    const script = shell.generateScript(programName, [completionArg, shellName]);
    stdout(script);
    return dispatchByMode(parser.mode, () => {
      const result = callOnCompletion(0);
      if (result instanceof Promise)
        throw new RunParserError("Synchronous parser returned async result.");
      return result;
    }, async () => callOnCompletion(0));
  }
  return dispatchByMode(parser.mode, () => {
    const syncParser = parser;
    const completionSuggestions = getSyncCompletionSuggestions(syncParser, args, rootOptionSuggestions);
    const suggestions = withRootOptionSuggestions(completionSuggestions.suggestions, args, rootOptionSuggestions, completionSuggestions.argumentContext);
    for (const chunk of shell.encodeSuggestions(suggestions))
      stdout(chunk);
    const result = callOnCompletion(0);
    if (result instanceof Promise)
      throw new RunParserError("Synchronous parser returned async result.");
    return result;
  }, async () => {
    const asyncParser = parser;
    const completionSuggestions = await getAsyncCompletionSuggestions(asyncParser, args, rootOptionSuggestions);
    for (const chunk of shell.encodeSuggestions(withRootOptionSuggestions(completionSuggestions.suggestions, args, rootOptionSuggestions, completionSuggestions.argumentContext)))
      stdout(chunk);
    return callOnCompletion(0);
  });
}
function withRootOptionSuggestions(suggestions, args, extraSuggestions, argumentContext) {
  if (extraSuggestions.length === 0)
    return suggestions;
  const prefix = args.at(-1) ?? "";
  if (argumentContext.optionsTerminated)
    return suggestions;
  if (argumentContext.completingOptionValue)
    return suggestions;
  if (argumentContext.completedRootOption)
    return suggestions;
  if (!(prefix === "" || prefix.startsWith("--") || prefix.startsWith("-") || prefix.startsWith("/") || prefix.startsWith("+")))
    return suggestions;
  const seen = new Set(suggestions.flatMap((suggestion) => suggestion.kind === "literal" ? [suggestion.text] : []));
  const combined = [...suggestions];
  for (const suggestion of extraSuggestions) {
    if (prefix === "-" && suggestion.text.startsWith("--"))
      continue;
    if (prefix !== "" && !suggestion.text.startsWith(prefix))
      continue;
    if (seen.has(suggestion.text))
      continue;
    combined.push(suggestion);
    seen.add(suggestion.text);
  }
  return combined;
}
function getSyncCompletionSuggestions(parser, args, rootOptionSuggestions) {
  const prefix = args.at(-1) ?? "";
  let context = createCompletionArgumentParserContext(parser, args.slice(0, -1));
  while (context.buffer.length > 0) {
    const result = parser.parse(context);
    if (result instanceof Promise)
      throw new RunParserError("Synchronous parser returned async result.");
    if (!result.success) {
      const argumentContext = getFailedCompletionArgumentContext(result, context, parser, rootOptionSuggestions);
      return {
        suggestions: Array.from(parser.suggest(withCompletionSuggestRuntime(parser, context), prefix)),
        argumentContext
      };
    }
    const previousBuffer = context.buffer;
    context = result.next;
    if (isCompletionBufferUnchanged(previousBuffer, context.buffer))
      return {
        suggestions: [],
        argumentContext: getCompletedCompletionArgumentContext(context)
      };
  }
  return {
    suggestions: Array.from(parser.suggest(withCompletionSuggestRuntime(parser, context), prefix)),
    argumentContext: getCompletedCompletionArgumentContext(context)
  };
}
async function getAsyncCompletionSuggestions(parser, args, rootOptionSuggestions) {
  const prefix = args.at(-1) ?? "";
  let context = createCompletionArgumentParserContext(parser, args.slice(0, -1));
  while (context.buffer.length > 0) {
    const result = await parser.parse(context);
    if (!result.success) {
      const argumentContext = getFailedCompletionArgumentContext(result, context, parser, rootOptionSuggestions);
      const suggestions$1 = [];
      const suggestContext$1 = await withCompletionSuggestRuntimeAsync(parser, context);
      for await (const suggestion of parser.suggest(suggestContext$1, prefix))
        suggestions$1.push(suggestion);
      return {
        suggestions: suggestions$1,
        argumentContext
      };
    }
    const previousBuffer = context.buffer;
    context = result.next;
    if (isCompletionBufferUnchanged(previousBuffer, context.buffer))
      return {
        suggestions: [],
        argumentContext: getCompletedCompletionArgumentContext(context)
      };
  }
  const suggestions = [];
  const suggestContext = await withCompletionSuggestRuntimeAsync(parser, context);
  for await (const suggestion of parser.suggest(suggestContext, prefix))
    suggestions.push(suggestion);
  return {
    suggestions,
    argumentContext: getCompletedCompletionArgumentContext(context)
  };
}
function getCompletedCompletionArgumentContext(context) {
  return {
    completingOptionValue: false,
    completedRootOption: false,
    optionsTerminated: context.optionsTerminated
  };
}
function withCompletionSuggestRuntime(parser, context) {
  const runtime = createDependencyRuntimeContext();
  const nodes = getCompletionSuggestRuntimeNodes(parser, context.state, context.exec?.path ?? []);
  if (nodes.length > 0)
    collectExplicitSourceValues(nodes, runtime);
  return addCompletionSuggestRuntime(context, runtime);
}
async function withCompletionSuggestRuntimeAsync(parser, context) {
  const runtime = createDependencyRuntimeContext();
  const nodes = getCompletionSuggestRuntimeNodes(parser, context.state, context.exec?.path ?? []);
  if (nodes.length > 0)
    await collectExplicitSourceValuesAsync(nodes, runtime);
  return addCompletionSuggestRuntime(context, runtime);
}
function addCompletionSuggestRuntime(context, runtime) {
  return {
    ...context,
    dependencyRegistry: runtime.registry,
    exec: context.exec ? {
      ...context.exec,
      dependencyRuntime: runtime,
      dependencyRegistry: runtime.registry
    } : undefined
  };
}
function getCompletionSuggestRuntimeNodes(parser, state, path) {
  if (typeof parser.getSuggestRuntimeNodes === "function")
    return parser.getSuggestRuntimeNodes(state, path);
  if (parser.dependencyMetadata?.source == null)
    return [];
  return [{
    path,
    parser,
    state
  }];
}
function createCompletionArgumentParserContext(parser, args) {
  return createParserContext({
    buffer: args,
    state: parser.initialState,
    optionsTerminated: false
  }, {
    usage: parser.usage,
    phase: "suggest",
    path: [],
    trace: createInputTrace()
  });
}
function getFailedCompletionArgumentContext(result, context, parser, rootOptionSuggestions) {
  const activeValueOptionNames = collectActiveValueOptionNames(parser.usage, context.exec?.commandPath ?? [], result.consumed > 0, parser.leadingNames);
  const token = context.buffer[0];
  return {
    completingOptionValue: (result.consumed === 0 || result.consumed === 1) && activeValueOptionNames.has(token),
    completedRootOption: result.consumed === 0 && isRootOptionToken(token, rootOptionSuggestions),
    optionsTerminated: context.optionsTerminated
  };
}
function isCompletionBufferUnchanged(before, after) {
  return before.length === after.length && before.every((arg, index) => arg === after[index]);
}
function collectActiveValueOptionNames(usage, commandPath, includeDirectAfterCommandOptions, rootLeadingNames) {
  const optionNames = {
    value: /* @__PURE__ */ new Set,
    flag: /* @__PURE__ */ new Set
  };
  if (commandPath.length === 0) {
    collectRootOptionNames(usage, optionNames, rootLeadingNames);
    return optionNames.value;
  } else
    collectActiveOptionNames(usage, commandPath, optionNames, false, includeDirectAfterCommandOptions);
  const names = new Set(optionNames.value);
  for (const name of optionNames.flag)
    names.delete(name);
  return names;
}
function collectRootOptionNames(usage, names, rootLeadingNames) {
  for (const term of usage)
    collectRootOptionNamesFromTerm(term, names, rootLeadingNames);
}
function collectRootOptionNamesFromTerm(term, names, rootLeadingNames) {
  switch (term.type) {
    case "option":
      for (const name of term.names) {
        if (!rootLeadingNames.has(name))
          continue;
        if (term.metavar != null)
          names.value.add(name);
        else
          names.flag.add(name);
      }
      return;
    case "optional":
    case "multiple":
    case "sequence":
      collectRootOptionNames(term.terms, names, rootLeadingNames);
      return;
    case "exclusive":
      for (const branch of term.terms)
        collectRootOptionNames(branch, names, rootLeadingNames);
      return;
    case "argument":
    case "command":
    case "literal":
    case "passthrough":
    case "ellipsis":
      return;
  }
}
function collectActiveOptionNames(usage, commandPath, names, fromExclusive, includeDirectAfterCommandOptions) {
  if (commandPath.length === 0) {
    collectOptionNamesAtCurrentCommandDepth(usage, names, false);
    return;
  }
  const [commandName, ...rest] = commandPath;
  for (let i = 0;i < usage.length; i++) {
    const term = usage[i];
    if (term.type === "command" && term.name === commandName) {
      const remainingUsage = usage.slice(i + 1);
      if (rest.length === 0)
        collectOptionNamesAtCurrentCommandDepth(remainingUsage, names, !fromExclusive && includeDirectAfterCommandOptions);
      else
        collectActiveOptionNames(remainingUsage, rest, names, fromExclusive, includeDirectAfterCommandOptions);
    } else if (term.type === "exclusive")
      for (const branch of term.terms)
        collectActiveOptionNames(branch, commandPath, names, true, includeDirectAfterCommandOptions);
    else if (term.type === "optional" || term.type === "multiple" || term.type === "sequence")
      collectActiveOptionNames(term.terms, commandPath, names, fromExclusive, includeDirectAfterCommandOptions);
  }
}
function isRootOptionToken(token, rootOptionSuggestions) {
  return token != null && rootOptionSuggestions.some((suggestion) => token === suggestion.text || token.startsWith(`${suggestion.text}=`));
}
function collectOptionNamesAtCurrentCommandDepth(usage, names, afterMatchedCommand) {
  for (const term of usage)
    if (collectOptionNamesAtCurrentCommandDepthFromTerm(term, names, afterMatchedCommand))
      return;
}
function collectOptionNamesAtCurrentCommandDepthFromTerm(term, names, afterMatchedCommand) {
  switch (term.type) {
    case "command":
      return !afterMatchedCommand;
    case "option":
      if (term.metavar != null)
        for (const name of term.names)
          names.value.add(name);
      else
        for (const name of term.names)
          names.flag.add(name);
      return false;
    case "optional":
    case "multiple":
    case "sequence":
      collectOptionNamesAtCurrentCommandDepth(term.terms, names, afterMatchedCommand);
      return false;
    case "exclusive":
      for (const branch of term.terms)
        collectOptionNamesAtCurrentCommandDepth(branch, names, false);
      return false;
    case "argument":
    case "literal":
    case "passthrough":
    case "ellipsis":
      return false;
  }
}
function getRootMetaOptionSuggestions(helpOptionConfig, helpOptionNames, versionOptionConfig, versionOptionNames) {
  const suggestions = [];
  if (helpOptionConfig != null && !isSuggestionHidden(helpOptionConfig.hidden))
    suggestions.push(...helpOptionNames.map((name) => ({
      kind: "literal",
      text: name
    })));
  if (versionOptionConfig != null && !isSuggestionHidden(versionOptionConfig.hidden))
    suggestions.push(...versionOptionNames.map((name) => ({
      kind: "literal",
      text: name
    })));
  return suggestions;
}
function validateVersionValue(value$1) {
  if (typeof value$1 !== "string") {
    const type = Array.isArray(value$1) ? "array" : typeof value$1;
    throw new TypeError(`Expected version value to be a string, but got ${type}.`);
  }
  if (value$1 === "")
    throw new TypeError("Version value must not be empty.");
  if (/[\x00-\x1f\x7f]/.test(value$1))
    throw new TypeError("Version value must not contain control characters.");
  return value$1;
}
function runParser(parserOrProgram, programNameOrArgs, argsOrOptions, optionsParam) {
  const isProgram = typeof programNameOrArgs !== "string";
  let parser;
  let programName;
  let args;
  let options;
  if (isProgram) {
    const program = parserOrProgram;
    parser = program.parser;
    programName = program.metadata.name;
    args = programNameOrArgs;
    options = argsOrOptions ?? {};
    options = {
      ...options,
      brief: options.brief ?? program.metadata.brief,
      description: options.description ?? program.metadata.description,
      examples: options.examples ?? program.metadata.examples,
      author: options.author ?? program.metadata.author,
      bugs: options.bugs ?? program.metadata.bugs,
      footer: options.footer ?? program.metadata.footer
    };
  } else {
    parser = parserOrProgram;
    programName = programNameOrArgs;
    args = argsOrOptions;
    options = optionsParam ?? {};
  }
  validateProgramName(programName);
  const { colors, messageFormatter, theme: requestedTheme, maxWidth: requestedMaxWidth, termWidth, showDefault, showChoices, sectionOrder, showUsage, usageLine, commandList = "recursive", aboveError = "usage", onError = () => {
    throw new RunParserError("Failed to parse command line arguments.");
  }, stderr = console.error, stdout = console.log, brief, description, examples, author, bugs, footer } = options;
  let maxWidth = requestedMaxWidth;
  const automaticWidth = hasAutomaticWidth(options);
  const theme = automaticWidth ? cacheTerminalTheme(requestedTheme) : requestedTheme;
  const formatOptions = (format) => automaticWidth ? withAutomaticWidth(format, (width) => {
    maxWidth = width;
  }) : format;
  const resolveUsageWidth = (usage) => {
    if (automaticWidth && maxWidth != null && maxWidth < minimumUsageWidth(programName, usage, usageLabel(), theme))
      maxWidth = undefined;
  };
  let usagePrefix;
  const usageLabel = () => usagePrefix ??= spaceAfterLabel(renderTerminalTerm({
    type: "label",
    label: "Usage:",
    kind: "usageSummary"
  }, theme, colors));
  const usageLabelWidth = () => measureText(usageLabel()).lastLineWidth;
  const norm = (c) => c === true ? {} : c;
  const helpCommandConfig = norm(options.help?.command);
  const helpOptionConfig = norm(options.help?.option);
  const onHelp = options.help?.onShow ?? (() => ({}));
  const versionCommandConfig = norm(options.version?.command);
  const versionOptionConfig = norm(options.version?.option);
  const versionValue = options.version ? validateVersionValue(options.version.value) : undefined;
  const onVersion = options.version?.onShow ?? (() => ({}));
  const completionCommandConfig = norm(options.completion?.command);
  const completionOptionConfig = norm(options.completion?.option);
  const onCompletion = options.completion?.onShow ?? (() => ({}));
  const onCompletionResult = (code) => onCompletion(code);
  const onErrorResult = (code, error) => onError(code, error);
  if (helpOptionConfig?.names)
    validateOptionNames(helpOptionConfig.names, "Help option");
  if (helpCommandConfig?.names)
    validateCommandNames(helpCommandConfig.names, "Help command");
  if (versionOptionConfig?.names)
    validateOptionNames(versionOptionConfig.names, "Version option");
  if (versionCommandConfig?.names)
    validateCommandNames(versionCommandConfig.names, "Version command");
  if (completionOptionConfig?.names)
    validateOptionNames(completionOptionConfig.names, "Completion option");
  if (completionCommandConfig?.names)
    validateCommandNames(completionCommandConfig.names, "Completion command");
  const helpOptionNames = helpOptionConfig?.names ?? ["--help"];
  const helpCommandNames = helpCommandConfig?.names ?? ["help"];
  const versionOptionNames = versionOptionConfig?.names ?? ["--version"];
  const versionCommandNames = versionCommandConfig?.names ?? ["version"];
  const completionCommandNames = completionCommandConfig?.names ?? ["completion"];
  const completionOptionNames = completionOptionConfig?.names ?? ["--completion"];
  const rootOptionSuggestions = getRootMetaOptionSuggestions(helpOptionConfig, helpOptionNames, versionOptionConfig, versionOptionNames);
  const activeMetaEntries = [];
  if (options.help && helpOptionConfig)
    activeMetaEntries.push([
      "option",
      "help option",
      helpOptionNames
    ]);
  if (options.help && helpCommandConfig)
    activeMetaEntries.push([
      "command",
      "help command",
      helpCommandNames
    ]);
  if (options.version && versionOptionConfig)
    activeMetaEntries.push([
      "option",
      "version option",
      versionOptionNames
    ]);
  if (options.version && versionCommandConfig)
    activeMetaEntries.push([
      "command",
      "version command",
      versionCommandNames
    ]);
  if (options.completion && completionOptionConfig)
    activeMetaEntries.push([
      "option",
      "completion option",
      completionOptionNames,
      true
    ]);
  if (options.completion && completionCommandConfig)
    activeMetaEntries.push([
      "command",
      "completion command",
      completionCommandNames
    ]);
  validateMetaNameCollisions(activeMetaEntries);
  const defaultShells = {
    bash,
    fish,
    nu,
    pwsh,
    zsh
  };
  const availableShells = options.completion?.shells ? {
    ...defaultShells,
    ...options.completion.shells
  } : defaultShells;
  const helpParsers = options.help ? createHelpParser(helpCommandConfig, helpOptionConfig) : {
    helpCommand: null,
    helpOption: null
  };
  const versionParsers = options.version ? createVersionParser(versionCommandConfig, versionOptionConfig) : {
    versionCommand: null,
    versionOption: null
  };
  const completionParsers = options.completion ? createCompletionParser(programName, availableShells, completionCommandConfig, completionOptionConfig) : {
    completionCommand: null,
    completionOption: null
  };
  const augmentedParser = !options.help && !options.version && !options.completion ? parser : combineWithHelpVersion(parser, helpParsers, versionParsers, completionParsers, {
    helpCommandGroup: helpCommandConfig?.group,
    helpOptionGroup: helpOptionConfig?.group,
    versionCommandGroup: versionCommandConfig?.group,
    versionOptionGroup: versionOptionConfig?.group,
    completionCommandGroup: completionCommandConfig?.group,
    completionOptionGroup: completionOptionConfig?.group
  });
  const helpAsCommand = helpCommandConfig != null;
  const versionAsCommand = versionCommandConfig != null;
  const completionAsCommand = completionCommandConfig != null;
  const helpAsOption = helpOptionConfig != null;
  const versionAsOption = versionOptionConfig != null;
  const completionAsOption = completionOptionConfig != null;
  let cachedRootHelpGeneratorParser;
  const getRootHelpGeneratorParser = () => {
    if (cachedRootHelpGeneratorParser != null)
      return cachedRootHelpGeneratorParser;
    const commandParsers = [parser];
    const groupedMeta = {};
    const ungroupedMeta = [];
    const addMeta = (metaParser, groupLabel) => {
      if (groupLabel)
        (groupedMeta[groupLabel] ??= []).push(metaParser);
      else
        ungroupedMeta.push(metaParser);
    };
    if (helpAsCommand && helpParsers.helpCommand)
      addMeta(helpParsers.helpCommand, helpCommandConfig?.group);
    if (versionAsCommand && versionParsers.versionCommand)
      addMeta(versionParsers.versionCommand, versionCommandConfig?.group);
    if (completionAsCommand && completionParsers.completionCommand)
      addMeta(completionParsers.completionCommand, completionCommandConfig?.group);
    commandParsers.push(...ungroupedMeta);
    for (const [label, parsers] of Object.entries(groupedMeta))
      commandParsers.push(group(label, parsers.length === 1 ? parsers[0] : longestMatch(...parsers)));
    const groupedMetaOptions = {};
    const ungroupedMetaOptions = [];
    const addMetaOption = (metaParser, groupLabel) => {
      if (groupLabel)
        (groupedMetaOptions[groupLabel] ??= []).push(metaParser);
      else
        ungroupedMetaOptions.push(metaParser);
    };
    if (helpAsOption && helpParsers.helpOption)
      addMetaOption(helpParsers.helpOption, helpOptionConfig?.group);
    if (versionAsOption && versionParsers.versionOption)
      addMetaOption(versionParsers.versionOption, versionOptionConfig?.group);
    if (completionAsOption && completionParsers.completionOption)
      addMetaOption(completionParsers.completionOption, completionOptionConfig?.group);
    commandParsers.push(...ungroupedMetaOptions);
    for (const [label, parsers] of Object.entries(groupedMetaOptions))
      commandParsers.push(group(label, parsers.length === 1 ? parsers[0] : longestMatch(...parsers)));
    cachedRootHelpGeneratorParser = commandParsers.length === 1 ? commandParsers[0] : longestMatchForMetaCommands(...commandParsers);
    return cachedRootHelpGeneratorParser;
  };
  const handleResult = (classified) => {
    switch (classified.type) {
      case "success":
        return classified.value;
      case "version":
        stdout(versionValue);
        return onVersion(0);
      case "completion":
        return handleCompletion([
          classified.shell,
          ...classified.commandPath ?? [],
          ...classified.args
        ], programName, parser, classified.source === "command" ? completionParsers.completionCommand : completionParsers.completionOption, stdout, stderr, onCompletionResult, onErrorResult, availableShells, colors, maxWidth, termWidth, completionCommandNames[0], completionOptionNames[0], classified.source === "option", sectionOrder, showUsage, rootOptionSuggestions, messageFormatter, theme, automaticWidth);
      case "help": {
        let helpGeneratorParser;
        let docGeneratorParser;
        const requestedCommand = classified.commands[0];
        if (requestedCommand != null && !classified.preferUserCommandDocs && completionCommandNames.includes(requestedCommand) && completionAsCommand && completionParsers.completionCommand) {
          helpGeneratorParser = completionParsers.completionCommand;
          docGeneratorParser = helpGeneratorParser;
        } else if (requestedCommand != null && !classified.preferUserCommandDocs && helpCommandNames.includes(requestedCommand) && helpAsCommand && helpParsers.helpCommand) {
          helpGeneratorParser = helpParsers.helpCommand;
          docGeneratorParser = helpGeneratorParser;
        } else if (requestedCommand != null && !classified.preferUserCommandDocs && versionCommandNames.includes(requestedCommand) && versionAsCommand && versionParsers.versionCommand) {
          helpGeneratorParser = versionParsers.versionCommand;
          docGeneratorParser = helpGeneratorParser;
        } else {
          helpGeneratorParser = getRootHelpGeneratorParser();
          docGeneratorParser = classified.commands.length > 0 ? parser : helpGeneratorParser;
        }
        const reportInvalidHelpCommand = (validationError) => {
          resolveUsageWidth(augmentedParser.usage);
          stderr(`${usageLabel()}${indentLines2(formatUsage(programName, augmentedParser.usage, {
            theme,
            colors,
            maxWidth: maxWidth == null ? undefined : maxWidth - usageLabelWidth(),
            expandCommands: true
          }), usageLabelWidth())}`);
          stderr(renderErrorMessage(validationError, formatOptions({
            messageFormatter,
            theme,
            colors,
            quotes: !colors,
            maxWidth
          })));
          return onError(1, validationError);
        };
        const displayHelp = (doc) => {
          if (doc != null) {
            const isMetaCommandHelp = requestedCommand != null && completionCommandNames.includes(requestedCommand) || requestedCommand != null && helpCommandNames.includes(requestedCommand) || requestedCommand != null && versionCommandNames.includes(requestedCommand);
            const isSubcommandHelp = classified.commands.length > 0;
            const isTopLevel = !isSubcommandHelp;
            const shouldOverride = !isMetaCommandHelp && !isSubcommandHelp;
            const augmentedDoc = maybeCollapseCommandList({
              ...doc,
              brief: shouldOverride ? brief ?? doc.brief : doc.brief,
              description: shouldOverride ? description ?? doc.description : doc.description,
              examples: isTopLevel && !isMetaCommandHelp ? examples ?? doc.examples : undefined,
              author: isTopLevel && !isMetaCommandHelp ? author ?? doc.author : undefined,
              bugs: isTopLevel && !isMetaCommandHelp ? bugs ?? doc.bugs : undefined,
              footer: shouldOverride ? footer ?? doc.footer : doc.footer ?? footer
            }, commandList, isTopLevel);
            const renderedDoc = isTopLevel && usageLine != null ? applyUsageLine(augmentedDoc, usageLine) : augmentedDoc;
            stdout(formatDocPage(programName, renderedDoc, formatOptions({
              messageFormatter,
              theme,
              colors,
              maxWidth,
              termWidth,
              showDefault,
              showChoices,
              sectionOrder,
              showUsage
            })));
            return onHelp(0, renderedDoc);
          }
          throw new RunParserError("Failed to generate help page.");
        };
        if (classified.commands.length > 0) {
          let validationContext = {
            buffer: [...classified.commands],
            optionsTerminated: false,
            state: helpGeneratorParser.initialState,
            usage: helpGeneratorParser.usage
          };
          const processStep = (stepResult) => {
            if (!stepResult.success)
              return stepResult.error;
            if (stepResult.consumed.length < 1)
              return message`Unexpected option or subcommand: ${optionName(validationContext.buffer[0])}.`;
            validationContext = {
              ...validationContext,
              buffer: stepResult.next.buffer,
              optionsTerminated: stepResult.next.optionsTerminated,
              state: stepResult.next.state,
              usage: stepResult.next.usage ?? validationContext.usage
            };
            return validationContext.buffer.length > 0 ? "continue" : null;
          };
          let validationResult = "continue";
          while (validationResult === "continue") {
            const stepResult = helpGeneratorParser.parse(validationContext);
            if (stepResult instanceof Promise) {
              const asyncValidate = async (result) => {
                let res = processStep(result);
                while (res === "continue") {
                  const next = helpGeneratorParser.parse(validationContext);
                  const resolved = next instanceof Promise ? await next : next;
                  res = processStep(resolved);
                }
                if (res != null)
                  return reportInvalidHelpCommand(res);
                const docOrPromise$1 = getDocPage(docGeneratorParser, classified.commands);
                return docOrPromise$1 instanceof Promise ? docOrPromise$1.then(displayHelp) : displayHelp(docOrPromise$1);
              };
              return stepResult.then(asyncValidate);
            }
            validationResult = processStep(stepResult);
          }
          if (validationResult != null)
            return reportInvalidHelpCommand(validationResult);
        }
        const docOrPromise = getDocPage(docGeneratorParser, classified.commands);
        if (docOrPromise instanceof Promise)
          return docOrPromise.then(displayHelp);
        return displayHelp(docOrPromise);
      }
      case "error": {
        const displayError = (doc, currentAboveError) => {
          let effectiveAboveError = currentAboveError;
          if (effectiveAboveError === "help")
            if (doc == null)
              effectiveAboveError = "usage";
            else {
              const isTopLevel = classified.commandPath.length < 1;
              const augmentedDoc = maybeCollapseCommandList({
                ...doc,
                brief: brief ?? doc.brief,
                description: description ?? doc.description,
                examples: examples ?? doc.examples,
                author: author ?? doc.author,
                bugs: bugs ?? doc.bugs,
                footer: footer ?? doc.footer
              }, commandList, isTopLevel);
              const defaultRootUsage = typeof usageLine === "function" && (options.help || options.version || options.completion) ? normalizeUsage(getRootHelpGeneratorParser().usage) : augmentedDoc.usage ?? [];
              const renderedDoc = isTopLevel && usageLine != null ? applyUsageLine(augmentedDoc, usageLine, defaultRootUsage) : augmentedDoc;
              stderr(formatDocPage(programName, renderedDoc, formatOptions({
                messageFormatter,
                theme,
                colors,
                maxWidth,
                termWidth,
                showDefault,
                showChoices,
                sectionOrder,
                showUsage
              })));
            }
          if (effectiveAboveError === "usage") {
            resolveUsageWidth(augmentedParser.usage);
            stderr(`${usageLabel()}${indentLines2(formatUsage(programName, augmentedParser.usage, {
              theme,
              colors,
              maxWidth: maxWidth == null ? undefined : maxWidth - usageLabelWidth(),
              expandCommands: true
            }), usageLabelWidth())}`);
          }
          stderr(renderErrorMessage(classified.error, formatOptions({
            messageFormatter,
            theme,
            colors,
            quotes: !colors,
            maxWidth
          })));
          return onError(1, classified.error);
        };
        if (aboveError === "help") {
          const parserForDoc = args.length < 1 ? augmentedParser : parser;
          const docOrPromise = getDocPage(parserForDoc, args);
          if (docOrPromise instanceof Promise)
            return docOrPromise.then((doc) => displayError(doc, aboveError));
          return displayError(docOrPromise, aboveError);
        }
        return displayError(undefined, aboveError);
      }
      default:
        throw new RunParserError("Unexpected parse result type");
    }
  };
  const parserMode = parser.mode;
  return dispatchByMode(parserMode, () => {
    const attempted = attemptParseSync(parser, args, {
      mode: "complete",
      session: getEffectfulSessionOption(options)
    });
    const classified = attempted.kind === "success" ? {
      type: "success",
      value: attempted.result.value
    } : classifyParseFailure(attempted, helpOptionConfig ? [...helpOptionNames] : [], helpCommandConfig ? [...helpCommandNames] : [], versionOptionConfig ? [...versionOptionNames] : [], versionCommandConfig ? [...versionCommandNames] : [], completionOptionConfig ? [...completionOptionNames] : [], completionCommandConfig ? [...completionCommandNames] : []);
    const handled = handleResult(classified);
    if (handled instanceof Promise)
      throw new RunParserError("Synchronous parser returned async result.");
    return handled;
  }, async () => {
    const attempted = await attemptParseAsync(parser, args, {
      mode: "complete",
      session: getEffectfulSessionOption(options)
    });
    const classified = attempted.kind === "success" ? {
      type: "success",
      value: attempted.result.value
    } : classifyParseFailure(attempted, helpOptionConfig ? [...helpOptionNames] : [], helpCommandConfig ? [...helpCommandNames] : [], versionOptionConfig ? [...versionOptionNames] : [], versionCommandConfig ? [...versionCommandNames] : [], completionOptionConfig ? [...completionOptionNames] : [], completionCommandConfig ? [...completionCommandNames] : []);
    const handled = handleResult(classified);
    return handled instanceof Promise ? await handled : handled;
  });
}
function applyUsageLine(doc, usageLine, defaultUsageLine = doc.usage ?? []) {
  const customUsageLine = typeof usageLine === "function" ? usageLine(cloneUsage(defaultUsageLine)) : usageLine;
  return {
    ...doc,
    usage: normalizeUsage(customUsageLine)
  };
}
function maybeCollapseCommandList(doc, commandList, isTopLevel) {
  if (commandList !== "top-level" || !isTopLevel)
    return doc;
  return {
    ...doc,
    sections: doc.sections.map((section) => ({
      ...section,
      entries: collapseTopLevelCommandEntries(section.entries)
    }))
  };
}
function collapseTopLevelCommandEntries(entries) {
  const collapsed = [];
  const commandIndexes = /* @__PURE__ */ new Map;
  for (const entry of entries) {
    if (entry.term.type !== "command") {
      collapsed.push(entry);
      continue;
    }
    const topLevelName = getTopLevelCommandName(entry.term.name);
    const existingIndex = commandIndexes.get(topLevelName);
    const isTopLevel = entry.term.name === topLevelName;
    if (existingIndex == null) {
      commandIndexes.set(topLevelName, collapsed.length);
      collapsed.push(isTopLevel ? entry : { term: {
        ...entry.term,
        name: topLevelName
      } });
      continue;
    }
    if (isTopLevel)
      collapsed[existingIndex] = entry;
  }
  return collapsed;
}
function getTopLevelCommandName(name) {
  return name.split(" ", 1)[0] ?? name;
}
var RunParserError = class extends Error {
  constructor(message$1) {
    super(message$1);
    this.name = "RunParserError";
  }
};
function indentLines2(text$1, indent) {
  return text$1.split(`
`).join(`
` + " ".repeat(indent));
}
export {
  argument,
  choice,
  command,
  constant,
  flag,
  formatMessage,
  map,
  message,
  multiple,
  object,
  option,
  optional,
  or,
  parse,
  runParser,
  string,
  text,
  withDefault
};
