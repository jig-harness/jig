/**
 * The home page's jig, drawn from its model (public/models/doweling-jig.glb)
 * as a technical drawing: paper faces, ink edges and silhouettes, in the
 * page's own tokens, so it follows the theme like a plate. The page's first
 * `--seq-len` of scrolling plays the model's "close" clip (the jaws close on
 * the board, the bushings seat, the bit descends), and a fine pointer
 * swivels it a few degrees. Everything here is an enhancement: the host
 * holds a still plate, hidden once the first frame is drawn, and nothing
 * loads when the reader asks for reduced motion or the browser has no
 * WebGL 2, and not below 1000 pixels wide, where the still plate stands.
 * Either preference can change while the page is open: the model then
 * starts once it is wanted, and while it is not, the host's styles bring
 * the still back and the figure stops answering scroll and pointer.
 */
import type * as THREE from "three";

interface Tokens {
  paper: string;
  ink: string;
}

/** How long the model may take to arrive before the still plate stays. */
const LOAD_TIMEOUT_MS = 20_000;

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const wide = matchMedia("(width > 1000px)");

const host = document.querySelector<HTMLElement>("[data-jig-model]");
if (host && webgl2()) {
  let started = false;
  const begin = () => {
    if (started || !wanted()) return;
    started = true;
    // Any failure (a stalled or broken download, a renderer that cannot be
    // made) leaves the still plate standing; a later change may retry.
    start(host).then(
      (running) => {
        if (!running) started = false;
      },
      () => {
        started = false;
      },
    );
  };
  reducedMotion.addEventListener("change", begin);
  wide.addEventListener("change", begin);
  begin();
}

function wanted(): boolean {
  return !reducedMotion.matches && wide.matches;
}

/** three.js's renderer needs WebGL 2. */
function webgl2(): boolean {
  return Boolean(document.createElement("canvas").getContext("webgl2"));
}

/** The page's colors, resolved by elements that wear the tokens. */
function tokens(el: HTMLElement): Tokens {
  const paperProbe = el.querySelector<HTMLElement>(".paper-probe");
  return {
    paper: paperProbe ? getComputedStyle(paperProbe).backgroundColor : "#fff",
    ink: getComputedStyle(el).color,
  };
}

/** The scroll distance the clip plays over, from the `--seq-len` probe. */
function seqLength(el: HTMLElement): number {
  const probe = el.querySelector<HTMLElement>(".seq-probe");
  return Math.max(
    1,
    probe?.getBoundingClientRect().height ?? innerHeight * 0.6,
  );
}

/** Samples per second of a retimed track. */
const RETIME_RATE = 50;

/**
 * Resamples a baked track so what it does between the `from` fractions of
 * the clip happens between the `to` fractions instead, holding its first
 * value before and its last after. The track gets new, uniform samples
 * over the whole clip: the optimizer keeps only the samples a linear
 * stretch needs, and the moved stretch needs samples at its own ends.
 */
function retime(
  track: THREE.KeyframeTrack,
  from: [number, number],
  to: [number, number],
  duration: number,
  components?: number[],
): void {
  const { times, values } = track;
  const size = track.getValueSize();
  const at = (time: number, out: Float32Array | number[], offset: number) => {
    let i = 1;
    while (i < times.length - 1 && times[i] < time) i++;
    const t0 = times[i - 1];
    const t1 = times[i];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
    for (let k = 0; k < size; k++) {
      const a = values[(i - 1) * size + k];
      const b = values[i * size + k];
      out[offset + k] = a + (b - a) * f;
    }
  };
  const [f0, f1] = [from[0] * duration, from[1] * duration];
  const [g0, g1] = [to[0] * duration, to[1] * duration];
  const count = Math.max(2, Math.ceil(duration * RETIME_RATE) + 1);
  const nextTimes = new Float32Array(count);
  const nextValues = new Float32Array(count * size);
  const moved = new Float32Array(size);
  for (let i = 0; i < count; i++) {
    const time = (i / (count - 1)) * duration;
    nextTimes[i] = time;
    at(time, nextValues, i * size);
    const source = Math.min(
      f1,
      Math.max(f0, f0 + ((time - g0) / (g1 - g0)) * (f1 - f0)),
    );
    at(source, moved, 0);
    for (let k = 0; k < size; k++)
      if (!components || components.includes(k))
        nextValues[i * size + k] = moved[k];
  }
  track.times = nextTimes;
  track.values = nextValues;
}

