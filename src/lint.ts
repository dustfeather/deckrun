/**
 * Strips C0/C1 control characters from text that came out of a document and
 * bounds its length.
 *
 * `deckrun lint` is meant to run in CI over decks other people wrote, and its
 * findings are printed straight to a terminal. An ESC, BEL or CSI byte lifted
 * out of a deck and echoed into a job log lets the deck blank the screen,
 * conceal the rest of the output, or redraw it — a reviewer then reads a clean
 * log for a deck that did not lint clean.
 */
export function sanitizeForTerminal(value: string, max = 120): string {
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
  return stripped.length > max ? stripped.slice(0, max) + "…" : stripped;
}

/**
 * Caps on the image scanner.
 *
 * The old pattern was `/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g`. The
 * greedy URL run has no upper bound and cannot contain `)`, so on a line of
 * `![](` repeated with no closing paren the run swallows the rest of the line
 * and then backtracks over all of it — from every `![` on the line. One
 * megabyte of that is roughly L^2/8 steps, which parks a CI runner until the
 * job times out on a diff that looks unremarkable.
 *
 * The scanner below walks the line once with a cursor instead. Runs are
 * bounded, and the whole file gets a fixed character budget so no crafted
 * line can turn linting into a denial of service.
 */
const MAX_ALT = 500;
const MAX_URL = 2048;
const MAX_TITLE = 500;
const SCAN_BUDGET = 4_000_000;

interface ImageMatch {
  alt: string;
  title: string;
  index: number;
}

/**
 * Finds `![alt](url "title")` occurrences on one line.
 *
 * `budget` is decremented by the number of characters examined and shared
 * across the file; when it runs out the scan stops. A URL run longer than
 * MAX_URL is not a URL, and the cursor jumps past it rather than retrying
 * from every `![` inside it — that is what keeps the pass linear.
 */
function scanImages(line: string, budget: { left: number }): ImageMatch[] {
  const found: ImageMatch[] = [];
  const isBreak = (ch: string) => ch === ")" || /\s/.test(ch);

  let i = 0;
  while (budget.left > 0) {
    const start = line.indexOf("![", i);
    if (start < 0) break;

    const alt = line.indexOf("]", start + 2);
    if (alt < 0) break;
    budget.left -= alt - start;
    if (alt - (start + 2) > MAX_ALT || line[alt + 1] !== "(") {
      i = alt + 1;
      continue;
    }

    // URL run: anything up to whitespace or the closing paren.
    const urlStart = alt + 2;
    let cursor = urlStart;
    while (cursor < line.length && cursor - urlStart <= MAX_URL && !isBreak(line[cursor])) {
      cursor++;
    }
    budget.left -= cursor - urlStart;
    if (cursor - urlStart > MAX_URL) {
      // Not a URL. Nothing inside a run this long can start a real image
      // either, so resume past it instead of retrying from every `![` in it.
      i = cursor;
      continue;
    }
    if (cursor === urlStart) {
      i = alt + 1;
      continue;
    }

    if (line[cursor] === ")") {
      found.push({ alt: line.slice(start + 2, alt), title: "", index: start });
      i = cursor + 1;
      continue;
    }

    // Optional ` "title"` before the closing paren.
    let quote = cursor;
    while (quote < line.length && /[ \t]/.test(line[quote])) quote++;
    if (line[quote] !== '"') {
      i = alt + 1;
      continue;
    }
    const window = line.slice(quote + 1, quote + 2 + MAX_TITLE);
    budget.left -= window.length;
    const close = window.indexOf('"');
    if (close < 0 || line[quote + 2 + close] !== ")") {
      i = alt + 1;
      continue;
    }
    found.push({
      alt: line.slice(start + 2, alt),
      title: window.slice(0, close),
      index: start,
    });
    i = quote + 3 + close;
  }

  return found;
}

export interface LintIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
  line: number;
  column: number;
  slide?: number;
}

