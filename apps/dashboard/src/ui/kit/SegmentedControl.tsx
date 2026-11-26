import { useId, type ReactNode } from "react";
import "./SegmentedControl.css";

export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  className = "",
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string; content?: ReactNode; disabled?: boolean }[];
  className?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={`nx-segmented ${className}`}>
      {options.map((option) => (
        <label key={option.value} className="nx-segmented__option" title={option.label}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            aria-label={option.label}
            onChange={() => onChange(option.value)}
          />
          <span>{option.content ?? option.label}</span>
        </label>
      ))}
    </div>
  );
}
