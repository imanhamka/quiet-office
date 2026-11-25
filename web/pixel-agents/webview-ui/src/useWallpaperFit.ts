// quiet-office: the largest integer zoom that shows the whole office in the
// window, and the pan that centres it. Recomputed on resize and on a new layout.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { OfficeState } from './office/engine/officeState.js';
import { fitOffice, getInsets, isWallpaper, onInsetsChange } from './wallpaper.js';

export function useWallpaperFit(
  officeState: OfficeState,
  layoutReady: boolean,
): { zoom: number; panRef: React.MutableRefObject<{ x: number; y: number }> } {
  const panRef = useRef({ x: 0, y: 0 });
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  useEffect(() => {
    if (!isWallpaper) return;
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    const offInsets = onInsetsChange(() => setSize({ w: window.innerWidth, h: window.innerHeight }));
    return () => {
      window.removeEventListener('resize', onResize);
      offInsets();
    };
  }, []);

  const layout = officeState.getLayout();
  const fit = useMemo(
    () => fitOffice(layout, size.w, size.h, getInsets()),
    // layoutReady: the first real layout replaces the placeholder one
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, size, layoutReady],
  );

  useLayoutEffect(() => {
    panRef.current = fit.pan;
  }, [fit]);

  return { zoom: fit.zoom, panRef };
}