export interface LintResult {
  slides: number;
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

export function lintMarkdown(markdown: string): LintResult {
  const issues: LintIssue[] = [];

  const trimmed = markdown.trim();
  if (!trimmed) {
    issues.push({
      rule: "empty-deck",
      severity: "error",
      message: "The deck is empty.",
      line: 1,
      column: 1,
    });
    return {
      slides: 0,
      errors: 1,
      warnings: 0,
      issues,
    };
  }

  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // Track slide boundaries
  interface SlideBoundary {
    slideIndex: number;
    startLine: number;
    endLine: number;
    lines: string[];
  }

  const slides: SlideBoundary[] = [];
  let curSlideLines: string[] = [];
  let curStartLine = 1;
  let slideIndex = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*---[ \t]*$/.test(line)) {
      slides.push({
        slideIndex,
        startLine: curStartLine,
        endLine: i,
        lines: curSlideLines,
      });
      slideIndex++;
      curStartLine = i + 2;
      curSlideLines = [];
    } else {
      curSlideLines.push(line);
    }
  }
  slides.push({
    slideIndex,
    startLine: curStartLine,
    endLine: lines.length,
    lines: curSlideLines,
  });

  // Global & Slide checks
  let inCodeFence = false;
  let fenceStartLine = 1;
  let fenceStartCol = 1;

  let inDisplayMath = false;
  let mathStartLine = 1;
  let mathStartCol = 1;

  // The slide a line belongs to is tracked with a cursor that only moves
  // forward. `slides.find(...)` re-scanned the whole array for every line, and
  // a deck that is nothing but `---` separators produces slides whose ranges
  // are all empty, so nothing ever short-circuits: O(lines x slides), with
  // both factors controlled by whoever wrote the deck.
  let slideCursor = 0;
  const scanBudget = { left: SCAN_BUDGET };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Determine current slide number
    while (
      slideCursor < slides.length - 1 &&
      lineNum > slides[slideCursor].endLine
    ) {
      slideCursor++;
    }
    const inRange =
      lineNum >= slides[slideCursor].startLine &&
      lineNum <= slides[slideCursor].endLine;
    const currentSlide = inRange ? slides[slideCursor].slideIndex : 1;

    // Check code fences
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true;
        fenceStartLine = lineNum;
        fenceStartCol = fenceMatch[1].length + 1;
        const tag = fenceMatch[3].trim();
        if (!tag) {
          issues.push({
            rule: "untagged-code-fence",
            severity: "warning",
            message: "Code fence has no language tag for syntax highlighting.",
            line: lineNum,
            column: fenceStartCol,
            slide: currentSlide,
          });
        }
      } else {
        inCodeFence = false;
      }
    }

    // Check display math
    if (!inCodeFence) {
      if (/^\s*\$\$\s*$/.test(line) || /^\s*\\\[\s*$/.test(line)) {
        if (!inDisplayMath) {
          inDisplayMath = true;
          mathStartLine = lineNum;
          mathStartCol = 1;
        } else {
          inDisplayMath = false;
        }
      } else if (line.includes("$$")) {
        const occurrences = (line.match(/\$\$/g) || []).length;
        if (occurrences % 2 !== 0) {
          inDisplayMath = !inDisplayMath;
          if (inDisplayMath) {
            mathStartLine = lineNum;
            mathStartCol = line.indexOf("$$") + 1;
          }
        }
      }

      // Check headings
      const headingMatch = line.match(/^(\s*#{1,6}\s+)(.*)$/);
      if (headingMatch && headingMatch[2].length > 80) {
        issues.push({
          rule: "long-heading",
          severity: "warning",
          message: `Heading is ${headingMatch[2].length} characters long; consider shortening for presentation readability.`,
          line: lineNum,
          column: headingMatch[1].length + 1,
          slide: currentSlide,
        });
      }

      // Check image directives
      for (const image of scanImages(line, scanBudget)) {
        const alt = image.alt.trim();
        const title = image.title;
        const col = image.index + 1;

        if (!alt) {
          issues.push({
            rule: "missing-image-alt",
            severity: "warning",
            message: "Image is missing alt text.",
            line: lineNum,
            column: col,
            slide: currentSlide,
          });
        }

        if (title) {
          const opMatch = title.toLowerCase().match(/opacity[=:]?\s*([^\s"]+)/);
          if (opMatch) {
            const val = parseFloat(opMatch[1]);
            if (isNaN(val) || val < 0 || val > 1) {
              issues.push({
                rule: "invalid-image-opacity",
                severity: "warning",
                message: `Invalid image opacity '${sanitizeForTerminal(opMatch[1], 40)}'; expected a number between 0 and 1.`,
                line: lineNum,
                column: col,
                slide: currentSlide,
              });
            }
          }
        }
      }
    }
  }

  if (inCodeFence) {
    issues.push({
      rule: "unclosed-code-fence",
      severity: "error",
      message: "Code fence was opened but never closed.",
      line: fenceStartLine,
      column: fenceStartCol,
    });
  }

  if (inDisplayMath) {
    issues.push({
      rule: "unclosed-math",
      severity: "error",
      message: "Display math block was opened but never closed.",
      line: mathStartLine,
      column: mathStartCol,
    });
  }

  // Per-slide checks
  for (const s of slides) {
    const slideContent = s.lines.join("\n").trim();
    if (!slideContent) {
      issues.push({
        rule: "empty-slide",
        severity: "warning",
        message: `Slide ${s.slideIndex} is empty.`,
        line: s.startLine,
        column: 1,
        slide: s.slideIndex,
      });
      continue;
    }

    // Check bullet density
    const bullets = s.lines.filter((l) =>
      /^\s*([-*+]|\d+[.)])\s+/.test(l)
    );
    if (bullets.length > 8) {
      issues.push({
        rule: "dense-slide",
        severity: "warning",
        message: `Slide ${s.slideIndex} has ${bullets.length} bullets (recommended maximum is 8).`,
        line: s.startLine,
        column: 1,
        slide: s.slideIndex,
      });
    }

    // Check reveal markers
    const revealCount = (slideContent.match(/\{reveal\}/g) || []).length;
    if (revealCount > 10) {
      issues.push({
        rule: "reveal-excessive",
        severity: "warning",
        message: `Slide ${s.slideIndex} has ${revealCount} reveal markers (recommended maximum is 10).`,
        line: s.startLine,
        column: 1,
        slide: s.slideIndex,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  return {
    slides: slides.length,
    errors,
    warnings,
    issues,
  };
}
