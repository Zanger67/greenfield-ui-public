// User groups ("tags") — the auditor's own grouping layer on top of flags.
// Flag an item (a commit, a sidecar group, a flagged area, a thread, a result
// doc), then tag it into a named group; later items reuse the same group via a
// fuzzy-matched "add to group" dropdown. Groups are first-class records in the
// data store (see createUserGroup et al.); their *own* annotations + flag live
// under a `usergroup:<id>` overlay key, so the existing ValidatorNotesEditor /
// AuditorPanel render them with no special-casing.
//
// This module owns the shared tag UI + the target-key resolver:
//   * TagEditor      — the chip-list + create/add-to-group combobox.
//   * FlagTags       — TagEditor under a "groups" heading, shown once an item is
//                      flagged (or already tagged), for the dossier / auditor panels.
//   * GroupTagChips  — read-only group chips for a target (overview rows).
//   * GroupBadge     — one coloured group pill.
//   * useDescribeTarget — resolve a membership target key back to a label + a
//                      navigation action, so a group's member list can route to
//                      each item's home screen.
import React from 'react';
import { WF, L, inkBorder } from './primitives.jsx';
import { useData } from './dataStore.jsx';

export const USERGROUP_PREFIX = 'usergroup:';
export const usergroupKey = (id) => `${USERGROUP_PREFIX}${id}`;

// Per-group accent, cycled by creation order so groups stay visually distinct.
// Reuses the categorical palette already defined for the semantic-area themes.
export const GROUP_PALETTE = [
  WF.catBlue, WF.catPurple, WF.catAmber, WF.catData, WF.catSlate, WF.catBlueGrey,
];
export const pickGroupColor = (i) => GROUP_PALETTE[((i % GROUP_PALETTE.length) + GROUP_PALETTE.length) % GROUP_PALETTE.length];

// Invert the membership map (targetKey → [groupId]) into groupId → [targetKey],
// so a group can list its members without scanning every target on each render.
export function reverseTagIndex(groupTags) {
  const out = {};
  for (const [targetKey, ids] of Object.entries(groupTags || {})) {
    for (const gid of ids || []) (out[gid] = out[gid] || []).push(targetKey);
  }
  return out;
}

// Subsequence-aware fuzzy score: a contiguous substring beats a scattered
// subsequence, an earlier hit beats a later one, and a shorter haystack breaks
// ties. Returns -1 for no match (so callers can filter), 0 for an empty query
// (everything matches equally, caller falls back to its own ordering).
export function fuzzyScore(q, text) {
  if (!q) return 0;
  const s = (text || '').toLowerCase();
  const query = q.toLowerCase();
  const idx = s.indexOf(query);
  if (idx >= 0) return 1000 - idx - s.length * 0.01;
  let qi = 0;
  for (let i = 0; i < s.length && qi < query.length; i += 1) {
    if (s[i] === query[qi]) qi += 1;
  }
  return qi === query.length ? 400 - s.length : -1;
}

// Resolve a membership target key back to a display descriptor + open action.
// Keys are either a bare commit event_id or a namespaced `prefix:rest` key.
// Labels resolve against the *ungated* data (rawData) so a member that's an
// AI-derived area/thread still names itself even when AI flags are toggled off.
export function useDescribeTarget() {
  const { data, rawData, openCommit, openGroup, openArea, openThread, openDoc } = useData();
  const src = rawData || data || {};
  const { byId = {}, chunks = [], semanticAreas = [], threads = [] } = src;
  return React.useCallback((targetKey) => {
    if (!targetKey) return null;
    const colon = targetKey.indexOf(':');
    const prefix = colon > 0 ? targetKey.slice(0, colon) : '';
    const rest = colon > 0 ? targetKey.slice(colon + 1) : targetKey;
    if (prefix === 'group') {
      const members = chunks.filter((c) => c.groupId === rest);
      const m0 = members[0];
      return {
        kind: 'group', icon: '▦',
        label: m0?.groupRoot || m0?.file || rest,
        sublabel: `group · ${members.length} commit${members.length === 1 ? '' : 's'}`,
        exists: members.length > 0,
        open: m0 ? () => openGroup(rest, m0.id) : null,
      };
    }
    if (prefix === 'area') {
      const a = semanticAreas.find((x) => x.area_id === rest);
      return { kind: 'area', icon: '◇', label: a?.title || rest, sublabel: 'flagged area', exists: !!a, open: () => openArea(rest) };
    }
    if (prefix === 'thread') {
      const t = threads.find((x) => x.thread_id === rest);
      return { kind: 'thread', icon: '🧵', label: t?.label || rest, sublabel: 'thread', exists: !!t, open: () => openThread(rest) };
    }
    if (prefix === 'doc') {
      return { kind: 'doc', icon: '▤', label: rest.replace(/_/g, ' '), sublabel: 'result document', exists: true, open: () => openDoc(rest) };
    }
    if (prefix === 'plot') {
      // `rest` is the figure filename; humanize it and route to the plots gallery.
      const label = rest.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
      return { kind: 'plot', icon: '🖼', label, sublabel: 'result plot', exists: true, open: () => openDoc('plots') };
    }
    if (prefix === USERGROUP_PREFIX.slice(0, -1)) {
      return { kind: 'usergroup', icon: '⬡', label: rest, sublabel: 'user group', exists: false, open: null };
    }
    const c = byId[targetKey];
    return {
      kind: 'commit', icon: '·',
      label: c?.title || c?.file || targetKey,
      sublabel: c ? c.kind : 'commit (not in this trace)',
      exists: !!c,
      open: () => openCommit(targetKey),
    };
  }, [byId, chunks, semanticAreas, threads, openCommit, openGroup, openArea, openThread, openDoc]);
}

