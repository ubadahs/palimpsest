import {
  AUTHOR_REVIEW_ELEMENT_IDS,
  embedJson,
  type AuthorAnswers,
  type AuthorReviewData,
} from "./author-review.js";

/**
 * One self-contained HTML file: no network, no server. The reader answers one
 * restatement at a time; answers persist in the browser as they go, and
 * "Save my answers" downloads this same file with them written in, which is
 * what they send back. Every piece of data reaches the page through
 * `textContent`, never as markup.
 */
export function renderAuthorReviewPage(
  data: AuthorReviewData,
  answers: AuthorAnswers = {},
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How your paper is cited</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script type="application/json" id="${AUTHOR_REVIEW_ELEMENT_IDS.data}">${embedJson(data)}</script>
<script type="application/json" id="${AUTHOR_REVIEW_ELEMENT_IDS.answers}">${embedJson(answers)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root {
  --bg: #fbfaf8; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6a66;
  --line: #e4e2dd; --accent: #2f5d50; --accent-text: #ffffff;
  --mark: #fff1c2; --quote: #f3f1ec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe7; --muted: #a09e98;
    --line: #34332f; --accent: #8cc5b2; --accent-text: #10201b;
    --mark: #4a3f17; --quote: #262522;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 680px; margin: 0 auto; padding: 40px 16px 64px; }
h1 { font-size: 24px; line-height: 1.3; margin: 0 0 16px; }
h2 { font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--muted); margin: 28px 0 8px; }
p { margin: 0 0 14px; }
.muted { color: var(--muted); }
.progress { font-size: 14px; color: var(--muted); display: flex; justify-content: space-between; }
blockquote { margin: 0 0 10px; padding: 12px 16px; background: var(--quote);
  border-radius: 8px; }
.source { font-size: 14px; color: var(--muted); margin-top: -4px; }
mark { background: var(--mark); color: inherit; padding: 0 2px; border-radius: 3px; }
.marker { font-weight: 700; text-decoration: underline; text-decoration-color: var(--accent);
  text-underline-offset: 3px; }
.paragraph { font-size: 15px; color: var(--muted); }
.link { background: none; border: 0; padding: 0; color: var(--accent); font: inherit;
  font-size: 14px; cursor: pointer; text-decoration: underline; }
.choices { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 8px; }
@media (min-width: 560px) { .choices { grid-template-columns: repeat(4, 1fr); } }
.choice { font: inherit; font-size: 15px; padding: 12px 8px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--text); }
.choice[aria-pressed="true"] { background: var(--accent); color: var(--accent-text);
  border-color: var(--accent); }
textarea { width: 100%; min-height: 64px; margin-top: 12px; padding: 10px 12px; font: inherit;
  font-size: 15px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
  color: var(--text); resize: vertical; }
.ours { margin-top: 20px; padding: 14px 16px; border-left: 3px solid var(--accent);
  background: var(--surface); border-radius: 0 8px 8px 0; font-size: 15px; }
nav { display: flex; justify-content: space-between; gap: 12px; margin-top: 32px; }
.button { font: inherit; padding: 10px 18px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--text); }
.button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.button:disabled { opacity: .4; cursor: default; }
`;

const SCRIPT = `
(function () {
  var DATA_ID = ${JSON.stringify(AUTHOR_REVIEW_ELEMENT_IDS.data)};
  var ANSWERS_ID = ${JSON.stringify(AUTHOR_REVIEW_ELEMENT_IDS.answers)};
  var LABELS = { accurate: "Accurate", changed: "Stretched or changed", wrong: "Wrong", unsure: "Not sure" };
  var ANSWERS = ["accurate", "changed", "wrong", "unsure"];
  var VERDICT_LABEL = { F: "Accurate", D: "Stretched or changed", E: "Wrong", U: "Not sure" };

  // Captured before rendering, so a save writes the file as it was sent.
  var pristine = "<!doctype html>\\n" + document.documentElement.outerHTML;
  var data = JSON.parse(document.getElementById(DATA_ID).textContent);
  var answers = JSON.parse(document.getElementById(ANSWERS_ID).textContent);
  var storageKey = "author-review:" + data.lineage.reportContentHash;
  try {
    var stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (stored && Object.keys(stored).length > Object.keys(answers).length) answers = stored;
  } catch (e) {}

  var app = document.getElementById("app");
  var screen = -1; // -1 intro, items.length done
  var showParagraph = false;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "onclick") node.addEventListener("click", attrs[key]);
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(answers)); } catch (e) {}
  }

  function answeredCount() {
    return data.items.filter(function (item) { return answers[item.itemId]; }).length;
  }

  function go(next) { screen = next; showParagraph = false; render(); window.scrollTo(0, 0); }

  function save() {
    var json = JSON.stringify(answers).replace(/</g, "\\\\u003c");
    var open = '<script type="application/json" id="' + ANSWERS_ID + '">';
    var start = pristine.indexOf(open) + open.length;
    var end = pristine.indexOf("<" + "/script>", start);
    var html = pristine.slice(0, start) + json + pristine.slice(end);
    var link = el("a", {
      href: URL.createObjectURL(new Blob([html], { type: "text/html" })),
      download: "my-answers.html",
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function intro() {
    var n = data.items.length;
    var title = data.seedTitle;
    return [
      el("h1", { text: (data.readerName ? "Hi " + data.readerName + "," : "Hi,") }),
      el("p", { text: "Here are " + n + " places where other papers describe findings from your paper, \\u201C" + title + ".\\u201D For each one, tell us whether the description is accurate." }),
      el("p", { text: "It takes about " + Math.max(5, Math.round(n * 0.8)) + " minutes, and you can skip any of them. After you answer, you\\u2019ll see what our tool thought." }),
      el("p", { class: "muted", text: "Your answers are kept in this browser as you go. When you\\u2019re done, click \\u201CSave my answers\\u201D and email the saved file back." }),
      el("nav", {}, [el("span"), el("button", { class: "button primary", text: answeredCount() > 0 ? "Continue" : "Start", onclick: function () {
        var firstOpen = data.items.findIndex(function (item) { return !answers[item.itemId]; });
        go(firstOpen === -1 ? 0 : firstOpen);
      } })]),
    ];
  }

  // paragraph[from, to) as nodes, with the author's citation marker in bold.
  function withMarker(item, from, to) {
    var marker = item.markerSpan;
    var text = function (a, b) { return document.createTextNode(item.paragraph.slice(a, b)); };
    if (!marker || marker.end <= from || marker.start >= to) return [text(from, to)];
    var start = Math.max(marker.start, from), end = Math.min(marker.end, to);
    return [text(from, start), el("strong", { class: "marker", text: item.paragraph.slice(start, end) }), text(end, to)];
  }

  function markerInSentence(item) {
    var marker = item.markerSpan;
    return marker != null && item.sentenceOffset != null &&
      marker.start >= item.sentenceOffset && marker.end <= item.sentenceOffset + item.citingSentence.length;
  }

  function citingSentence(item) {
    if (item.sentenceOffset == null) return el("blockquote", { text: item.citingSentence });
    var start = item.sentenceOffset, end = start + item.citingSentence.length;
    if (!showParagraph) return el("blockquote", {}, withMarker(item, start, end));
    return el("blockquote", { class: "paragraph" }, withMarker(item, 0, start).concat(
      [el("mark", {}, withMarker(item, start, end))],
      withMarker(item, end, item.paragraph.length)));
  }

  function itemScreen(index) {
    var item = data.items[index];
    var answer = answers[item.itemId];
    var cited = item.citingPaperTitle + (item.citingPaperYear ? " (" + item.citingPaperYear + ")" : "");
    var seed = item.seedQuotes.length > 0
      ? item.seedQuotes.map(function (quote) { return el("blockquote", { text: "\\u201C" + quote + "\\u201D" }); })
      : [el("blockquote", { text: item.seedSummary || "" })];

    var choices = el("div", { class: "choices", role: "group", "aria-label": "Your answer" },
      ANSWERS.map(function (value, i) {
        return el("button", {
          class: "choice", text: LABELS[value], "aria-pressed": String(answer ? answer.final === value : false),
          title: "Shortcut: " + (i + 1),
          onclick: function () { choose(item, value); },
        });
      }));

    var note = el("textarea", { placeholder: "Anything to add? (optional)", "aria-label": "Note" });
    note.value = answer ? answer.note : "";
    note.addEventListener("input", function () {
      if (!answers[item.itemId]) return;
      answers[item.itemId].note = note.value;
      persist();
    });

    var children = [
      el("div", { class: "progress" }, [
        el("span", { text: (index + 1) + " of " + data.items.length }),
        el("button", { class: "link", text: "Save my answers", onclick: save }),
      ]),
      el("h2", { text: "Your paper says" }),
    ].concat(seed, [
      el("h2", { text: "A citing paper describes it as" }),
      citingSentence(item),
      el("p", { class: "source", text: cited + (markerInSentence(item) ? " \u00B7 your paper is the reference in bold" : "") }),
      item.sentenceOffset != null ? el("button", { class: "link", text: showParagraph ? "Show just the sentence" : "Show the full paragraph", onclick: function () { showParagraph = !showParagraph; render(); } }) : null,
      el("h2", { text: "Is this an accurate description of your work?" }),
      choices,
      answer ? note : null,
      answer ? el("div", { class: "ours" }, [
        el("strong", { text: "Our tool\\u2019s read: " + VERDICT_LABEL[item.ours.verdict] + ". " }),
        document.createTextNode(item.ours.explanation),
      ]) : null,
      el("nav", {}, [
        el("button", { class: "button", text: "Back", onclick: function () { go(index - 1); } }),
        el("button", { class: "button primary", text: answer ? "Next" : "Skip", onclick: function () { go(index + 1); } }),
      ]),
    ]);
    return children;
  }

  function choose(item, value) {
    var existing = answers[item.itemId];
    answers[item.itemId] = existing
      ? { first: existing.first, final: value, note: existing.note }
      : { first: value, final: value, note: "" };
    persist();
    render();
  }

  function done() {
    var count = answeredCount();
    return [
      el("h1", { text: "Thank you" }),
      el("p", { text: "You answered " + count + " of " + data.items.length + ". Click below to save a copy of this file with your answers in it, then email that file back." }),
      el("p", { class: "muted", text: "We found " + data.restatementCount + " restatements of your paper in all; these were a sample." }),
      el("nav", {}, [
        el("button", { class: "button", text: "Back", onclick: function () { go(data.items.length - 1); } }),
        el("button", { class: "button primary", text: "Save my answers", onclick: save }),
      ]),
    ];
  }

  function render() {
    var nodes = screen < 0 ? intro() : screen >= data.items.length ? done() : itemScreen(screen);
    app.replaceChildren.apply(app, nodes.filter(Boolean));
  }

  document.addEventListener("keydown", function (event) {
    if (event.target && event.target.tagName === "TEXTAREA") return;
    if (screen < 0 || screen >= data.items.length) return;
    var digit = Number(event.key);
    if (digit >= 1 && digit <= 4) choose(data.items[screen], ANSWERS[digit - 1]);
    else if (event.key === "ArrowRight") go(screen + 1);
    else if (event.key === "ArrowLeft" && screen > 0) go(screen - 1);
  });

  render();
})();
`;