/** The model's parts, by the names of their nodes in the GLB. */
const PARTS = new Set([
  "Board",
  "JawNear",
  "JawFar",
  "RodLeft",
  "RodRight",
  "Screw",
  "Handle",
  "Block",
  "BushingCentre",
  "BushingLeft",
  "BushingRight",
  "Bit",
]);

/* The engraving's shader fragments, spliced into MeshLambertMaterial. */
const ENGRAVE_HEAD = `
uniform vec3 uInk;
uniform vec3 uPaper;
uniform float uMode;
varying vec3 vPartNormal;
// A line about a pixel wide centred on each whole value of x (x counts
// lines); fades out where the lines would pack closer than three pixels.
// The width has a floor: where the UVs do not change across a pixel,
// smoothstep's edges would be equal, and its result undefined.
float engraveLine(float x) {
  float d = abs(fract(x) - 0.5);
  float aa = max(fwidth(x), 1e-4);
  float line = 1.0 - smoothstep(0.6 * aa, 1.4 * aa, d);
  return line * (1.0 - smoothstep(0.25, 0.4, aa));
}`;
const ENGRAVE_BODY = `
{
  // The face's shade under one light fixed to the part, from above, the
  // left and behind, so the faces the camera sees from the near left are
  // the shaded ones: 1 facing the light, -1 turned away.
  float lit = dot(normalize(vPartNormal), normalize(vec3(-0.5, 0.85, -0.5)));
  float mask = 0.0;
  if (uMode < 0.5) {
    float wob = 0.22 * sin(vUv.x * 7.0 + 1.7 * sin(vUv.x * 2.1 + vUv.y * 3.0))
      + 0.08 * sin(vUv.x * 23.0 + vUv.y * 11.0);
    mask = 0.45 * engraveLine(vUv.y * 11.0 + wob);
    mask += 0.5 * engraveLine((vUv.x + vUv.y) * 12.0) * step(lit, -0.5);
  } else if (uMode < 1.5) {
    mask = 0.55 * engraveLine((vUv.x + vUv.y) * 12.0) * step(lit, 0.25);
    mask += 0.55 * engraveLine((vUv.x - vUv.y) * 12.0) * step(lit, -0.5);
  }
  outgoingLight = mix(uPaper, uInk, clamp(mask, 0.0, 1.0));
}`;