// One group pill: a colour dot + the group name, optionally clickable (jump to
// the group) and/or removable (untag this target). Sized to sit inline among
// chips in the dossier / overview.
export function GroupBadge({ group, onClick, onRemove, title }) {
  const color = (group && group.color) || WF.ink2;
  return (
    <span
      title={title || (group ? group.name : '')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontFamily: WF.monoFont, fontSize: 10, fontWeight: 600,
        color: WF.ink, background: WF.paper,
        border: `1px solid ${color}`, borderLeft: `4px solid ${color}`,
        padding: '1px 5px', borderRadius: 2, maxWidth: 180,
        cursor: onClick ? 'pointer' : 'default',
      }}
      onClick={onClick}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group ? group.name : '(group)'}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`remove from ${group ? group.name : 'group'}`}
          title="remove from this group"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: WF.ink3, fontFamily: WF.monoFont, fontSize: 11, lineHeight: 1,
            padding: 0, marginRight: -1,
          }}
        >×</button>
      )}
    </span>
  );
}

// Read-only group chips for a target — used on the overview rows so a flagged
// item shows which groups it's in at a glance. Clicking a chip jumps to the
// group on the semantic-areas screen. Renders nothing when untagged.
export function GroupTagChips({ targetKey, onOpenGroup }) {
  const { userGroupsOverlay = {}, groupTagsOverlay = {}, openUserGroup } = useData();
  const ids = groupTagsOverlay[targetKey] || [];
  const groups = ids.map((id) => userGroupsOverlay[id]).filter(Boolean);
  if (groups.length === 0) return null;
  const open = onOpenGroup || openUserGroup;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {groups.map((g) => (
        <GroupBadge key={g.id} group={g} onClick={() => open(g.id)} title={`group: ${g.name} — open`} />
      ))}
    </span>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  fontFamily: WF.monoFont, fontSize: 12,
  padding: '5px 7px', border: inkBorder(1.2), background: WF.paper, color: WF.ink,
};

