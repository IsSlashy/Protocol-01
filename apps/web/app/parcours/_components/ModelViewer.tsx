'use client';

/**
 * Visionneuse GLB pour la section ULTRAKILL : trois angles, un seul canvas.
 *
 * C'est le SEUL composant client de /parcours. Tout le reste de la page est
 * rendu sur le serveur. three.js et ses deux extras sont charges dynamiquement
 * à l'entrée dans le viewport, donc rien n'est télécharge tant que le lecteur
 * n'a pas defile jusqu'ici.
 *
 * Les modèles sont ignores par git (voir public/models/ultrakill/.gitignore),
 * donc en production ils peuvent très bien ne pas exister. Le composant traite
 * ce cas comme un état normal et affiche une explication, plutôt que de tourner
 * indefiniment sur un chargement qui n'aboutira jamais.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from '../parcours.module.css';

export interface ModelAngle {
  id: string;
  label: string;
  file: string;
  caption: string;
  /** Position de depart de la camera, en coordonnees spheriques. */
  azimuth: number;
  elevation: number;
  /** Multiplicateur de distance applique au rayon de la boîte englobante. */
  zoom: number;
}

export const ANGLES: ModelAngle[] = [
  {
    id: 'fps',
    label: 'Vue première personne',
    file: '/models/ultrakill/fps_arms.glb',
    caption:
      "Les bras tels que le joueur les voit. C'est le maillage sur lequel s'accroche l'animation du power-up.",
    azimuth: 0.5,
    elevation: 0.15,
    zoom: 1.15,
  },
  {
    id: 'v1',
    label: 'V1',
    file: '/models/ultrakill/v1.glb',
    caption:
      "Le modèle du personnage joueur. Sert de référence d'echelle : c'est son enveloppe mesurée en jeu qui contraint la géométrie du niveau.",
    azimuth: 0.9,
    elevation: 0.2,
    zoom: 1.3,
  },
  {
    id: 'v3',
    label: 'V3',
    file: '/models/ultrakill/v3.glb',
    caption:
      'La variante V3, importee dans le projet Unity du niveau pour valider les proportions et les points de fixation.',
    azimuth: -0.8,
    elevation: 0.2,
    zoom: 1.3,
  },
];

type Status = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

