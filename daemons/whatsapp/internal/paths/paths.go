// Package paths decides where the daemon keeps its two SQLite files.
//
// The rules, in priority order, and the reason they are strict:
//
//  1. An explicitly-set env var is ALWAYS honored, verbatim. The reference
//     implementation this daemon was ported from had a real bug here: after
//     reading WA_DB_PATH it checked for a deployment-specific mount directory
//     and, when that directory was absent (i.e. on every ordinary machine),
//     unconditionally overwrote the operator's explicit choice with a
//     cwd-relative "wa.db". Under a LaunchAgent or a Windows service the
//     working directory is unpredictable (launchd defaults to "/"), so
//     session state silently landed wherever the process happened to start.
//     Explicit configuration never loses to a heuristic here.
//
//  2. Defaults go to the platform's per-user application-data directory,
//     never the current working directory:
//     - macOS:   ~/Library/Application Support/financial-brain/whatsapp/
//     - Windows: %LOCALAPPDATA%\financial-brain\whatsapp\
//     - other:   $XDG_DATA_HOME/financial-brain/whatsapp/ or
//     ~/.local/share/financial-brain/whatsapp/
//
//  3. If no explicit path is set and no home/app-data directory can be
//     determined, Resolve returns an error. It never falls back to a
//     relative path.
package paths

import (
	"errors"
	"path/filepath"
)

// AppDirName is the vendor directory the daemon nests under inside the
// platform app-data directory. The CLI half (`brain connect whatsapp`,
// a later work package) may override the whole directory per-install via
// WA_DATA_DIR; this is the standalone default.
const AppDirName = "financial-brain"

// Env vars the daemon reads. All optional.
const (
	// EnvSessionDB points at the whatsmeow session store (device identity +
	// encryption keys). Kept as WA_DB_PATH for continuity with the reference
	// daemon — but here it is always honored when set.
	EnvSessionDB = "WA_DB_PATH"
	// EnvOutboxDB points at the captured-message outbox database.
	EnvOutboxDB = "WA_OUTBOX_PATH"
	// EnvDataDir moves the whole data directory; individual files not
	// explicitly overridden default inside it.
	EnvDataDir = "WA_DATA_DIR"
)

// Default file names inside the data directory.
const (
	SessionDBName = "wa-session.db"
	OutboxDBName  = "wa-outbox.db"
)

// Env carries the ambient inputs so resolution is a pure, testable function.
type Env struct {
	// Getenv looks up an environment variable ("" when unset).
	Getenv func(string) string
	// GOOS is runtime.GOOS in production; injected in tests.
	GOOS string
	// Home is the user's home directory (os.UserHomeDir); may be "".
	Home string
}

// Resolved is where everything lives.
type Resolved struct {
	// DataDir is the directory the daemon should create (0700). It is ""
	// when BOTH files were explicitly overridden, in which case the daemon
	// creates each file's parent directory instead.
	DataDir   string
	SessionDB string
	OutboxDB  string
}

// ErrNoHome means no explicit path was configured and the platform app-data
// location could not be determined. The daemon refuses to guess.
var ErrNoHome = errors.New("cannot resolve a data directory: no explicit path set (WA_DATA_DIR / WA_DB_PATH / WA_OUTBOX_PATH) and the user home / app-data directory is unknown; refusing to write into the working directory")

// Resolve applies the rules documented on the package.
func Resolve(env Env) (Resolved, error) {
	getenv := env.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}

	explicitSession := getenv(EnvSessionDB)
	explicitOutbox := getenv(EnvOutboxDB)

	var out Resolved
	out.SessionDB = explicitSession
	out.OutboxDB = explicitOutbox

	// Both files explicitly placed: no default directory needed at all.
	if explicitSession != "" && explicitOutbox != "" {
		return out, nil
	}

	dataDir := getenv(EnvDataDir)
	if dataDir == "" {
		base, err := platformDataDir(env, getenv)
		if err != nil {
			return Resolved{}, err
		}
		dataDir = filepath.Join(base, AppDirName, "whatsapp")
	}
	out.DataDir = dataDir
	if out.SessionDB == "" {
		out.SessionDB = filepath.Join(dataDir, SessionDBName)
	}
	if out.OutboxDB == "" {
		out.OutboxDB = filepath.Join(dataDir, OutboxDBName)
	}
	return out, nil
}

// platformDataDir returns the per-user application-data base directory for
// the platform, or ErrNoHome. Never a relative path.
func platformDataDir(env Env, getenv func(string) string) (string, error) {
	switch env.GOOS {
	case "darwin":
		if env.Home == "" {
			return "", ErrNoHome
		}
		return filepath.Join(env.Home, "Library", "Application Support"), nil
	case "windows":
		if v := getenv("LOCALAPPDATA"); v != "" {
			return v, nil
		}
		if env.Home != "" {
			return filepath.Join(env.Home, "AppData", "Local"), nil
		}
		return "", ErrNoHome
	default:
		if v := getenv("XDG_DATA_HOME"); v != "" {
			return filepath.Join(v), nil
		}
		if env.Home != "" {
			return filepath.Join(env.Home, ".local", "share"), nil
		}
		return "", ErrNoHome
	}
}
