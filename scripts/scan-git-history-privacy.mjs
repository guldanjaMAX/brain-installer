#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_INDEX,
  safeIdentifier,
  scanIdentityText,
} from "./privacy-identity.mjs";
import { CONFIRMED, scan as scanCredentialShapes } from "../worker/src/lib/secret-scan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function childEnvironment() {
  return {
    PATH: process.env.PATH || "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
  };
}

function git(repo, args, { input = undefined, encoding = "utf8", maxBuffer = 512 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding,
    input,
    env: childEnvironment(),
    maxBuffer,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || result.error?.message || "git failed").trim();
    throw new Error(`git ${args[0]} failed: ${diagnostic}`);
  }
  return result.stdout;
}

function isAncestor(repo, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repo,
    encoding: "utf8",
    env: childEnvironment(),
    timeout: 30_000,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base failed: ${String(result.stderr || result.error?.message || "unknown error").trim()}`);
}

function resolveLocalRemoteRevision(repo, localName, objectId) {
  const local = spawnSync("git", ["rev-parse", "--verify", localName], {
    cwd: repo,
    encoding: "utf8",
    env: childEnvironment(),
    timeout: 30_000,
  });
  if (local.status === 0) {
    const localObjectId = String(local.stdout).trim();
    if (localObjectId !== objectId) {
      throw new Error("the local public-ref snapshot is stale; fetch full history deliberately before scanning");
    }
    return localName;
  }

  // A brand-new repository's first Actions checkout can contain the exact
  // checked-out object without creating refs/remotes/origin/<branch>. Accept
  // that object only after exact local readback; missing server objects still
  // fail closed instead of making the scanner fetch with ambient credentials.
  const object = spawnSync("git", ["cat-file", "-e", `${objectId}^{object}`], {
    cwd: repo,
    encoding: "utf8",
    env: childEnvironment(),
    timeout: 30_000,
  });
  if (object.status !== 0) {
    throw new Error("the local checkout is missing a server-visible object; fetch full history deliberately before scanning");
  }
  return objectId;
}

function loadRefManifest(refManifest) {
  if (!refManifest) return null;
  const manifest = JSON.parse(readFileSync(refManifest, "utf8"));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.refs) || !manifest.refs.length) {
    throw new Error("public-ref manifest has an unsupported schema");
  }
  const publicNames = new Set();
  for (const entry of manifest.refs) {
    if (!entry || typeof entry.public_ref !== "string" || typeof entry.local_ref !== "string" ||
        !/^[0-9a-f]{40,64}$/.test(entry.tip_object)) {
      throw new Error("public-ref manifest contains a malformed entry");
    }
    if (publicNames.has(entry.public_ref)) throw new Error("public-ref manifest contains a duplicate ref");
    publicNames.add(entry.public_ref);
  }
  return manifest.refs;
}

function publicRefs(repo, prefixes, explicitRefs, remote = null, refManifest = null) {
  const discovered = new Map();
  const manifestEntries = loadRefManifest(refManifest);
  if (remote) {
    const output = git(repo, ["ls-remote", "--refs", "--heads", "--tags", remote]);
    const serverRefs = new Map();
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const [objectId, publicName] = line.split(/\s+/, 2);
      const localName = publicName.startsWith("refs/heads/")
        ? `refs/remotes/${remote}/${publicName.slice("refs/heads/".length)}`
        : publicName;
      const revisionName = resolveLocalRemoteRevision(repo, localName, objectId);
      discovered.set(localName, { objectId, publicName, revisionName });
      serverRefs.set(publicName, { localName, objectId });
    }
    for (const entry of manifestEntries || []) {
      const observed = serverRefs.get(entry.public_ref);
      if (!observed || observed.localName !== entry.local_ref) {
        throw new Error("a reviewed public ref is missing or mapped differently on the server");
      }
      const movingHead = entry.public_ref.startsWith("refs/heads/");
      if ((!movingHead && observed.objectId !== entry.tip_object) ||
          (movingHead && !isAncestor(repo, entry.tip_object, observed.objectId))) {
        throw new Error("a server public ref no longer descends from the committed incident inventory");
      }
    }
  } else if (manifestEntries) {
    for (const entry of manifestEntries) {
      if (scanIdentityText(entry.public_ref).length || scanIdentityText(entry.local_ref).length) {
        throw new Error("public-ref manifest contains a private identifier in a ref name");
      }
      const localObjectId = git(repo, ["rev-parse", "--verify", entry.local_ref]).trim();
      const movingHead = entry.public_ref.startsWith("refs/heads/");
      if ((!movingHead && localObjectId !== entry.tip_object) ||
          (movingHead && !isAncestor(repo, entry.tip_object, localObjectId))) {
        throw new Error("the local public-ref snapshot no longer descends from the committed incident inventory");
      }
      discovered.set(entry.local_ref, { objectId: localObjectId, publicName: entry.public_ref });
    }
  } else if (prefixes.length) {
    const output = git(repo, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      ...prefixes,
    ]);
    for (const line of output.split("\n")) {
      if (!line) continue;
      const [name, objectId] = line.split("\0");
      if (!name || !objectId || name.endsWith("/HEAD")) continue;
      discovered.set(name, { objectId, publicName: name });
    }
  }
  for (const name of explicitRefs) {
    if (!name || name.endsWith("/HEAD")) continue;
    const objectId = git(repo, ["rev-parse", "--verify", name]).trim();
    discovered.set(name, { objectId, publicName: name });
  }
  for (const [localName, { publicName }] of discovered) {
    const hasPrivateIdentifier = scanIdentityText(localName).length || scanIdentityText(publicName).length;
    const hasCredentialShape = [localName, publicName].some((name) =>
      scanCredentialShapes(name).findings.some((finding) => finding.severity === CONFIRMED));
    if (hasPrivateIdentifier || hasCredentialShape) {
      throw new Error("a selected public ref name contains private or credential-shaped material");
    }
  }
  const refs = [...discovered].map(([name, value]) => {
    const { objectId, publicName, revisionName = name } = value;
    let commitId = null;
    try {
      commitId = git(repo, ["rev-parse", "--verify", `${revisionName}^{commit}`]).trim();
    } catch {
      // A public ref can legally point at a non-commit object. It is still
      // inventoried and scanned, but has no commit graph to traverse.
    }
    return {
      name: revisionName,
      display_name: safeIdentifier(publicName, "redacted-ref"),
      object_id: objectId,
      commit_id: commitId,
    };
  }).sort((a, b) => a.display_name.localeCompare(b.display_name) || a.object_id.localeCompare(b.object_id));
  if (!refs.length) throw new Error("no public refs were found; pass --ref or --ref-prefix explicitly");
  return refs;
}

function objectInventory(repo, refs) {
  const revisionInput = `${refs.map((ref) => ref.name).join("\n")}\n`;
  const raw = git(repo, ["rev-list", "--objects", "--stdin"], { input: revisionInput });
  const objectIds = new Set();
  const pathFindings = new Map();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" ");
    const objectId = separator === -1 ? line : line.slice(0, separator);
    if (!/^[0-9a-f]{40,64}$/.test(objectId)) {
      throw new Error("git returned a malformed object id during history enumeration");
    }
    objectIds.add(objectId);
  }

  const ids = [...objectIds].sort();
  const checked = git(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: `${ids.join("\n")}\n`,
  });
  const objects = checked.trim().split("\n").filter(Boolean).map((line) => {
    const [objectId, type, sizeText] = line.split(" ");
    const size = Number(sizeText);
    if (!/^[0-9a-f]{40,64}$/.test(objectId) || !type || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("git returned malformed object metadata");
    }
    return { object_id: objectId, type, size };
  });
  return { objects, pathFindings };
}

function readBatch(repo, objects) {
  if (!objects.length) return new Map();
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repo,
    encoding: null,
    input: Buffer.from(`${objects.map((object) => object.object_id).join("\n")}\n`, "utf8"),
    env: childEnvironment(),
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`git cat-file failed: ${String(result.stderr || result.error?.message || "unknown error").trim()}`);
  }
  const output = result.stdout;
  const contents = new Map();
  let offset = 0;
  for (const expected of objects) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) throw new Error("git cat-file output ended before its header");
    const header = output.subarray(offset, newline).toString("utf8");
    const [objectId, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (objectId !== expected.object_id || type !== expected.type || size !== expected.size) {
      throw new Error("git cat-file output did not match the requested object inventory");
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 10) {
      throw new Error("git cat-file output ended before an object body completed");
    }
    contents.set(objectId, output.subarray(start, end));
    offset = end + 1;
  }
  return contents;
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  if (!sample.length) return false;
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) control++;
  }
  return control / sample.length > 0.1;
}

function messageBody(type, text) {
  if (type !== "commit" && type !== "tag") return text;
  const boundary = text.indexOf("\n\n");
  return boundary === -1 ? "" : text.slice(boundary + 2);
}

function scanPathMaterial(path, identityIndex) {
  const findings = new Map(scanIdentityText(path, identityIndex).map((finding) =>
    [`${finding.kind}:${finding.label}`, finding]));
  for (const credential of scanCredentialShapes(path).findings) {
    if (credential.severity !== CONFIRMED) continue;
    const finding = { kind: "credential_candidate", label: credential.label };
    findings.set(`${finding.kind}:${finding.label}`, finding);
  }
  return [...findings.values()];
}

function parseTreeEntries(buffer, objectIdLength) {
  const entries = [];
  const oidBytes = objectIdLength / 2;
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    const nul = buffer.indexOf(0, space + 1);
    if (space === -1 || nul === -1 || nul + 1 + oidBytes > buffer.length) {
      throw new Error("git tree object is malformed");
    }
    const mode = buffer.subarray(offset, space).toString("ascii");
    const name = buffer.subarray(space + 1, nul).toString("utf8");
    const objectId = buffer.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
    entries.push({ mode, name, objectId });
    offset = nul + 1 + oidBytes;
  }
  return entries;
}

function addCompleteTreePathFindings(inventory, contents, identityIndex) {
  const objectById = new Map(inventory.objects.map((object) => [object.object_id, object]));
  const treeEntries = new Map();
  for (const object of inventory.objects) {
    if (object.type !== "tree") continue;
    treeEntries.set(object.object_id, parseTreeEntries(contents.get(object.object_id), object.object_id.length));
  }
  const rootTrees = new Set();
  for (const object of inventory.objects) {
    if (object.type !== "commit") continue;
    const firstLine = contents.get(object.object_id).toString("utf8", 0, 96).split("\n", 1)[0];
    const match = /^tree ([0-9a-f]{40,64})$/.exec(firstLine);
    if (!match) throw new Error("git commit object has no valid root tree");
    rootTrees.add(match[1]);
  }

  const visited = new Set();
  const scanTree = (treeId, prefix) => {
    const visitKey = `${treeId}\0${prefix}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const entries = treeEntries.get(treeId);
    if (!entries) throw new Error("reachable commit references a missing tree object");
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const findings = scanPathMaterial(fullPath, identityIndex);
      if (findings.length) {
        const existing = inventory.pathFindings.get(entry.objectId) || [];
        const combined = new Map([...existing, ...findings].map((finding) =>
          [`${finding.kind}:${finding.label}`, finding]));
        inventory.pathFindings.set(entry.objectId, [...combined.values()]);
      }
      if (entry.mode === "40000" || entry.mode === "040000" || objectById.get(entry.objectId)?.type === "tree") {
        scanTree(entry.objectId, fullPath);
      }
    }
  };
  for (const rootTree of rootTrees) scanTree(rootTree, "");
}

