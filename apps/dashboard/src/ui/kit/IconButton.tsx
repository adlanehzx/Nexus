import type { ComponentPropsWithRef, ReactNode } from "react";
import "./IconButton.css";

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  icon: ReactNode;
  label: string;
  variant?: "secondary" | "ghost";
  size?: "md" | "sm";
  pressed?: boolean;
}

export function IconButton({
  icon,
  label,
  variant = "secondary",
  size = "md",
  pressed,
  disabled,
  className = "",
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`nx-icon-button nx-icon-button--${variant} nx-icon-button--${size} ${pressed ? "nx-icon-button--pressed" : ""} ${className}`.trim()}
    >
      <span className="nx-icon-button__icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}
