import { useEffect, useState } from "react";

export interface CyberRetypeTitleProps {
  /** The full text to display and animate */
  text: string;
  /** Number of characters at the end of the title to erase and retype (default: 4) */
  eraseCount?: number;
  /** Interval in ms between animation cycles (default: 4500ms) */
  interval?: number;
  /** Optional extra CSS classes */
  className?: string;
  /** Optional inline styles */
  style?: React.CSSProperties;
}

/**
 * CyberRetypeTitle
 *
 * Futuristic sci-fi typewriter / terminal retyping animation.
 * Periodically erases the last few characters of a title and re-types them
 * with a glowing cyan terminal cursor.
 *
 * Accessible: sets aria-label with the full static text, while hiding the
 * animated character sequence from screen readers with aria-hidden="true".
 */
export function CyberRetypeTitle({
  text,
  eraseCount = 4,
  interval = 4500,
  className,
  style,
}: CyberRetypeTitleProps) {
  const [displayText, setDisplayText] = useState(text);

  useEffect(() => {
    // Reset immediately whenever the target text changes (e.g. language toggle or route)
    setDisplayText(text);

    if (text.length <= eraseCount + 2) {
      return;
    }

    const minLength = Math.max(1, text.length - eraseCount);
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const runCycle = () => {
      // Step 1: Wait for idle interval
      timeoutId = setTimeout(() => {
        if (cancelled) return;

        // Step 2: Delete characters backward
        let currentLen = text.length;

        const deleteStep = () => {
          if (cancelled) return;
          if (currentLen > minLength) {
            currentLen--;
            setDisplayText(text.slice(0, currentLen));
            timeoutId = setTimeout(deleteStep, 65);
          } else {
            // Step 3: Pause briefly at shortest point
            timeoutId = setTimeout(() => {
              if (cancelled) return;

              // Step 4: Retype forward
              const typeStep = () => {
                if (cancelled) return;
                if (currentLen < text.length) {
                  currentLen++;
                  setDisplayText(text.slice(0, currentLen));
                  timeoutId = setTimeout(typeStep, 85);
                } else {
                  // Step 5: Schedule next cycle
                  runCycle();
                }
              };

              typeStep();
            }, 280);
          }
        };

        deleteStep();
      }, interval);
    };

    runCycle();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [text, eraseCount, interval]);

  return (
    <span
      className={`cyber-retype-title ${className ?? ""}`.trim()}
      style={style}
      aria-label={text}
    >
      <span aria-hidden="true">
        {displayText}
        <span className="cyber-cursor" aria-hidden="true">
          _
        </span>
      </span>
    </span>
  );
}