/** Draws the model into `el`; false when it is not drawn after all. */
async function start(el: HTMLElement): Promise<boolean> {
  const src = el.dataset.src;
  if (!src) return false;
  const [
    T,
    { GLTFLoader },
    { MeshoptDecoder },
    { LineSegments2 },
    { LineSegmentsGeometry },
    { LineMaterial },
  ] = await Promise.all([
    import("three"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
    import("three/addons/lines/LineSegments2.js"),
    import("three/addons/lines/LineSegmentsGeometry.js"),
    import("three/addons/lines/LineMaterial.js"),
  ]);
  // The preference may have changed while the code was arriving.
  if (!wanted()) return false;
  // The download is bounded, and dropped when the model stops being wanted.
  const manager = new T.LoadingManager();
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const abort = () => {
    if (!wanted()) manager.abort();
  };
  reducedMotion.addEventListener("change", abort);
  wide.addEventListener("change", abort);
  const timer = setTimeout(() => manager.abort(), LOAD_TIMEOUT_MS);
  const gltf = await loader.loadAsync(src).finally(() => {
    clearTimeout(timer);
    reducedMotion.removeEventListener("change", abort);
    wide.removeEventListener("change", abort);
  });
  if (!wanted()) return false;
  const model = gltf.scene;
  // A model without its clip is not drawn: the still plate stays.
  const clip =
    gltf.animations.find((a) => a.name === "close") ?? gltf.animations[0];
  if (!clip) return false;

  const renderer = new T.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  el.append(renderer.domElement);

  const scene = new T.Scene();
  const rig = new T.Group();
  rig.add(model);
  scene.add(rig);
  scene.add(new T.HemisphereLight(0xffffff, 0x9a9a9a, 1.6));
  const sun = new T.DirectionalLight(0xffffff, 0.5);
  sun.position.set(-0.4, 1, 0.8);
  scene.add(sun);

  // Paper faces, ink edges, and an inverted hull for the silhouettes the
  // edge lines miss (a cylinder's sides have no sharp edge).
  // The engraving: every face is paper, and its shade is drawn as hatching
  // in ink from the part's UV map, denser as the face turns from a light
  // fixed to the part. The board gets its grain along its length (mode 0),
  // the jaws and the guide block a diagonal hatch (1); the small round
  // parts stay plain (3), their edges and silhouettes being enough. One
  // material per mode; the colors are shared.
  const inkColor = { value: new T.Color() };
  const paperColor = { value: new T.Color() };
  const engraved = (mode: 0 | 1 | 3) => {
    const m = new T.MeshLambertMaterial({
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    m.defines = { USE_UV: "" };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uInk = inkColor;
      shader.uniforms.uPaper = paperColor;
      shader.uniforms.uMode = { value: mode };
      // The part's own normal, so a face's shade is fixed to the face and
      // does not change as the figure turns.
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vPartNormal;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvPartNormal = normal;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${ENGRAVE_HEAD}`)
        .replace(
          "#include <opaque_fragment>",
          `${ENGRAVE_BODY}\n#include <opaque_fragment>`,
        );
    };
    return m;
  };
  const papers = { wood: engraved(0), metal: engraved(1), plain: engraved(3) };
  const HATCHED = new Set(["JawNear", "JawFar", "Block"]);
  // A mesh is named for its data, under the node named for the part (a
  // part with children, or with several primitives, gets a node of its
  // own); the part is the nearest named ancestor.
  const partOf = (mesh: THREE.Object3D): string => {
    for (let o: THREE.Object3D | null = mesh; o; o = o.parent)
      if (PARTS.has(o.name)) return o.name;
    return mesh.name;
  };
  const paperFor = (part: string) =>
    part === "Board"
      ? papers.wood
      : HATCHED.has(part)
        ? papers.metal
        : papers.plain;
  const ink = new LineMaterial({
    linewidth: 1.4,
    transparent: true,
    opacity: 0.85,
    worldUnits: false,
  });
  const hull = new T.MeshBasicMaterial({ side: T.BackSide });
  hull.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\ntransformed += normalize(normal) * 0.0007;",
    );
  };
  const meshes: THREE.Mesh[] = [];
  model.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
  });
  for (const mesh of meshes) {
    mesh.material = paperFor(partOf(mesh));
    const threshold = 30;
    const edges = new LineSegments2(
      new LineSegmentsGeometry().fromEdgesGeometry(
        new T.EdgesGeometry(mesh.geometry, threshold),
      ),
      ink,
    );
    const outline = new T.Mesh(mesh.geometry, hull);
    mesh.add(edges, outline);
  }

  // The bit sets off a moment after the bushings rather than once they are
  // seated: its tracks are resampled so the motion the clip has in its last
  // fifth plays from 62% to 92% of the clip instead.
  for (const track of clip.tracks) {
    // Only the vertical component moves: the parts also ride along with the
    // guide block while the jaws close, and that must stay in step with it.
    if (track.name === "Bit.position")
      retime(track, [0.8, 1], [0.54, 0.9], clip.duration, [1]);
    if (
      track.name === "BushingLeft.position" ||
      track.name === "BushingRight.position"
    )
      retime(track, [0.55, 0.8], [0.42, 0.72], clip.duration, [1]);
  }

  const mixer = new T.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  action.paused = true;

  // The camera: a three-quarter view from above and the near left, framed
  // on the open pose (the largest).
  const camera = new T.PerspectiveCamera(20, 16 / 9, 0.01, 10);
  const frame = () => {
    action.time = 0;
    mixer.update(0);
    // Framed on the whole model in the open pose, the bit raised above the
    // guide block included; the offsets below are tuned to that box.
    const box = new T.Box3().setFromObject(model);
    const center = box.getCenter(new T.Vector3());
    const radius = box.getSize(new T.Vector3()).length() / 2;
    rig.position.copy(center).negate();
    // From the near left, turned so the handle comes toward the viewer.
    const dir = new T.Vector3(-0.55, 1.15, 1).normalize();
    const dist =
      (radius / Math.sin(T.MathUtils.degToRad(camera.fov / 2))) * 0.8;
    camera.position.copy(dir.multiplyScalar(dist));
    camera.lookAt(0, -radius * 0.1, 0);
  };
  frame();

  const applyTokens = () => {
    const t = tokens(el);
    paperColor.value.set(t.paper);
    inkColor.value.set(t.ink);
    for (const m of Object.values(papers)) m.color.set(t.paper);
    ink.color.set(t.ink);
    hull.color.set(t.ink);
  };
  applyTokens();

  // Drawing on demand: scroll, pointer, theme and size each ask for one
  // frame; the swivel eases over a few.
  let queued = false;
  const draw = () => {
    queued = false;
    if (renderer.getContext().isContextLost()) return;
    renderer.render(scene, camera);
    if (!el.dataset.ready) el.dataset.ready = "1";
  };
  const requestDraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };

  const resize = () => {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    ink.resolution.set(
      width * renderer.getPixelRatio(),
      height * renderer.getPixelRatio(),
    );
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestDraw();
  };
  new ResizeObserver(resize).observe(el);

  // A lost drawing context brings the still back until a frame is drawn
  // on the restored one; nothing else would ask for that frame.
  renderer.domElement.addEventListener("webglcontextlost", () => {
    delete el.dataset.ready;
  });
  renderer.domElement.addEventListener("webglcontextrestored", requestDraw);
  resize();

  // The rig's turn is two parts: the scroll's spin, from SPIN_FROM at the
  // top of the page to its rest as the clip ends, and the pointer's swivel.
  const SPIN_FROM = T.MathUtils.degToRad(22);
  const turn = { spin: SPIN_FROM, yaw: 0, pitch: 0 };
  const pose = () => {
    rig.rotation.y = turn.spin + turn.yaw;
    rig.rotation.x = turn.pitch;
  };
  pose();

  let seq = seqLength(el);
  const scrub = () => {
    if (!wanted()) return;
    const t = Math.min(1, Math.max(0, scrollY / seq));
    action.time = t * clip.duration;
    mixer.update(0);
    turn.spin = SPIN_FROM * (1 - t);
    pose();
    requestDraw();
  };
  addEventListener("scroll", scrub, { passive: true });
  addEventListener("resize", () => {
    seq = seqLength(el);
    scrub();
  });
  scrub();
  // Wanted again after a narrow window or reduced motion: catch up.
  reducedMotion.addEventListener("change", scrub);
  wide.addEventListener("change", scrub);

  const themed = new MutationObserver(() => {
    applyTokens();
    requestDraw();
  });
  themed.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    applyTokens();
    requestDraw();
  });

  // The swivel: a fine pointer over the hero turns the jig a few degrees
  // toward it, and it eases back when the pointer leaves.
  if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
    const stage = el.closest("section") ?? el;
    const target = { yaw: 0, pitch: 0 };
    let easing = false;
    const ease = () => {
      const dy = target.yaw - turn.yaw;
      const dp = target.pitch - turn.pitch;
      turn.yaw += dy * 0.12;
      turn.pitch += dp * 0.12;
      pose();
      draw();
      if (Math.abs(dy) > 0.0005 || Math.abs(dp) > 0.0005)
        requestAnimationFrame(ease);
      else easing = false;
    };
    const nudge = () => {
      if (easing) return;
      easing = true;
      requestAnimationFrame(ease);
    };
    stage.addEventListener("pointermove", (e) => {
      if (!wanted()) return;
      const r = stage.getBoundingClientRect();
      target.yaw =
        ((e.clientX - r.left) / r.width - 0.5) * T.MathUtils.degToRad(14);
      target.pitch =
        ((e.clientY - r.top) / r.height - 0.5) * T.MathUtils.degToRad(6);
      nudge();
    });
    stage.addEventListener("pointerleave", () => {
      target.yaw = 0;
      target.pitch = 0;
      nudge();
    });
  }
  return true;
}
