import { marked } from "marked";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Locates a math block without letting the regex engine walk the document.
 *
 * The obvious pattern for this is `^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$`,
 * but marked hands block tokenizers the *entire* remaining source, so the
 * lazy group is expanded one character at a time and the greedy `[ \t]*`
 * in front of the closing fence re-consumes and gives back the whitespace
 * run on every one of those expansions. An unclosed `$$` followed by a few
 * megabytes of spaces is then quadratic, and one `POST /__parse` pins the
 * server's only thread. Scanning for the fence with `indexOf` is linear.
 */
function matchMathBlock(
  src: string,
  open: string,
  close: string
): { raw: string; text: string } | undefined {
  if (!src.startsWith(open)) return;

  // The opening fence may be followed by blanks and an optional newline.
  const head = /^[ \t]*\n?/.exec(src.slice(open.length))![0];
  const bodyStart = open.length + head.length;

  for (let cursor = bodyStart; ; ) {
    const at = src.indexOf(close, cursor);
    if (at < 0) return;
    // A fence only closes the block when the rest of its line is blank.
    const tail = /^[ \t]*(?:\n|$)/.exec(src.slice(at + close.length));
    if (!tail) {
      cursor = at + close.length;
      continue;
    }
    const body = src.slice(bodyStart, at).replace(/\n?[ \t]*$/, "");
    if (!body) return;
    return {
      raw: src.slice(0, at + close.length + tail[0].length),
      text: body.trim(),
    };
  }
}

/**
 * Capture TeX before the regular Markdown tokenizer sees it. This keeps
 * operators such as `*` and `_` inside a formula instead of turning them into
 * emphasis. The browser can then render these deliberately marked nodes with
 * KaTeX after fonts and layout styles are available.
 */
marked.use({
  extensions: [
    {
      name: "deckrunBlockMath",
      level: "block",
      tokenizer(src) {
        const match =
          matchMathBlock(src, "$$", "$$") ?? matchMathBlock(src, "\\[", "\\]");
        if (!match) return;
        return {
          type: "deckrunBlockMath",
          raw: match.raw,
          text: match.text,
          display: true,
        };
      },
      renderer(token) {
        return `<div class="math-source" data-display="true">${escapeHtml(String(token.text))}</div>\n`;
      },
    },
    {
      name: "deckrunInlineMath",
      level: "inline",
      start(src) {
        const dollar = src.indexOf("$");
        const paren = src.indexOf("\\(");
        if (dollar < 0) return paren < 0 ? undefined : paren;
        if (paren < 0) return dollar;
        return Math.min(dollar, paren);
      },
      tokenizer(src) {
        // A closing dollar followed by a digit is treated as currency rather
        // than math, so ordinary prose like "$5 and $10" stays untouched.
        const dollars = /^\$(?!\s|\$)((?:\\.|[^\\$\n])*?[^\\$\s])\$(?!\$|\d)/.exec(src);
        const parens = /^\\\(((?:\\.|[^\\\n])*?)\\\)/.exec(src);
        const match = dollars ?? parens;
        if (!match) return;
        return {
          type: "deckrunInlineMath",
          raw: match[0],
          text: match[1],
          display: false,
        };
      },
      renderer(token) {
        return `<span class="math-source" data-display="false">${escapeHtml(String(token.text))}</span>`;
      },
    },
    {
      name: "deckrunRevealMarker",
      level: "inline",
      start(src) {
        const at = src.indexOf("{reveal}");
        return at < 0 ? undefined : at;
      },
      tokenizer(src) {
        const match = /^\{reveal\}/.exec(src);
        if (!match) return;
        return { type: "deckrunRevealMarker", raw: match[0] };
      },
      renderer() {
        return '<span class="deckrun-fragment-marker" aria-hidden="true"></span>';
      },
    },
  ],
});

const NOTES_OPEN = /^<!--[ \t\r\n]{0,64}notes?:/i;

/**
 * Lifts `<!-- notes: … -->` comments out of a slide and returns what is left.
 *
 * The comments are located with `indexOf` rather than with a global
 * `/<!--\s*notes?:\s*[\s\S]*?-->/g`. That pattern restarts its lazy scan at
 * every `<!--` in the slide, so a deck built from repeated unclosed
 * `<!--notes:` openers costs O(n²) — reachable unauthenticated through
 * `POST /__parse` with a 32 MB body.
 */
function extractNotes(raw: string): { notes?: string; body: string } {
  let notes: string | undefined;
  let body = "";
  let from = 0;

  for (;;) {
    const open = raw.indexOf("<!--", from);
    if (open < 0) break;
    if (!NOTES_OPEN.test(raw.slice(open, open + 80))) {
      // Some other comment: keep it, and resume past its opener.
      body += raw.slice(from, open + 4);
      from = open + 4;
      continue;
    }
    const close = raw.indexOf("-->", open);
    if (close < 0) break; // unclosed notes comment: leave the tail untouched
    if (notes === undefined) {
      notes = raw.slice(open, close).replace(NOTES_OPEN, "").trim();
    }
    body += raw.slice(from, open);
    from = close + 3;
  }

  return { notes, body: body + raw.slice(from) };
}

export interface PositionedImage {
  src: string;
  alt: string;
  opacity: number;
}

export interface Slide {
  html: string;
  bgImage?: PositionedImage;
  rightImage?: PositionedImage;
  leftImage?: PositionedImage;
  notes?: string;
}

type ImagePosition = "inline" | "right" | "left" | "bg";

function parseImageDirective(title: string | undefined | null): {
  position: ImagePosition;
  opacity: number;
} {
  if (!title) return { position: "inline", opacity: 1 };

  const t = title.trim().toLowerCase();
  let position: ImagePosition = "inline";

  if (t.includes("right")) position = "right";
  else if (t.includes("left")) position = "left";
  else if (t.includes("bg")) position = "bg";

  const opacityMatch = t.match(/opacity[=:]?\s*([0-9]*\.?[0-9]+)/);
  const opacity = opacityMatch
    ? Math.min(1, Math.max(0, parseFloat(opacityMatch[1])))
    : 1;

  return { position, opacity };
}

export function parseSlides(markdown: string): Slide[] {
  // Normalize line endings
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split on slide separator: "---" on its own line (with optional surrounding blank lines)
  const rawSlides = normalized.split(/\n[ \t]*---[ \t]*\n/);

  return rawSlides
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const slide: Slide = { html: "" };

      // Extract speaker notes (<!-- notes: ... --> at end)
      const { notes, body } = extractNotes(raw);
      if (notes !== undefined) slide.notes = notes;
      let processedMd = body;

      // Find positioned images via title attribute: ![alt](src "right opacity:0.7")
      const imgRegex =
        /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g;
      const toRemove: string[] = [];
      let match: RegExpExecArray | null;

      // Reset lastIndex before use since we're reusing the regex
      imgRegex.lastIndex = 0;

      while ((match = imgRegex.exec(raw)) !== null) {
        const [full, alt, src, titleAttr] = match;
        const { position, opacity } = parseImageDirective(titleAttr);

        if (position === "bg") {
          slide.bgImage = { src, alt, opacity };
          toRemove.push(full);
        } else if (position === "right") {
          slide.rightImage = { src, alt, opacity };
          toRemove.push(full);
        } else if (position === "left") {
          slide.leftImage = { src, alt, opacity };
          toRemove.push(full);
        }
      }

      for (const item of toRemove) {
        // Replace only first occurrence (the matched image)
        processedMd = processedMd.replace(item, "");
      }

      // Render remaining markdown to HTML
      slide.html = marked.parse(processedMd.trim()) as string;

      return slide;
    });
}
