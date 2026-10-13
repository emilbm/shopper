import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { blankEntry, EntryEditor, entriesForSave, newKey, type EditableEntry } from '../components/EntryEditor';
import { ErrorBanner, IconBack, IconTrash, Spinner, useConfirm } from '../components/ui';
import { useSaveShortcut } from '../keys';
import { keys, useLists } from '../queries';

export default function ListEditPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const lists = useLists();
  const { confirm, dialog } = useConfirm();

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [entries, setEntries] = useState<EditableEntry[]>(() => (id ? [] : [blankEntry(), blankEntry(), blankEntry()]));
  const [loaded, setLoaded] = useState(id === null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loaded || !lists.data) return;
    const list = lists.data.find((l) => l.id === id);
    if (!list) {
      navigate('/lists', { replace: true });
      return;
    }
    setName(list.name);
    setNotes(list.notes);
    setEntries(
      list.entries.length
        ? list.entries.map((e) => ({ key: newKey(), name: e.name, quantity: e.quantity, unit: e.unit, note: '' }))
        : [blankEntry()],
    );
    setLoaded(true);
  }, [lists.data, id, loaded, navigate]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const input = { name: name.trim(), notes, entries: entriesForSave(entries) };
    try {
      if (id) await api.lists.update(id, input);
      else await api.lists.create(input);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.lists }),
        qc.invalidateQueries({ queryKey: keys.items }),
      ]);
      navigate('/lists', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  useSaveShortcut(() => {
    if (name.trim() && !saving) void save();
  });

  const remove = async () => {
    if (!id) return;
    if (!(await confirm({ title: `Delete “${name}”?`, confirmLabel: 'Delete list', danger: true }))) return;
    try {
      await api.lists.remove(id);
      await qc.invalidateQueries({ queryKey: keys.lists });
      navigate('/lists', { replace: true });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <header className="header">
        <button className="btn btn--quiet btn--icon" onClick={() => navigate(-1)} aria-label="Back">
          <IconBack />
        </button>
        <h1>{id ? 'Edit list' : 'New list'}</h1>
        <button className="btn btn--primary btn--sm" disabled={!name.trim() || saving} onClick={() => void save()} title="Save (Ctrl+S)">
          Save
        </button>
      </header>
      <main className="main main--narrow">
        {!loaded && <Spinner />}
        {loaded && (
          <div className="stack">
            <div className="field">
              <label htmlFor="l-name">Name</label>
              <input id="l-name" className="input" placeholder="Weekly staples" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="l-notes">Notes</label>
              <input id="l-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <h2 className="section-title">What it adds</h2>
            <EntryEditor entries={entries} onChange={setEntries} />
            <ErrorBanner error={error} />
            <button className="btn btn--primary btn--block btn--lg" disabled={!name.trim() || saving} onClick={() => void save()}>
              Save list
            </button>
            {id && (
              <button className="btn btn--danger btn--block" onClick={() => void remove()}>
                <IconTrash /> Delete list
              </button>
            )}
          </div>
        )}
      </main>
      {dialog}
    </>
  );
}
