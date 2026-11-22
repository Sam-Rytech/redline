import { useEffect, useRef } from "react";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import shapeUrl from "../../assets/ribbon-shape.svg?raw";

type Props = {
  size?: number;
  spin?: boolean;
  /** Swing in from edge-on to the pose over this many ms, after `introDelay` ms. */
  intro?: number;
  introDelay?: number;
  className?: string;
};

const POSE_Y = -0.22;
const easeOutBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/** The ribbon mark: the traced outline extruded into a thick red solid, posed at a three-quarter turn. */
export function RibbonMark({ size = 480, spin = false, intro = 0, introDelay = 0, className = "" }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x4a3a36, 1.3));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(-4, 6, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffd9cc, 0.6);
    fill.position.set(6, -2, 4);
    scene.add(fill);

    const data = new SVGLoader().parse(shapeUrl);
    const shapes = data.paths.flatMap((p) => SVGLoader.createShapes(p));
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: 180,
      bevelEnabled: true,
      bevelThickness: 40,
      bevelSize: 28,
      bevelSegments: 6,
      curveSegments: 24,
    });
    geometry.scale(1, -1, -1); // the trace is stored upside down; flipping depth too keeps faces outward
    geometry.center();
    const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute("position") as THREE.BufferAttribute);
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    const face = new THREE.MeshStandardMaterial({ color: 0xe5321f, roughness: 0.55 });
    const side = new THREE.MeshStandardMaterial({ color: 0x9e1a0d, roughness: 0.6 });
    const mesh = new THREE.Mesh(geometry, [face, side]);
    const group = new THREE.Group();
    group.add(mesh);
    group.scale.setScalar(1.6 / span);
    group.rotation.order = "YXZ";
    group.rotation.set(0.32, POSE_Y, 0);
    const baseScale = group.scale.x;
    scene.add(group);

    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    camera.position.set(0, 0, 4.2);

    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const ms = now - t0;
      let more = spin;
      if (intro > 0) {
        const k = Math.max(0, Math.min(1, (ms - introDelay) / intro));
        const e = easeOutBack(k);
        group.visible = ms >= introDelay;
        group.rotation.y = POSE_Y + (1 - e) * (Math.PI / 2);
        group.scale.setScalar(baseScale * (0.35 + 0.65 * Math.min(1, e)));
        if (k < 1) more = true;
      }
      if (spin) group.rotation.y = POSE_Y + (ms / 1000) * 0.9;
      renderer.render(scene, camera);
      if (more) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      geometry.dispose();
      face.dispose();
      side.dispose();
      renderer.dispose();
    };
  }, [size, spin, intro, introDelay]);

  return <canvas ref={ref} className={className} style={{ width: size, height: size }} aria-hidden="true" />;
}