function addClassification(target, finding, location) {
  const key = `${finding.kind}:${finding.label}`;
  target.classifications.set(key, { kind: finding.kind, category: finding.label });
  target.locations.add(location);
}

function scanObjects(repo, inventory, identityIndex) {
  const readableObjects = inventory.objects.filter((object) => ["blob", "commit", "tag"].includes(object.type));
  const contents = readBatch(repo, inventory.objects);
  addCompleteTreePathFindings(inventory, contents, identityIndex);
  const findings = new Map();
  const ensure = (object) => {
    if (!findings.has(object.object_id)) {
      findings.set(object.object_id, {
        object_id: object.object_id,
        object_type: object.type,
        classifications: new Map(),
        locations: new Set(),
      });
    }
    return findings.get(object.object_id);
  };

  let binaryBlobCount = 0;
  for (const object of readableObjects) {
    const pathHits = inventory.pathFindings.get(object.object_id) || [];
    for (const finding of pathHits) addClassification(ensure(object), finding, "path");

    const buffer = contents.get(object.object_id);
    if (object.type === "blob" && looksBinary(buffer)) {
      binaryBlobCount++;
      continue;
    }
    const text = messageBody(object.type, buffer.toString("utf8"));
    for (const finding of scanIdentityText(text, identityIndex)) {
      addClassification(ensure(object), finding, object.type === "blob" ? "content" : "message");
    }
    const credentialResult = scanCredentialShapes(text);
    for (const credential of credentialResult.findings) {
      if (credential.severity !== CONFIRMED) continue;
      addClassification(ensure(object), { kind: "credential_candidate", label: credential.label },
        object.type === "blob" ? "content" : "message");
    }
  }

  return {
    binaryBlobCount,
    findings: [...findings.values()].map((finding) => ({
      object_id: finding.object_id,
      object_type: finding.object_type,
      classifications: [...finding.classifications.values()].sort((a, b) =>
        a.kind.localeCompare(b.kind) || a.category.localeCompare(b.category)),
      locations: [...finding.locations].sort(),
      reachable_from: [],
    })).sort((a, b) => a.object_id.localeCompare(b.object_id)),
  };
}

