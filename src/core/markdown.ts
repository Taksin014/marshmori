// A deliberately small Markdown renderer for chat replies. Everything is escaped
// first, so model output can never inject HTML; then a few safe patterns are
// turned into tags: code fences, inline code, bold, italics, headings and lists.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function inline(text: string): string {
  // `code` first, so its contents are left alone.
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${part.slice(1, -1)}</code>`;
      }
      return part
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
    })
    .join("");
}

export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source.replace(/\r\n/g, "\n"));
  const out: string[] = [];
  const lines = escaped.split("\n");
  let i = 0;
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or end of a still-streaming message)
      const lang = fence[1] ? ` data-lang="${fence[1]}"` : "";
      out.push(`<pre${lang}><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<p class="md-h">${inline(heading[2])}</p>`);
      i++;
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      i++;
      continue;
    }
    closeList();
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Consecutive plain lines form one paragraph.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  closeList();
  return out.join("");
}
