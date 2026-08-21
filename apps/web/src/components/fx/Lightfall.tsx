import { useEffect, useRef, useState, memo } from "react";

const MAX_COLORS = 8;

const hexToRGB = (hex: string): [number, number, number] => {
  const c = hex.replace("#", "").padEnd(6, "0");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  return [r, g, b];
};

const prepColors = (input?: string[]) => {
  const base = (input && input.length ? input : ["#A6C8FF", "#5227FF", "#FF9FFC"]).slice(
    0,
    MAX_COLORS,
  );
  const count = base.length;
  const arr: [number, number, number][] = [];
  for (let i = 0; i < MAX_COLORS; i++) arr.push(hexToRGB(base[Math.min(i, base.length - 1)]));
  const avg: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    avg[0] += arr[i][0];
    avg[1] += arr[i][1];
    avg[2] += arr[i][2];
  }
  avg[0] /= count;
  avg[1] /= count;
  avg[2] /= count;
  return { arr, count, avg };
};

const vertex = /* glsl */ `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;

uniform vec3  iResolution;
uniform vec2  iMouse;
uniform float iTime;

uniform vec3  uColor0;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform vec3  uColor3;
uniform vec3  uColor4;
uniform vec3  uColor5;
uniform vec3  uColor6;
uniform vec3  uColor7;
uniform int   uColorCount;

uniform vec3  uBgColor;
uniform vec3  uMouseColor;
uniform float uSpeed;
uniform int   uStreakCount;
uniform float uStreakWidth;
uniform float uStreakLength;
uniform float uGlow;
uniform float uDensity;
uniform float uTwinkle;
uniform float uZoom;
uniform float uBgGlow;
uniform float uOpacity;
uniform float uMouseEnabled;
uniform float uMouseStrength;
uniform float uMouseRadius;

varying vec2 vUv;

vec3 palette(float h) {
  int count = uColorCount;
  if (count < 1) count = 1;
  int idx = int(floor(clamp(h, 0.0, 0.999999) * float(count)));
  if (idx <= 0) return uColor0;
  if (idx == 1) return uColor1;
  if (idx == 2) return uColor2;
  if (idx == 3) return uColor3;
  if (idx == 4) return uColor4;
  if (idx == 5) return uColor5;
  if (idx == 6) return uColor6;
  return uColor7;
}

vec3 tanhv(vec3 x) {
  vec3 e = exp(-2.0 * x);
  return (1.0 - e) / (1.0 + e);
}

vec2 sceneC(vec2 frag, vec2 r) {
  vec2 P = (frag + frag - r) / r.x;
  float z = 0.0;
  float d = 1e3;
  vec4 O = vec4(0.0);
  for (int k = 0; k < 25; k++) {
    if (d <= 1e-4) break;
    O = z * normalize(vec4(P, uZoom, 0.0)) - vec4(0.0, 4.0, 1.0, 0.0) / 4.5;
    d = 1.0 - sqrt(length(O * O));
    z += d;
  }
  return vec2(O.x, atan(O.z, O.y));
}

void mainImage(out vec4 o, vec2 C) {
  vec2 r = iResolution.xy;
  vec2 uv0 = (C + C - r) / r.x;
  float T = 0.1 * iTime * uSpeed + 9.0;
  float angRings = max(1.0, floor(6.28318530718 * max(uDensity, 0.05) + 0.5));
  vec2 Y = vec2(5e-3, 6.28318530718 / angRings);

  vec2 c0 = sceneC(C, r);
  vec2 cdx = sceneC(C + vec2(1.0, 0.0), r);
  vec2 cdy = sceneC(C + vec2(0.0, 1.0), r);
  vec2 dCx = cdx - c0;
  vec2 dCy = cdy - c0;
  dCx.y -= 6.28318530718 * floor(dCx.y / 6.28318530718 + 0.5);
  dCy.y -= 6.28318530718 * floor(dCy.y / 6.28318530718 + 0.5);
  vec2 fw = abs(dCx) + abs(dCy);
  C = c0;

  vec2 P = vec2(2.0, 1.0) * uv0 - (r / r.x) * vec2(0.0, 1.0);
  vec4 O = vec4(uBgColor * 90.0 * uBgGlow / (1e3 * dot(P, P) + 6.0), 0.0);

  float mGlow = 0.0;
  if (uMouseEnabled > 0.5) {
    vec2 mN = (iMouse + iMouse - r) / r.x;
    float md = length(uv0 - mN);
    mGlow = exp(-md * md / max(uMouseRadius * uMouseRadius, 1e-4)) * uMouseStrength;
    O.rgb += uMouseColor * mGlow * 0.25;
  }

  float zr = 5e-4 * uStreakWidth;
  vec2 rr = vec2(max(length(fw), 1e-5));
  float tail = 19.0 / max(uStreakLength, 0.05);

  for (int m = 0; m < 16; m++) {
    if (m >= uStreakCount) break;
    float jf = float(m) + 1.0;
    float ic = fract(sin(dot(vec2(jf, floor(C.x / Y.x + 0.5)), vec2(7.0, 11.0)) * 73.0));
    vec2 Pp = C - (T + T * ic) * vec2(0.0, 1.0);
    Pp -= floor(Pp / Y + 0.5) * Y;
    float h = fract(8663.0 * ic);
    vec3 col = palette(h);
    float weight = mix(1.5, 1.0 + sin(T + 7.0 * h + 4.0), uTwinkle);
    weight *= (1.0 + mGlow * 2.0);
    vec2 inner = vec2(length(max(Pp, vec2(-1.0, 0.0))), length(Pp) - zr) - zr;
    vec2 sm = vec2(1.0) - smoothstep(-rr, rr, inner);
    O.rgb += dot(sm, vec2(exp(tail * Pp.y), 3.0)) * col * weight;
    C.x += Y.x / 8.0;
  }

  vec3 colr = sqrt(tanhv(max(O.rgb * uGlow - vec3(0.04, 0.08, 0.02), 0.0)));
  float streakAlpha = clamp(max(max(colr.r, colr.g), colr.b) * 2.4, 0.0, 1.0) * uOpacity;
  o = vec4(colr, streakAlpha);
}

void main() {
  vec4 color;
  mainImage(color, vUv * iResolution.xy);
  gl_FragColor = color;
}
`;

