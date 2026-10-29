import { useRef, useState, type ReactNode } from "react";

export function Futuristic3DCard({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState("perspective(1000px) rotateX(0deg) rotateY(0deg)");
  const [glarePos, setGlarePos] = useState({ x: 50, y: 50, opacity: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const rotX = -((y - centerY) / centerY) * 5; // max 5 deg tilt
    const rotY = ((x - centerX) / centerX) * 5;

    setTransform(
      `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) translateZ(2px)`,
    );
    setGlarePos({
      x: Math.round((x / rect.width) * 100),
      y: Math.round((y / rect.height) * 100),
      opacity: 0.18,
    });
  };

  const handleMouseLeave = () => {
    setTransform("perspective(1000px) rotateX(0deg) rotateY(0deg) translateZ(0px)");
    setGlarePos((prev) => ({ ...prev, opacity: 0 }));
  };

  return (
    <div
      ref={cardRef}
      className={`cyber-3d-card ${className}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        ...style,
        transform,
        transition: "transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.2s ease",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        className="cyber-card-glare"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: "none",
          background: `radial-gradient(circle at ${glarePos.x}% ${glarePos.y}%, rgba(0, 240, 255, ${glarePos.opacity}), transparent 60%)`,
          transition: "opacity 0.2s ease",
          zIndex: 1,
        }}
      />
      <div style={{ position: "relative", zIndex: 2 }}>{children}</div>
    </div>
  );
}
