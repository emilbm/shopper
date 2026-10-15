import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Recipe, RecipeDraft } from '../../../shared/types';
import { api, type RecipeInput } from '../api';
import { blankEntry, EntryEditor, entriesForSave, newKey, type EditableEntry } from '../components/EntryEditor';
import { PictureEditor, useBlobUrl } from '../components/PictureEditor';
import { ErrorBanner, IconBack, IconTrash, Spinner, useConfirm } from '../components/ui';
import { useSaveShortcut } from '../keys';
import { keys, useRecipe } from '../queries';

interface Form {
  name: string;
  servings: number;
  tags: string;
  sourceUrl: string;
  instructions: string;
  notes: string;
  entries: EditableEntry[];
}

const fromRecipe = (r: Recipe | RecipeDraft): Form => ({
  name: r.name,
  servings: r.servings,
  tags: r.tags.join(', '),
  sourceUrl: r.sourceUrl,
  instructions: r.instructions,
  notes: 'notes' in r ? r.notes : '',
  entries: r.ingredients.length
    ? r.ingredients.map((i) => ({ key: newKey(), name: i.name, quantity: i.quantity, unit: i.unit, note: i.note }))
    : [blankEntry()],
});

const EMPTY: Form = {
  name: '',
  servings: 4,
  tags: '',
  sourceUrl: '',
  instructions: '',
  notes: '',
  entries: [blankEntry(), blankEntry(), blankEntry()],
};

const VIA_NOTE: Record<RecipeDraft['via'], string> = {
  ai: 'Read by the AI. Check the amounts before saving.',
  'structured-data': 'Taken from the page’s recipe data and split by hand. Check the amounts before saving.',
  heuristic: 'Read without AI, so it is rough. Check everything before saving.',
};

export default function RecipeEditPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const location = useLocation();
  const draft = (location.state as { draft?: RecipeDraft } | null)?.draft;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const existing = useRecipe(id);
  const { confirm, dialog } = useConfirm();

  const [form, setForm] = useState<Form | null>(() => (id ? null : draft ? fromRecipe(draft) : EMPTY));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  // A new recipe's picture waits for the save: an import's, fetched by the
  // server, or one chosen here, uploaded once the recipe exists.
  const [draftImage, setDraftImage] = useState<string | null>(draft?.imageUrl ?? null);
  const [pending, setPending] = useState<Blob | null>(null);
  const pendingUrl = useBlobUrl(pending);
  const [pictureBusy, setPictureBusy] = useState(false);
  const [pictureError, setPictureError] = useState<unknown>(null);

  /** An existing recipe's picture changes at once, apart from the form. */
  const changePicture = async (fn: () => Promise<Recipe>) => {
    setPictureBusy(true);
    setPictureError(null);
    try {
      const saved = await fn();
      qc.setQueryData(keys.recipe(saved.id), saved);
      await qc.invalidateQueries({ queryKey: keys.recipes });
    } catch (err) {
      setPictureError(err);
    } finally {
      setPictureBusy(false);
    }
  };

  useEffect(() => {
    if (id && existing.data && !form) setForm(fromRecipe(existing.data));
  }, [id, existing.data, form]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    // A draft's aisle guesses ride along, so new items arrive already sorted.
    const hints = new Map(draft?.ingredients.map((i) => [i.name.toLowerCase(), i.category]));
    const input: RecipeInput = {
      name: form.name.trim(),
      servings: form.servings,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      sourceUrl: form.sourceUrl.trim(),
      instructions: form.instructions,
      notes: form.notes,
      ingredients: entriesForSave(form.entries).map((e) => ({ ...e, category: hints.get(e.name.toLowerCase()) ?? null })),
      imageUrl: !id && !pending && draftImage ? draftImage : undefined,
    };
    try {
      let saved = id ? await api.recipes.update(id, input) : await api.recipes.create(input);
      if (!id && pending) saved = await api.recipes.uploadImage(saved.id, pending);
      qc.setQueryData(keys.recipe(saved.id), saved);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.recipes }),
        qc.invalidateQueries({ queryKey: keys.items }),
      ]);
      navigate(`/recipes/${saved.id}`, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  useSaveShortcut(() => {
    if (form?.name.trim() && !saving) void save();
  });

  const remove = async () => {
    if (!id || !form) return;
    const ok = await confirm({
      title: `Delete “${form.name}”?`,
      body: 'Anything it already put on the shopping list stays there.',
      confirmLabel: 'Delete recipe',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.recipes.remove(id);
      qc.removeQueries({ queryKey: keys.recipe(id) });
      await qc.invalidateQueries({ queryKey: keys.recipes });
      navigate('/recipes', { replace: true });
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
        <h1>{id ? 'Edit recipe' : 'New recipe'}</h1>
        <button className="btn btn--primary btn--sm" disabled={!form?.name.trim() || saving} onClick={() => void save()} title="Save (Ctrl+S)">
          Save
        </button>
      </header>
      <main className="main main--narrow">
        {!form && <Spinner />}
        <ErrorBanner error={existing.error} />
        {form && (
          <div className="stack">
            {draft && !id && <div className="banner banner--info">{VIA_NOTE[draft.via]}</div>}
            <div className="field">
              <label htmlFor="r-name">Name</label>
              <input id="r-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
            </div>

            <h2 className="section-title">Picture</h2>
            {id ? (
              <PictureEditor
                src={existing.data?.image ?? null}
                busy={pictureBusy}
                error={pictureError}
                onUpload={(picture) => void changePicture(() => api.recipes.uploadImage(id, picture))}
                onRemove={() => void changePicture(() => api.recipes.removeImage(id))}
                onFromSource={existing.data?.sourceUrl ? () => void changePicture(() => api.recipes.fetchImage(id)) : undefined}
              />
            ) : (
              <PictureEditor
                src={pendingUrl ?? draftImage}
                caption={!pending && draftImage ? 'From the recipe’s page. It is kept when you save.' : undefined}
                onUpload={setPending}
                onRemove={() => {
                  setPending(null);
                  setDraftImage(null);
                }}
              />
            )}

            <h2 className="section-title">Ingredients</h2>
            <EntryEditor entries={form.entries} onChange={(entries) => set('entries', entries)} withNotes />

            <h2 className="section-title">Method</h2>
            <textarea
              className="textarea"
              rows={8}
              value={form.instructions}
              onChange={(e) => set('instructions', e.target.value)}
              aria-label="Method"
            />

            <h2 className="section-title">Details</h2>
            <div className="field">
              <label htmlFor="r-tags">Tags</label>
              <input id="r-tags" className="input" placeholder="pasta, hverdagsmad" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="r-src">Source</label>
              <input id="r-src" className="input" type="url" placeholder="https://…" value={form.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="r-notes">Notes</label>
              <textarea id="r-notes" className="textarea" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </div>

            <ErrorBanner error={error} />
            <button className="btn btn--primary btn--block btn--lg" disabled={!form.name.trim() || saving} onClick={() => void save()}>
              Save recipe
            </button>
            {id && (
              <button className="btn btn--danger btn--block" onClick={() => void remove()}>
                <IconTrash /> Delete recipe
              </button>
            )}
          </div>
        )}
      </main>
      {dialog}
    </>
  );
}
