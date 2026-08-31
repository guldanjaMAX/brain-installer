import { useMemo, useState } from "react";
import { Confirm, Empty, Note, Row, Section } from "./ui";

const STORAGE_KEY = "financial-brain-customized-tasks-v1";
type SavedTasks = Record<string, string[]>;

function readSavedTasks(): SavedTasks {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: SavedTasks = {};
    for (const [scope, tasks] of Object.entries(parsed)) {
      if (!Array.isArray(tasks)) continue;
      clean[scope] = tasks
        .filter((task): task is string => typeof task === "string")
        .map((task) => task.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 20);
    }
    return clean;
  } catch {
    return {};
  }
}

function writeSavedTasks(tasks: SavedTasks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // The page still works for this visit. The note below never claims a save
    // succeeded when browser storage is unavailable.
  }
}

export function CustomizedTasks({
  scope,
  activeLabel,
  onRun,
}: {
  scope: string | null;
  activeLabel: string;
  onRun: (task: string) => void;
}) {
  const key = scope || "all";
  const [saved, setSaved] = useState<SavedTasks>(() => readSavedTasks());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const tasks = useMemo(() => saved[key] || [], [key, saved]);

  function replace(nextTasks: string[]) {
    const next = { ...saved, [key]: nextTasks.slice(0, 20) };
    setSaved(next);
    writeSavedTasks(next);
  }

  function add() {
    const value = draft.trim().slice(0, 300);
    if (!value) return;
    replace([...tasks, value]);
    setDraft("");
    setAdding(false);
  }

  function update(index: number) {
    const value = draft.trim().slice(0, 300);
    if (!value) return;
    replace(tasks.map((task, taskIndex) => taskIndex === index ? value : task));
    setDraft("");
    setEditing(null);
  }

  return (
    <div id="home-customized-tasks" className="scroll-mt-24">
      <Section
        title="Customized tasks"
        blurb={`Questions you return to for ${activeLabel}. Running one opens it as a new request. Nothing runs in the background.`}
        action={
          <button
            type="button"
            onClick={() => { setAdding(true); setEditing(null); setDraft(""); }}
            className="text-[13.5px] text-accent font-medium"
          >
            + Add task
          </button>
        }
      >
        <Note>Saved on this device. These are shortcuts, not automatic jobs.</Note>
        {adding && (
          <TaskEditor
            value={draft}
            setValue={setDraft}
            saveLabel="Add task"
            onSave={add}
            onCancel={() => { setAdding(false); setDraft(""); }}
          />
        )}
        {tasks.length === 0 && !adding ? (
          <Empty>No customized task is saved for this view.</Empty>
        ) : tasks.map((task, index) => editing === index ? (
          <TaskEditor
            key={`${key}:${index}`}
            value={draft}
            setValue={setDraft}
            saveLabel="Save"
            onSave={() => update(index)}
            onCancel={() => { setEditing(null); setDraft(""); }}
          />
        ) : (
          <Row key={`${key}:${index}:${task}`}>
            <span className="min-w-0 flex-1 text-[14.5px]">{task}</span>
            <span className="flex items-center gap-1 flex-wrap">
              <button
                type="button"
                onClick={() => onRun(task)}
                className="text-[13px] font-medium text-accent px-2 py-1 rounded-lg hover:bg-accent-soft"
              >
                Run
              </button>
              <button
                type="button"
                onClick={() => { setEditing(index); setAdding(false); setDraft(task); }}
                className="text-[13px] text-ink-soft px-2 py-1 rounded-lg hover:bg-paper"
              >
                Update
              </button>
              <Confirm
                label="Remove"
                question="Remove this task?"
                onConfirm={() => replace(tasks.filter((_, taskIndex) => taskIndex !== index))}
              />
            </span>
          </Row>
        ))}
      </Section>
    </div>
  );
}

function TaskEditor({ value, setValue, saveLabel, onSave, onCancel }: {
  value: string;
  setValue: (value: string) => void;
  saveLabel: string;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="p-4 border-b border-line last:border-b-0">
      <label className="block text-[13px] font-medium">
        Task wording
        <textarea
          autoFocus
          value={value}
          maxLength={300}
          rows={2}
          onChange={(event) => setValue(event.target.value)}
          className="mt-2 w-full rounded-xl border border-line bg-card px-3 py-2 text-[14px] leading-relaxed outline-none focus:border-accent resize-y"
          placeholder="Review monthly cash flow"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!value.trim()}
          onClick={onSave}
          className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-45"
        >
          {saveLabel}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-2 text-[13px] text-ink-soft">
          Cancel
        </button>
      </div>
    </div>
  );
}
