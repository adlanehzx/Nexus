import type { ComponentPropsWithRef, ReactNode } from "react";
import "./Button.css";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
  size?: "md" | "sm";
  loading?: boolean;
  icon?: ReactNode;
  kbd?: ReactNode;
}
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  icon,
  kbd,
  children,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={Boolean(disabled) || loading}
      aria-busy={loading || undefined}
      className={`nx-button nx-button--${variant} nx-button--${size} ${className}`}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {loading ? <span className="nx-button__lamp" aria-hidden="true" /> : null}
      {children}
      {kbd}
    </button>
  );
}
