import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "./Button.js";
import "./Dialog.css";

export function Dialog({
  title,
  isOpen,
  onClose,
  closeLabel,
  children,
  width,
  className = "",
}: {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
  width?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !isOpen) return;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [isOpen]);
  if (!isOpen) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`nx-dialog ${className}`}
      style={width ? ({ "--nx-dialog-width": width } as CSSProperties) : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="nx-dialog__header">
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {closeLabel}
        </Button>
      </header>
      <div className="nx-dialog__body">{children}</div>
    </dialog>
  );
}
