import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ErrorBanner, IconBack, IconSparkle } from '../components/ui';
import { useAiEnabled } from '../queries';

export default function RecipeImportPage() {
  const navigate = useNavigate();
  const aiEnabled = useAiEnabled();
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ready = mode === 'url' ? /^https?:\/\/\S+$/i.test(url.trim()) : text.trim().length > 0;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await api.recipes.import(mode === 'url' ? { url: url.trim() } : { text });
      // Straight into the editor: nothing is saved until it has been looked over.
      navigate('/recipes/new', { state: { draft }, replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="header">
        <button className="btn btn--quiet btn--icon" onClick={() => navigate(-1)} aria-label="Back">
          <IconBack />
        </button>
        <h1>Import a recipe</h1>
      </header>
      <main className="main main--narrow">
        <div className="stack">
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={mode === 'url'} className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>
              From a web page
            </button>
            <button role="tab" aria-selected={mode === 'text'} className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
              Paste text
            </button>
          </div>

          {mode === 'url' ? (
            <input
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://www.valdemarsro.dk/…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
          ) : (
            <textarea
              className="textarea"
              rows={12}
              placeholder={'Lasagne\n\n500 g hakket oksekød\n1 dåse hakkede tomater\n…\n\nBrun kødet…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          )}

          <p className="small muted" style={{ margin: 0 }}>
            {aiEnabled
              ? 'The AI reads the recipe and splits each ingredient into item, amount and note. Nothing is saved until you have checked it.'
              : mode === 'url'
                ? 'Works on sites that publish recipe data (most big recipe sites do). AI is not set up, so other pages cannot be read.'
                : 'AI is not set up, so this is a rough reading: the first line becomes the name, lines starting with an amount become ingredients.'}
          </p>

          <ErrorBanner error={error} />
          <button className={`btn btn--block btn--lg ${aiEnabled ? 'btn--ai' : 'btn--primary'}`} disabled={!ready || busy} onClick={() => void run()}>
            {busy ? (
              <>
                <span className="spinner spinner--inline" /> Reading…
              </>
            ) : (
              <>
                {aiEnabled && <IconSparkle />} Read the recipe
              </>
            )}
          </button>
        </div>
      </main>
    </>
  );
}
