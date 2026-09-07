import sanitizeHtml from "sanitize-html";

/**
 * Strips executable markup out of rendered slide HTML.
 *
 * marked dropped its `sanitize` option in v8 and nothing replaced it, so raw
 * HTML in a deck reached the rendered slide verbatim: a `<script>` tag, an
 * `onerror=` handler and a `javascript:` href all survived. Opening a `.md`
 * file someone else wrote ran their JavaScript — in the editor preview, in the
 * presented deck, and in the standalone HTML export handed to an audience.
 *
 * Benign HTML is kept rather than escaped, because decks legitimately use it
 * for layout. What goes is the part that executes: script and event handlers,
 * plugin and frame embeds, and any URL scheme that is not a plain link or an
 * inline image.
 */
const ALLOWED_TAGS = [
  // Text and structure marked emits, plus the layout tags decks tend to use.
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div", "span", "section", "article", "header", "footer", "aside", "main",
  "blockquote", "pre", "code", "kbd", "samp", "var",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "a", "img", "figure", "figcaption", "picture", "source",
  "b", "i", "em", "strong", "small", "s", "strike", "del", "ins", "mark", "sub", "sup", "u",
  "br", "hr", "wbr", "abbr", "cite", "q", "time", "details", "summary",
  // Inline SVG, so diagrams and icons pasted into a deck still render.
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "text", "tspan", "defs", "marker", "linearGradient", "radialGradient", "stop",
  "clipPath", "mask", "pattern", "symbol", "use", "title", "desc",
];

// `data-*` matters to deckrun itself: the math nodes carry `data-display` and
// the slide wrapper carries `data-index`. `aria-*` is markup, not capability.
const COMMON_ATTRS = [
  "class", "id", "title", "style", "role", "lang", "dir", "hidden",
  "data-*", "aria-*",
];

/** Geometry and paint attributes, so inline SVG survives intact. */
const SVG_ATTRS = [
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "width", "height", "points", "transform", "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "stroke-dashoffset", "stroke-opacity", "opacity", "offset", "stop-color",
  "stop-opacity", "gradientUnits", "gradientTransform", "patternUnits",
  "markerWidth", "markerHeight", "refX", "refY", "orient", "clip-path",
  "text-anchor", "dominant-baseline", "font-size", "font-family", "font-weight",
  "dx", "dy", "viewBox", "preserveAspectRatio", "xmlns", "xmlns:xlink",
  // The parser lowercases attribute names, so the camelCase SVG attributes
  // have to be listed in both forms or they are dropped from real diagrams.
  "viewbox", "preserveaspectratio", "gradientunits", "gradienttransform",
  "patternunits", "markerwidth", "markerheight", "refx", "refy",
];

export function sanitizeSlideHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": COMMON_ATTRS,
      a: [...COMMON_ATTRS, "href", "target", "rel", "name"],
      img: [...COMMON_ATTRS, "src", "alt", "width", "height", "loading", "decoding", "srcset", "sizes"],
      source: [...COMMON_ATTRS, "src", "srcset", "sizes", "type", "media"],
      td: [...COMMON_ATTRS, "colspan", "rowspan", "align", "valign"],
      th: [...COMMON_ATTRS, "colspan", "rowspan", "align", "valign", "scope"],
      col: [...COMMON_ATTRS, "span", "width"],
      colgroup: [...COMMON_ATTRS, "span"],
      ol: [...COMMON_ATTRS, "start", "reversed", "type"],
      li: [...COMMON_ATTRS, "value"],
      details: [...COMMON_ATTRS, "open"],
      time: [...COMMON_ATTRS, "datetime"],
      svg: [...COMMON_ATTRS, ...SVG_ATTRS],
      g: [...COMMON_ATTRS, ...SVG_ATTRS],
      path: [...COMMON_ATTRS, ...SVG_ATTRS],
      circle: [...COMMON_ATTRS, ...SVG_ATTRS],
      ellipse: [...COMMON_ATTRS, ...SVG_ATTRS],
      rect: [...COMMON_ATTRS, ...SVG_ATTRS],
      line: [...COMMON_ATTRS, ...SVG_ATTRS],
      polyline: [...COMMON_ATTRS, ...SVG_ATTRS],
      polygon: [...COMMON_ATTRS, ...SVG_ATTRS],
      text: [...COMMON_ATTRS, ...SVG_ATTRS],
      tspan: [...COMMON_ATTRS, ...SVG_ATTRS],
      marker: [...COMMON_ATTRS, ...SVG_ATTRS],
      linearGradient: [...COMMON_ATTRS, ...SVG_ATTRS],
      radialGradient: [...COMMON_ATTRS, ...SVG_ATTRS],
      stop: [...COMMON_ATTRS, ...SVG_ATTRS],
      clipPath: [...COMMON_ATTRS, ...SVG_ATTRS],
      mask: [...COMMON_ATTRS, ...SVG_ATTRS],
      pattern: [...COMMON_ATTRS, ...SVG_ATTRS],
      symbol: [...COMMON_ATTRS, ...SVG_ATTRS],
      use: [...COMMON_ATTRS, ...SVG_ATTRS, "href"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite", "srcset"],
    allowProtocolRelative: true,
    // Class names are a styling hook, not a capability; keep them all.
    allowedClasses: false as unknown as undefined,
    // Anything not in the tag list is unwrapped rather than deleted, so the
    // text inside an unknown wrapper is not silently lost — except for the
    // elements whose *content* is the payload.
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "template", "iframe", "object", "embed"],
    parseStyleAttributes: false,
    allowVulnerableTags: false,
  });
}