// The combobox: current tags as removable chips, then a text input that filters
// existing groups by fuzzy match (the "add to group" dropdown) and offers to
// create a new group from whatever's typed. The options list renders inline
// (not absolutely positioned) so it never clips inside the scrollable side
// panels it lives in. Tagging a target into a group it isn't already in adds it;
// creating makes the group (cycling the palette) and tags in one step.
export function TagEditor({ targetKey, placeholder = 'tag into a group…' }) {
  const { userGroupsOverlay = {}, groupTagsOverlay = {}, createUserGroup, tagTarget, untagTarget } = useData();
  const wrapRef = React.useRef(null);
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);

  const currentIds = groupTagsOverlay[targetKey] || [];
  const currentGroups = currentIds.map((id) => userGroupsOverlay[id]).filter(Boolean);

  const allGroups = React.useMemo(() => Object.values(userGroupsOverlay), [userGroupsOverlay]);
  const q = query.trim();
  const matches = React.useMemo(() => {
    const available = allGroups.filter((g) => !currentIds.includes(g.id));
    return available
      .map((g) => ({ g, score: fuzzyScore(q, g.name) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => (b.score - a.score) || a.g.name.localeCompare(b.g.name))
      .map((x) => x.g);
  }, [allGroups, currentIds, q]);

  // Offer "create" only when there's text that doesn't exactly name an existing
  // group (case-insensitive) — so re-typing an existing name adds, not dupes.
  const exactExists = q && allGroups.some((g) => g.name.toLowerCase() === q.toLowerCase());
  const showCreate = q && !exactExists;
  // Flat option list the keyboard walks: matches first, then the create row.
  const options = React.useMemo(
    () => [...matches.map((g) => ({ type: 'group', g })), ...(showCreate ? [{ type: 'create' }] : [])],
    [matches, showCreate],
  );

  // The top match is auto-selected (hi 0) on every query change / (re)open, so
  // Enter auto-completes to it. Escape clears the selection (hi -1) without
  // closing — see onKeyDown — so the auditor can opt out of the suggestion.
  React.useEffect(() => { setHi(0); }, [query, open]);

  // Close the inline dropdown on an outside click (Escape is handled on the input).
  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const addExisting = (g) => { tagTarget(targetKey, g.id); setQuery(''); };
  const create = () => {
    const id = createUserGroup(q, pickGroupColor(allGroups.length));
    if (id) tagTarget(targetKey, id);
    setQuery('');
  };
  const choose = (opt) => { if (!opt) return; if (opt.type === 'create') create(); else addExisting(opt.g); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hi >= 0 && options[hi]) {
        // A row is selected (the auto-selected top match, or one navigated to) —
        // auto-complete to it.
        choose(options[hi]);
      } else if (q) {
        // Selection was cleared with Escape: don't grab a suggestion. Create the
        // typed name, or add the group it exactly names (no duplicate).
        const existing = allGroups.find((g) => g.name.toLowerCase() === q.toLowerCase());
        if (existing) { if (!currentIds.includes(existing.id)) addExisting(existing); else setQuery(''); }
        else create();
      }
    } else if (e.key === 'Escape') {
      // First Escape clears the highlighted suggestion (unselect all); with
      // nothing selected, the next closes the dropdown, then clears the field.
      if (hi >= 0) { e.stopPropagation(); setHi(-1); }
      else if (open) { e.stopPropagation(); setOpen(false); }
      else setQuery('');
    } else if (e.key === 'Backspace' && !query && currentGroups.length) {
      // Quick un-tag: backspace on an empty field drops the most recent tag.
      untagTarget(targetKey, currentGroups[currentGroups.length - 1].id);
    }
  };

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {currentGroups.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {currentGroups.map((g) => (
            <GroupBadge key={g.id} group={g} onRemove={() => untagTarget(targetKey, g.id)} title={`in group: ${g.name}`} />
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={inputStyle}
        />
        {open && (options.length > 0 || q) && (
          <div style={{ border: inkBorder(1.2), borderTop: 'none', background: WF.paper, maxHeight: 200, overflow: 'auto' }}>
            {options.map((opt, i) => {
              const active = i === Math.min(hi, options.length - 1);
              if (opt.type === 'create') {
                return (
                  <button
                    key="__create"
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); create(); }}
                    onMouseEnter={() => setHi(i)}
                    style={optRowStyle(active)}
                  >
                    <span style={{ color: active ? WF.paper : WF.heat4, fontWeight: 700 }}>＋ create</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{q}”</span>
                  </button>
                );
              }
              const g = opt.g;
              return (
                <button
                  key={g.id}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); addExisting(g); }}
                  onMouseEnter={() => setHi(i)}
                  style={optRowStyle(active)}
                >
                  <span style={{ width: 9, height: 9, flexShrink: 0, background: g.color || WF.ink2, border: `1px solid ${active ? WF.paper : WF.ink}` }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                </button>
              );
            })}
            {options.length === 0 && q && (
              <div style={{ padding: '6px 8px' }}>
                <L mono size={11} color={WF.ink3}>no match</L>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The active option inverts to a solid ink fill (the same "selected" idiom the
// screen tabs / nav buttons use) so the highlight is unmistakable — a far starker
// cue than the old paper-vs-paperAlt nudge. ink/paper invert together, so this
// reads in both light and dark themes; the row's inner swatch / create label flip
// to onAccent to stay legible on the fill.
const optRowStyle = (active) => ({
  display: 'flex', alignItems: 'center', gap: 7, width: '100%',
  textAlign: 'left', border: 'none', borderTop: `1px solid ${WF.rule}`,
  borderLeft: `4px solid ${active ? WF.heat4 : 'transparent'}`,
  background: active ? WF.ink : WF.paper, color: active ? WF.paper : WF.ink,
  fontFamily: WF.monoFont, fontSize: 12, fontWeight: active ? 700 : 400,
  padding: '5px 8px', cursor: 'pointer',
});

// TagEditor under a small "groups" heading, shown once an item is flagged — or
// whenever it already carries tags, so an existing membership is never hidden
// just because the flag was later cleared. Dropped wholesale into the dossier
// commit / group panels and the shared AuditorPanel.
export function FlagTags({ targetKey, flagged, label = 'groups', style = {} }) {
  const { groupTagsOverlay = {} } = useData();
  const hasTags = (groupTagsOverlay[targetKey] || []).length > 0;
  if (!flagged && !hasTags) return null;
  return (
    <div style={style}>
      <L size={11} weight={700} color={WF.ink3} style={{ display: 'block', marginBottom: 6 }}>{label}</L>
      <TagEditor targetKey={targetKey} />
    </div>
  );
}