export interface LightfallProps {
  className?: string;
  dpr?: number;
  paused?: boolean;
  colors?: string[];
  backgroundColor?: string;
  speed?: number;
  streakCount?: number;
  streakWidth?: number;
  streakLength?: number;
  glow?: number;
  density?: number;
  twinkle?: number;
  zoom?: number;
  backgroundGlow?: number;
  opacity?: number;
  mouseInteraction?: boolean;
  mouseStrength?: number;
  mouseRadius?: number;
  mouseDampening?: number;
  mixBlendMode?: string;
}

function LightfallComponent({
  className,
  dpr,
  paused = false,
  colors = ["#F59E0B", "#D97706", "#10B981"],
  backgroundColor = "#07070A",
  speed = 0.5,
  streakCount = 2,
  streakWidth = 1,
  streakLength = 1,
  glow = 1,
  density = 0.6,
  twinkle = 1,
  zoom = 3,
  backgroundGlow = 0.5,
  opacity = 1,
  mouseInteraction = true,
  mouseStrength = 0.5,
  mouseRadius = 1,
  mouseDampening = 0.15,
  mixBlendMode,
}: LightfallProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const rendererRef = useRef<unknown>(null);
  const programRef = useRef<unknown>(null);
  const meshRef = useRef<unknown>(null);
  const geometryRef = useRef<unknown>(null);
  const uniformsRef = useRef<Record<string, { value: unknown }> | null>(null);
  const mouseTargetRef = useRef<number[]>([0, 0]);
  const lastTimeRef = useRef<number>(0);
  const [mounted, setMounted] = useState(false);

  // Store latest prop targets in a ref for smooth lerping without WebGL teardowns
  const propsRef = useRef({
    colors,
    backgroundColor,
    speed,
    streakCount,
    streakWidth,
    streakLength,
    glow,
    density,
    twinkle,
    zoom,
    backgroundGlow,
    opacity,
    mouseInteraction,
    mouseStrength,
    mouseRadius,
    mouseDampening,
    paused,
  });

  propsRef.current = {
    colors,
    backgroundColor,
    speed,
    streakCount,
    streakWidth,
    streakLength,
    glow,
    density,
    twinkle,
    zoom,
    backgroundGlow,
    opacity,
    mouseInteraction,
    mouseStrength,
    mouseRadius,
    mouseDampening,
    paused,
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    import("ogl")
      .then(({ Renderer, Program, Mesh, Triangle }) => {
        if (cancelled || !container) return;

        const effectiveDpr = Math.min(dpr ?? window.devicePixelRatio ?? 1, 1.5);

        let renderer: InstanceType<typeof Renderer>;
        try {
          renderer = new Renderer({
            dpr: effectiveDpr,
            alpha: true,
            antialias: true,
          });
        } catch {
          return;
        }
        rendererRef.current = renderer;
        const gl = renderer.gl;
        if (!gl) return;
        const canvas = gl.canvas as HTMLCanvasElement;

        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        container.appendChild(canvas);

        const { arr, count, avg } = prepColors(propsRef.current.colors);

        const uniforms: Record<string, { value: unknown }> = {
          iResolution: { value: [gl.drawingBufferWidth, gl.drawingBufferHeight, 1] },
          iMouse: { value: [0, 0] },
          iTime: { value: 0 },
          uColor0: { value: [...arr[0]] },
          uColor1: { value: [...arr[1]] },
          uColor2: { value: [...arr[2]] },
          uColor3: { value: [...arr[3]] },
          uColor4: { value: [...arr[4]] },
          uColor5: { value: [...arr[5]] },
          uColor6: { value: [...arr[6]] },
          uColor7: { value: [...arr[7]] },
          uColorCount: { value: count },
          uBgColor: { value: hexToRGB(propsRef.current.backgroundColor) },
          uMouseColor: { value: [...avg] },
          uSpeed: { value: propsRef.current.speed },
          uStreakCount: {
            value: Math.max(1, Math.min(16, Math.round(propsRef.current.streakCount))),
          },
          uStreakWidth: { value: propsRef.current.streakWidth },
          uStreakLength: { value: propsRef.current.streakLength },
          uGlow: { value: propsRef.current.glow },
          uDensity: { value: propsRef.current.density },
          uTwinkle: { value: propsRef.current.twinkle },
          uZoom: { value: propsRef.current.zoom },
          uBgGlow: { value: propsRef.current.backgroundGlow },
          uOpacity: { value: propsRef.current.opacity },
          uMouseEnabled: { value: propsRef.current.mouseInteraction ? 1 : 0 },
          uMouseStrength: { value: propsRef.current.mouseStrength },
          uMouseRadius: { value: propsRef.current.mouseRadius },
        };
        uniformsRef.current = uniforms;

        const program = new Program(gl, { vertex, fragment, uniforms });
        programRef.current = program;

        const geometry = new Triangle(gl);
        geometryRef.current = geometry;
        const mesh = new Mesh(gl, { geometry, program });
        meshRef.current = mesh;

        const resize = () => {
          const rect = container.getBoundingClientRect();
          renderer.setSize(rect.width, rect.height);
          (uniforms.iResolution.value as number[]) = [
            gl.drawingBufferWidth,
            gl.drawingBufferHeight,
            1,
          ];
        };

        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(container);

        const onPointerMove = (e: PointerEvent) => {
          const rect = canvas.getBoundingClientRect();
          const scale = renderer.dpr || 1;
          const x = (e.clientX - rect.left) * scale;
          const y = (rect.height - (e.clientY - rect.top)) * scale;
          mouseTargetRef.current = [x, y];
          if (propsRef.current.mouseDampening <= 0) {
            (uniforms.iMouse.value as number[]) = [x, y];
          }
        };
        canvas.addEventListener("pointermove", onPointerMove);

        // Smooth uniform interpolation loop
        const loop = (t: number) => {
          rafRef.current = requestAnimationFrame(loop);
          (uniforms.iTime.value as number) = t * 0.001;

          if (!lastTimeRef.current) lastTimeRef.current = t;
          const dt = Math.min((t - lastTimeRef.current) / 1000, 0.1);
          lastTimeRef.current = t;

          const p = propsRef.current;

          // Smooth lerp factor for seamless theme switching (~300ms transition)
          const lerpFactor = Math.min(1.0, dt * 6.0);

          // Lerp colors
          const { arr: targetColors, count: targetCount, avg: targetAvg } = prepColors(p.colors);
          uniforms.uColorCount.value = targetCount;
          for (let i = 0; i < MAX_COLORS; i++) {
            const cur = (uniforms[`uColor${i}`] as { value: [number, number, number] }).value;
            const target = targetColors[i];
            cur[0] += (target[0] - cur[0]) * lerpFactor;
            cur[1] += (target[1] - cur[1]) * lerpFactor;
            cur[2] += (target[2] - cur[2]) * lerpFactor;
          }

          // Lerp mouse and background colors
          const curMouse = uniforms.uMouseColor.value as [number, number, number];
          curMouse[0] += (targetAvg[0] - curMouse[0]) * lerpFactor;
          curMouse[1] += (targetAvg[1] - curMouse[1]) * lerpFactor;
          curMouse[2] += (targetAvg[2] - curMouse[2]) * lerpFactor;

          const targetBg = hexToRGB(p.backgroundColor);
          const curBg = uniforms.uBgColor.value as [number, number, number];
          curBg[0] += (targetBg[0] - curBg[0]) * lerpFactor;
          curBg[1] += (targetBg[1] - curBg[1]) * lerpFactor;
          curBg[2] += (targetBg[2] - curBg[2]) * lerpFactor;

          // Lerp scalar parameters
          uniforms.uGlow.value =
            (uniforms.uGlow.value as number) +
            (p.glow - (uniforms.uGlow.value as number)) * lerpFactor;
          uniforms.uOpacity.value =
            (uniforms.uOpacity.value as number) +
            (p.opacity - (uniforms.uOpacity.value as number)) * lerpFactor;
          uniforms.uBgGlow.value =
            (uniforms.uBgGlow.value as number) +
            (p.backgroundGlow - (uniforms.uBgGlow.value as number)) * lerpFactor;
          uniforms.uStreakWidth.value =
            (uniforms.uStreakWidth.value as number) +
            (p.streakWidth - (uniforms.uStreakWidth.value as number)) * lerpFactor;
          uniforms.uStreakLength.value =
            (uniforms.uStreakLength.value as number) +
            (p.streakLength - (uniforms.uStreakLength.value as number)) * lerpFactor;
          uniforms.uSpeed.value =
            (uniforms.uSpeed.value as number) +
            (p.speed - (uniforms.uSpeed.value as number)) * lerpFactor;
          uniforms.uDensity.value =
            (uniforms.uDensity.value as number) +
            (p.density - (uniforms.uDensity.value as number)) * lerpFactor;
          uniforms.uTwinkle.value =
            (uniforms.uTwinkle.value as number) +
            (p.twinkle - (uniforms.uTwinkle.value as number)) * lerpFactor;
          uniforms.uZoom.value =
            (uniforms.uZoom.value as number) +
            (p.zoom - (uniforms.uZoom.value as number)) * lerpFactor;
          uniforms.uStreakCount.value = Math.max(1, Math.min(16, Math.round(p.streakCount)));
          uniforms.uMouseEnabled.value = p.mouseInteraction ? 1 : 0;
          uniforms.uMouseStrength.value = p.mouseStrength;
          uniforms.uMouseRadius.value = p.mouseRadius;

          // Mouse position damping
          if (p.mouseDampening > 0) {
            const tau = Math.max(1e-4, p.mouseDampening);
            let factor = 1 - Math.exp(-dt / tau);
            if (factor > 1) factor = 1;
            const target = mouseTargetRef.current;
            const cur = uniforms.iMouse.value as number[];
            cur[0] += (target[0] - cur[0]) * factor;
            cur[1] += (target[1] - cur[1]) * factor;
          }

          if (!p.paused && programRef.current && meshRef.current) {
            try {
              renderer.render({ scene: meshRef.current as InstanceType<typeof Mesh> });
            } catch (e) {
              console.error(e);
            }
          }
        };

        rafRef.current = requestAnimationFrame(loop);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const callIfFn = (obj: unknown, key: string) => {
        if (obj && typeof (obj as Record<string, unknown>)[key] === "function") {
          (obj as Record<string, (...args: unknown[]) => void>)[key].call(obj);
        }
      };
      callIfFn(programRef.current, "remove");
      callIfFn(geometryRef.current, "remove");
      callIfFn(meshRef.current, "remove");
      callIfFn(rendererRef.current, "destroy");
      const container = containerRef.current;
      if (container) {
        const canvas = container.querySelector("canvas");
        if (canvas && canvas.parentElement === container) container.removeChild(canvas);
      }
      rendererRef.current = null;
      programRef.current = null;
      geometryRef.current = null;
      meshRef.current = null;
      uniformsRef.current = null;
    };
  }, [mounted, dpr]);

  return (
    <div
      ref={containerRef}
      className={`lightfall-container ${className ?? ""}`}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        ...(mixBlendMode
          ? { mixBlendMode: mixBlendMode as React.CSSProperties["mixBlendMode"] }
          : {}),
      }}
    />
  );
}

export const Lightfall = memo(LightfallComponent);
export default Lightfall;