function addReachability(repo, refs, findings) {
  const byObject = new Map(findings.map((finding) => [finding.object_id, finding]));
  for (const ref of refs) {
    const ids = new Set();
    if (ref.commit_id) {
      const raw = git(repo, ["rev-list", "--objects", ref.name]);
      for (const line of raw.split("\n")) {
        if (!line) continue;
        ids.add(line.split(" ", 1)[0]);
      }
    } else {
      ids.add(ref.object_id);
    }
    for (const objectId of ids) {
      const finding = byObject.get(objectId);
      if (finding) finding.reachable_from.push(ref.display_name);
    }
  }
  for (const finding of findings) finding.reachable_from.sort();
}

function categorySummary(findings) {
  const categories = new Map();
  for (const finding of findings) {
    for (const classification of finding.classifications) {
      const key = `${classification.kind}:${classification.category}`;
      const current = categories.get(key) || {
        kind: classification.kind,
        category: classification.category,
        object_count: 0,
      };
      current.object_count++;
      categories.set(key, current);
    }
  }
  return [...categories.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.category.localeCompare(b.category));
}

export function baselineFromReport(report) {
  return {
    schema_version: 1,
    finding_objects: report.finding_objects.map((finding) => ({
      object_id: finding.object_id,
      object_type: finding.object_type,
      classifications: finding.classifications,
      locations: finding.locations,
    })),
  };
}

