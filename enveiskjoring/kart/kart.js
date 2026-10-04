// Tegning og interaksjon for kartsiden. Logikken ligger i graf.js.
(async function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const sti = (pts) => "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L");
  const m = (px) => Math.round(px);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const [nett, scenarier] = await Promise.all([
    fetch("nett.json").then((r) => r.json()),
    fetch("scenarier.json").then((r) => r.json()),
  ]);
  const VIEWBOX = "0 92 1256 515";

  const tilstand = {
    scenarier: [...scenarier, { id: "eget", navn: "Eget scenario", beskrivelse: "Klikk på en vei i kartet for å bytte retning: toveis → fram → bak → stengt.", retning: {} }],
    aktiv: "eget",
    visning: "ruter",
    hus: null,
    rediger: false,
    sammenlign: new Set(["toveis", scenarier[1] && scenarier[1].id].filter(Boolean)),
    kant: null, node: null, kobleHus: false,
    kandidater: null,
    optNr: 0,
  };

  // ---------- lagring i nettleseren ----------
  // Egne scenarier og «Eget scenario» lagres i localStorage. Det kan være utilgjengelig (privat
  // vindu o.l.), så alt er pakket i try/catch og siden virker uten.
  const LAGER = "kart-scenarier", EGET = "kart-eget";
  const les = (n, std) => { try { const v = localStorage.getItem(n); return v ? JSON.parse(v) : std; } catch (e) { return std; } };
  const skriv = (n, v) => { try { localStorage.setItem(n, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const lokale = () => tilstand.scenarier.filter((s) => s.lokal);
  const lagreLokale = () => skriv(LAGER, lokale().map(({ id, navn, beskrivelse, retning }) => ({ id, navn, beskrivelse, retning })));
  for (const s of les(LAGER, [])) if (s && s.id && s.retning) tilstand.scenarier.push({ ...s, lokal: true });
  const lagretEget = les(EGET, null);
  if (lagretEget && typeof lagretEget === "object") scenario0("eget").retning = lagretEget;
  function scenario0(id) { return tilstand.scenarier.find((s) => s.id === id); }

  let modell, basis, cache;
  function bygg() {
    modell = Graf.lagModell(nett);
    basis = Graf.beregn(modell, {});
    cache = new Map();
    if (!tilstand.kandidater) tilstand.kandidater = new Set(modell.kandidater);
  }
  bygg();
  // lagrede scenarier kan peke på veier som ikke finnes lenger
  for (const sc of tilstand.scenarier) for (const k of Object.keys(sc.retning)) if (!modell.kanter[k] || !Graf.RETNINGER.includes(sc.retning[k])) delete sc.retning[k];

  const stigning = (k) => (modell.noder[k.til].hoyde - modell.noder[k.fra].hoyde) / (k.Lm || 1) * 100;
  const scenario = (id) => tilstand.scenarier.find((s) => s.id === id);
  function nt(sc) {
    const nokkel = JSON.stringify(sc.retning);
    if (!cache.has(nokkel)) cache.set(nokkel, Graf.nokkeltall(modell, sc.retning, basis));
    return cache.get(nokkel);
  }

  // ---------- tegning ----------

  function forskyv(pts, o) {
    // Parallellforskyver mot høyre i kjøreretningen, så inn- og ut-rute på samme vei havner på hver sin side
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [p[0] - (dy / l) * o, p[1] + (dx / l) * o];
    });
  }

  function rutePts(segmenter) {
    const ut = [];
    for (const s of segmenter) {
      if (s.d0 === s.d1) continue;
      const pts = Graf.delLinje(modell.kanter[s.kant].pts, s.d0, s.d1);
      ut.push(...(ut.length ? pts.slice(1) : pts));
    }
    return ut;
  }

  function pil(g, pts, d, cls = "pil", st = 7) {
    const p = Graf.punktPaa(pts, d), q = Graf.punktPaa(pts, Math.min(d + 2, Graf.lengde(pts)));
    const v = Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI;
    el("path", { d: `M${st} 0 L${-st} ${-st * 0.75} L${-st * 0.4} 0 L${-st} ${st * 0.75} Z`, class: cls, transform: `translate(${p[0]} ${p[1]}) rotate(${v})` }, g);
  }

  function tegn(svg, sc, { liten = false } = {}) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", VIEWBOX);
    const n = nt(sc);
    const valgtRes = tilstand.hus != null ? n.res.find((r) => r.nr === tilstand.hus) : null;

    const lag = (navn) => el("g", { "data-lag": navn }, svg);
    const gOmr = lag("omrader"), gVei = lag("veier"), gLast = lag("last"), gPil = lag("piler"),
      gRute = lag("ruter"), gHus = lag("hus"), gRed = lag("rediger");

    nett.omrader.forEach((o, i) => {
      el("polygon", { points: o.polygon.join(" "), class: `omr omr-${i + 1}` }, gOmr);
      if (o.etikett && !liten) el("text", { x: o.etikett[0], y: o.etikett[1], class: "omr-navn" }, gOmr).textContent = o.navn;
    });
    for (const p of nett.p) {
      el("polygon", { points: p.polygon.join(" "), class: "p-flate" }, gOmr);
      const cx = p.polygon.reduce((a, q) => a + q[0], 0) / p.polygon.length, cy = p.polygon.reduce((a, q) => a + q[1], 0) / p.polygon.length;
      el("text", { x: cx - 6, y: cy + 6, class: "p-tekst" }, gOmr).textContent = "P";
    }
    for (const b of nett.bygg) el("polyline", { points: b.linje.join(" "), class: "bygg" }, gOmr);

    const maksLast = Math.max(1, ...Object.values(n.last).map((l) => l.fram + l.bak));
    for (const k of Object.values(modell.kanter)) {
      const r = Graf.retningFor(modell, sc.retning, k.id);
      const d = sti(k.pts);
      if ((r === "fram" || r === "bak") && k.kjorbar) el("path", { d, class: "vei-endret" }, gVei);
      el("path", { d, class: `vei vei-${k.type}` + (r === "stengt" && k.kjorbar ? " vei-stengt" : "") }, gVei);
      if (/usikker/.test(k.merknad || "")) el("path", { d, class: "usikker" }, gVei);
      if (tilstand.kant === k.id && !liten) el("path", { d, class: "kant-valgt" }, gVei);
      if (!liten && (k.kjorbar || tilstand.rediger)) {
        const t = el("path", { d, class: "treff", "data-kant": k.id }, gVei);
        el("title", {}, t).textContent = `${k.id}${k.merknad ? ": " + k.merknad : ""} (${r}, ${Math.round(k.Lm)} m, ${stigning(k).toFixed(1)} % fra ${k.fra} mot ${k.til})`;
        el("path", { d, class: "hover" }, gVei);
      }
      // belastning
      const l = n.last[k.id];
      if (tilstand.visning === "belastning" && l) {
        const tot = l.fram + l.bak;
        const w = 3 + 14 * tot / maksLast;
        if (k.darlig_sikt && k.type !== "hovedaare") el("path", { d, class: "last-sikt", "stroke-width": w + 6 }, gLast);
        el("path", { d, class: "last " + (l.fram && l.bak ? "last-to" : "last-en"), "stroke-width": w }, gLast);
      }
      // retningspiler og stengt-markering
      if (r === "fram" || r === "bak") {
        const pts = r === "fram" ? k.pts : [...k.pts].reverse();
        const ant = Math.max(1, Math.round(k.L / 90));
        for (let i = 0; i < ant; i++) pil(gPil, pts, k.L * (i + 0.5) / ant);
      } else if (r === "stengt" && k.kjorbar) {
        const [x, y] = Graf.punktPaa(k.pts, k.L / 2);
        el("path", { d: `M${x - 6} ${y - 6} L${x + 6} ${y + 6} M${x + 6} ${y - 6} L${x - 6} ${y + 6}`, class: "stengt-x" }, gPil);
      }
    }
    for (const nd of Object.values(modell.noder))
      if (nd.type === "rundkjoring") el("circle", { cx: nd.x, cy: nd.y, r: nd.radius || (nd.id === "rk" ? 24 : 10), class: "rk" }, gVei);

    // valgt hus: inn- og ut-rute
    if (valgtRes && valgtRes.gyldig) {
      const inn = forskyv(rutePts(valgtRes.innSti), 3), ut = forskyv(rutePts(valgtRes.utSti), 3);
      for (const [pts, kl] of [[inn, "inn"], [ut, "ut"]]) if (pts.length > 1) el("path", { d: sti(pts), class: "rute-kontur" }, gRute);
      for (const [pts, kl] of [[inn, "inn"], [ut, "ut"]]) if (pts.length > 1) { el("path", { d: sti(pts), class: `rute rute-${kl}` }, gRute); pilerLangs(gRute, pts, `rute-pil-${kl}`); }
      for (const [x, y] of valgtRes.snuSteder) {
        el("circle", { cx: x, cy: y, r: liten ? 6 : 9, class: "snu-merke" }, gRute);
        if (!liten) el("text", { x, y: y + 4, class: "snu-tekst" }, gRute).textContent = "↺";
      }
    }

    // hus
    n.res.forEach((r, i) => {
      const h = modell.hus[i];
      const omvei = r.gyldig && (r.inn + r.ut - basis[i].inn - basis[i].ut) > 1;
      const c = el("circle", {
        cx: h.x, cy: h.y, r: liten ? 4 : 5.5, "data-hus": h.nr,
        class: "hus" + (r.gyldig ? "" : " ugyldig") + (omvei ? " omvei" : "") + (tilstand.hus === h.nr ? " valgt" : tilstand.hus != null && !liten ? " dempet" : ""),
      }, gHus);
      el("title", {}, c).textContent = `Hus ${h.nr}`;
      if (!liten) el("text", { x: h.x, y: h.y - 7, class: "hus-nr" }, gHus).textContent = h.nr;
      if (tilstand.rediger && !liten && tilstand.hus === h.nr) el("line", { x1: h.x, y1: h.y, x2: h.px, y2: h.py, stroke: "currentColor", "stroke-dasharray": "2 2", class: "pil" }, gHus);
    });

    const hv = tilstand.hus != null && modell.hus.find((h) => h.nr === tilstand.hus);
    if (hv) {
      el("circle", { cx: hv.x, cy: hv.y, r: liten ? 9 : 13, class: "hus-ring" }, gHus);
      if (!liten) {
        const venstre = hv.x > 1150;
        const t = el("text", { x: hv.x + (venstre ? -16 : 16), y: hv.y + 5, class: "hus-etikett", "text-anchor": venstre ? "end" : "start" }, gHus);
        t.textContent = `Hus ${hv.nr}`;
      }
    }

    // redigeringshåndtak
    if (tilstand.rediger && !liten) {
      for (const k of nett.kanter) k.punkter.forEach((p, i) =>
        el("circle", { cx: p[0], cy: p[1], r: 4, class: "hndl knekk", "data-knekk": `${k.id}:${i}` }, gRed));
      for (const nd of nett.noder)
        el("circle", { cx: nd.x, cy: nd.y, r: 6, class: "hndl" + (tilstand.node === nd.id ? " valgt" : ""), "data-node": nd.id }, gRed);
    }
  }

  function pilerLangs(g, pts, cls) {
    const L = Graf.lengde(pts);
    const ant = Math.max(1, Math.round(L / 120));
    for (let i = 0; i < ant; i++) pil(g, pts, L * (i + 0.5) / ant, "pil " + cls, 6);
  }

  // ---------- paneler ----------

  const RADER = [
    ["Kjøring på indre veier (m per hus)", (n) => n.indreSnitt, 0, -1],
    ["… av det på veier med dårlig sikt (m per hus)", (n) => n.siktSnitt, 0, -1],
    ["Hus uten vei inn eller ut", (n) => n.ugyldige, 0, -1],
    ["Hus med lengre vei", (n) => n.lengre, 0, -1],
    ["Snitt omvei per hus (m)", (n) => n.snittOmvei, 0, -1],
    ["Største omvei (m)", (n) => n.maksOmvei, 0, -1],
    ["Snitt tur inn + ut (m)", (n) => n.snittTur, 0, -1],
    ["Møtekonflikter (indeks)", (n) => n.konflikt, 0, -1],
    ["Turer opp bratt bakke", (n) => n.bratt, 0, -1],
    ["Turer der bilen må snu", (n) => n.turerMedSnu, 0, -1],
  ];
  const fmt = (v) => (Math.abs(v) >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1));

  function tabell(scs) {
    const ref = nt(scenario("toveis"));
    let h = `<thead><tr><th></th>${scs.map((s) => `<th class="tall">${esc(s.navn)}</th>`).join("")}</tr></thead><tbody>`;
    for (const [navn, f] of RADER) {
      h += `<tr><td>${navn}</td>` + scs.map((s) => {
        const v = f(nt(s)), r = f(ref);
        const kl = v < r - 0.05 ? "bedre" : v > r + 0.05 ? "verre" : "";
        return `<td class="tall ${kl}">${fmt(v)}</td>`;
      }).join("") + "</tr>";
    }
    return h + "</tbody>";
  }

  function retningsliste(sc) {
    const e = Object.values(modell.kanter).filter((k) => k.kjorbar).map((k) => [k.id, Graf.retningFor(modell, sc.retning, k.id)]).filter(([, r]) => r !== "toveis");
    if (!e.length) return "<p class='status'>Alle veier toveis.</p>";
    return "<p>" + e.map(([k, r]) => `<span class="chip">${esc(k)}: ${r}</span>`).join("") + "</p>";
  }

  function panelScenario() {
    const sc = scenario(tilstand.aktiv);
    $("#panel-scenario").innerHTML = `
      <h3>${esc(sc.navn)}</h3>
      <p class="status">${sc.lokal ? "Lagret i denne nettleseren. Klikk i kartet endrer dette scenariet, og alt lagres automatisk."
        : sc.id === "eget" ? "Eget scenario: klikk i kartet endrer det, og det huskes automatisk."
        : "Fast scenario som ikke kan endres. Klikker du i kartet, havner endringen i «Eget scenario»."}</p>
      ${sc.lokal ? `<label class="beskrivelse">Beskrivelse<textarea id="sc-beskrivelse" rows="2">${esc(sc.beskrivelse || "")}</textarea></label>` : `<p>${esc(sc.beskrivelse || "")}</p>`}
      ${retningsliste(sc)}
      <div class="table-scroll"><table>${tabell(sc.id === "toveis" ? [sc] : [scenario("toveis"), sc])}</table></div>
      <p><button id="kopier-sc">Kopier JSON til utklippstavla</button></p>`;
    $("#kopier-sc").onclick = () => kopier(scenarioJson(sc), "#kopier-sc");
    const bf = $("#sc-beskrivelse");
    if (bf) bf.onchange = () => { sc.beskrivelse = bf.value; lagreLokale(); melding("Beskrivelsen er lagret."); };
  }

  const scenarioJson = (sc) => JSON.stringify({ navn: sc.navn, beskrivelse: sc.beskrivelse || "", retning: sc.retning }, null, 1);

  // Knapperaden ved nedtrekkslista
  function nyttLokalt(navn, beskrivelse, retning) {
    const ny = { id: "lokal-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), navn, beskrivelse, retning: { ...retning }, lokal: true };
    tilstand.scenarier.push(ny);
    const ok = lagreLokale();
    velgScenario(ny.id); sammenlign();
    melding(ok ? `«${navn}» er lagret i denne nettleseren.` : "Kunne ikke lagre i nettleseren (privat vindu?). Last ned i stedet.");
    return ny;
  }
  $("#sc-ny").onclick = () => {
    const navn = prompt("Navn på det nye scenariet:");
    if (navn && navn.trim()) nyttLokalt(navn.trim(), "", {});
  };
  $("#sc-kopi").onclick = () => {
    const sc = scenario(tilstand.aktiv);
    const navn = prompt("Navn på kopien:", sc.id === "eget" ? "" : `${sc.navn} (kopi)`);
    if (navn && navn.trim()) nyttLokalt(navn.trim(), sc.id === "eget" ? "" : sc.beskrivelse || "", sc.retning);
  };
  $("#sc-navn").onclick = () => {
    const sc = scenario(tilstand.aktiv);
    if (!sc.lokal) return;
    const navn = prompt("Nytt navn:", sc.navn);
    if (!navn || !navn.trim()) return;
    sc.navn = navn.trim(); lagreLokale(); fyllScenarioer(); oppdater(); sammenlign();
    melding(`Navnet er endret til «${sc.navn}».`);
  };
  $("#sc-slett").onclick = () => {
    const sc = scenario(tilstand.aktiv);
    if (!sc.lokal || !confirm(`Slette «${sc.navn}» fra nettleseren? Last det ned først hvis du vil ta vare på det.`)) return;
    tilstand.scenarier = tilstand.scenarier.filter((x) => x !== sc);
    tilstand.sammenlign.delete(sc.id);
    lagreLokale(); velgScenario("eget"); sammenlign();
    melding(`«${sc.navn}» er slettet.`);
  };
  $("#sc-last-ned").onclick = () => { const sc = scenario(tilstand.aktiv); lastNed(scenarioJson(sc), filnavn(sc.navn) + ".json"); };
  $("#sc-last-opp").onclick = () => $("#fil-sc").click();

  function knappestatus() {
    const lokal = !!scenario(tilstand.aktiv).lokal;
    for (const id of ["#sc-navn", "#sc-slett"]) {
      $(id).disabled = !lokal;
      $(id).title = lokal ? "" : "Bare scenarier du har lagret selv kan få nytt navn eller slettes. Bruk Kopier først.";
    }
  }

  let meldingTid;
  const melding = (t) => { const m = $("#sc-melding"); m.textContent = t; clearTimeout(meldingTid); meldingTid = setTimeout(() => (m.textContent = ""), 6000); };
  const filnavn = (n) => (n || "scenario").toLowerCase().replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[å]/g, "a").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario";
  function lastNed(tekst, navn) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([tekst], { type: "application/json" })), download: navn });
    a.click(); URL.revokeObjectURL(a.href);
  }

  // Last opp: ett scenario ({navn, retning}) eller en liste av dem. Ukjente veier og retninger hoppes over.
  const filInn = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json", id: "fil-sc", hidden: true });
  document.body.appendChild(filInn);
  filInn.onchange = async () => {
    const f = filInn.files[0]; filInn.value = "";
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch (e) { melding("Filen er ikke gyldig JSON."); return; }
    const liste = Array.isArray(data) ? data : [data];
    let sist = null, hoppet = 0;
    for (const d of liste) {
      if (!d || typeof d.retning !== "object") { hoppet++; continue; }
      const retning = {};
      for (const [k, r] of Object.entries(d.retning)) {
        if (modell.kanter[k] && Graf.RETNINGER.includes(r)) { if (r !== "toveis") retning[k] = r; } else hoppet++;
      }
      sist = { id: "lokal-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), navn: String(d.navn || f.name.replace(/\.json$/i, "")), beskrivelse: String(d.beskrivelse || "Lastet opp fra fil."), retning, lokal: true };
      tilstand.scenarier.push(sist);
    }
    if (!sist) { melding("Fant ikke noe scenario i filen."); return; }
    const ok = lagreLokale();
    velgScenario(sist.id); sammenlign();
    melding(`Lastet opp «${sist.navn}»${liste.length > 1 ? ` og ${liste.length - 1} til` : ""}.` + (hoppet ? ` ${hoppet} ukjente veier eller verdier ble hoppet over.` : "") + (ok ? " Lagret i nettleseren." : ""));
  };

  // meter en tur (inn + ut) går på indre veier
  const indreM = (r) => [...r.innSti, ...r.utSti].reduce((a, sg) => {
    const k = modell.kanter[sg.kant];
    return a + (k.type === "hovedaare" ? 0 : Math.abs(sg.d1 - sg.d0) * k.f);
  }, 0);

  function panelHus() {
    const p = $("#panel-hus");
    if (tilstand.hus == null) { p.innerHTML = "<h3>Hus</h3><p class='status'>Klikk på et hus i kartet for å se ruten inn (blå) og ut (oransje).</p>"; return; }
    const i = modell.hus.findIndex((h) => h.nr === tilstand.hus);
    const h = modell.hus[i], r = nt(scenario(tilstand.aktiv)).res[i], b = basis[i], s = 1;
    let html = `<h3>Hus ${h.nr} <span class="status">· grend ${h.grend ?? "?"} · ved vei ${esc(h.kant)}${h.hoyde != null ? ` · ${h.hoyde} moh` : ""}</span></h3>`;
    if (!r.gyldig) html += "<p class='verre'><strong>Kommer ikke inn eller ut</strong> i dette scenariet.</p>";
    else {
      const om = (r.inn + r.ut - b.inn - b.ut) * s;
      html += `<table><tbody>
        <tr><td><span class="chip" style="background:var(--inn);color:#fff">Inn</span> fra rundkjøringen</td><td class="tall">${m(r.inn * s)} m</td><td class="tall status">toveis ${m(b.inn * s)} m</td></tr>
        <tr><td><span class="chip" style="background:var(--ut);color:#fff">Ut</span> til rundkjøringen</td><td class="tall">${m(r.ut * s)} m</td><td class="tall status">toveis ${m(b.ut * s)} m</td></tr>
        <tr><td>Omvei</td><td class="tall ${om > 1 ? "verre" : ""}">${m(om)} m</td><td></td></tr>
        <tr><td>På indre veier</td><td class="tall">${m(indreM(r))} m</td><td class="tall status">toveis ${m(indreM(b))} m</td></tr>
        <tr><td>Må snu</td><td class="tall ${r.snu > b.snu ? "verre" : r.snu < b.snu ? "bedre" : ""}">${r.snu ? r.snu + " gang" + (r.snu > 1 ? "er" : "") : "nei"}</td><td class="tall status">toveis ${b.snu || "nei"}</td></tr></tbody></table>`;
    }
    if (modell.indreFaktor !== 1) html += `<p class="status">Ruten er valgt slik at en meter på indre vei teller ${String(modell.indreFaktor).replace(".", ",")} ganger så mye som på ytre vei, og 1,5 ganger ekstra der sikten er dårlig.</p>`;
    if (tilstand.rediger) html += `<p><button id="koble">${tilstand.kobleHus ? "Klikk en vei i kartet …" : "Koble huset til en annen vei"}</button></p>`;
    p.innerHTML = html;
    const kb = $("#koble");
    if (kb) kb.onclick = () => { tilstand.kobleHus = !tilstand.kobleHus; panelHus(); };
  }

  function panelRediger() {
    const p = $("#panel-rediger");
    p.hidden = !tilstand.rediger;
    if (!tilstand.rediger) return;
    let html = `<h3>Rediger veinettet</h3>
      <p class="status">Dra kryss (fylte sirkler) og knekkpunkter (hule sirkler). Klikk en vei eller et kryss for å endre egenskaper. Endringer lagres ikke på siden. Last ned <code>nett.json</code> og legg den i repoet.</p>`;
    const k = tilstand.kant && nett.kanter.find((x) => x.id === tilstand.kant);
    if (k) {
      const sel = (navn, valg) => `<select data-felt="${navn}">${valg.map((v) => `<option ${k[navn] === v ? "selected" : ""}>${v}</option>`).join("")}</select>`;
      const cb = (navn) => `<input type="checkbox" data-felt="${navn}" ${k[navn] ? "checked" : ""}>`;
      html += `<h3>Vei ${esc(k.id)} <span class="status">(${esc(k.fra)} → ${esc(k.til)}, ${m(modell.kanter[k.id].Lm)} m, stigning ${stigning(modell.kanter[k.id]).toFixed(1)} %)</span></h3>
        <div class="skjema" data-kant="${esc(k.id)}">
          <span>Type</span>${sel("type", ["vei", "hovedaare", "gangvei"])}
          <span>Bredde</span>${sel("bredde", ["smal", "bred"])}
          <span>Parkering langs</span>${cb("parkering")}
          <span>Kan bli enveis</span>${cb("kan_enveis")}
          <span>Bratt</span>${cb("bratt")}
          <span>Dårlig sikt / hekker</span>${cb("darlig_sikt")}
          <span>Merknad</span><input type="text" data-felt="merknad" value="${esc(k.merknad || "")}">
        </div>
        <p><button id="snu">Bytt fra og til</button> <button id="knekk">Legg til knekkpunkt</button></p>`;
    }
    const nd = tilstand.node && nett.noder.find((x) => x.id === tilstand.node);
    if (nd) {
      html += `<h3>Kryss ${esc(nd.id)}</h3>
        <div class="skjema" data-node="${esc(nd.id)}">
          <span>Høyde (moh)</span><input type="number" step="0.1" data-felt="hoyde" value="${nd.hoyde}">
          <span>Kan snu her</span><input type="checkbox" data-felt="snuplass" ${nd.snuplass ? "checked" : ""}>
          <span>Posisjon</span><span>${m(nd.x)}, ${m(nd.y)}</span>
        </div>`;
    }
    html += `<p><button id="last-ned" class="hoved">Last ned nett.json</button></p>`;
    p.innerHTML = html;

    p.querySelectorAll("[data-felt]").forEach((inp) => {
      inp.onchange = () => {
        const mål = inp.closest("[data-kant]") ? nett.kanter.find((x) => x.id === tilstand.kant) : nett.noder.find((x) => x.id === tilstand.node);
        const f = inp.dataset.felt;
        mål[f] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? parseFloat(inp.value) : inp.value;
        endret();
      };
    });
    const snu = $("#snu");
    if (snu) snu.onclick = () => { [k.fra, k.til] = [k.til, k.fra]; k.punkter.reverse(); endret(); };
    const knekk = $("#knekk");
    if (knekk) knekk.onclick = () => { const mk = modell.kanter[k.id]; k.punkter.push(Graf.punktPaa(mk.pts, mk.L / 2).map(Math.round)); k.punkter.sort((a, b) => Graf.projiser(mk.pts, a).d - Graf.projiser(mk.pts, b).d); endret(); };
    $("#last-ned").onclick = () => {
      const blob = new Blob([JSON.stringify(nett, null, 1)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "nett.json" });
      a.click(); URL.revokeObjectURL(a.href);
    };
  }

  function forklaring() {
    const f = tilstand.visning === "ruter"
      ? [["var(--inn)", "Rute inn"], ["var(--ut)", "Rute ut"], ["var(--konflikt)", "↺ Må snu"], ["var(--ut)", "Hus med omvei (fylt)"], ["var(--ugyldig)", "Hus uten rute"], ["var(--gangvei)", "Gangvei"]]
      : [["var(--inn)", "Trafikk én vei"], ["var(--konflikt)", "Trafikk begge veier (møter)"], ["var(--text)", "Svart kant: dårlig sikt / hekker"], ["var(--gangvei)", "Gangvei"]];
    $("#forklaring").innerHTML = f.map(([c, t]) => `<span style="--c:${c}">${t}</span>`).join("") + "<span style='--c:transparent'>Strektykkelse = antall turer</span>".repeat(tilstand.visning === "belastning");
  }

  // ---------- sammenligning ----------

  function sammenlign() {
    $("#sammenlign-valg").innerHTML = tilstand.scenarier.map((s) =>
      `<label><input type="checkbox" value="${esc(s.id)}" ${tilstand.sammenlign.has(s.id) ? "checked" : ""}> ${esc(s.navn)}</label>`).join("");
    $("#sammenlign-valg").querySelectorAll("input").forEach((i) => i.onchange = () => {
      i.checked ? tilstand.sammenlign.add(i.value) : tilstand.sammenlign.delete(i.value); sammenlign();
    });
    const scs = tilstand.scenarier.filter((s) => tilstand.sammenlign.has(s.id));
    $("#sammenlign-tabell").innerHTML = scs.length ? tabell(scs) : "";
    const box = $("#sammenlign-kart");
    box.innerHTML = "";
    for (const s of scs) {
      const fig = document.createElement("figure");
      fig.innerHTML = `<figcaption>${esc(s.navn)}</figcaption>`;
      const svg = el("svg", { role: "img", "aria-label": s.navn });
      fig.appendChild(svg); box.appendChild(fig);
      tegn(svg, s, { liten: true });
      svg.style.cursor = "pointer";
      svg.onclick = () => { velgScenario(s.id); $("#kart").scrollIntoView({ behavior: "smooth", block: "center" }); };
    }
  }

  // ---------- optimering ----------

  function kandidatliste() {
    $("#ant-kand").textContent = `${tilstand.kandidater.size} av ${modell.kandidater.length}`;
    $("#kandidatliste").innerHTML = modell.kandidater.map((k) =>
      `<label title="${esc(modell.kanter[k].merknad || "")}"><input type="checkbox" value="${k}" ${tilstand.kandidater.has(k) ? "checked" : ""}> ${k}</label>`).join("");
    $("#kandidatliste").querySelectorAll("input").forEach((i) => i.onchange = () => {
      i.checked ? tilstand.kandidater.add(i.value) : tilstand.kandidater.delete(i.value); kandidatliste();
    });
  }

  document.querySelectorAll(".opt-vekter input[type=range]").forEach((r) => {
    const o = r.parentElement.querySelector("output");
    const vis = () => (o.textContent = (+r.value).toFixed(1));
    r.oninput = vis; vis();
  });

  $("#kjor-opt").onclick = () => {
    const status = $("#opt-status");
    status.textContent = "Regner …";
    setTimeout(() => {
      const t0 = performance.now();
      const kand = modell.kandidater.filter((k) => tilstand.kandidater.has(k));
      const res = Graf.optimer(modell, {
        kandidater: kand,
        vekt: { indre: +$("#v-indre").value, omvei: +$("#v-omvei").value, konflikt: +$("#v-konflikt").value, bakke: +$("#v-bakke").value, snu: +$("#v-snu").value },
        tillatStengt: $("#v-stengt").checked,
      });
      status.textContent = `Testet ${res.testet.toLocaleString("no")} løsninger${res.testet < res.total ? ` (lokalt søk, av ${res.total.toLocaleString("no")} mulige)` : ""} på ${Math.round(performance.now() - t0)} ms.`;
      visOpt(res.beste);
    }, 20);
  };

  for (const mot of ["hoyre", "venstre"]) $("#monster-" + mot).onclick = () => {
    const eget = scenario("eget");
    const stengt = Object.entries(eget.retning).filter(([, r]) => r === "stengt").map(([k]) => k);
    const r = Graf.retningsmonster(modell, { mot, stengt });
    eget.retning = r.retning;
    $("#monster-status").textContent = (r.ugyldige ? `${r.ugyldige} hus kommer ikke inn eller ut. ` : "") +
      (r.toveisIgjen.length ? `Toveis for at alle skal komme frem: ${r.toveisIgjen.join(", ")}.` : "");
    velgScenario("eget");
    $("#kart").scrollIntoView({ behavior: "smooth", block: "center" });
  };

  function visOpt(beste) {
    const ref = nt(scenario("toveis"));
    let h = `<div class="table-scroll"><table><thead><tr><th>#</th><th>Endringer</th><th class="tall">Poeng</th><th class="tall">Indre vei</th><th class="tall">Snitt omvei</th><th class="tall">Konflikter</th><th class="tall">Opp bratt</th><th class="tall">Må snu</th><th></th></tr></thead><tbody>`;
    beste.forEach((b, i) => {
      const e = Object.entries(b.retning).map(([k, r]) => `<span class="chip">${k}: ${r}</span>`).join("") || "<span class='status'>ingen</span>";
      h += `<tr><td>${i + 1}</td><td>${e}</td><td class="tall">${b.poeng.toFixed(1)}</td><td class="tall ${b.nt.indreSnitt < ref.indreSnitt ? "bedre" : "verre"}">${fmt(b.nt.indreSnitt)} m</td><td class="tall">${fmt(b.nt.snittOmvei)} m</td>
        <td class="tall ${b.nt.konflikt < ref.konflikt ? "bedre" : ""}">${fmt(b.nt.konflikt)}</td><td class="tall">${b.nt.bratt}</td><td class="tall ${b.nt.turerMedSnu < ref.turerMedSnu ? "bedre" : ""}">${b.nt.turerMedSnu}</td>
        <td><button data-vis="${i}">Vis</button> <button data-legg="${i}">+ Sammenlign</button></td></tr>`;
    });
    $("#opt-resultat").innerHTML = beste.length ? h + `</tbody></table></div><p class="status">Referanse toveis: indre vei ${fmt(ref.indreSnitt)} m per hus, konflikter ${fmt(ref.konflikt)}, opp bratt ${ref.bratt}, må snu ${ref.turerMedSnu}.</p>` : "<p>Ingen gyldige løsninger.</p>";
    $("#opt-resultat").querySelectorAll("[data-vis]").forEach((b) => b.onclick = () => {
      scenario("eget").retning = { ...beste[+b.dataset.vis].retning }; cache.clear(); velgScenario("eget");
      $("#kart").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("#opt-resultat").querySelectorAll("[data-legg]").forEach((b) => b.onclick = () => {
      const id = "forslag-" + ++tilstand.optNr;
      tilstand.scenarier.push({ id, navn: `Forslag ${tilstand.optNr}`, beskrivelse: "Fra optimeringen.", retning: { ...beste[+b.dataset.legg].retning } });
      tilstand.sammenlign.add(id); fyllScenarioer(); sammenlign();
      b.disabled = true; b.textContent = "Lagt til";
    });
  }

  // ---------- interaksjon ----------

  function fyllScenarioer() {
    const opt = (s) => `<option value="${esc(s.id)}" ${s.id === tilstand.aktiv ? "selected" : ""}>${esc(s.navn)}</option>`;
    const faste = tilstand.scenarier.filter((s) => !s.lokal), egne = lokale();
    $("#scenario").innerHTML = `<optgroup label="Scenarier">${faste.map(opt).join("")}</optgroup>` +
      (egne.length ? `<optgroup label="Lagret i nettleseren">${egne.map(opt).join("")}</optgroup>` : "");
  }
  function velgScenario(id) { tilstand.aktiv = id; fyllScenarioer(); oppdater(); }
  $("#scenario").onchange = (e) => velgScenario(e.target.value);

  document.querySelectorAll("[data-visning]").forEach((b) => b.onclick = () => {
    tilstand.visning = b.dataset.visning;
    document.querySelectorAll("[data-visning]").forEach((x) => x.classList.toggle("valgt", x === b));
    oppdater();
  });
  $("#snu-straff").value = modell.snuStraff;
  const indre = $("#indre-faktor"), indreUt = indre.parentElement.querySelector("output");
  indre.value = modell.indreFaktor;
  const visIndre = () => (indreUt.textContent = "×" + (+indre.value).toFixed(1).replace(".", ","));
  visIndre();
  indre.oninput = visIndre;
  indre.onchange = () => { nett.meta.indre_faktor = +indre.value; endret(); };
  $("#snu-straff").onchange = (e) => { nett.meta.snu_straff_m = Math.max(0, +e.target.value || 0); endret(); };
  $("#rediger").onchange = (e) => { tilstand.rediger = e.target.checked; tilstand.kobleHus = false; oppdater(); };

  function endret() { bygg(); oppdater(); sammenlign(); }

  function statuslinje() {
    const sc = scenario(tilstand.aktiv);
    const endr = Object.values(modell.kanter).filter((k) => k.kjorbar).map((k) => [k.id, Graf.retningFor(modell, sc.retning, k.id)]).filter(([, r]) => r !== "toveis");
    let h = `<span><b>Scenario:</b> ${esc(sc.navn)}</span>`;
    h += `<span><b>Endrede veier:</b> ${endr.length ? endr.map(([k, r]) => `<span class="chip">${esc(k)} ${r === "stengt" ? "stengt" : "enveis"}</span>`).join("") : "ingen"}</span>`;
    h += `<span><b>Hus:</b> ${tilstand.hus != null ? `${tilstand.hus} <button id="fjern-hus" aria-label="Fjern valgt hus">×</button>` : "<span class='status'>klikk et hus</span>"}</span>`;
    if (tilstand.rediger && (tilstand.kant || tilstand.node)) h += `<span><b>Redigerer:</b> ${tilstand.kant ? "vei " + esc(tilstand.kant) : "kryss " + esc(tilstand.node)}</span>`;
    $("#valgt").innerHTML = h;
    const f = $("#fjern-hus");
    if (f) f.onclick = () => { tilstand.hus = null; oppdater(); };
  }

  function oppdater() {
    skriv(EGET, scenario("eget").retning); // husk Eget scenario til neste gang
    tegn($("#kart"), scenario(tilstand.aktiv));
    statuslinje();
    knappestatus();
    panelScenario(); panelHus(); panelRediger(); forklaring();
    if (tilstand.aktiv === "eget") sammenlign();
  }

  const svg = $("#kart");
  function svgPunkt(ev) {
    const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.round(q.x), Math.round(q.y)];
  }

  let drag = null;
  svg.addEventListener("pointerdown", (ev) => {
    const t = ev.target;
    if (tilstand.rediger && (t.dataset.node || t.dataset.knekk || t.dataset.hus)) {
      drag = { t, flyttet: false };
      svg.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const [x, y] = svgPunkt(ev);
    const t = drag.t;
    drag.flyttet = true;
    if (t.dataset.node) Object.assign(nett.noder.find((n) => n.id === t.dataset.node), { x, y });
    else if (t.dataset.knekk) { const [kid, i] = t.dataset.knekk.split(":"); nett.kanter.find((k) => k.id === kid).punkter[+i] = [x, y]; }
    else if (t.dataset.hus) Object.assign(nett.hus.find((h) => h.nr === +t.dataset.hus), { x, y });
    bygg();
    tegn(svg, scenario(tilstand.aktiv));
    drag.t = svg.querySelector(t.dataset.node ? `[data-node="${t.dataset.node}"]` : t.dataset.knekk ? `[data-knekk="${t.dataset.knekk}"]` : `[data-hus="${t.dataset.hus}"]`) || t;
  });
  svg.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    const t = drag.t, flyttet = drag.flyttet;
    drag = null;
    if (flyttet) { endret(); return; }
    klikk(t);
  });
  svg.addEventListener("click", (ev) => { if (!tilstand.rediger || !(ev.target.dataset.node || ev.target.dataset.knekk || ev.target.dataset.hus)) klikk(ev.target); });

  function klikk(t) {
    if (t.dataset.hus) {
      const nr = +t.dataset.hus;
      tilstand.hus = tilstand.hus === nr && !tilstand.rediger ? null : nr;
      tilstand.kobleHus = false;
      oppdater();
    } else if (t.dataset.node) {
      tilstand.node = t.dataset.node; tilstand.kant = null; oppdater();
    } else if (t.dataset.kant) {
      let kid = t.dataset.kant;
      if (tilstand.rediger && tilstand.kobleHus && tilstand.hus != null) {
        nett.hus.find((h) => h.nr === tilstand.hus).kant = kid;
        tilstand.kobleHus = false; endret();
      } else if (tilstand.rediger) {
        tilstand.kant = kid; tilstand.node = null; oppdater();
      } else {
        let k = modell.kanter[kid];
        if (k.type === "hovedaare") return;
        if (k.folger) { kid = k.folger; k = modell.kanter[kid]; } // klikk på w1 endrer f1
        let sc = scenario(tilstand.aktiv);
        // Faste scenarier endres ikke: kopier til Eget først. Eget og lagrede endres direkte.
        if (sc.id !== "eget" && !sc.lokal) { scenario("eget").retning = { ...sc.retning }; sc = scenario("eget"); tilstand.aktiv = "eget"; fyllScenarioer(); melding("Fast scenario: endringen er lagt i «Eget scenario»."); }
        const valg = Graf.RETNINGER;
        const neste = valg[(valg.indexOf(Graf.retningFor(modell, sc.retning, kid)) + 1) % valg.length];
        if (neste === "toveis") delete sc.retning[kid]; else sc.retning[kid] = neste;
        sc.retning = { ...sc.retning };
        if (sc.lokal) lagreLokale();
        oppdater();
      }
    }
  }

  function kopier(tekst, knapp) {
    const b = $(knapp), før = b.textContent;
    const ferdig = (ok) => { b.textContent = ok ? "Kopiert" : "Kunne ikke kopiere"; setTimeout(() => (b.textContent = før), 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(tekst).then(() => ferdig(true), () => ferdig(false));
    else ferdig(false);
  }

  // Hjelp: vises første gang, kan lukkes og hentes frem igjen med «Hjelp»-knappen
  const hjelp = $("#hjelp");
  const lagre = (v) => { try { localStorage.setItem("kart-hjelp-sett", v); } catch (e) {} };
  let sett = false;
  try { sett = localStorage.getItem("kart-hjelp-sett") === "1"; } catch (e) {}
  $("#vis-hjelp").onclick = () => hjelp.showModal();
  hjelp.addEventListener("close", () => lagre("1"));
  hjelp.addEventListener("click", (e) => { if (e.target === hjelp) hjelp.close(); }); // klikk utenfor lukker
  if (!sett) hjelp.showModal();

  fyllScenarioer();
  kandidatliste();
  oppdater();
  sammenlign();
})();