export default function ModelViewer() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<Status>('idle');
  const [detail, setDetail] = useState('');
  const [inView, setInView] = useState(false);
  const [spin, setSpin] = useState(true);

  /** Tout ce qui doit survivre entre deux rendus et être libere au demontage. */
  const teardownRef = useRef<null | (() => void)>(null);
  const setModelRef = useRef<null | ((a: ModelAngle) => void)>(null);
  const spinRef = useRef(true);

  useEffect(() => {
    spinRef.current = spin;
  }, [spin]);

  /* Ne rien charger tant que la section n'est pas approchee. */
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView) return;
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let frame = 0;

    setStatus('loading');

    (async () => {
      const THREE = await import('three');
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      if (cancelled) return;

      const width = mount.clientWidth || 640;
      const height = mount.clientHeight || 420;

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x08080a);

      const camera = new THREE.PerspectiveCamera(38, width / height, 0.01, 500);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.minDistance = 0.2;
      controls.maxDistance = 200;

      /* Eclairage neutre : ces maillages sont stylises et a plat, un
         eclairage physique realiste les rendrait moins lisibles que le jeu. */
      scene.add(new THREE.AmbientLight(0xffffff, 1.5));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(3, 5, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x39c5bb, 1.1);
      rim.position.set(-4, 2, -3);
      scene.add(rim);

      const grid = new THREE.GridHelper(10, 20, 0x1c1c22, 0x14141a);
      grid.position.y = 0;
      scene.add(grid);

      const loader = new GLTFLoader();
      let current: import('three').Object3D | null = null;

      const disposeCurrent = () => {
        if (!current) return;
        scene.remove(current);
        current.traverse((o) => {
          const mesh = o as import('three').Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material as
            | import('three').Material
            | import('three').Material[]
            | undefined;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
        current = null;
      };

      const load = (angle: ModelAngle) => {
        setStatus('loading');
        loader.load(
          angle.file,
          (gltf) => {
            if (cancelled) return;
            disposeCurrent();
            const model = gltf.scene;

            /* Recentrer sur l'origine et poser le modèle sur la grille. */
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            model.position.sub(center);
            model.position.y += size.y / 2;
            scene.add(model);
            current = model;

            /* Cadrer en tenant compte du ratio : les bras sont un objet large
               et plat, donc un cadrage calcule sur le seul champ vertical les
               repousse beaucoup trop loin. On prend la distance qui satisfait
               à la fois la hauteur et la largeur, plus la demi-profondeur. */
            const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
            const fov = (camera.fov * Math.PI) / 180;
            const halfV = Math.tan(fov / 2);
            const halfH = halfV * camera.aspect;
            const distV = size.y / 2 / halfV;
            const distH = Math.max(size.x, size.z) / 2 / halfH;
            const dist = (Math.max(distV, distH) + size.z / 2) * angle.zoom;
            const { azimuth, elevation } = angle;
            camera.position.set(
              dist * Math.cos(elevation) * Math.sin(azimuth),
              size.y / 2 + dist * Math.sin(elevation),
              dist * Math.cos(elevation) * Math.cos(azimuth)
            );
            controls.target.set(0, size.y / 2, 0);
            controls.minDistance = radius * 0.6;
            controls.maxDistance = dist * 4;
            controls.update();

            grid.scale.setScalar(Math.max(radius / 2, 0.25));
            setStatus('ready');
          },
          undefined,
          (err) => {
            if (cancelled) return;
            /* Un 404 signifie presque toujours que le .glb n'a pas été
               déployé, parce qu'il est volontairement ignore par git. */
            const msg = err instanceof Error ? err.message : String(err);
            setDetail(msg);
            setStatus(/404|not found|failed to fetch/i.test(msg) ? 'missing' : 'error');
          }
        );
      };

      setModelRef.current = load;
      load(ANGLES[active]);

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const clock = new THREE.Clock();
      const tick = () => {
        frame = requestAnimationFrame(tick);
        const dt = clock.getDelta();
        if (current && spinRef.current && !reduced) {
          current.rotation.y += dt * 0.35;
        }
        controls.update();
        renderer.render(scene, camera);
      };
      tick();

      const onResize = () => {
        const w = mount.clientWidth || 640;
        const h = mount.clientHeight || 420;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(mount);

      teardownRef.current = () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        controls.dispose();
        disposeCurrent();
        grid.geometry.dispose();
        (grid.material as import('three').Material).dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) {
          mount.removeChild(renderer.domElement);
        }
      };
    })().catch((e: unknown) => {
      if (cancelled) return;
      setDetail(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });

    return () => {
      cancelled = true;
      teardownRef.current?.();
      teardownRef.current = null;
      setModelRef.current = null;
    };
    // `active` est volontairement hors des dependances : changer d'angle
    // recharge le modèle via setModelRef, sans reconstruire le renderer, le
    // contexte WebGL et les contr. Le relire ici recreerait tout a chaque
    // clic d'onglet.
  }, [inView]);

  const pick = useCallback((i: number) => {
    setActive(i);
    setModelRef.current?.(ANGLES[i]);
  }, []);

  const angle = ANGLES[active];

  /* Les trois onglets sont des boutons Styx a padding reduit : styx.css n'a pas
     de controle segmente, donc la seule chose ecrite ici est de la geometrie. */
  const tabStyle = { padding: '0.5rem 0.95rem' } as const;

  return (
    <div className="styx-panel">
      <div
        className="styx-panel-head"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.6rem',
          padding: '0.75rem 0.9rem',
        }}
      >
        <div
          role="tablist"
          aria-label="Angles"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}
        >
          {ANGLES.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={i === active ? 'styx-btn' : 'styx-btn-ghost'}
              style={tabStyle}
              onClick={() => pick(i)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="styx-btn-ghost"
          style={{ ...tabStyle, marginLeft: 'auto' }}
          onClick={() => setSpin((s) => !s)}
          aria-pressed={spin}
        >
          {spin ? 'rotation on' : 'rotation off'}
        </button>
      </div>

      <div className={styles.viewerStage}>
        <div ref={mountRef} className={styles.viewerCanvas} />

        {status !== 'ready' ? (
          <div className={styles.viewerOverlay}>
            {status === 'loading' || status === 'idle' ? (
              <p className="styx-mono">chargement du maillage...</p>
            ) : null}
            {status === 'missing' ? (
              <>
                <p className="styx-overline">Modele non déployé</p>
                <p className="styx-card-note" style={{ maxWidth: '62ch' }}>
                  Les maillages sont des assets d'ULTRAKILL, un jeu commercial de New Blood
                  Interactive. Ils tournent en local mais ne sont pas commites dans le dépôt public,
                  donc ils ne sont pas servis ici. Le mod et le niveau, eux, sont mon travail.
                </p>
              </>
            ) : null}
            {status === 'error' ? (
              <>
                <p className="styx-overline">Rendu indisponible</p>
                <p className="styx-card-note" style={{ maxWidth: '62ch' }}>
                  WebGL n'a pas pu démarrer sur cet appareil. {detail}
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <p
        className="styx-note"
        style={{ padding: '0.9rem 1.1rem', borderTop: '1px solid var(--styx-rule)' }}
      >
        <span className="styx-code-name">{angle.label}.</span>{' '}{angle.caption} Glisser pour orbiter,
        molette pour zoomer.
      </p>
    </div>
  );
}
