package main

import "testing"

// The two flags exist for one reason: a Windows Scheduled Task action cannot
// set an environment variable, so a supervisor has no other way to tell this
// process where the data directory is. Getting that wrong is not a cosmetic
// failure — the daemon would write its session store somewhere the drain never
// reads, and capture would look like it was working while nothing arrived.
func TestParseOptions(t *testing.T) {
	for _, tc := range []struct {
		name    string
		argv    []string
		dataDir string
		logFile string
		wantErr bool
	}{
		{name: "no arguments is valid", argv: nil},
		{name: "data dir alone", argv: []string{"--data-dir", `C:\Users\priya\.brain\whatsapp\acme`}, dataDir: `C:\Users\priya\.brain\whatsapp\acme`},
		{name: "log file alone", argv: []string{"--log-file", `C:\Users\priya\.brain\logs\acme.log`}, logFile: `C:\Users\priya\.brain\logs\acme.log`},
		{
			name:    "both, in either order",
			argv:    []string{"--log-file", "/tmp/a.log", "--data-dir", "/tmp/data"},
			dataDir: "/tmp/data",
			logFile: "/tmp/a.log",
		},
		{name: "a path with spaces survives", argv: []string{"--data-dir", `C:\Program Files\brain data`}, dataDir: `C:\Program Files\brain data`},
		{name: "a flag with no value is refused", argv: []string{"--data-dir"}, wantErr: true},
		{name: "an empty value is refused", argv: []string{"--log-file", ""}, wantErr: true},
		{name: "an unknown argument is refused, not ignored", argv: []string{"--send"}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseOptions(tc.argv)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected a refusal, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.dataDir != tc.dataDir {
				t.Errorf("dataDir = %q, want %q", got.dataDir, tc.dataDir)
			}
			if got.logFile != tc.logFile {
				t.Errorf("logFile = %q, want %q", got.logFile, tc.logFile)
			}
		})
	}
}

// The flag has to beat the environment, and it has to beat ONLY the name it
// overrides. A wrapper that swallowed every other lookup would silently discard
// WA_DB_PATH and WA_OUTBOX_PATH.
func TestGetenvWith(t *testing.T) {
	base := func(key string) string {
		switch key {
		case "WA_DATA_DIR":
			return "/from/environment"
		case "WA_OUTBOX_PATH":
			return "/explicit/outbox.db"
		}
		return ""
	}

	unchanged := getenvWith(base, "WA_DATA_DIR", "")
	if got := unchanged("WA_DATA_DIR"); got != "/from/environment" {
		t.Errorf("an empty flag must not override the environment: got %q", got)
	}

	overridden := getenvWith(base, "WA_DATA_DIR", "/from/flag")
	if got := overridden("WA_DATA_DIR"); got != "/from/flag" {
		t.Errorf("the flag must win: got %q", got)
	}
	if got := overridden("WA_OUTBOX_PATH"); got != "/explicit/outbox.db" {
		t.Errorf("every other name must fall through unchanged: got %q", got)
	}
	if got := overridden("WA_DB_PATH"); got != "" {
		t.Errorf("an unset name must stay unset: got %q", got)
	}
}
