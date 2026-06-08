// Editable validator-notes panel used in both the DAG-orbit right rail
// and the dossier body. Backed by the dataStore's userNotesOverlay —
// notes added/edited here will eventually be serialised (alongside
// flags) into the auditor's output JSON artifact. Historical notes from
// the input jsonl (`chunk.notes`) stay read-only and are rendered
// separately.
import React from 'react';
import { WF, inkBorder, L, Box, Chip } from './primitives.jsx';
import { useData } from './dataStore.jsx';

const SAVE_DEBOUNCE_MS = 500;

// Debounce that also exposes a flush() so callers can persist immediately
// (e.g. on blur) without waiting out the trailing delay.
function useDebouncedCallback(fn, delay) {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  const timer = React.useRef(null);
  const pending = React.useRef(null);

  const flush = React.useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null) {
      const args = pending.current;
      pending.current = null;
      fnRef.current(...args);
    }
  }, []);

  const debounced = React.useCallback((...args) => {
    pending.current = args;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pending.current = null;
      fnRef.current(...args);
    }, delay);
  }, [delay]);

  React.useEffect(() => () => flush(), [flush]);
  return [debounced, flush];
}

const noteTextareaStyle = {
  width: '100%',
  fontFamily: WF.monoFont,
  fontSize: 12,
  padding: 6,
  border: inkBorder(),
  background: WF.paper,
  boxSizing: 'border-box',
  resize: 'vertical',
};

// One existing note: an always-editable textarea that auto-saves while
// you type (debounced) and flushes on blur. Emptying it and blurring
// removes the note.
function NoteRow({ chunkId, note, onUpdate, onDelete }) {
  const [text, setText] = React.useState(note.text);

  const [save, flushSave] = useDebouncedCallback((value) => {
    if (value.trim()) onUpdate(chunkId, note.id, value);
  }, SAVE_DEBOUNCE_MS);

  const onChange = (e) => {
    setText(e.target.value);
    save(e.target.value);
  };

  const onBlur = () => {
    if (!text.trim()) {
      onDelete(chunkId, note.id);
    } else {
      flushSave();
    }
  };

  return (
    <Box style={{ padding: 8, borderLeft: `4px solid ${WF.ink}`, background: WF.paperAlt }}>
      <textarea
        value={text}
        onChange={onChange}
        onBlur={onBlur}
        rows={3}
        style={noteTextareaStyle}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
        <L mono size={10} color={WF.ink3}>{fmtStamp(note.editedAt || note.createdAt)}</L>
        <div style={{ flex: 1 }} />
        <Chip style={{ cursor: 'pointer' }} onClick={() => onDelete(chunkId, note.id)}>delete</Chip>
      </div>
    </Box>
  );
}

// The list + add-new flow for validator notes on a chunk. Auto-saves —
// existing notes persist as you type (debounced), and the draft commits
// on blur or ⌘⏎. Controlled by the dataStore.
export function ValidatorNotesEditor({ chunkId, notes = [], placeholder = 'add a validator note …' }) {
  const { addUserNote, updateUserNote, deleteUserNote } = useData();
  const [draft, setDraft] = React.useState('');

  const commitDraft = () => {
    if (!draft.trim()) return;
    addUserNote(chunkId, draft);
    setDraft('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {notes.length === 0 && (
        <L mono size={10} color={WF.ink3}>no validator notes yet</L>
      )}
      {notes.map((n) => (
        <NoteRow
          key={n.id}
          chunkId={chunkId}
          note={n}
          onUpdate={updateUserNote}
          onDelete={deleteUserNote}
        />
      ))}
      <div style={{ borderTop: `1px dashed ${WF.rule2}`, paddingTop: 8, marginTop: 4 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            // Cmd/Ctrl + Enter commits the draft without leaving the keyboard.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitDraft();
          }}
          placeholder={placeholder}
          rows={3}
          style={noteTextareaStyle}
        />
        <L mono size={10} color={WF.ink3} style={{ display: 'block', marginTop: 6 }}>
          auto-saves · ⌘⏎ or click away to add
        </L>
      </div>
    </div>
  );
}

function fmtStamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