export function compareBaseline(report, baseline) {
  if (!baseline || baseline.schema_version !== 1 || !Array.isArray(baseline.finding_objects)) {
    throw new Error("history baseline has an unsupported schema");
  }
  const actual = JSON.stringify(baselineFromReport(report));
  const expected = JSON.stringify(baseline);
  return {
    matches: actual === expected,
    actual_finding_objects: report.finding_objects.length,
    expected_finding_objects: baseline.finding_objects.length,
  };
}

export function evaluateStrictRelease(report, dispositions) {
  if (!dispositions || dispositions.schema_version !== 1 || !Array.isArray(dispositions.approved_candidates)) {
    throw new Error("credential disposition file has an unsupported schema");
  }
  const allowedDispositions = new Set(["synthetic_fixture", "scanner_source", "public_documentation_example"]);
  const approved = new Set();
  for (const entry of dispositions.approved_candidates) {
    if (!entry || !/^[0-9a-f]{40,64}$/.test(entry.object_id) ||
        typeof entry.category !== "string" || !allowedDispositions.has(entry.disposition)) {
      throw new Error("credential disposition file contains a malformed entry");
    }
    const key = `${entry.object_id}:${entry.category}`;
    if (approved.has(key)) throw new Error("credential disposition file contains a duplicate entry");
    approved.add(key);
  }

  const observedCandidates = new Set();
  const blockingObjects = new Set();
  for (const finding of report.finding_objects) {
    for (const classification of finding.classifications) {
      if (classification.kind === "credential_candidate") {
        const key = `${finding.object_id}:${classification.category}`;
        observedCandidates.add(key);
        if (!approved.has(key)) blockingObjects.add(finding.object_id);
      } else {
        // Ordinary privacy and known-revoked credentials are never allowlisted
        // for a clean public release.
        blockingObjects.add(finding.object_id);
      }
    }
  }
  const staleDispositions = [...approved].filter((key) => !observedCandidates.has(key));
  return {
    passes: blockingObjects.size === 0 && staleDispositions.length === 0,
    blocking_object_count: blockingObjects.size,
    approved_candidate_count: approved.size,
    stale_disposition_count: staleDispositions.length,
  };
}

