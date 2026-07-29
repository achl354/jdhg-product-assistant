// streamingAnswer.js
//
// Incrementally extracts the JSON string value of a top-level "answer" key
// from a (possibly incomplete) JSON object's raw text, decoding standard
// JSON string escapes as it goes.
//
// This exists because the Anthropic SDK's own best-effort partial-JSON
// parser (used for its `inputJson` event's jsonSnapshot argument) discards
// a string value entirely until its closing quote has arrived — so it
// cannot be used to reveal the "answer" field growing character by
// character as the model generates it, only once each field is fully
// complete. Genuine token-by-token reveal needs an extractor that returns
// whatever has decoded so far even when the string is still open.
//
// Returns:
//   - null if the "answer" key/value hasn't started arriving yet
//   - the decoded string so far otherwise (whether or not it's complete —
//     the caller can't tell from this function alone, and doesn't need to:
//     it just keeps calling this as more raw JSON text arrives, and the
//     decoded text keeps growing until the model finishes that field)
export function extractPartialAnswerText(jsonBuffer) {
  const keyMatch = jsonBuffer.match(/"answer"\s*:\s*"/);
  if (!keyMatch) return null;

  let i = keyMatch.index + keyMatch[0].length;
  let decoded = "";

  while (i < jsonBuffer.length) {
    const ch = jsonBuffer[i];

    if (ch === '"') {
      // Closing quote — the string value is complete.
      return decoded;
    }

    if (ch === "\\") {
      const next = jsonBuffer[i + 1];
      if (next === undefined) break; // escape sequence not fully arrived yet — stop here, wait for more text

      switch (next) {
        case "n": decoded += "\n"; i += 2; break;
        case "t": decoded += "\t"; i += 2; break;
        case "r": decoded += "\r"; i += 2; break;
        case "b": decoded += "\b"; i += 2; break;
        case "f": decoded += "\f"; i += 2; break;
        case '"': decoded += '"'; i += 2; break;
        case "\\": decoded += "\\"; i += 2; break;
        case "/": decoded += "/"; i += 2; break;
        case "u": {
          const hex = jsonBuffer.slice(i + 2, i + 6);
          if (hex.length < 4) return decoded; // incomplete unicode escape — wait for more text
          decoded += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          decoded += next;
          i += 2;
      }
      continue;
    }

    decoded += ch;
    i++;
  }

  return decoded; // no closing quote yet — string still open, this is the partial content so far
}
