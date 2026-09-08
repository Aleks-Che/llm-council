import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatSize, isMarkdownAttachment } from '../attachments';
import CopyButton from './CopyButton';
import './AttachmentPreview.css';

const MIN_PREVIEW_WIDTH = 320;
const MIN_CHAT_WIDTH = 360;
const WIDTH_STORAGE_KEY = 'llmcouncil_attachment_preview_width';

export default function AttachmentPreview({ attachment, onClose }) {
  const closeButtonRef = useRef(null);
  const previewRef = useRef(null);
  const dragRef = useRef(null);
  const [resizing, setResizing] = useState(false);
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
      return Number.isFinite(saved) && saved >= MIN_PREVIEW_WIDTH ? saved : null;
    } catch {
      return null;
    }
  });
  const [dimensions, setDimensions] = useState({ width: MIN_PREVIEW_WIDTH, max: MIN_PREVIEW_WIDTH });

  useEffect(() => {
    const preview = previewRef.current;
    const observer = new ResizeObserver(() => {
      const next = {
        width: Math.round(preview.getBoundingClientRect().width),
        max: Math.max(MIN_PREVIEW_WIDTH, Math.floor(preview.parentElement.clientWidth - MIN_CHAT_WIDTH)),
      };
      setDimensions((previous) => previous.width === next.width && previous.max === next.max ? previous : next);
    });
    observer.observe(preview);
    observer.observe(preview.parentElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (resizing) return;
    try {
      if (width === null) localStorage.removeItem(WIDTH_STORAGE_KEY);
      else localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }, [width, resizing]);

  const resize = (nextWidth) => {
    const maximum = previewRef.current.parentElement.clientWidth - MIN_CHAT_WIDTH;
    setWidth(Math.max(MIN_PREVIEW_WIDTH, Math.min(Math.round(nextWidth), maximum)));
  };

  const startResize = (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, width: previewRef.current.getBoundingClientRect().width };
    setResizing(true);
  };

  const moveResize = (event) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    resize(drag.width + drag.x - event.clientX);
  };

  const stopResize = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleResizeKeyDown = (event) => {
    const current = previewRef.current.getBoundingClientRect().width;
    const next = { ArrowLeft: current + 24, ArrowRight: current - 24, Home: MIN_PREVIEW_WIDTH, End: dimensions.max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
  };

  useEffect(() => {
    closeButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <aside ref={previewRef} id="attachment-preview"
      className={`attachment-preview${resizing ? ' attachment-preview-resizing' : ''}`}
      style={{ '--attachment-preview-width': width === null ? undefined : `${width}px` }}
      aria-label={`Просмотр файла ${attachment.name}`}>
      <div className="attachment-preview-resize" role="separator" tabIndex={0}
        aria-label="Ширина просмотрщика файла" aria-orientation="vertical" aria-controls="attachment-preview"
        aria-valuemin={MIN_PREVIEW_WIDTH} aria-valuemax={dimensions.max} aria-valuenow={dimensions.width}
        aria-valuetext={`${dimensions.width} пикселей`}
        title="Перетащите для изменения ширины. Двойной щелчок — сброс"
        onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize}
        onPointerCancel={stopResize} onLostPointerCapture={stopResize}
        onKeyDown={handleResizeKeyDown} onDoubleClick={() => setWidth(null)} />
      <div className="attachment-preview-header">
        <div className="attachment-preview-heading">
          <h2 title={attachment.name}>{attachment.name}</h2>
          <span className="attachment-size">{attachment.sizeLabel ?? formatSize(attachment.size)}</span>
        </div>
        <CopyButton text={attachment.content} />
        <button ref={closeButtonRef} type="button" className="attachment-preview-close"
          aria-label="Закрыть просмотр файла" title="Закрыть (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="attachment-preview-body" tabIndex={0} role="region" aria-label="Содержимое файла">
        {attachment.content === '' ? (
          <p className="attachment-preview-empty">Файл пуст</p>
        ) : isMarkdownAttachment(attachment.name) ? (
          <div className="markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{attachment.content}</ReactMarkdown>
          </div>
        ) : (
          <pre className="attachment-preview-text">{attachment.content}</pre>
        )}
      </div>
    </aside>
  );
}
