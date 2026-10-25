import { useEffect, useRef } from 'react';

interface SidebarResizeHandleProps {
  width: number;
  onWidthChange: (width: number) => void;
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export function SidebarResizeHandle({ width, onWidthChange }: SidebarResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 360));
      onWidthChange(Math.min(maxWidth, Math.max(MIN_WIDTH, dragRef.current.startWidth + event.clientX - dragRef.current.startX)));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [onWidthChange]);

  const startDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onMouseDown={startDrag}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onWidthChange(width - 16); }
        if (event.key === 'ArrowRight') { event.preventDefault(); onWidthChange(width + 16); }
      }}
      className="group relative z-10 -mx-1.5 w-3 shrink-0 cursor-col-resize touch-none"
      title="Drag to resize sidebar"
    >
      <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent-primary/60 group-active:bg-accent-primary" />
    </div>
  );
}
