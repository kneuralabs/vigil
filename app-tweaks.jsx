/* Vigil — Tweaks island. Mounts the panel and maps tweaks → :root data-attrs.
   The vanilla monitoring app keeps running independently. */
const VIGIL_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "royal",
  "density": "balanced",
  "motion": true
}/*EDITMODE-END*/;

// Theme persistence is shared with the header toggle in enhance.js:
// localStorage[vigil-theme] is the single runtime source of truth, while the
// EDITMODE `theme` above is only the shipped default when nothing is stored.
const VIGIL_THEME_KEY = "vigil-theme";
function readStoredTheme() {
  try {
    const v = localStorage.getItem(VIGIL_THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch (e) { return null; }
}
// Initial tweak values with the stored theme override applied (computed once).
const VIGIL_INITIAL_TWEAKS = {
  ...VIGIL_TWEAK_DEFAULTS,
  theme: readStoredTheme() || VIGIL_TWEAK_DEFAULTS.theme,
};

const VIGIL_ACCENTS = [
  { name: "royal", label: "Royal Authority Blue", c: "#1C5CAA" },
  { name: "navy",  label: "Deep Navy",           c: "#0D2E5A" },
  { name: "sky",   label: "Sky Blue",            c: "#4A8BC8" },
  { name: "red",   label: "Precision Red",       c: "#C8281E" }
];

function applyVigilTweaks(t) {
  const r = document.documentElement;
  r.dataset.theme = t.theme;
  r.dataset.accent = t.accent;
  r.dataset.density = t.density;
  r.dataset.motion = t.motion ? "on" : "off";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t.theme === "light" ? "#F7F8FA" : "#07182F");
}

function VigilTweaks() {
  const [t, setTweak] = useTweaks(VIGIL_INITIAL_TWEAKS);
  // Apply tweaks to :root and persist the theme so it survives reloads and
  // stays consistent with whatever the header toggle last wrote.
  React.useEffect(() => {
    applyVigilTweaks(t);
    try { localStorage.setItem(VIGIL_THEME_KEY, t.theme); } catch (e) {}
  }, [t.theme, t.accent, t.density, t.motion]);

  // Mirror header-toggle changes (enhance.js dispatches `vigil:theme`) into the
  // Mode radio so the two controls never disagree. The ref guards against
  // re-firing setTweak for a value we already hold.
  const themeRef = React.useRef(t.theme);
  themeRef.current = t.theme;
  React.useEffect(() => {
    const onExternalTheme = (e) => {
      const m = e && e.detail;
      if ((m === "dark" || m === "light") && m !== themeRef.current) setTweak("theme", m);
    };
    window.addEventListener("vigil:theme", onExternalTheme);
    return () => window.removeEventListener("vigil:theme", onExternalTheme);
  }, [setTweak]);

  return (
    <TweaksPanel>
      <TweakSection label="Theme" />
      <TweakRadio
        label="Mode" value={t.theme}
        options={["dark", "light"]}
        onChange={(v) => setTweak("theme", v)} />

      <TweakRow label="Accent">
        <div style={{ display: "flex", gap: 8 }}>
          {VIGIL_ACCENTS.map((a) => {
            const on = t.accent === a.name;
            return (
              <button key={a.name} title={a.label}
                onClick={() => setTweak("accent", a.name)}
                style={{
                  width: 30, height: 30, borderRadius: 8, cursor: "pointer",
                  background: a.c, padding: 0,
                  border: on ? "2px solid var(--tw-fg, #fff)" : "2px solid transparent",
                  boxShadow: on ? "0 0 0 2px rgba(0,0,0,.35)" : "none",
                  outline: "none", transition: "transform .12s",
                  transform: on ? "scale(1.06)" : "scale(1)"
                }} />
            );
          })}
        </div>
      </TweakRow>

      <TweakSection label="Layout" />
      <TweakRadio
        label="Density" value={t.density}
        options={["compact", "balanced", "spacious"]}
        onChange={(v) => setTweak("density", v)} />

      <TweakSection label="Motion" />
      <TweakToggle
        label="Animations" value={t.motion}
        onChange={(v) => setTweak("motion", v)} />
    </TweaksPanel>
  );
}

(function () {
  // Apply the stored-theme-aware initial values directly on load (before React
  // mounts) so there's no light→dark flash and no need to re-assert later.
  applyVigilTweaks(VIGIL_INITIAL_TWEAKS);
  const mount = document.getElementById("tweaks-root");
  ReactDOM.createRoot(mount).render(<VigilTweaks />);
})();
