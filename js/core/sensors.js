/* global Cesium */
// GLSL "sensor" looks applied as Cesium post-process stages.
const HEAD = `
uniform sampler2D colorTexture;
uniform float u_time;
in vec2 v_textureCoordinates;
float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const SHADERS = {
  nvg: `${HEAD}
void main(){
  vec2 uv = v_textureCoordinates;
  float l = luma(texture(colorTexture, uv).rgb);
  l = pow(l, 0.75) * 1.55;
  float grain = (rand(uv * 900.0 + u_time) - 0.5) * 0.16;
  float scan = 0.94 + 0.06 * sin(uv.y * 900.0);
  vec2 d = uv - 0.5;
  float vig = smoothstep(0.62, 0.25, length(d));
  vec3 phosphor = vec3(0.18, 1.0, 0.32);
  out_FragColor = vec4(phosphor * (l + grain) * scan * vig, 1.0);
}`,
  flir: `${HEAD}
vec3 ironbow(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0, 0.0, 0.05);
  vec3 c1 = vec3(0.32, 0.0, 0.55);
  vec3 c2 = vec3(0.85, 0.12, 0.35);
  vec3 c3 = vec3(1.0, 0.55, 0.0);
  vec3 c4 = vec3(1.0, 0.95, 0.65);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5)  return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
void main(){
  vec2 uv = v_textureCoordinates;
  vec3 c = texture(colorTexture, uv).rgb;
  // Heuristic "heat": bright + warm surfaces read hot, water/vegetation cold.
  float heat = luma(c) * 0.8 + (c.r - c.b) * 0.35 + 0.08;
  heat += (rand(uv * 700.0 + u_time) - 0.5) * 0.04;
  out_FragColor = vec4(ironbow(heat), 1.0);
}`,
  crt: `${HEAD}
void main(){
  vec2 uv = v_textureCoordinates - 0.5;
  uv *= 1.0 + dot(uv, uv) * 0.12;
  uv += 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { out_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float ab = 0.0018;
  vec3 c = vec3(texture(colorTexture, uv + vec2(ab, 0.0)).r, texture(colorTexture, uv).g, texture(colorTexture, uv - vec2(ab, 0.0)).b);
  float scan = 0.82 + 0.18 * sin(uv.y * 1400.0);
  float mask = 0.9 + 0.1 * sin(uv.x * 2400.0);
  float flicker = 0.97 + 0.03 * sin(u_time * 60.0);
  vec2 d = uv - 0.5;
  float vig = smoothstep(0.75, 0.3, length(d));
  out_FragColor = vec4(c * scan * mask * flicker * vig * vec3(1.05, 1.0, 0.95), 1.0);
}`,
  noir: `${HEAD}
void main(){
  vec2 uv = v_textureCoordinates;
  float l = luma(texture(colorTexture, uv).rgb);
  l = smoothstep(0.05, 0.85, l);
  l += (rand(uv * 1200.0 + u_time) - 0.5) * 0.09;
  vec2 d = uv - 0.5;
  float vig = smoothstep(0.7, 0.2, length(d));
  out_FragColor = vec4(vec3(l * vig), 1.0);
}`,
};

export function createSensorController(viewer) {
  let stage = null;
  let current = 'normal';
  const t0 = performance.now();
  return {
    get mode() {
      return current;
    },
    set(mode) {
      if (stage) {
        viewer.scene.postProcessStages.remove(stage);
        stage = null;
      }
      current = SHADERS[mode] ? mode : 'normal';
      document.body.dataset.sensor = current;
      if (current === 'normal') return current;
      stage = viewer.scene.postProcessStages.add(
        new Cesium.PostProcessStage({
          name: 'argus_' + current,
          fragmentShader: SHADERS[current],
          uniforms: { u_time: () => ((performance.now() - t0) / 1000) % 1000 },
        }),
      );
      return current;
    },
  };
}
