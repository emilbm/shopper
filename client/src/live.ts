import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * This browser tab, as the server's live updates know it, so a tab can tell
 * its own changes from someone else's. Not crypto.randomUUID: that needs
 * https, and the app is often reached over plain http on the LAN.
 */
export const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Keep this tab in step with everyone else's: when the server says something
 * changed somewhere else, refetch what is on screen. Several changes in quick
 * succession (a whole recipe going on the list) make one refetch.
 */
export function useLiveSync() {
  const qc = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries(), 150);
    };

    const source = new EventSource('/api/events');
    let dropped = false;
    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as { type: string; by: string | null };
        if (event.type === 'changed' && event.by !== CLIENT_ID) refresh();
      } catch {
        /* not ours to understand */
      }
    };
    // Back after a dropped connection (a sleeping laptop, a server restart):
    // whatever happened meanwhile was missed, so catch up.
    source.onerror = () => {
      dropped = true;
    };
    source.onopen = () => {
      if (dropped) refresh();
      dropped = false;
    };

    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [qc]);
}
