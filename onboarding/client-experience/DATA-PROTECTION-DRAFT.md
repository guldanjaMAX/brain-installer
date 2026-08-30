# Data protection and support terms draft

**Status: product draft for privacy counsel, contract counsel, and security
review. This document is not legal advice, legal approval, a signed data
processing agreement, or a final incident commitment.**

## Product facts to carry into counsel review

- The Brain is installed in the owner's Cloudflare account. The owner controls
  the Cloudflare account, plan, hostname, resources, provider connections, and
  physical passkeys.
- Original provider files remain in their source unless the owner separately
  configures optional R2 file storage. Extracted text, source metadata, access
  state, and operating records can be stored in the owner's D1 database.
- Semantic vectors and their limited metadata are stored in the owner's
  Vectorize index. Workers AI processes retrieval and answer-generation inputs
  inside the owner's Cloudflare configuration.
- Provider credentials are entered in provider pages or hidden terminal
  prompts and stored only through the released protected credential path. They
  are not placed in the manifest, website, customer packet, support journal, or
  acceptance receipt.
- Claude Code is an owner-controlled client. When the owner deliberately asks
  Claude to use the Brain, the question and returned answer or excerpts may be
  processed under the owner's Anthropic agreement. Counsel should confirm
  whether this is client-directed processing rather than a vendor subprocessor.
- The local support journal is private and is not uploaded automatically. A
  support preview is shared only when the owner chooses to send a sanitized
  excerpt through an approved channel.
- The candidate gives Financial Brain support no standing access to an owner's
  live Brain. Temporary read-only diagnostics require a separate owner action,
  remain visible and revocable, and expire automatically.

## Draft role and subprocessor table

| Party or service | Current technical role | Counsel question |
|---|---|---|
| Owner or customer | Controls the Cloudflare and source-provider accounts, approved sources, users, retention, and deletion decisions | Confirm controller or business role in the engagement |
| Financial Brain service team | Supplies software, installation guidance, and owner-approved support | Define processor, service provider, independent contractor, and professional-services boundaries |
| Cloudflare | Hosts the owner's Worker, D1, Vectorize, optional R2, and Workers AI in the owner's account | Confirm whether Cloudflare is customer-direct, vendor subprocessor, or both for each service |
| GitHub | Distributes the public immutable installer asset | Confirm that no customer content is processed and document package-log retention |
| Anthropic or another owner-selected AI client | Processes content only when the owner deliberately uses that client with the Brain | Confirm client-directed status and disclosure language |
| Google, Zoom, mail, bank, message, storage, or other source providers | Supply only the sources the owner connects or exports | Treat each as customer-directed unless a Financial Brain contract or credential changes the role |
| Approved support channel | Receives only the sanitized material the owner elects to share | Name the actual channel and retention before delivery |

Do not list a provider as live merely because a connector or fixture exists.
The final list must match the specific engagement and current released paths.

## Draft retention schedule for decision

Counsel and the owner should set values for these categories before client
delivery:

| Category | Technical location | Draft trigger | Decision still required |
|---|---|---|---|
| Extracted document text and source metadata | Owner D1 | Retain while the source is approved and the service is active | Contractual maximum, legal holds, source-specific rules |
| Semantic vectors and vector metadata | Owner Vectorize | Delete through the released source-forget and vector-deletion workflow | Maximum completion window and backup treatment |
| Optional original file objects | Owner R2, only when enabled | Follow the owner's approved source and retention schedule | Whether R2 is enabled and any immutable-backup requirement |
| Authentication and provider credentials | Released protected credential stores in owner-controlled infrastructure or local Keychain | Revoke on disconnect, role change, incident, or handoff decision | Rotation cadence and residual provider-session treatment |
| Owner activity and access history | Owner D1 | Retain for an owner-approved audit period | Exact period and export requirements |
| Local support journal | Owner's computer | Owner clears with the released command after the support need ends | Default local retention and legal-hold exception |
| Golden 20 suite and evaluation artifacts | Owner's computer | Retain while useful for regression and handoff | Contractual duration and secure deletion procedure |
| Website access logs | Site hosting provider | Provider-controlled | Confirm categories, region, and deletion availability |

Deletion must preserve honest states while asynchronous vector deletion or a
provider revocation is still pending. A request is not reported complete until
the released path verifies the affected live systems. Counsel should define the
formal request clock without changing that technical proof boundary.

## Draft incident and support language

1. The owner reports suspected unauthorized access, credential exposure,
   unexplained source scope, or service unavailability through the configured
   incident contact.
2. The first responder records time, affected owner, observable systems, and a
   safe issue code without collecting credentials or raw private content.
3. Mutation stops when continued action could expand harm. Recovery artifacts
   and provider evidence are preserved only to the minimum approved extent.
4. The owner remains the approver for credential rotation, provider revocation,
   deletion, recovery, account transfer, and external notification unless a
   signed agreement says otherwise.
5. Notification timing, recipients, regulator obligations, insurance notice,
   and evidence retention must be set by counsel and the signed engagement. A
   configured response target is not a statutory-notice promise.
6. Closure requires verification of the live service path, affected access,
   source freshness, deletion or rotation completion, and any required owner
   communication.

## Counsel decisions before publication

- governing entities, addresses, jurisdictions, and contact roles;
- controller, processor, service-provider, and subprocessor classification;
- approved subprocessor list and change-notice process;
- data location, cross-border transfer, and government-request language;
- retention periods, deletion deadlines, backup treatment, and legal holds;
- incident definition, notification clock, security contact, and escalation;
- support coverage, response targets, exclusions, and service credits;
- warranty, limitation, professional-services, and regulated-data boundaries;
- treatment of financial, medical, legal, employment, child, biometric, and
  other sensitive data;
- customer export, termination, account transfer, and evidence requirements.