export function scanRepository({
  repo = ROOT,
  refPrefixes = ["refs/remotes/origin", "refs/tags"],
  refs: explicitRefs = [],
  remote = null,
  refManifest = null,
  identityIndex = IDENTITY_INDEX,
} = {}) {
  const root = git(repo, ["rev-parse", "--show-toplevel"]).trim();
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  if (shallow) throw new Error("full-history privacy scanning refuses a shallow repository");
  const refs = publicRefs(root, refPrefixes, explicitRefs, remote, refManifest);
  const inventory = objectInventory(root, refs);
  const scanned = scanObjects(root, inventory, identityIndex);
  addReachability(root, refs, scanned.findings);

  const commitIds = refs.filter((ref) => ref.commit_id).map((ref) => ref.name);
  const commits = commitIds.length
    ? git(root, ["rev-list", "--count", ...commitIds]).trim()
    : "0";
  const typeCounts = new Map();
  for (const object of inventory.objects) typeCounts.set(object.type, (typeCounts.get(object.type) || 0) + 1);
  const affectedRefs = refs.map((ref) => {
    const reachable = scanned.findings.filter((finding) => finding.reachable_from.includes(ref.display_name));
    return {
      ref: ref.display_name,
      tip_object: ref.object_id,
      finding_object_count: reachable.length,
      credential_object_count: reachable.filter((finding) =>
        finding.classifications.some((item) => item.kind !== "privacy")).length,
      privacy_object_count: reachable.filter((finding) =>
        finding.classifications.some((item) => item.kind === "privacy")).length,
    };
  }).filter((ref) => ref.finding_object_count > 0);

  return {
    schema_version: 1,
    scanner_policy: {
      public_ref_prefixes: [...refPrefixes].sort(),
      explicit_ref_count: explicitRefs.length,
      ref_source: remote
        ? `remote:${remote}${refManifest ? "+committed-manifest" : ""}`
        : refManifest ? "committed-manifest" : "local-ref-prefixes",
      shallow_repository: false,
      commit_headers_excluded: true,
      binary_blob_contents_excluded: true,
      matched_values_and_raw_paths_emitted: false,
    },
    inventory: {
      public_ref_count: refs.length,
      commit_count: Number(commits),
      object_count: inventory.objects.length,
      blob_count: typeCounts.get("blob") || 0,
      tree_count: typeCounts.get("tree") || 0,
      tag_object_count: typeCounts.get("tag") || 0,
      binary_blob_count: scanned.binaryBlobCount,
    },
    categories: categorySummary(scanned.findings),
    affected_public_refs: affectedRefs,
    finding_objects: scanned.findings,
  };
}

