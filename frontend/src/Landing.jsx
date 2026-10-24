import { useEffect, useRef } from "react";
import Auth from "./Auth.jsx";

const LETTERS = ["N", "E", "X", "U", "S"];

// Where each letter starts (in vw / vh / degrees) before it flies into place.
const FROM = [
  { x: -130, y: 0, r: -28 },  // N  comes in from the left
  { x: 0, y: -130, r: 22 },   // E  drops in from the top
  { x: 0, y: 130, r: -18 },   // X  rises from the bottom
  { x: 0, y: -130, r: -24 },  // U  drops in from the top
  { x: -130, y: 30, r: 30 },  // S  slides in from the left
];

// Words that drift around the screen, then get pulled into the title.
const WORDS = [
  { w: "SAVE", x: 6, y: 14, ax: 30, ay: 18, d: 9, s: 0 },
  { w: "SEND", x: 72, y: 10, ax: -26, ay: 24, d: 11, s: 1 },
  { w: "DEPOSIT", x: 38, y: 6, ax: 20, ay: 30, d: 12, s: 2 },
  { w: "TRANSFER", x: 8, y: 70, ax: 34, ay: -20, d: 10, s: 0.5 },
  { w: "SECURE", x: 76, y: 74, ax: -30, ay: -26, d: 13, s: 1.5 },
  { w: "BALANCE", x: 60, y: 86, ax: -18, ay: -30, d: 9, s: 2.5 },
  { w: "SPEND", x: 22, y: 86, ax: 24, ay: -22, d: 12, s: 0.8 },
  { w: "GROW", x: 84, y: 40, ax: -34, ay: 16, d: 10, s: 1.2 },
  { w: "ACCOUNT", x: 2, y: 42, ax: 28, ay: 26, d: 14, s: 2 },
  { w: "INSTANT", x: 50, y: 92, ax: 18, ay: -34, d: 11, s: 0.3 },
  { w: "CARD", x: 90, y: 20, ax: -22, ay: 30, d: 8, s: 1.8 },
  { w: "BANK", x: 28, y: 22, ax: 26, ay: 20, d: 12, s: 2.2 },
];

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export default function Landing({ onSignedIn }) {
  const heroRef = useRef(null);
  const stageRef = useRef(null);
  const subRef = useRef(null);
  const hintRef = useRef(null);
  const lettersRef = useRef([]);

  useEffect(() => {
    const hero = heroRef.current;
    const stage = stageRef.current;

    const render = (p) => {
      // The hero can unmount (e.g. right after sign-in) while a frame is queued.
      if (!hero.isConnected || !subRef.current || !hintRef.current) return;
      stage.style.setProperty("--p", p.toFixed(4));
      LETTERS.forEach((_, i) => {
        const el = lettersRef.current[i];
        if (!el) return;
        const t = clamp((p - i * 0.1) / 0.4);
        const e = easeOut(t);
        const f = FROM[i];
        el.style.opacity = clamp(t * 3);
        el.style.transform =
          `translate(${f.x * (1 - e)}vw, ${f.y * (1 - e)}vh) rotate(${f.r * (1 - e)}deg)`;
      });
      const reveal = clamp((p - 0.8) / 0.15);
      subRef.current.style.opacity = reveal;
      subRef.current.style.transform = `translateY(${(1 - reveal) * 24}px)`;
      subRef.current.style.pointerEvents = reveal > 0.5 ? "auto" : "none";
      hintRef.current.style.opacity = clamp(1 - p * 8);
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      render(1);
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = hero.getBoundingClientRect();
      const span = hero.offsetHeight - window.innerHeight;
      render(clamp(-rect.top / span));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };

    const onPointer = (e) => {
      stage.style.setProperty("--mx", ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      stage.style.setProperty("--my", ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    stage.addEventListener("pointermove", onPointer);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      stage.removeEventListener("pointermove", onPointer);
    };
  }, []);

  return (
    <>
      <section className="hero" ref={heroRef}>
        <div className="hero-stage" ref={stageRef}>
          <nav className="hero-nav">
            <span className="hero-mark">N</span>
            <a className="hero-link" href="#start">Sign in</a>
          </nav>

          {WORDS.map((item) => (
            <span key={item.w} className="word"
              style={{ "--x": item.x, "--y": item.y }} aria-hidden="true">
              <span className="word-inner"
                style={{ "--ax": `${item.ax}px`, "--ay": `${item.ay}px`,
                  animationDuration: `${item.d}s`, animationDelay: `-${item.s * 3}s` }}>
                {item.w}
              </span>
            </span>
          ))}

          <h1 className="hero-title" aria-label="Nexus">
            {LETTERS.map((ch, i) => (
              <span key={i} className="letter-fly" aria-hidden="true"
                ref={(el) => (lettersRef.current[i] = el)}>
                <span className="letter">{ch}</span>
              </span>
            ))}
          </h1>

          <div className="hero-sub" ref={subRef}>
            <p>Banking that moves with you.</p>
            <a className="hero-cta" href="#start">Open account <span aria-hidden="true">→</span></a>
          </div>

          <div className="scroll-hint" ref={hintRef}>
            <span>Scroll</span>
            <i aria-hidden="true" />
          </div>
        </div>
      </section>

      <section id="start" className="start">
        <Auth onSignedIn={onSignedIn} />
      </section>
    </>
  );
}
