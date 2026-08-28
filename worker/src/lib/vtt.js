/**
 * Subtitle and caption files to plain speaker-tagged transcript.
 *
 * WHY THIS IS ITS OWN FILE. `vttToPlainTranscript` was written for the Zoom
 * connector and lived inside `zoom.js`. The local ingest path needs the exact
 * same conversion for a `.vtt` a client saved out of a meeting tool by hand,
 * and the onboarding documentation has been telling clients to do that. Two
 * copies of a transcript parser drift, and the drift is invisible: both keep
 * producing text, one of them slowly starts producing worse text. So the one
 * implementation moved here, `zoom.js` imports and re-exports it unchanged,
 * and `ingest/extract.mjs` registers `.vtt` and `.srt` against it.
 *
 * A transcript without speakers is far less useful for retrieval — "who said
 * we would extend the deadline" is unanswerable from an undifferentiated wall
 * of sentences — so speaker attribution is preserved wherever the file carries
 * it, from either of the two conventions files in the wild actually use:
 * a `Name:` prefix on the first line of a cue (what Zoom writes), and the
 * WebVTT `<v Name>` voice span (what the spec defines).
 */

const VTT_TIMESTAMP = /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/;

/** SubRip's shorter form, which omits the hour on some writers. */
const SRT_TIMESTAMP = /^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/;

/**
 * Inline cue markup, removed rather than indexed.
 *
 * Deliberately a short list of the exact shapes the WebVTT and SubRip formats
 * define — voice, class, italic/bold/underline/ruby spans, and mid-cue
 * timestamps — instead of a general `<[^>]+>` sweep. A transcript is prose,
 * and prose contains "profit < cost" and "a<b"; a general sweep silently eats
 * the rest of the sentence after one of those.
 */
const CUE_MARKUP =
  /<\/?(?:v(?:\.[^>\s]*)?(?:\s[^>]*)?|c(?:\.[^>\s]*)?|i|b|u|ruby|rt|lang(?:\s[^>]*)?)>|<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/gi;

/** `<v Alex Rivera>` names the speaker of the cue. Capture it before stripping. */
const VOICE_SPAN = /^<v(?:\.[^>\s]*)?\s+([^>]+)>/i;

/** SubRip positioning, which is metadata about where to draw the text. */
const SRT_POSITIONING = /\{\\an?\d+\}/g;

/**
 * The shared cue reader. Both formats are "a cue header, then lines of text,
 * separated by blank lines"; only their headers and their inline markup
 * differ, so only those two things are parameters.
 *
 *   1. Cue-number lines (`^\d+$`) are skipped. In the Zoom reference
 *      implementation this was a real bug: a bare "12" before each cue was
 *      appended into the transcript text, so every transcript in that index
 *      carries stray digits.
 *   2. The WebVTT header block (`WEBVTT` through the first blank line) is
 *      skipped whole. Skipping only the `WEBVTT` line itself turns a
 *      "Kind: captions" or "Language: en-US" metadata line into a SPEAKER
 *      called "Kind", with the rest of the transcript attributed to it.
 *   3. A speaker prefix is only recognised on the FIRST line of a cue.
 *      Matching `^([^:]+):` on every line makes a wrapped continuation line
 *      reading "meet at 3:30 tomorrow" invent a speaker named "meet at 3".
 *   4. Text in a cue with no speaker prefix is emitted unattributed instead of
 *      dropped. Flushing only when a speaker is known parses a transcript with
 *      no attribution at all to the empty string — silent, total data loss
 *      with no error anywhere.
 *
 * NOTE blocks are skipped as the WebVTT spec defines them.
 */
function cuesToPlainTranscript(body, { header = false, positioning = null } = {}) {
  if (!body) return "";
  const lines = String(body).split(/\r?\n/);
  const out = [];
  let speaker = null;
  let buffer = [];
  // A speaker prefix is only meaningful at the start of a cue. Everything after
  // that is continuation text, colons and all.
  let atCueStart = false;
  let index = 0;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join(" ").trim();
    if (text) out.push(speaker ? `${speaker}: ${text}` : text);
    buffer = [];
    speaker = null;
  };

  // The header block: WEBVTT plus any metadata lines, through the first blank
  // line. Skipped whole rather than one line deep.
  if (header && lines[0] && /^﻿?WEBVTT/i.test(lines[0])) {
    index = 1;
    while (index < lines.length && lines[index].trim()) index++;
  }

  for (; index < lines.length; index++) {
    const line = lines[index];
    let trimmed = line.trim();

    if (!trimmed) {
      flush();
      atCueStart = false;
      continue;
    }
    // A NOTE comment runs to the next blank line and is never transcript text.
    if (/^NOTE(\s|$)/.test(trimmed)) {
      flush();
      while (index + 1 < lines.length && lines[index + 1].trim()) index++;
      atCueStart = false;
      continue;
    }
    if (/^\d+$/.test(trimmed)) continue;          // cue number
    if (VTT_TIMESTAMP.test(trimmed) || SRT_TIMESTAMP.test(trimmed)) {
      // Cue timing, plus whatever alignment and position settings follow it on
      // the same line. All of it is layout, none of it is speech.
      atCueStart = true;
      continue;
    }

    // A voice span names the speaker of the cue in the spec's own way, which
    // the `Name:` convention below cannot see.
    let voiced = null;
    const voice = atCueStart ? trimmed.match(VOICE_SPAN) : null;
    if (voice) voiced = voice[1].trim().split(".")[0].trim() || null;
    if (positioning) trimmed = trimmed.replace(positioning, "");
    trimmed = trimmed.replace(CUE_MARKUP, "").trim();
    if (!trimmed) {
      if (atCueStart && voiced) {
        flush();
        speaker = voiced;
      }
      atCueStart = false;
      continue;
    }

    if (atCueStart) {
      if (voiced) {
        flush();
        speaker = voiced;
        buffer.push(trimmed);
        atCueStart = false;
        continue;
      }
      const speakerMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (speakerMatch) {
        // A cue that names a speaker ends whatever turn was open. Ordinary
        // Zoom output already separates cues with a blank line, so this only
        // matters for a file whose cues run together.
        flush();
        speaker = speakerMatch[1].trim();
        const tail = speakerMatch[2].trim();
        if (tail) buffer.push(tail);
      } else {
        buffer.push(trimmed);
      }
      atCueStart = false;
      continue;
    }
    buffer.push(trimmed);
  }
  flush();
  return out.join("\n");
}

/** WebVTT to plain speaker-tagged transcript. */
export function vttToPlainTranscript(vttBody) {
  return cuesToPlainTranscript(vttBody, { header: true });
}

/**
 * SubRip (.srt) to plain speaker-tagged transcript.
 *
 * SubRip has no header block and writes its cue times with a comma, which the
 * shared reader already accepts, so the only format-specific handling is its
 * `{\an8}` positioning override.
 */
export function srtToPlainTranscript(srtBody) {
  return cuesToPlainTranscript(srtBody, { header: false, positioning: SRT_POSITIONING });
}

/**
 * Does this text actually carry cues?
 *
 * Registering a format means promising it works. A file that merely ends in
 * `.vtt` and contains no cue at all is not a transcript we read badly, it is
 * something else entirely, and the honest answer is to refuse it by name
 * rather than to index whatever prose happens to be in it.
 */
export function hasTimedCues(body) {
  for (const line of String(body || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (VTT_TIMESTAMP.test(trimmed) || SRT_TIMESTAMP.test(trimmed)) return true;
  }
  return false;
}
