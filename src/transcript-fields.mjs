// Both Claude and Codex store JSONL transcripts. This helper decodes only a
// named string field from a raw line; prompts, replies and tool output stay
// unparsed and are never retained.
export function stringField(line, name) {
  const marker = `"${name}"`;
  let index = line.indexOf(marker);
  while (index >= 0) {
    if (index === 0 || line[index - 1] !== "\\") {
      const match = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line.slice(index + marker.length));
      if (!match) return null;
      try { return JSON.parse(match[1]); } catch { return null; }
    }
    index = line.indexOf(marker, index + marker.length);
  }
  return null;
}

// Return only newline-terminated lines. A partial first line from a tail slice
// and a partial trailing line from an in-progress write are both dropped.
export function completeLines(text, atEnd) {
  if (!text) return [];
  if (!atEnd || !text.endsWith("\n")) {
    const last = text.lastIndexOf("\n");
    text = last < 0 ? "" : text.slice(0, last + 1);
  }
  return text ? text.split("\n").filter(Boolean) : [];
}

// All occurrences of a named string field on one raw line. Only the matched
// string literal is decoded; the line itself is never JSON-parsed, and escaped
// occurrences inside prompt/reply text are skipped. The scan is bounded.
export function stringFields(line, name, { limit = 256 } = {}) {
  if (typeof line !== "string" || !line || !Number.isSafeInteger(limit) || limit <= 0) return [];
  const values = [];
  const marker = `"${name}"`;
  let index = line.indexOf(marker);
  while (index >= 0 && values.length < limit) {
    if (index === 0 || line[index - 1] !== "\\") {
      const match = /^\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line.slice(index + marker.length));
      if (match) {
        try {
          const value = JSON.parse(match[1]);
          if (typeof value === "string" && value) values.push(value);
        } catch { /* a torn literal is skipped */ }
      }
    }
    index = line.indexOf(marker, index + marker.length);
  }
  return values;
}
