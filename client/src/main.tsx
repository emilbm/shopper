import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { installErrorReporting, reportClientError } from './errors';
import './theme.css';
import './styles.css';
import './app.css';
import './cook.css';

installErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Two phones may share one list in the shop, so a return to the app
      // should show what the other one ticked off.
      refetchOnWindowFocus: true,
      staleTime: 10_000,
      retry: 1,
    },
  },
});

/** A render crash shows a way out instead of a blank page, and is reported. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    reportClientError(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty">
        <h2>Something broke</h2>
        <p>It has been reported. Reloading usually gets past it.</p>
        <button className="btn btn--primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