function parseArgs(argv) {
  const options = {
    repo: ROOT,
    refPrefixes: ["refs/remotes/origin", "refs/tags"],
    refs: [],
    format: "summary",
    baseline: null,
    recordBaseline: null,
    requireClean: false,
    requireZeroFindings: false,
    remote: null,
    refManifest: null,
    credentialDispositions: resolve(ROOT, "privacy/credential-dispositions.json"),
  };
  let customRefSelection = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--repo") options.repo = resolve(argv[++index] || "");
    else if (arg === "--ref-prefix") {
      if (!customRefSelection) options.refPrefixes = [];
      customRefSelection = true;
      options.refPrefixes.push(argv[++index] || "");
    } else if (arg === "--ref") {
      if (!customRefSelection) options.refPrefixes = [];
      customRefSelection = true;
      options.refs.push(argv[++index] || "");
    } else if (arg === "--remote") {
      if (customRefSelection && options.refPrefixes.length) {
        throw new Error("--remote cannot be combined with --ref-prefix");
      }
      customRefSelection = true;
      options.refPrefixes = [];
      options.remote = argv[++index] || "";
    } else if (arg === "--ref-manifest") {
      if (customRefSelection && !options.remote) {
        throw new Error("--ref-manifest cannot be combined with --ref or --ref-prefix");
      }
      customRefSelection = true;
      options.refPrefixes = [];
      options.refManifest = resolve(argv[++index] || "");
    } else if (arg === "--format") options.format = argv[++index] || "";
    else if (arg === "--baseline") options.baseline = resolve(argv[++index] || "");
    else if (arg === "--record-baseline") options.recordBaseline = resolve(argv[++index] || "");
    else if (arg === "--require-clean") options.requireClean = true;
    else if (arg === "--require-zero-findings") options.requireZeroFindings = true;
    else if (arg === "--credential-dispositions") {
      options.credentialDispositions = resolve(argv[++index] || "");
    }
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.refPrefixes.every(Boolean) || !options.refs.every(Boolean)) throw new Error("ref selection cannot be empty");
  if (options.remote === "" || options.refManifest === "") throw new Error("ref selection cannot be empty");
  if (!options.credentialDispositions) throw new Error("credential disposition path cannot be empty");
  if (!["summary", "json"].includes(options.format)) throw new Error("--format must be summary or json");
  if ([options.baseline, options.recordBaseline, options.requireClean, options.requireZeroFindings].filter(Boolean).length > 1) {
    throw new Error("--baseline, --record-baseline, --require-clean, and --require-zero-findings are mutually exclusive");
  }
  return options;
}

function printSummary(report) {
  console.log(`history inventory: ${report.inventory.public_ref_count} public refs, ` +
    `${report.inventory.commit_count} commits, ${report.inventory.object_count} objects`);
  console.log(`sanitized findings: ${report.finding_objects.length} objects across ${report.categories.length} categories`);
  for (const category of report.categories) {
    console.log(`  ${category.kind}: ${category.category} (${category.object_count} object(s))`);
  }
  for (const ref of report.affected_public_refs) {
    console.log(`  ref ${ref.ref}: ${ref.finding_object_count} finding object(s), ` +
      `${ref.credential_object_count} credential, ${ref.privacy_object_count} privacy`);
  }
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log("usage: node scripts/scan-git-history-privacy.mjs [--repo PATH] [--remote NAME] [--ref-manifest FILE | --ref-prefix REF | --ref REF] [--format summary|json] [--baseline FILE | --record-baseline FILE | --require-clean | --require-zero-findings] [--credential-dispositions FILE]");
      return 0;
    }
    const report = scanRepository(options);
    if (options.format === "json") console.log(JSON.stringify(report, null, 2));
    else printSummary(report);

    if (options.recordBaseline) {
      writeFileSync(options.recordBaseline, `${JSON.stringify(baselineFromReport(report), null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      console.log(`RECORDED  sanitized baseline with ${report.finding_objects.length} finding object(s)`);
      return 0;
    }

    if (options.baseline) {
      const comparison = compareBaseline(report, JSON.parse(readFileSync(options.baseline, "utf8")));
      if (!comparison.matches) {
        console.error(`FAIL  full-history privacy baseline changed: expected ${comparison.expected_finding_objects}, observed ${comparison.actual_finding_objects}`);
        return 1;
      }
      console.log(`PASS  full-history privacy baseline contains exactly ${comparison.actual_finding_objects} known finding object(s)`);
      return 0;
    }
    if (options.requireClean) {
      const dispositions = JSON.parse(readFileSync(options.credentialDispositions, "utf8"));
      const strict = evaluateStrictRelease(report, dispositions);
      if (!strict.passes) {
        console.error(`FAIL  strict release gate found ${strict.blocking_object_count} blocking object(s) and ` +
          `${strict.stale_disposition_count} stale credential disposition(s)`);
        return 1;
      }
      console.log(`PASS  strict release gate found no privacy or revoked-credential objects and exactly ` +
        `${strict.approved_candidate_count} reviewed synthetic credential candidate(s)`);
    }
    if (options.requireZeroFindings) {
      if (report.finding_objects.length !== 0) {
        console.error(`FAIL  zero-finding history gate found ${report.finding_objects.length} finding object(s)`);
        return 1;
      }
      console.log("PASS  zero-finding history gate found exactly 0 finding objects");
    }
    return 0;
  } catch (error) {
    console.error(`FAIL  full-history privacy scan: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
