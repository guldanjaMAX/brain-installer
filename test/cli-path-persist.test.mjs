// `brain` must survive a new terminal.
//
// The install uses a user npm prefix, and the page had the client export its
// bin directory for the current session only. On a real install the command
// vanished twice on one machine, once per new window, and read as the product
// uninstalling itself. brain tools now writes the export into every shell
// profile a Mac or Linux box reads, idempotently, and names the folder on
// Windows rather than touching PATH with setx.

import { brainCliPrefix, persistCliPath, renderCliCommands, runningCliBinDir } from "../brain.mjs";

let fail = 0, ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  console.log((condition ? "PASS  " : "FAIL  ") + name + (condition ? "" : "  " + String(detail).slice(0, 240)));
  if (!condition) fail++;
};

const fakeFs = (initial = {}) => {
  const files = { ...initial };
  return {
    files,
    existsSync: (f) => f in files,
    readFileSync: (f) => files[f],
    appendFileSync: (f, text) => { files[f] = (files[f] || "") + text; },
  };
};

const BIN = "/Users/client/.npm-global/bin";

{
  const fs = fakeFs({ "/Users/client/.zshrc": "export FOO=1\n" });
  const r = persistCliPath({ binDir: BIN, home: "/Users/client", platform: "darwin", ...fs });
  check("writes all three profiles on a Mac", r.action === "written" &&
    JSON.stringify(r.written) === JSON.stringify([".zshrc", ".bash_profile", ".bashrc"]), JSON.stringify(r));
  check("the export names the exact bin directory",
    fs.files["/Users/client/.zshrc"].includes(`export PATH="${BIN}:$PATH"`), fs.files["/Users/client/.zshrc"]);
  check("an existing profile keeps its content", fs.files["/Users/client/.zshrc"].startsWith("export FOO=1\n"));

  const again = persistCliPath({ binDir: BIN, home: "/Users/client", platform: "darwin", ...fs });
  check("a second run changes nothing", again.action === "present" && again.written.length === 0, JSON.stringify(again));
  check("no profile carries the line twice",
    fs.files["/Users/client/.zshrc"].split(BIN).length === 2, fs.files["/Users/client/.zshrc"]);
}

{
  const fs = fakeFs();
  const r = persistCliPath({ binDir: "/usr/local/bin", home: "/Users/client", platform: "darwin", ...fs });
  check("a system prefix is left alone", r.action === "skipped" && Object.keys(fs.files).length === 0, JSON.stringify(r));
}

{
  const fs = fakeFs();
  const r = persistCliPath({ binDir: "C:/Users/client/AppData/Roaming/npm", home: "C:/Users/client", platform: "win32", ...fs });
  check("Windows is told the folder and nothing is written",
    r.action === "manual" && /never setx/.test(r.reason) && Object.keys(fs.files).length === 0, JSON.stringify(r));
}

{
  const fs = fakeFs();
  fs.appendFileSync = () => { throw new Error("EACCES: permission denied"); };
  const r = persistCliPath({ binDir: BIN, home: "/Users/client", platform: "darwin", ...fs });
  check("a write failure is reported, not thrown", r.action === "failed" && /EACCES/.test(r.reason), JSON.stringify(r));
}

check("the bin directory is derived from a user-prefix install",
  runningCliBinDir("/Users/client/.npm-global/lib/node_modules/brain-installer/brain.mjs", "darwin") === BIN);
check("a Windows global install resolves to its prefix",
  runningCliBinDir("C:\\Users\\client\\AppData\\Roaming\\npm\\node_modules\\brain-installer\\brain.mjs", "win32") ===
    "C:/Users/client/AppData/Roaming/npm");
check("a source checkout has no bin directory to persist",
  runningCliBinDir("/Users/dev/brain-installer/brain.mjs", "darwin") === null);

{
  const options = {
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    scriptPath: "C:\\Users\\client\\AppData\\Roaming\\npm\\node_modules\\brain-installer\\brain.mjs",
  };
  const prefix = brainCliPrefix(options);
  const rendered = renderCliCommands(
    "Re-run `brain update <manifest>`; then use brain doctor <manifest> --repair.",
    options,
  );
  check("Windows recovery commands use the running Node and CLI paths",
    rendered.includes(`${prefix} update <manifest>`) && rendered.includes(`${prefix} doctor <manifest> --repair`),
    rendered);
  check("Windows recovery output contains no PATH-dependent bare brain command",
    !/\bbrain\s+(?:update|doctor)\b/.test(rendered), rendered);
  check("non-Windows recovery commands keep the short installed command",
    renderCliCommands("brain update <manifest>", { ...options, platform: "darwin" }) === "brain update <manifest>");
}

console.log(`\ncli path persistence: ${ran - fail}/${ran} passed`);
process.exit(fail ? 1 : 0);
