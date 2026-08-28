package paths

import (
	"path/filepath"
	"strings"
	"testing"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// The bug this package exists to fix: an explicitly-set WA_DB_PATH must be
// honored even though the deployment mount directory ("/data" in the
// reference daemon) does not exist on this machine. There is no directory
// probe left in the code at all; this test pins that an explicit value
// survives resolution verbatim on every platform.
func TestExplicitEnvAlwaysHonored(t *testing.T) {
	for _, goos := range []string{"darwin", "windows", "linux"} {
		r, err := Resolve(Env{
			Getenv: envMap(map[string]string{
				EnvSessionDB: "/custom/place/session.db",
				EnvOutboxDB:  "/custom/place/outbox.db",
			}),
			GOOS: goos,
			Home: "", // even with NO home dir, explicit paths must work
		})
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", goos, err)
		}
		if r.SessionDB != "/custom/place/session.db" {
			t.Fatalf("%s: explicit session path not honored: %q", goos, r.SessionDB)
		}
		if r.OutboxDB != "/custom/place/outbox.db" {
			t.Fatalf("%s: explicit outbox path not honored: %q", goos, r.OutboxDB)
		}
		if r.DataDir != "" {
			t.Fatalf("%s: no default dir should be computed when both files are explicit, got %q", goos, r.DataDir)
		}
	}
}

func TestExplicitSessionOnlyStillDefaultsOutbox(t *testing.T) {
	r, err := Resolve(Env{
		Getenv: envMap(map[string]string{EnvSessionDB: "/keep/this/wa.db"}),
		GOOS:   "darwin",
		Home:   "/Users/client",
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.SessionDB != "/keep/this/wa.db" {
		t.Fatalf("explicit session path not honored: %q", r.SessionDB)
	}
	want := filepath.Join("/Users/client", "Library", "Application Support", AppDirName, "whatsapp", OutboxDBName)
	if r.OutboxDB != want {
		t.Fatalf("outbox default wrong: got %q want %q", r.OutboxDB, want)
	}
}

func TestDataDirEnvMovesBothDefaults(t *testing.T) {
	r, err := Resolve(Env{
		Getenv: envMap(map[string]string{EnvDataDir: "/srv/brain-wa"}),
		GOOS:   "linux",
		Home:   "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.DataDir != "/srv/brain-wa" {
		t.Fatalf("data dir env not honored: %q", r.DataDir)
	}
	if r.SessionDB != filepath.Join("/srv/brain-wa", SessionDBName) {
		t.Fatalf("session default not inside data dir: %q", r.SessionDB)
	}
	if r.OutboxDB != filepath.Join("/srv/brain-wa", OutboxDBName) {
		t.Fatalf("outbox default not inside data dir: %q", r.OutboxDB)
	}
}

func TestDarwinDefault(t *testing.T) {
	r, err := Resolve(Env{Getenv: envMap(nil), GOOS: "darwin", Home: "/Users/client"})
	if err != nil {
		t.Fatal(err)
	}
	wantDir := "/Users/client/Library/Application Support/financial-brain/whatsapp"
	if r.DataDir != wantDir {
		t.Fatalf("darwin default dir: got %q want %q", r.DataDir, wantDir)
	}
	if !strings.HasPrefix(r.SessionDB, wantDir) || !strings.HasPrefix(r.OutboxDB, wantDir) {
		t.Fatalf("files not inside default dir: %q %q", r.SessionDB, r.OutboxDB)
	}
	if !filepath.IsAbs(r.SessionDB) || !filepath.IsAbs(r.OutboxDB) {
		t.Fatalf("default paths must be absolute: %q %q", r.SessionDB, r.OutboxDB)
	}
}

func TestWindowsDefaultPrefersLocalAppData(t *testing.T) {
	r, err := Resolve(Env{
		Getenv: envMap(map[string]string{"LOCALAPPDATA": `C:\Users\client\AppData\Local`}),
		GOOS:   "windows",
		Home:   `C:\Users\client`,
	})
	if err != nil {
		t.Fatal(err)
	}
	// filepath on the test host is POSIX, so assert on components rather
	// than separator style.
	if !strings.Contains(r.DataDir, `AppData\Local`) {
		t.Fatalf("windows default should be under LOCALAPPDATA: %q", r.DataDir)
	}
	if !strings.Contains(r.DataDir, AppDirName) || !strings.Contains(r.DataDir, "whatsapp") {
		t.Fatalf("windows default missing vendor/whatsapp components: %q", r.DataDir)
	}
}

func TestWindowsFallsBackToHomeWhenLocalAppDataUnset(t *testing.T) {
	r, err := Resolve(Env{Getenv: envMap(nil), GOOS: "windows", Home: `C:\Users\client`})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.DataDir, "AppData") {
		t.Fatalf("windows home fallback should build an AppData path: %q", r.DataDir)
	}
}

func TestLinuxHonorsXDGDataHome(t *testing.T) {
	r, err := Resolve(Env{
		Getenv: envMap(map[string]string{"XDG_DATA_HOME": "/home/client/.data"}),
		GOOS:   "linux",
		Home:   "/home/client",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(r.DataDir, "/home/client/.data") {
		t.Fatalf("XDG_DATA_HOME not honored: %q", r.DataDir)
	}
}

// No env, no home: refuse. Never a cwd-relative fallback.
func TestNoHomeErrorsInsteadOfCwdFallback(t *testing.T) {
	for _, goos := range []string{"darwin", "windows", "linux"} {
		_, err := Resolve(Env{Getenv: envMap(nil), GOOS: goos, Home: ""})
		if err == nil {
			t.Fatalf("%s: expected an error when nothing is resolvable, got none", goos)
		}
	}
}

// Belt and braces: whatever the resolution path, a default (non-explicit)
// result never produces a relative file path.
func TestDefaultsAreNeverRelative(t *testing.T) {
	cases := []Env{
		{Getenv: envMap(nil), GOOS: "darwin", Home: "/Users/x"},
		{Getenv: envMap(map[string]string{"XDG_DATA_HOME": "/xdg"}), GOOS: "linux", Home: "/home/x"},
		{Getenv: envMap(map[string]string{EnvDataDir: "/explicit/dir"}), GOOS: "windows", Home: ""},
	}
	for i, env := range cases {
		r, err := Resolve(env)
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if !filepath.IsAbs(r.SessionDB) || !filepath.IsAbs(r.OutboxDB) {
			t.Fatalf("case %d: relative path leaked: %q %q", i, r.SessionDB, r.OutboxDB)
		}
	}
}
