import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
}

/**
 * Keep the screen on while cooking — floury fingers should not have to wake the phone. Unsupported browsers (Safari before 16.4,
 * any desktop without the API) simply carry on — nothing here is load-bearing.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const wakeLock = (navigator as Navigator & WakeLockNavigator).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        sentinel = await wakeLock.request('screen');
      } catch {
        // Denied (battery saver, backgrounded tab) — not worth surfacing.
      }
    };

    // The lock is dropped whenever the tab is hidden, so re-take it on return.
    const onVisible = () => void acquire();
    document.addEventListener('visibilitychange', onVisible);
    void acquire();

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}
