import type { Slide } from "./parser.js";

export interface RichFeatures {
  math: boolean;
  mermaid: boolean;
}

export function richContentFeatures(slides: Slide[]): RichFeatures {
  let math = false;
  let mermaid = false;
  for (const slide of slides) {
    if (!math && (slide.html.includes('class="math-source"') || slide.html.includes("math-source"))) {
      math = true;
    }
    if (
      !mermaid &&
      (slide.html.includes("language-mermaid") ||
        slide.html.includes("lang-mermaid") ||
        slide.html.includes('class="mermaid"'))
    ) {
      mermaid = true;
    }
  }
  return { math, mermaid };
}

/**
 * The head tags for math and diagram rendering.
 *
 * The CDN variants carry Subresource Integrity digests. A standalone export
 * runs third-party JavaScript on whatever machine it is opened on, including
 * the machines of everyone the deck is sent to, so the bytes are pinned.
 */
export function richContentHead(
  features: RichFeatures,
  source: "local" | "cdn" = "local"
): string {
  const parts: string[] = [];
  if (features.math) {
    if (source === "cdn") {
      parts.push(
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.18.4/dist/katex.min.css"' +
          ' integrity="sha384-u1zONI5gPXUx0UKI62c75/zww972y0v2rSK5ZYlVdS6xEuWDeZWUI66v6t1gvlXJ"' +
          ' crossorigin="anonymous">'
      );
      parts.push(
        '<script src="https://cdn.jsdelivr.net/npm/katex@0.18.4/dist/katex.min.js"' +
          ' integrity="sha384-ykMNcWQhhTUb0YV9SPpPUFURHZ+tWmubkakGBP+OgNK/UXdO2gtzglWx0Rj9hnO3"' +
          ' crossorigin="anonymous"></script>'
      );
    } else {
      parts.push('<link rel="stylesheet" href="/__vendor/katex.min.css">');
      parts.push('<script src="/__vendor/katex.min.js"></script>');
    }
  }
  if (features.mermaid) {
    if (source === "cdn") {
      parts.push(
        '<script src="https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js"' +
          ' integrity="sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2"' +
          ' crossorigin="anonymous"></script>'
      );
    } else {
      parts.push('<script src="/__vendor/mermaid.min.js"></script>');
    }
  }
  return parts.join("\n  ");
}

export const RICH_CONTENT_CSS = `/* ── Rich Content (Math & Diagrams) ─────────────────────────────────────── */

.math-source {
  font-family: inherit;
}

div.math-source {
  display: flex;
  justify-content: center;
  margin: 1.2em 0;
  overflow-x: auto;
  overflow-y: hidden;
}

span.math-source {
  display: inline;
}

.katex-display {
  margin: 0.8em 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.katex {
  font-size: 1.15em;
  text-rendering: auto;
}

.math-error {
  color: var(--maroon, #f38ba8);
  background: var(--surface0, rgba(255, 0, 0, 0.1));
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 0.85em;
}

.mermaid {
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 1.2em auto;
  max-width: 100%;
  overflow: hidden;
}

.mermaid svg {
  max-width: 100%;
  height: auto;
}

.mermaid-error {
  color: var(--maroon, #f38ba8);
  background: var(--surface0, rgba(255, 0, 0, 0.1));
  border: 1px solid var(--maroon, #f38ba8);
  border-radius: 6px;
  padding: 12px 16px;
  font-family: var(--font-mono, monospace);
  font-size: 0.9em;
  white-space: pre-wrap;
  margin: 1em 0;
}
`;

export const RICH_CONTENT_RUNTIME = `(function () {
  window.deckrunRenderRichContent = function (root) {
    if (!root) return Promise.resolve();

    // 1. Render KaTeX math
    if (window.katex) {
      var mathNodes = root.querySelectorAll('.math-source:not([data-rendered])');
      for (var i = 0; i < mathNodes.length; i++) {
        var el = mathNodes[i];
        var tex = el.textContent || '';
        var isDisplay = el.dataset.display === 'true';
        try {
          window.katex.render(tex, el, {
            displayMode: isDisplay,
            throwOnError: false,
            output: 'htmlAndMathml'
          });
          el.setAttribute('data-rendered', 'true');
        } catch (err) {
          // The message derives from the deck's own TeX, so it is written as
          // text rather than parsed as markup.
          var errSpan = document.createElement('span');
          errSpan.className = 'math-error';
          errSpan.textContent = (err && err.message) ? String(err.message) : 'Math rendering error';
          el.textContent = '';
          el.appendChild(errSpan);
          el.setAttribute('data-rendered', 'true');
        }
      }
    }

    // 2. Render Mermaid diagrams
    var mermaidPromises = [];
    var codeBlocks = root.querySelectorAll('pre code.language-mermaid, pre code.lang-mermaid');
    if (codeBlocks.length > 0 && window.mermaid) {
      try {
        // 'strict' is Mermaid's default and the only level that runs its
        // DOMPurify pass over the generated SVG. Under 'loose' that pass is
        // skipped entirely and click directives are live, so a mermaid
        // block in someone else's deck injects raw markup and event
        // handlers into the page — an injection path of its own, since
        // the SVG is produced after any sanitizing of the Markdown output.
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict'
        });
      } catch (e) {}

      for (var j = 0; j < codeBlocks.length; j++) {
        (function (codeEl) {
          var preEl = codeEl.closest('pre');
          if (!preEl || preEl.dataset.rendered) return;
          preEl.dataset.rendered = 'true';
          var code = codeEl.textContent || '';
          var container = document.createElement('div');
          container.className = 'mermaid';
          preEl.parentNode.insertBefore(container, preEl);
          preEl.style.display = 'none';

          var id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
          var p = window.mermaid.render(id, code)
            .then(function (res) {
              container.innerHTML = res.svg;
              preEl.remove();
            })
            .catch(function (err) {
              container.className = 'mermaid-error';
              container.textContent = 'Mermaid Error: ' + (err && err.message ? err.message : String(err));
              preEl.remove();
            });
          mermaidPromises.push(p);
        })(codeBlocks[j]);
      }
    }

    return Promise.all(mermaidPromises).then(function () {});
  };
})();
`;
