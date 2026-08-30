# Acceptance, handoff, and future updates

## Golden 20 session

Run this only after the approved starting sources are loaded and meaning search
is ready:

```text
brain eval <manifest> --golden-20
```

The owner and technician complete twenty owner-written cases together:

- six facts answered by one document;
- three questions requiring more than one document;
- three questions about something that changed over time;
- three questions that must distinguish people correctly;
- five plausible questions the Brain must refuse because the evidence does not
  support an answer.

The owner writes each question from memory before retrieval. For answerable
cases, the owner confirms the returned evidence. For unanswerable cases, the
owner checks the live refusal. The session saves after every question and can
resume after an interruption.

A completed Golden 20 is an owner-reviewed private question set and defaults to
the stricter onboarding profile. Passing that gate proves this first useful set,
not a release certification, a professional audit, or coverage of every source
and question.

### Golden 20 Claude prompt

```text
Guide me through brain eval <manifest> --golden-20 one case at a time. Do not invent, rewrite, or improve my questions. Keep raw questions, answers, filenames, source paths, and citations private on this computer. For each case, help me confirm the evidence or the refusal, then state whether the case passed, failed, or is blocked by missing material. Do not call the session certification.
```

## Acceptance record

The handoff receipt should record each item as accepted, blocked, or deferred:

- exact installed release and package digest;
- final hostname and Cloudflare account ownership;
- live health, migration, search-readiness, and vector-backlog results;
- physical passkey enrollment, sign-out, sign-in, and recovery path;
- app desktop, keyboard, and mobile-width checks;
- every approved source with counts, freshness, provenance, proof level, and
  unresolved gap;
- exclusion and leak-tripwire results;
- Golden 20 result and the location of its private local suite;
- support contact, coverage window, response targets, and offline path;
- access removed, retained, or time-limited for each technician or collaborator;
- owner-approved retention and deletion decisions;
- the next update check date.

Keep secrets, raw private content, questions, answers, filenames, paths, invite
links, passkey identifiers, and authentication details out of the receipt.

## Owner handoff

Before closing the session, the owner should be able to:

1. open the app and sign in with a passkey;
2. ask one supported and one unsupported question;
3. see source freshness and a partial or unavailable state;
4. run `brain doctor <manifest>`;
5. preview the local support note with `brain support --preview`;
6. identify the manifest and private local evaluation suite without sharing
   their paths publicly;
7. revoke the temporary Cloudflare token and verify the Brain still works;
8. explain who can access the Brain and how to remove that access;
9. find the approved support profile and update page.

## Future update notification

The public release feed is `https://financialbrain.ai/update/manifest.json` and
the human and Claude guide is `https://financialbrain.ai/update`. A client app
may report **update available**, **current**, or **update check unavailable**.
Unavailable is not the same as current.

An update notice never performs a background update. It points the owner to the
reviewed page and this copyable prompt:

```text
Open https://financialbrain.ai/update, read the whole page, compare the reviewed release with my installed Brain, and explain the changes. Begin read-only. If an update is available, ask before the Cloudflare update and keep every credential in its provider page or hidden terminal prompt. Finish with exact version, health, source freshness, vector backlog, and one known plus one unknown question.
```

After a successful update, record the exact version, recovery bookmark, health,
source freshness, vector backlog, release notes, and any live acceptance that
must be repeated. If the feed cannot be reached or validated, do not claim the
client is current.
