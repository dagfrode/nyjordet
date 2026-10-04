// Ren logikk for veinettet: geometri, ruter, nøkkeltall og optimering.
// Ingen DOM – kan kjøres både i nettleser (window.Graf) og i node (require).
(function (root) {
  "use strict";

  const RETNINGER = ["toveis", "fram", "bak", "stengt"];

  // ---------- geometri ----------

  function polylinje(nett, kant) {
    const n = nodeMap(nett);
    const a = n[kant.fra], b = n[kant.til];
    return [[a.x, a.y], ...kant.punkter, [b.x, b.y]];
  }

  function lengde(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return s;
  }

  // Nærmeste punkt på polylinje: { d: avstand langs linja, dist: avstand fra p, x, y }
  function projiser(pts, p) {
    let best = null, akk = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
      const x = ax + t * dx, y = ay + t * dy, dist = Math.hypot(p[0] - x, p[1] - y);
      if (!best || dist < best.dist) best = { d: akk + t * Math.sqrt(l2), dist, x, y };
      akk += Math.sqrt(l2);
    }
    return best;
  }

  // Punkt på avstand d langs polylinje
  function punktPaa(pts, d) {
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d <= l || i === pts.length - 1) {
        const t = l ? Math.min(1, d / l) : 0;
        return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
      }
      d -= l;
    }
    return pts[pts.length - 1];
  }

  // Del av polylinje mellom d0 og d1 (d0 > d1 gir motsatt retning)
  function delLinje(pts, d0, d1) {
    const rev = d0 > d1;
    const [s, e] = rev ? [d1, d0] : [d0, d1];
    const ut = [punktPaa(pts, s)];
    let akk = 0;
    for (let i = 1; i < pts.length; i++) {
      akk += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (akk > s && akk < e) ut.push(pts[i]);
    }
    ut.push(punktPaa(pts, e));
    return rev ? ut.reverse() : ut;
  }

  const _nm = new WeakMap();
  function nodeMap(nett) {
    let m = _nm.get(nett.noder);
    if (!m) { m = Object.fromEntries(nett.noder.map(n => [n.id, n])); _nm.set(nett.noder, m); }
    return m;
  }

  // ---------- modell ----------

  // Bygger en beregningsmodell fra nett.json. Kall på nytt etter redigering.
  function lagModell(nett) {
    _nm.delete(nett.noder);
    const noder = nodeMap(nett);
    // Meter fra pikselkoordinater: via georef (affin) hvis den finnes, ellers fast skala
    const g = nett.meta && nett.meta.georef && nett.meta.georef.A;
    const skala = (nett.meta && nett.meta.skala_m_per_px) || 0.41;
    const tilMeter = g ? (p) => [p[0] * g[0][0] + p[1] * g[1][0] + g[2][0], p[0] * g[0][1] + p[1] * g[1][1] + g[2][1]] : (p) => [p[0] * skala, p[1] * skala];
    const kanter = {};
    for (const k of nett.kanter) {
      const pts = polylinje(nett, k);
      const L = lengde(pts), Lm = lengde(pts.map(tilMeter));
      // L: piksler (tegning), Lm: meter (beregning), f: meter per piksel langs denne veien
      kanter[k.id] = { ...k, pts, L, Lm, f: L ? Lm / L : skala, kjorbar: k.type !== "gangvei" };
    }
    // Ruter starter og slutter i meta.start (rundkjøringen). Uten den: hvor som helst på hovedåren.
    const start = nett.meta && nett.meta.start;
    const hub = new Set(start && noder[start] ? [start] : []);
    if (!hub.size) for (const k of Object.values(kanter)) if (k.type === "hovedaare") { hub.add(k.fra); hub.add(k.til); }

    const kjorbare = Object.values(kanter).filter(k => k.kjorbar);
    const hus = nett.hus.map(h => {
      let k = h.kant && kanter[h.kant] && kanter[h.kant].kjorbar ? kanter[h.kant] : null;
      let pr = k ? projiser(k.pts, [h.x, h.y]) : null;
      if (!k) for (const kk of kjorbare) {
        const p = projiser(kk.pts, [h.x, h.y]);
        if (!pr || p.dist < pr.dist) { pr = p; k = kk; }
      }
      return { ...h, kant: k.id, d: pr.d, px: pr.x, py: pr.y };
    });
    const kandidater = Object.values(kanter).filter(k => k.kjorbar && k.type !== "hovedaare" && k.kan_enveis && !k.folger).map(k => k.id);
    return { nett, noder, kanter, hus, hub, kandidater, snuStraff: (nett.meta && nett.meta.snu_straff_m) ?? 50,
      indreFaktor: (nett.meta && nett.meta.indre_faktor) ?? 1 };
  }

  function retningFor(modell, retning, kid) {
    const k = modell.kanter[kid];
    if (!k.kjorbar) return "stengt";
    if (k.type === "hovedaare") return "toveis";
    // Vei som følger en annen (f.eks. w1 følger f1): samme kjøreretning gjennom felles kryss
    if (k.folger && modell.kanter[k.folger]) {
      const a = modell.kanter[k.folger], r = retningFor(modell, retning, a.id);
      const sammeVei = a.til === k.fra || a.fra === k.til;
      return sammeVei || r === "toveis" || r === "stengt" ? r : r === "fram" ? "bak" : "fram";
    }
    return (retning && retning[kid]) || "toveis";
  }

  // Hvor tungt en meter på denne veien teller i rutevalget. Indre veier teller indreFaktor ganger mer
  // enn hovedåren, og ekstra der sikten er dårlig, så bilene holder seg på ytre vei når de kan.
  function kostFaktor(modell, k, indreFaktor) {
    if (k.type === "hovedaare") return 1;
    return (indreFaktor ?? modell.indreFaktor) * (k.darlig_sikt ? 1.5 : 1);
  }

  // Buer: { fra, til, kant, framover, L: meter, C: kostnad }
  function buer(modell, retning, indreFaktor) {
    const ut = [];
    for (const k of Object.values(modell.kanter)) {
      const r = retningFor(modell, retning, k.id);
      const C = k.Lm * kostFaktor(modell, k, indreFaktor);
      if (r === "toveis" || r === "fram") ut.push({ fra: k.fra, til: k.til, kant: k.id, framover: true, L: k.Lm, C });
      if (r === "toveis" || r === "bak") ut.push({ fra: k.til, til: k.fra, kant: k.id, framover: false, L: k.Lm, C });
    }
    return ut;
  }

  // Kan man snu her uten å rygge? Rundkjøringer, P-plasser og noder merket snuplass.
  function kanSnu(modell, id) {
    const n = modell.noder[id];
    return n.type === "rundkjoring" || n.type === "parkering" || !!n.snuplass;
  }

  // Dijkstra over buer (tilstand = hvilken bue man nettopp har kjørt), så vi vet kjøreretningen
  // og kan straffe snuing. Grafen er liten (~60 buer), så en enkel lineær kø holder.
  function dijkstraBuer(n, start, kanter, kost) {
    const dist = new Array(n).fill(Infinity), via = new Array(n).fill(-1), ferdig = new Array(n).fill(false);
    for (const [i, c] of start) if (c < dist[i]) dist[i] = c;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!ferdig[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) break;
      ferdig[u] = true;
      for (const v of kanter(u)) {
        const c = dist[u] + kost(u, v);
        if (c < dist[v]) { dist[v] = c; via[v] = u; }
      }
    }
    return { dist, via };
  }

  // Beregner ruter for alle hus i et scenario. Hver tur går fra start (rundkjøringen) til huset
  // og tilbake. Rutene velges etter kostnad (meter vektet med kostFaktor, pluss snuStraff for hver
  // snuing). Rapporterte inn/ut er ekte meter; del-strekninger (d0/d1) er i piksler for tegning.
  function beregn(modell, retning, snuStraffM, indreFaktor) {
    const S = snuStraffM ?? modell.snuStraff;
    const bs = buer(modell, retning, indreFaktor);
    bs.forEach((b, i) => (b.i = i));
    const utFra = {}, innTil = {};
    for (const b of bs) { (utFra[b.fra] = utFra[b.fra] || []).push(b); (innTil[b.til] = innTil[b.til] || []).push(b); }
    const erSnu = (a, b) => a.kant === b.kant && a.framover !== b.framover;
    const straff = (a, b) => (erSnu(a, b) && !kanSnu(modell, a.til) ? S : 0);
    const hub = modell.hub;

    // fram[i]: kostnad fra start til og med bue i. bak[i]: kostnad etter bue i og hjem til start.
    const fram = dijkstraBuer(bs.length, bs.filter(b => hub.has(b.fra)).map(b => [b.i, b.C]),
      u => (utFra[bs[u].til] || []).map(b => b.i), (u, v) => straff(bs[u], bs[v]) + bs[v].C);
    const bak = dijkstraBuer(bs.length, bs.filter(b => hub.has(b.til)).map(b => [b.i, 0]),
      u => (innTil[bs[u].fra] || []).map(b => b.i), (u, v) => straff(bs[v], bs[u]) + bs[u].C);

    // Kostnad for å stå klar ved starten av bue b (før den kjøres), og hvilken bue man kom fra
    function klarFor(b) {
      if (hub.has(b.fra)) return { c: 0, fra: -1 };
      let best = { c: Infinity, fra: -1 };
      for (const a of innTil[b.fra] || []) {
        const c = fram.dist[a.i] + straff(a, b);
        if (c < best.c) best = { c, fra: a.i };
      }
      return best;
    }
    // Sti fra start til og med bue i (liste av buer), og til hjem etter bue i
    const stiInn = (i) => { const s = []; while (i >= 0) { s.unshift(bs[i]); i = fram.via[i]; } return s; };
    const stiHjem = (i) => { const s = []; i = bak.via[i]; while (i >= 0) { s.push(bs[i]); i = bak.via[i]; } return s; };
    const snuinger = (buer, steder) => {
      for (let j = 1; j < buer.length; j++) if (erSnu(buer[j - 1], buer[j]) && !kanSnu(modell, buer[j].fra)) steder.push(buer[j].fra);
    };

    return modell.hus.map(h => {
      const k = modell.kanter[h.kant];
      const kf = kostFaktor(modell, k, indreFaktor);
      const d = h.d * k.f * kf, L = k.Lm * kf; // kostnad langs husets vei
      const fw = bs.find(b => b.kant === k.id && b.framover), bw = bs.find(b => b.kant === k.id && !b.framover);
      // ankomst: kjører mot til (fw) eller mot fra (bw)
      const ank = [], avg = [];
      if (fw) { const k0 = klarFor(fw); ank.push({ dir: fw, c: k0.c + d, fra: k0.fra, del: [0, h.d] }); avg.push({ dir: fw, c: (L - d) + bak.dist[fw.i], del: [h.d, k.L] }); }
      if (bw) { const k0 = klarFor(bw); ank.push({ dir: bw, c: k0.c + (L - d), fra: k0.fra, del: [k.L, h.d] }); avg.push({ dir: bw, c: d + bak.dist[bw.i], del: [h.d, 0] }); }
      let best = null;
      for (const a of ank) for (const u of avg) {
        const snuHer = a.dir !== u.dir;
        const c = a.c + u.c + (snuHer ? S : 0);
        if (isFinite(c) && (!best || c < best.c)) best = { a, u, c, snuHer };
      }
      if (!best) return { nr: h.nr, gyldig: false, inn: Infinity, ut: Infinity, snu: 0, snuSteder: [], innSti: [], utSti: [] };

      const innBuer = best.a.fra >= 0 ? stiInn(best.a.fra) : [];
      const hjemBuer = stiHjem(best.u.dir.i);
      const steder = [];
      snuinger([...innBuer, best.a.dir], steder);
      const snuHus = best.snuHer;
      snuinger([best.u.dir, ...hjemBuer], steder);
      const len = (buer) => buer.reduce((s, b) => s + b.L, 0);
      return {
        nr: h.nr, gyldig: true,
        inn: len(innBuer) + Math.abs(best.a.del[1] - best.a.del[0]) * k.f,
        ut: Math.abs(best.u.del[1] - best.u.del[0]) * k.f + len(hjemBuer),
        snu: steder.length + (snuHus ? 1 : 0),
        snuSteder: [...steder.map(id => [modell.noder[id].x, modell.noder[id].y]), ...(snuHus ? [[h.px, h.py]] : [])],
        innSti: [...innBuer.map(b => seg(modell, b)), { kant: k.id, d0: best.a.del[0], d1: best.a.del[1] }],
        utSti: [{ kant: k.id, d0: best.u.del[0], d1: best.u.del[1] }, ...hjemBuer.map(b => seg(modell, b))],
      };
    });
  }

  function seg(modell, b) { const L = modell.kanter[b.kant].L; return b.framover ? { kant: b.kant, d0: 0, d1: L } : { kant: b.kant, d0: L, d1: 0 }; }

  // ---------- nøkkeltall ----------

  function nokkeltall(modell, retning, basis) {
    basis = basis || beregn(modell, {});
    const res = beregn(modell, retning);
    const s = 1; // resultatene er allerede i meter
    const last = {}; // kant -> { fram, bak }
    let ugyldige = 0, sumOmvei = 0, maksOmvei = 0, lengre = 0, bratt = 0, stigning = 0, snu = 0, turerMedSnu = 0, indreMeter = 0, siktMeter = 0;
    res.forEach((r, i) => {
      if (!r.gyldig) { ugyldige++; return; }
      const om = (r.inn + r.ut - basis[i].inn - basis[i].ut) * s;
      sumOmvei += om; if (om > maksOmvei) maksOmvei = om; if (om > 1) lengre++;
      snu += r.snu; if (r.snu) turerMedSnu++;
      for (const sg of [...r.innSti, ...r.utSti]) {
        if (sg.d0 === sg.d1) continue;
        const k = modell.kanter[sg.kant];
        const l = last[sg.kant] = last[sg.kant] || { fram: 0, bak: 0 };
        const framover = sg.d1 > sg.d0;
        l[framover ? "fram" : "bak"]++;
        if (k.type !== "hovedaare") {
          const meter = Math.abs(sg.d1 - sg.d0) * k.f;
          indreMeter += meter;
          if (k.darlig_sikt) siktMeter += meter;
        }
        const dh = (modell.noder[k.til].hoyde - modell.noder[k.fra].hoyde) * (framover ? 1 : -1) * Math.abs(sg.d1 - sg.d0) / (k.L || 1);
        if (dh > 0) { stigning += dh; if (k.bratt) bratt++; }
      }
    });
    // Møtekonflikter: biler i begge retninger på samme kant, vektet etter bredde og sikt
    let konflikt = 0;
    for (const [kid, l] of Object.entries(last)) {
      const k = modell.kanter[kid];
      const v = (k.bredde === "bred" ? 0.3 : 1) * (k.darlig_sikt ? 1.5 : 1);
      konflikt += Math.min(l.fram, l.bak) * v;
    }
    const gyldige = res.length - ugyldige;
    return {
      res, last, ugyldige, lengre,
      endringer: Object.keys(retning || {}).filter(k => retningFor(modell, retning, k) !== "toveis").length,
      snittOmvei: gyldige ? sumOmvei / gyldige : 0,
      maksOmvei, konflikt, bratt, stigning, snu, turerMedSnu,
      // trygghet: meter kjørt på indre veier per hus (inn + ut)
      indreSnitt: gyldige ? indreMeter / gyldige : 0,
      siktSnitt: gyldige ? siktMeter / gyldige : 0,
      snittTur: gyldige ? res.reduce((a, r) => a + (r.gyldig ? r.inn + r.ut : 0), 0) * s / gyldige : 0,
    };
  }

  function poeng(nt, vekt) {
    if (nt.ugyldige) return Infinity;
    return (vekt.indre ?? 0) * nt.indreSnitt / 10 + vekt.omvei * nt.snittOmvei / 10 + vekt.konflikt * nt.konflikt / 10 + vekt.bakke * nt.bratt / 10 + (vekt.snu ?? 1) * nt.snu / 10
      + 0.05 * nt.endringer; // litt straff per endring, så enkle løsninger vinner ved likt resultat
  }

  // ---------- retningsmønster ----------

  // Gjør indre veier enveis i én hovedretning på kartet ("hoyre" = venstre→høyre, "venstre" = motsatt)
  // der det går. Veier som går mest loddrett, og veiene i `stengt`, får ikke retning. Deretter
  // gjøres veier toveis igjen én og én (den som redder flest hus først) til alle hus kommer inn og ut.
  function retningsmonster(modell, { mot = "hoyre", stengt = [], snuStraffM, indreFaktor } = {}) {
    const retning = {};
    for (const id of stengt) retning[id] = "stengt";
    for (const id of modell.kandidater) {
      if (retning[id]) continue;
      const k = modell.kanter[id], a = modell.noder[k.fra], b = modell.noder[k.til];
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) < 0.5 * Math.abs(dy)) continue; // mest loddrett: la være toveis
      retning[id] = (dx > 0) === (mot === "hoyre") ? "fram" : "bak";
    }
    const ugyldige = (r) => beregn(modell, r, snuStraffM, indreFaktor).filter(x => !x.gyldig).length;
    let n = ugyldige(retning);
    const tilbake = [];
    while (n > 0) {
      let best = null;
      for (const id of Object.keys(retning)) {
        if (retning[id] === "stengt") continue;
        const r2 = { ...retning }; delete r2[id];
        const n2 = ugyldige(r2);
        if (!best || n2 < best.n) best = { id, n: n2 };
      }
      if (!best || best.n >= n) break; // kan ikke reddes ved å åpne én vei til
      delete retning[best.id]; tilbake.push(best.id); n = best.n;
    }
    return { retning, toveisIgjen: tilbake, ugyldige: n };
  }

  // ---------- optimering ----------

  // Prøver retninger på kandidatkantene. Full gjennomgang hvis det er få nok kombinasjoner,
  // ellers lokalt søk med tilfeldige omstarter. Returnerer de beste unike løsningene.
  function optimer(modell, { kandidater, vekt, tillatStengt = false, antall = 10, maksKombinasjoner = 60000, omstarter = 40 }) {
    const valg = tillatStengt ? RETNINGER : RETNINGER.slice(0, 3);
    const basis = beregn(modell, {});
    const sett = new Map();
    const vurder = (retning) => {
      const nokkel = kandidater.map(k => retning[k] || "toveis").join(",");
      if (sett.has(nokkel)) return sett.get(nokkel).poeng;
      const nt = nokkeltall(modell, retning, basis);
      const p = poeng(nt, vekt);
      sett.set(nokkel, { retning: { ...retning }, poeng: p, nt });
      return p;
    };
    const total = Math.pow(valg.length, kandidater.length);
    if (total <= maksKombinasjoner) {
      const idx = kandidater.map(() => 0);
      for (let n = 0; n < total; n++) {
        const r = {};
        kandidater.forEach((k, i) => { if (idx[i]) r[k] = valg[idx[i]]; });
        vurder(r);
        for (let i = 0; i < idx.length; i++) { if (++idx[i] < valg.length) break; idx[i] = 0; }
      }
    } else {
      for (let o = 0; o < omstarter; o++) {
        let r = {};
        if (o) kandidater.forEach(k => { const v = valg[Math.floor(Math.random() * valg.length)]; if (v !== "toveis") r[k] = v; });
        let p = vurder(r), bedre = true;
        while (bedre) {
          bedre = false;
          for (const k of kandidater) for (const v of valg) {
            const r2 = { ...r }; if (v === "toveis") delete r2[k]; else r2[k] = v;
            const p2 = vurder(r2);
            if (p2 < p) { r = r2; p = p2; bedre = true; }
          }
        }
      }
    }
    const liste = [...sett.values()].filter(x => isFinite(x.poeng)).sort((a, b) => a.poeng - b.poeng);
    // Fjern varianter som bare snur veier uten trafikk (samme tall som en enklere løsning)
    const sett2 = new Set(), beste = [];
    for (const x of liste) {
      const n = x.nt, sig = [n.snittOmvei, n.konflikt, n.bratt, n.maksOmvei].map(v => v.toFixed(3)).join("|");
      if (sett2.has(sig)) continue;
      sett2.add(sig); beste.push(x);
      if (beste.length >= antall) break;
    }
    return { testet: sett.size, total, beste };
  }

  const Graf = { RETNINGER, lagModell, beregn, nokkeltall, poeng, optimer, retningsmonster, retningFor, delLinje, punktPaa, lengde, projiser };
  if (typeof module !== "undefined" && module.exports) module.exports = Graf; else root.Graf = Graf;
})(this);
