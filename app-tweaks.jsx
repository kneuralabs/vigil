/* Vigil — Tweaks island. Mounts the panel and maps tweaks → :root data-attrs.
   The vanilla monitoring app keeps running independently. */
const VIGIL_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "royal",
  "density": "balanced",
  "motion": true
}/*EDITMODE-END*/;

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
  const [t, setTweak] = useTweaks(VIGIL_TWEAK_DEFAULTS);
  React.useEffect(() => { applyVigilTweaks(t); }, [t.theme, t.accent, t.density, t.motion]);

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
  // VIGIL_TWEAK_DEFAULTS is the persisted source of truth (host rewrites the
  // EDITMODE block on save), so apply it directly on load — no localStorage.
  applyVigilTweaks(VIGIL_TWEAK_DEFAULTS);
  const mount = document.getElementById("tweaks-root");
  ReactDOM.createRoot(mount).render(<VigilTweaks />);
})();
