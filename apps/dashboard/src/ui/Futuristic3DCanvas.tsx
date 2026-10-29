import { useEffect, useRef } from "react";

interface Point3D {
  x: number;
  y: number;
  z: number;
}

interface Particle3D {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
}

export function Futuristic3DCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth ?? window.innerWidth);
    let height = (canvas.height = canvas.parentElement?.clientHeight ?? 260);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.parentElement?.clientWidth ?? window.innerWidth;
      height = canvas.height = canvas.parentElement?.clientHeight ?? 260;
    };

    window.addEventListener("resize", handleResize);

    // Mouse perspective tracking
    let mouseX = 0;
    let mouseY = 0;
    let targetRotX = 0;
    let targetRotY = 0;
    let currentRotX = 0;
    let currentRotY = 0;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      mouseX = x / rect.width;
      mouseY = y / rect.height;
      targetRotY = mouseX * 0.9;
      targetRotX = -mouseY * 0.9;
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });

    // Generate 3D Core Polyhedron (Icosahedron vertices)
    const phi = (1 + Math.sqrt(5)) / 2;
    const rawVertices: Point3D[] = [
      { x: -1, y: phi, z: 0 },
      { x: 1, y: phi, z: 0 },
      { x: -1, y: -phi, z: 0 },
      { x: 1, y: -phi, z: 0 },
      { x: 0, y: -1, z: phi },
      { x: 0, y: 1, z: phi },
      { x: 0, y: -1, z: -phi },
      { x: 0, y: 1, z: -phi },
      { x: phi, y: 0, z: -1 },
      { x: phi, y: 0, z: 1 },
      { x: -phi, y: 0, z: -1 },
      { x: -phi, y: 0, z: 1 },
    ];

    // Scale up polyhedron
    const coreScale = 75;
    const vertices = rawVertices.map((v) => ({
      x: v.x * coreScale,
      y: v.y * coreScale,
      z: v.z * coreScale,
    }));

    // Find edges based on standard icosahedron distance
    const edges: [number, number][] = [];
    const expectedDist = 2 * coreScale;
    const tolerance = coreScale * 0.4;
    for (let i = 0; i < vertices.length; i++) {
      for (let j = i + 1; j < vertices.length; j++) {
        const v1 = vertices[i]!;
        const v2 = vertices[j]!;
        const d = Math.hypot(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
        if (Math.abs(d - expectedDist) < tolerance) {
          edges.push([i, j]);
        }
      }
    }

    // Secondary inner wireframe (cube)
    const cubeScale = 38;
    const innerVertices: Point3D[] = [];
    for (const x of [-1, 1]) {
      for (const y of [-1, 1]) {
        for (const z of [-1, 1]) {
          innerVertices.push({ x: x * cubeScale, y: y * cubeScale, z: z * cubeScale });
        }
      }
    }

    // Floating 3D ambient data particles
    const particleCount = 40;
    const particles: Particle3D[] = [];
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: (Math.random() - 0.5) * 600,
        y: (Math.random() - 0.5) * 300,
        z: (Math.random() - 0.5) * 400,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        vz: (Math.random() - 0.5) * 0.4,
        radius: Math.random() * 1.8 + 1,
      });
    }

    // 3D rotation projection helper
    function rotateAndProject(
      point: Point3D,
      rx: number,
      ry: number,
      rz: number,
      cx: number,
      cy: number,
      fov: number,
    ): { x: number; y: number; z: number; scale: number } {
      // Y-axis rotation
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const x1 = point.x * cosY + point.z * sinY;
      const z1 = -point.x * sinY + point.z * cosY;

      // X-axis rotation
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const y2 = point.y * cosX - z1 * sinX;
      const z2 = point.y * sinX + z1 * cosX;

      // Z-axis rotation
      const cosZ = Math.cos(rz);
      const sinZ = Math.sin(rz);
      const x3 = x1 * cosZ - y2 * sinZ;
      const y3 = x1 * sinZ + y2 * cosZ;

      // Perspective scale
      const cameraDistance = 350;
      const scale = fov / (cameraDistance + z2);

      return {
        x: cx + x3 * scale,
        y: cy + y3 * scale,
        z: z2,
        scale,
      };
    }

    let t = 0;

    const render = () => {
      t += 0.012;
      ctx.clearRect(0, 0, width, height);

      // Smooth inertia rotation
      currentRotX += (targetRotX - currentRotX) * 0.05;
      currentRotY += (targetRotY - currentRotY) * 0.05;

      const baseRotX = t * 0.35 + currentRotX;
      const baseRotY = t * 0.55 + currentRotY;
      const baseRotZ = t * 0.18;

      const cx = width * 0.85; // Placed toward top-right corner or center depending on width
      const cy = height * 0.5;
      const fov = 320;

      // 1. Draw connecting 3D ambient data cloud
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.z += p.vz;
        if (p.x < -300 || p.x > 300) p.vx *= -1;
        if (p.y < -150 || p.y > 150) p.vy *= -1;
        if (p.z < -200 || p.z > 200) p.vz *= -1;
      }

      const projectedParticles = particles.map((p) =>
        rotateAndProject(p, currentRotX * 0.3, currentRotY * 0.3, 0, cx, cy, fov),
      );

      // Connect near particles
      for (let i = 0; i < projectedParticles.length; i++) {
        for (let j = i + 1; j < projectedParticles.length; j++) {
          const p1 = projectedParticles[i]!;
          const p2 = projectedParticles[j]!;
          const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          if (dist < 70) {
            const alpha = (1 - dist / 70) * 0.15;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(0, 240, 255, ${alpha.toFixed(3)})`;
            ctx.lineWidth = 0.8;
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
      }

      // Draw particle nodes
      for (let i = 0; i < projectedParticles.length; i++) {
        const p = projectedParticles[i]!;
        const orig = particles[i]!;
        const alpha = Math.max(0.1, Math.min(0.7, 0.4 + (p.z / 200) * 0.3));
        ctx.beginPath();
        ctx.fillStyle = `rgba(0, 240, 255, ${alpha.toFixed(3)})`;
        ctx.arc(p.x, p.y, orig.radius * p.scale * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Project Outer 3D Polyhedron Core
      const projCore = vertices.map((v) =>
        rotateAndProject(v, baseRotX, baseRotY, baseRotZ, cx, cy, fov),
      );

      // Draw 3D Edges with neon holographic glow
      ctx.lineWidth = 1.3;
      for (const [i1, i2] of edges) {
        const p1 = projCore[i1]!;
        const p2 = projCore[i2]!;
        const avgZ = (p1.z + p2.z) / 2;
        const depthAlpha = Math.max(0.15, Math.min(0.85, 0.5 + (avgZ / 100) * 0.4));

        ctx.beginPath();
        const grad = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
        grad.addColorStop(0, `rgba(0, 240, 255, ${depthAlpha.toFixed(3)})`);
        grad.addColorStop(0.5, `rgba(180, 50, 255, ${depthAlpha.toFixed(3)})`);
        grad.addColorStop(1, `rgba(0, 255, 170, ${depthAlpha.toFixed(3)})`);
        ctx.strokeStyle = grad;
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      // Draw 3D Vertices (Glowing laser nodes)
      for (const p of projCore) {
        const nodeAlpha = Math.max(0.2, Math.min(1, 0.6 + (p.z / 100) * 0.4));
        ctx.beginPath();
        ctx.fillStyle = `rgba(255, 255, 255, ${nodeAlpha.toFixed(3)})`;
        ctx.shadowColor = "#00f0ff";
        ctx.shadowBlur = 10;
        ctx.arc(p.x, p.y, Math.max(1.5, 3 * p.scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0; // reset
      }

      // 3. Project Inner Counter-Rotating Cube
      const innerProj = innerVertices.map((v) =>
        rotateAndProject(v, -baseRotX * 1.3, -baseRotY * 1.3, baseRotZ * 0.5, cx, cy, fov),
      );

      ctx.lineWidth = 0.9;
      ctx.strokeStyle = "rgba(0, 240, 255, 0.35)";
      for (let i = 0; i < 8; i++) {
        for (let j = i + 1; j < 8; j++) {
          const v1 = innerVertices[i]!;
          const v2 = innerVertices[j]!;
          const diffs = (v1.x === v2.x ? 1 : 0) + (v1.y === v2.y ? 1 : 0) + (v1.z === v2.z ? 1 : 0);
          if (diffs === 2) {
            const p1 = innerProj[i]!;
            const p2 = innerProj[j]!;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
      }

      // 4. Center Glowing Singularity
      ctx.beginPath();
      const pulseSize = (Math.sin(t * 3) * 0.2 + 0.8) * 8;
      const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, pulseSize * 2.5);
      centerGrad.addColorStop(0, "rgba(255, 255, 255, 0.95)");
      centerGrad.addColorStop(0.3, "rgba(0, 240, 255, 0.6)");
      centerGrad.addColorStop(1, "rgba(0, 240, 255, 0)");
      ctx.fillStyle = centerGrad;
      ctx.arc(cx, cy, pulseSize * 2.5, 0, Math.PI * 2);
      ctx.fill();

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`futuristic-3d-canvas ${className ?? ""}`}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        pointerEvents: "none",
        zIndex: 0,
        width: "100%",
        height: "100%",
        opacity: 0.85,
      }}
    />
  );
}
