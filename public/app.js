/*!
 * memglow — live 3D view of an AI assistant's Markdown memory.
 * MIT License. Uses 3d-force-graph and three.js (MIT), bundled in vendor/memglow-graph.js.
 *
 * Pure, testable pieces first (camera follow, activation envelope, comets, single-note target),
 * then the page: graph loading, live stream (/api/stream), activity journal, note panel.
 */
function creerSuiviCamera(o) {
  "use strict";
  var FUSION_MS = 400, FENETRE_MS = 2500, CALME_MS = 6e3, SUSPENSION_MS = 2e4;
  var TEMPS_RESSORT = 0.3, TEMPS_VISEE = 0.24;
  var MARGE = 1.35, MARGE_VUE = 1.12, RAYON_MIN = 28, DIST_MIN = 55;
  var actif = true, reduit = !!o.reduit;
  var mode = "repos";
  var points = [];
  var dernierEvt = -1e9, suspenduJusqua = -1e9, rotationEnPause = false;
  var dir = null;
  var pos = null, cible = null;
  var vPos = { x: 0, y: 0, z: 0 }, vCib = { x: 0, y: 0, z: 0 };
  var visPos = null, visCib = null;
  var vVisPos = { x: 0, y: 0, z: 0 }, vVisCib = { x: 0, y: 0, z: 0 };
  var enMouvement = false;
  function norme(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  }
  function aPos(n) {
    return n && typeof n.x === "number" && isFinite(n.x) && isFinite(n.y) && isFinite(n.z);
  }
  function cadre(pts, marge, rayonMin) {
    var mn = { x: Infinity, y: Infinity, z: Infinity }, mx = { x: -Infinity, y: -Infinity, z: -Infinity }, k = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!aPos(p)) continue;
      k++;
      mn.x = Math.min(mn.x, p.x);
      mn.y = Math.min(mn.y, p.y);
      mn.z = Math.min(mn.z, p.z);
      mx.x = Math.max(mx.x, p.x);
      mx.y = Math.max(mx.y, p.y);
      mx.z = Math.max(mx.z, p.z);
    }
    if (!k) return null;
    var c = { x: (mn.x + mx.x) / 2, y: (mn.y + mx.y) / 2, z: (mn.z + mx.z) / 2 }, r = 0;
    for (var j = 0; j < pts.length; j++) {
      if (!aPos(pts[j])) continue;
      r = Math.max(r, Math.hypot(pts[j].x - c.x, pts[j].y - c.y, pts[j].z - c.z));
    }
    r = Math.max(r, rayonMin);
    var demiV = (o.fov() || 50) * Math.PI / 360;
    var demiH = Math.atan(Math.tan(demiV) * (o.aspect() || 1));
    var demi = Math.min(demiV, demiH);
    return { centre: c, distance: Math.max(DIST_MIN, r / Math.sin(demi) * marge) };
  }
  function lireEtat() {
    var cam = o.lireCamera();
    pos = { x: cam.pos.x, y: cam.pos.y, z: cam.pos.z };
    cible = { x: cam.cible.x, y: cam.cible.y, z: cam.cible.z };
  }
  function directionCourante() {
    var cam = o.lireCamera();
    var d = { x: cam.pos.x - cam.cible.x, y: cam.pos.y - cam.cible.y, z: cam.pos.z - cam.cible.z }, n = norme(d);
    return n > 1e-6 ? { x: d.x / n, y: d.y / n, z: d.z / n } : { x: 0, y: 0, z: 1 };
  }
  function but() {
    var pts, f;
    if (mode === "retour") {
      pts = o.tousLesPoints();
      f = cadre(pts, MARGE_VUE, RAYON_MIN);
    } else {
      pts = points.map(function(e) {
        return e.n;
      });
      f = cadre(pts, MARGE, RAYON_MIN);
    }
    if (!f) return null;
    return {
      cible: f.centre,
      pos: { x: f.centre.x + dir.x * f.distance, y: f.centre.y + dir.y * f.distance, z: f.centre.z + dir.z * f.distance }
    };
  }
  function amortir(cur, tgt, vit, dt, temps) {
    var omega = 2 / temps, x = omega * dt;
    var e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    ["x", "y", "z"].forEach(function(a) {
      var ch = cur[a] - tgt[a], tmp = (vit[a] + omega * ch) * dt;
      vit[a] = (vit[a] - omega * tmp) * e;
      cur[a] = tgt[a] + (ch + tmp) * e;
    });
  }
  function demarrer() {
    if (!enMouvement) {
      lireEtat();
      vPos = { x: 0, y: 0, z: 0 };
      vCib = { x: 0, y: 0, z: 0 };
      visPos = { x: pos.x, y: pos.y, z: pos.z };
      visCib = { x: cible.x, y: cible.y, z: cible.z };
      vVisPos = { x: 0, y: 0, z: 0 };
      vVisCib = { x: 0, y: 0, z: 0 };
    }
    enMouvement = true;
    if (!rotationEnPause) {
      rotationEnPause = true;
      o.pauseRotation();
    }
  }
  return {
    viser: function(noeuds) {
      if (!actif || reduit) return;
      var t = o.maintenant();
      dernierEvt = t;
      if (t < suspenduJusqua) return;
      var neufs = (noeuds || []).filter(Boolean);
      if (!neufs.length) return;
      var fusion = mode === "suivi" && (enMouvement || t - (points.length ? points[points.length - 1].t : -1e9) < FUSION_MS);
      if (fusion) points = points.filter(function(e) {
        return t - e.t < FENETRE_MS;
      });
      else {
        points = [];
        dir = directionCourante();
      }
      neufs.forEach(function(n) {
        points.push({ n, t });
      });
      if (!dir) dir = directionCourante();
      mode = "suivi";
      demarrer();
    },
    interaction: function() {
      suspenduJusqua = o.maintenant() + SUSPENSION_MS;
      enMouvement = false;
      mode = "repos";
      points = [];
    },
    tic: function(dtMs) {
      var t = o.maintenant();
      if (rotationEnPause && mode === "repos" && !enMouvement && t >= suspenduJusqua) {
        rotationEnPause = false;
        o.reprendreRotation();
      }
      if (!actif || reduit) return;
      if (mode === "suivi" && t - dernierEvt > CALME_MS && t >= suspenduJusqua) {
        mode = "retour";
        dir = directionCourante();
        demarrer();
      }
      if (!enMouvement || t < suspenduJusqua) return;
      var b = but();
      if (!b) {
        enMouvement = false;
        return;
      }
      var dt = Math.min(0.1, Math.max(1e-3, dtMs / 1e3));
      amortir(visPos, b.pos, vVisPos, dt, TEMPS_VISEE);
      amortir(visCib, b.cible, vVisCib, dt, TEMPS_VISEE);
      amortir(pos, visPos, vPos, dt, TEMPS_RESSORT);
      amortir(cible, visCib, vCib, dt, TEMPS_RESSORT);
      o.ecrireCamera(pos, cible);
      var reste = Math.hypot(pos.x - b.pos.x, pos.y - b.pos.y, pos.z - b.pos.z) + Math.hypot(cible.x - b.cible.x, cible.y - b.cible.y, cible.z - b.cible.z);
      if (reste < 0.4 && norme(vPos) < 0.6 && norme(vCib) < 0.6 && norme(vVisPos) < 0.6 && norme(vVisCib) < 0.6) {
        enMouvement = false;
        if (mode === "retour") {
          mode = "repos";
          points = [];
        }
      }
    },
    activer: function(oui) {
      actif = !!oui;
      if (!actif) {
        enMouvement = false;
        mode = "repos";
        points = [];
      }
    },
    etat: function() {
      return { mode, enMouvement, points: points.length, suspendu: o.maintenant() < suspenduJusqua, rotationEnPause };
    },
    _cadre: cadre
  };
}
function creerEnveloppe(opts) {
  opts = opts || {};
  var MONTEE = opts.montee || 150, RETOUR = opts.retour || 2500;
  function adoucir(u) {
    return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
  }
  function niveau(o, t) {
    var e = o && o.__env;
    if (!e) return 0;
    var dt = t - e.debut;
    if (dt < 0) return e.depart;
    if (dt < MONTEE) return e.depart + (e.crete - e.depart) * adoucir(dt / MONTEE);
    dt -= MONTEE;
    if (dt < e.maintien) return e.crete;
    dt -= e.maintien;
    if (dt < RETOUR) return e.crete * (1 - adoucir(dt / RETOUR));
    return 0;
  }
  return {
    activer: function(o, force, maintien, t) {
      var e = o.__env;
      var courant = niveau(o, t);
      var enMaintien = e && t - e.debut < MONTEE + e.maintien;
      var crete = Math.max(force, enMaintien ? e.crete : 0);
      o.__env = { depart: courant, crete, debut: t, maintien: Math.max(maintien || 0, enMaintien ? e.debut + MONTEE + e.maintien - t - MONTEE : 0) };
    },
    niveau,
    phase: function(o, t) {
      var e = o && o.__env;
      if (!e) return "repos";
      var dt = t - e.debut;
      if (dt < MONTEE) return "montee";
      if (dt < MONTEE + e.maintien) return "maintien";
      if (dt < MONTEE + e.maintien + RETOUR) return "retour";
      return "repos";
    },
    finie: function(o, t) {
      var e = o && o.__env;
      return !e || t - e.debut >= MONTEE + e.maintien + RETOUR;
    }
  };
}
function creerCometes(o) {
  var N = o.points || 14;
  var FIN = o.fin || 450;
  var MAX = o.max || 220, GARDER = o.garder || 60;
  var fond = o.fond || [0.016, 0.07, 0.06];
  var libres = [], actives = [], total = 0;
  var pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  function adoucir(u) {
    return 0.7 * u + 0.3 * u * u * (3 - 2 * u);
  }
  function poignee() {
    var p = libres.pop();
    if (p) return p;
    if (total < MAX) {
      total++;
      return { h: o.fabrique(), libreDepuis: 0 };
    }
    var i = actives.findIndex(function(c2) {
      return c2.lent;
    });
    if (i < 0) i = 0;
    var c = actives.splice(i, 1)[0];
    return c.p;
  }
  function relacher(c) {
    c.p.h.montrer(false);
    c.p.libreDepuis = o.maintenant();
    libres.push(c.p);
  }
  return {
    lancer: function(de, vers, couleur, opt) {
      opt = opt || {};
      var c = {
        de,
        vers,
        couleur,
        debut: o.maintenant(),
        duree: opt.duree || 1e3,
        lent: !!opt.lent,
        eclat: opt.eclat == null ? 1 : opt.eclat,
        taille: opt.taille || 1,
        longueur: opt.longueur || 0.3,
        cle: opt.cle || null,
        p: poignee()
      };
      c.p.h.montrer(true);
      actives.push(c);
      return c;
    },
    enCours: function(cle) {
      return actives.some(function(c) {
        return c.cle === cle;
      });
    },
    tic: function() {
      var t = o.maintenant();
      for (var i = actives.length - 1; i >= 0; i--) {
        var c = actives[i], d = c.de, v = c.vers;
        if (d.x == null || v.x == null) {
          actives.splice(i, 1);
          relacher(c);
          continue;
        }
        var ecoule = t - c.debut, u = Math.min(1, ecoule / c.duree);
        var tete = adoucir(u), queue, alpha, opTete;
        if (ecoule <= c.duree) {
          queue = Math.max(0, tete - c.longueur);
          alpha = 1;
          opTete = 1;
        } else {
          var e = (ecoule - c.duree) / FIN;
          if (e >= 1) {
            actives.splice(i, 1);
            relacher(c);
            continue;
          }
          tete = 1;
          queue = 1 - c.longueur * (1 - e);
          alpha = Math.pow(1 - e, 1.2);
          opTete = 1 - e;
        }
        var dx = v.x - d.x, dy = v.y - d.y, dz = v.z - d.z;
        for (var k = 0; k < N; k++) {
          var f = k / (N - 1);
          var s = queue + (tete - queue) * f;
          pos[3 * k] = d.x + dx * s;
          pos[3 * k + 1] = d.y + dy * s;
          pos[3 * k + 2] = d.z + dz * s;
          var a = Math.pow(f, 1.6) * alpha * c.eclat;
          for (var j = 0; j < 3; j++) col[3 * k + j] = fond[j] + (c.couleur[j] - fond[j]) * a;
        }
        c.p.h.trainee(pos, col, N);
        c.p.h.tete(d.x + dx * tete, d.y + dy * tete, d.z + dz * tete, c.taille * (0.6 + 0.4 * opTete), opTete * c.eclat);
      }
      if (libres.length > GARDER) {
        for (var m = libres.length - 1; m >= 0 && libres.length > GARDER; m--) {
          if (t - libres[m].libreDepuis > 1e4) {
            libres[m].h.liberer();
            libres.splice(m, 1);
            total--;
          }
        }
      }
    },
    etat: function() {
      return { actives: actives.length, libres: libres.length, total };
    },
    detruire: function() {
      actives.forEach(function(c) {
        c.p.h.liberer();
      });
      libres.forEach(function(p) {
        p.h.liberer();
      });
      actives = [];
      libres = [];
      total = 0;
    }
  };
}
function hauteurPanneau(basScene, hautPanneau, marge, mini) {
  return Math.max(mini || 140, Math.floor(basScene - hautPanneau - (marge || 16)));
}

/* ---- Phone layout (COMPACT block of app.css) ----
   Portrait under 640 px, or a phone on its side (little height, whatever the width). The CSS and
   these helpers share this query: change one, change the other. Above it, the chip, magnifier and
   sheet parts are hidden by CSS and the page is exactly as before. The three helpers below only
   touch the elements they are given (testable with a fake DOM, see test/page-smoke.test.js). */
var COMPACT_QUERY = "(max-width: 640px), (max-height: 500px) and (orientation: landscape)";

function estEchap(e) { return !!e && (e.key === "Escape" || e.key === "Esc"); }

/** Settings as a bottom sheet: o = { details, closeButton, scrim, handle, compact() }.
    Opened on a phone: focus to the close button. Closed by that button, the dimmed background, a
    swipe of more than 50 px down from the handle, or close() (Escape, wired by the page); the
    focus goes back to the gear (the <summary>). → { isOpen(), close() }, or null without details. */
function setupSheet(o) {
  var d = o && o.details;
  if (!d || !d.addEventListener) return null;
  var resume = d.querySelector ? d.querySelector("summary") : null;
  function isOpen() { return !!d.open; }
  function close() {
    if (!d.open) return;
    d.open = false;
    if (d.removeAttribute) d.removeAttribute("open");
    if (resume && resume.focus) resume.focus();
  }
  d.addEventListener("toggle", function() {
    if (d.open && o.compact() && o.closeButton && o.closeButton.focus) o.closeButton.focus();
  });
  if (o.closeButton) o.closeButton.addEventListener("click", close);
  if (o.scrim) o.scrim.addEventListener("click", close);
  var h = o.handle, depart = null;
  if (h && h.addEventListener) {
    h.addEventListener("touchstart", function(e) {
      if (!o.compact() || !e.touches || !e.touches.length) return;
      depart = e.touches[0].clientY;
      if (e.stopPropagation) e.stopPropagation();
    }, { passive: true });
    h.addEventListener("touchmove", function(e) { if (e.stopPropagation) e.stopPropagation(); }, { passive: true });
    h.addEventListener("touchend", function(e) {
      if (depart === null) return;
      var fin = e.changedTouches && e.changedTouches.length ? e.changedTouches[0].clientY : depart;
      var glisse = fin - depart;
      depart = null;
      if (glisse > 50) close();
    });
  }
  return { isOpen: isOpen, close: close };
}

/** Legend behind the "Themes" chip: o = { details, compact(), read(k), write(k, v) }.
    Always unfolded outside the phone layout. On a phone: folded the first time, unless the viewer
    unfolded it before (key memglow.legendOpen, this browser only); then left as the viewer sets it.
    → apply(), to call again on resize / orientation change. */
function setupLegendFold(o) {
  var d = o && o.details;
  if (!d || !d.addEventListener) return null;
  var KEY = "memglow.legendOpen", fait = false;
  function apply() {
    if (!o.compact()) { d.open = true; fait = false; return; }
    if (fait) return;
    fait = true;
    d.open = o.read(KEY) === "1";
  }
  d.addEventListener("toggle", function() {
    if (o.compact() && fait) o.write(KEY, d.open ? "1" : "0");
  });
  apply();
  return apply;
}

/** Search behind the magnifier: o = { button, form, field, compact(), later(fn, ms), active() }.
    The button opens the field (focus in it) and folds it again; Escape or leaving the field folds
    it, and the focus returns to the button on Escape. → { open(), close(focusButton) }. */
function setupSearchFold(o) {
  var b = o && o.button, f = o && o.form, c = o && o.field;
  if (!b || !f || !c || !b.addEventListener) return null;
  var CLASSE = "mem-cherche--ouverte";
  function estOuvert() { return f.classList.contains(CLASSE); }
  function open() {
    f.classList.add(CLASSE);
    b.setAttribute("aria-expanded", "true");
    if (c.focus) c.focus();
  }
  function close(rendre) {
    if (!estOuvert()) return;
    f.classList.remove(CLASSE);
    b.setAttribute("aria-expanded", "false");
    if (rendre && b.focus) b.focus();
  }
  b.addEventListener("click", function() { if (estOuvert()) close(true); else open(); });
  c.addEventListener("keydown", function(e) {
    if (estEchap(e) && o.compact() && estOuvert()) {
      close(true);
      if (e.stopPropagation) e.stopPropagation();
    }
  });
  c.addEventListener("blur", function() {
    if (!o.compact()) return;
    // A short delay: picking a suggestion of the datalist blurs and refocuses the field.
    o.later(function() { if (o.active() !== c) close(false); }, 180);
  });
  return { open: open, close: close, isOpen: estOuvert };
}
var CIBLE_COULEUR = { read: "#4DEBFF", write: "#FF4D2E", search: "#C9A6FF" };
// Same hue family as CIBLE_COULEUR, darkened for contrast on the "Light" background (≥3:1 against
// its brightest tint, ≈0.93 relative luminance — see FONDS.clair and teinteLisible below).
var CIBLE_COULEUR_CLAIR = { read: "#0086A8", write: "#B33A1E", search: "#7A4FD1" };
// The index note's colour on "Light": the usual warm gold (#FFF3D6) is too pale to scale down and
// stay warm (see teinteLisible), so a proper dark goldenrod is used directly — same hue family.
var COULEUR_CLAIR_INDEX = "#B8860B";
function creerCible(opts) {
  "use strict";
  var o = opts || {};
  var CYCLE = o.cycle || 550, NB = o.clignotements || 3, MAINTIEN = o.maintien || 4e3, RETOUR = o.retour || 2500, ANNEAU = o.anneau || 700;
  var BLINK = CYCLE * NB;
  function adoucir(u) {
    return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
  }
  return {
    CLIGNOTEMENT_MS: BLINK,
    activer: function(n, type, t) {
      var c = n.__cible;
      var enClignotement = c && t - c.t0 < BLINK;
      if (enClignotement) {
        c.type = type;
        c.finMaintien = Math.max(c.finMaintien, t + MAINTIEN);
      } else {
        n.__cible = { type, t0: t, finMaintien: t + BLINK + MAINTIEN };
      }
      return n.__cible;
    },
    etat: function(n, t, reduit) {
      var c = n.__cible;
      if (!c) return null;
      var d = t - c.t0;
      if (t >= c.finMaintien + RETOUR) return null;
      var force, allume = true;
      if (t > c.finMaintien) force = 1 - adoucir((t - c.finMaintien) / RETOUR);
      else if (d < BLINK && !reduit) {
        allume = d % CYCLE < CYCLE / 2;
        force = allume ? 1 : 0.2;
      } else force = 1;
      var anneau = reduit ? 1 : adoucir(d / ANNEAU);
      return { type: c.type, force, allume, anneau, nom: t > c.finMaintien ? force : 1 };
    },
    finie: function(n, t) {
      var c = n.__cible;
      return !c || t >= c.finMaintien + RETOUR;
    }
  };
}
/* Bubble radius. "Size by": links (default: grows with the number of links) or token cost (grows
   with the square root of the note's token estimate, clamped, so one huge note does not crush the
   rest). "Bubble size" multiplies notes and the index (0.5 to 3); relay bubbles get half the
   effect. The index is the "sun" of the graph: clearly bigger than any note at every factor. */
var RAYON_INDEX = 14, RAYON_LIENS_BASE = 1.6, RAYON_LIENS_PAS = 0.9, RAYON_RELAIS = 3.4;
var RAYON_JETONS_MIN = 1.2, RAYON_JETONS_MAX = 7.5, RAYON_JETONS_K = 0.07;
var FACTEUR_TAILLE_MIN = 0.5, FACTEUR_TAILLE_MAX = 3;
function facteurTaille(f) {
  f = Number(f);
  return isFinite(f) && f > 0 ? Math.min(FACTEUR_TAILLE_MAX, Math.max(FACTEUR_TAILLE_MIN, f)) : 1;
}
function rayonNote(opts) {
  var o = opts || {};
  var f = facteurTaille(o.facteur == null ? 1 : o.facteur);
  if (o.estIndex) return RAYON_INDEX * f;
  if (o.mode === "jetons") {
    var r = RAYON_JETONS_K * Math.sqrt(Math.max(0, o.jetons || 0));
    return Math.min(RAYON_JETONS_MAX, Math.max(RAYON_JETONS_MIN, r)) * f;
  }
  return (RAYON_LIENS_BASE + Math.sqrt(Math.max(0, o.degre || 0)) * RAYON_LIENS_PAS) * f;
}
function rayonRelais(facteur) {
  return RAYON_RELAIS * (1 + (facteurTaille(facteur) - 1) * 0.5);
}

/* Minimum on-screen size: the radius a sphere of radius r, at distance d from the camera, needs to
   be at least minPx pixels on screen (perspective: px = r · (H/2) / (d · tan(fov/2))). Close up
   nothing changes. `lointain` (0 → 1) says how much the floor enlarged it (used to brighten it a
   little from afar). */
function plancherRayon(r, d, tanDemiFov, hauteurPx, minPx) {
  if (!(d > 0) || !(hauteurPx > 0) || !(tanDemiFov > 0)) return { rayon: r, lointain: 0 };
  var mini = minPx * d * tanDemiFov / (hauteurPx / 2);
  if (mini <= r) return { rayon: r, lointain: 0 };
  return { rayon: mini, lointain: Math.min(1, (mini / r - 1) / 2) };
}

/* Signal speed: time a comet takes along one link — 1.8 s at the default (×1), bounds 0.3 to 2.
   The ambient flow stays 2.4 times slower than a burst. */
var DUREE_COMETE = 1800, VITESSE_MIN = 0.3, VITESSE_MAX = 2;
function dureeComete(vitesse, lent) {
  var v = Number(vitesse);
  if (!isFinite(v) || v <= 0) v = 1;
  v = Math.min(VITESSE_MAX, Math.max(VITESSE_MIN, v));
  return Math.round(DUREE_COMETE * (lent ? 2.4 : 1) / v);
}

/* Light level of a link (0 → 1): the signal, not the link.
   - comet in flight on it: the link stays at its resting level — only the comet lights the way;
   - after arrival: a trace (its own envelope, set at arrival time) fades out, plus a faint echo of
     its two notes' activity (0.3 between notes, 0.45 for a relay thread);
   - clicking a note sets its own envelope at 0.9: its links light up clearly. */
function niveauLien(o) {
  if (o.enVol) return 0;
  var bouts = Math.max(o.actA || 0, o.actB || 0) * (o.relais ? 0.45 : 0.3);
  return Math.min(1, Math.max(o.propre || 0, bouts));
}

/* 3D collision (the bundle has no forceCollide). Two bubbles closer than radiusA + radiusB +
   effective margin are pushed apart (anticipated positions x + vx, correction shared equally).
   The margin is RELATIVE to the spread (margin × spread × 0.75) — it used to be absolute and was
   swamped by the scale of the graph — and the correction is firmer (0.5, two passes per tick), so
   "Minimum spacing" wins over "Gravity". */
var COLLISION_FORCE = 0.5, COLLISION_PASSES = 2;
function margeEffective(marge, ecart) {
  return Math.max(0, marge) * Math.max(0.5, ecart) * 0.75;
}
function creerCollision(rayonDe, margeCourante) {
  var noeuds = [], rayons = [];
  function force() {
    var nb = noeuds.length, m = margeCourante();
    for (var r = 0; r < nb; r++) rayons[r] = rayonDe(noeuds[r]);
    for (var passe = 0; passe < COLLISION_PASSES; passe++) {
      for (var i = 0; i < nb; i++) {
        var a = noeuds[i], ra = rayons[i] + m;
        var ax = a.x + a.vx, ay = a.y + a.vy, az = a.z + a.vz;
        for (var j = i + 1; j < nb; j++) {
          var b = noeuds[j];
          var dx = b.x + b.vx - ax, dy = b.y + b.vy - ay, dz = b.z + b.vz - az;
          var min = ra + rayons[j];
          var d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= min * min) continue;
          if (d2 === 0) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dz = Math.random() - 0.5;
            d2 = dx * dx + dy * dy + dz * dz;
          }
          var d = Math.sqrt(d2), p = (min - d) / d * COLLISION_FORCE * 0.5;
          dx *= p;
          dy *= p;
          dz *= p;
          a.vx -= dx;
          a.vy -= dy;
          a.vz -= dz;
          b.vx += dx;
          b.vy += dy;
          b.vz += dz;
          ax -= dx;
          ay -= dy;
          az -= dz;
        }
      }
    }
  }
  force.initialize = function(nodes) {
    noeuds = nodes || [];
  };
  return force;
}

/* Scene background presets ("Background" setting): deep (default: radial gradient, vignette,
   faint fixed star dust), plain (#04120F, the former background), night blue, light. Every DARK
   tint stays very dark (luminance < 0.03, far below the glow threshold 0.58): the glow never
   spreads over the background. "clair" (Light) is the one deliberate exception — a near-white,
   faintly mint-tinted gradient (luminance up to ≈0.93) in the spirit of the project's own light
   charte — so for it alone: no star dust (etoiles: 0), the glow is raised to a threshold above the
   background itself and cut almost to nothing (seuilLueur, coefLueur — see the Glow slider wiring
   below), and `clair: true` flags every other place in this file that must darken a colour to stay
   readable on white (teinteLisible, CIBLE_COULEUR_CLAIR, COULEUR_CLAIR_INDEX). Data only; the page
   draws it on a canvas. */
var FONDS = {
  profond: { uni: "#04120F", centre: "#0B2B25", milieu: "#05160F", bord: "#010504", etoiles: 1, teinteEtoile: [205, 255, 232] },
  uni: { uni: "#04120F" },
  nuit: { uni: "#050B18", centre: "#122447", milieu: "#07102A", bord: "#010208", etoiles: 1.4, teinteEtoile: [210, 225, 255] },
  clair: {
    uni: "#EEF6F1", centre: "#F3F9F6", milieu: "#E3F0E8", bord: "#D4E6DA", etoiles: 0, teinteEtoile: [255, 255, 255],
    clair: true, seuilLueur: 0.97, coefLueur: 0.12
  }
};
function fondValide(v) {
  return Object.prototype.hasOwnProperty.call(FONDS, v) ? v : "profond";
}
// WCAG-2.1 relative luminance of an sRGB colour (0-1 channels). Pure.
function luminanceRelative(r, g, b) {
  function lin(u) { return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/* On the "Light" background, a colour must be dark enough to read: scaled down — same hue, same
   ratio between channels, so the same colour family, just darker — until its relative luminance is
   at or under `max` (default 0.24, ≈3.4:1 against Light's brightest tint). Left unchanged outside
   "clair" mode, already-dark colours, or an unparsable hex. Pure, no THREE, no DOM: notes, links,
   comets, sub-theme bubbles and the 3D legend all go through it (see the rendering code below). */
function teinteLisible(hex, clair, max) {
  if (!clair || typeof hex !== "string") return hex;
  var m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  var seuil = typeof max === "number" ? max : 0.24;
  var h = m[1];
  var r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  if (luminanceRelative(r, g, b) <= seuil) return "#" + h.toUpperCase();
  var lo = 0, hi = 1;
  for (var i = 0; i < 24; i++) {
    var mid = (lo + hi) / 2;
    if (luminanceRelative(r * mid, g * mid, b * mid) > seuil) hi = mid; else lo = mid;
  }
  function h2(v) {
    var n = Math.max(0, Math.min(255, Math.round(v * lo))).toString(16);
    return n.length < 2 ? "0" + n : n;
  }
  return "#" + h2(r * 255) + h2(g * 255) + h2(b * 255);
}

/* "Name distance": opacity of a name from the camera → note distance. Full up to `seuil`, zero at
   1.35 × seuil, smooth in between; seuil = Infinity: always shown. */
function opaciteNom(d, seuil) {
  if (!(seuil < Infinity)) return 1;
  var u = (d - seuil) / (0.35 * seuil);
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  return 1 - u * u * (3 - 2 * u);
}

/* Saved hidden themes: keep only the themes that exist in this configuration. */
function masquesValides(masques, themes) {
  var out = {};
  Object.keys(masques || {}).forEach(function(k) {
    if (masques[k] === true && (themes.indexOf(k) >= 0 || k === "index" || k === "other")) out[k] = true;
  });
  return out;
}

/* ---- i18n (public/i18n.js, public/i18n/<code>.json) ----
   app.js never blocks on the language file: window.MemglowI18n.t is used once loaded (and kept
   live — see "memglow:language" below); until then, and in the Node tests (no window/document at
   all), T() falls back to this small English copy of the few keys app.js itself renders. Static
   Settings labels live in index.html (data-i18n) and are translated by i18n.js directly: app.js
   does not need them. Kept in sync with public/i18n/en.json by a test. */
var EN_APP = {
  "theme.index": "Index", "theme.other": "Other", "theme.note": "Note",
  "journal.actionRead": "Read", "journal.actionSearch": "Search", "journal.actionWrite": "Write",
  "journal.actionAdded": "New note", "journal.actionChanged": "Note changed", "journal.actionRemoved": "Note removed",
  "journal.actionGeneric": "Activity",
  "journal.sourceAgent": "Agent", "journal.sourceDemo": "Demo", "journal.sourceFile": "File",
  "journal.channelFile": "file", "journal.channelDemo": "demo",
  "journal.diffBadge": "± view",
  "diff.notFound": "Change not found.", "diff.lineWord": { one: "line", other: "lines" },
  "panel.written": "Written {when}",
  "panel.tokens": { one: "≈ {show} token", other: "≈ {show} tokens" },
  "panel.outgoingLinks": { one: "{n} outgoing link", other: "{n} outgoing links" },
  "panel.incoming": "{n} incoming",
  "common.today": "today", "common.yesterday": "yesterday",
  "common.daysAgo": { one: "{n} day ago", other: "{n} days ago" },
  "search.noMatch": "No matching note.",
  "status.loading": "Loading the graph…", "status.noNotes": "No notes yet.",
  "error.libraryFailed": "The graph library could not load.",
  "error.loadFailed": "Could not load the memory. Reload the page.",
  "error.webgl": "Your browser cannot display 3D here (WebGL unavailable).",
  "stats.notesWord": { one: "note", other: "notes" }, "stats.linksWord": { one: "link", other: "links" }
};
/** Same interpolation/plural rule as public/i18n.js (resolveText), duplicated on purpose: every
    page script here is self-contained (see esc()/costEsc()/aiEsc(), each its own copy too). */
function resolveTextApp(dict, key, params) {
  var entry = dict ? dict[key] : undefined;
  if (entry === undefined || entry === null) return key;
  var str = entry;
  if (typeof entry === "object") {
    var n = params && typeof params.n === "number" ? params.n : null;
    var hasOne = Object.prototype.hasOwnProperty.call(entry, "one");
    var hasOther = Object.prototype.hasOwnProperty.call(entry, "other");
    str = n === 1 && hasOne ? entry.one : hasOther ? entry.other : hasOne ? entry.one : key;
  }
  if (typeof str !== "string") return key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, function(m, name) {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m;
  });
}
function defaultT(key, params) {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  if (M && M.dict && Object.prototype.hasOwnProperty.call(M.dict, key)) return M.t(key, params);
  return resolveTextApp(EN_APP, key, params);
}

/* Numbers and times in the memglow language (the Settings choice, window.MemglowI18n.lang() — not
   the browser locale, which the journal clock used to follow), with Intl. Same options as
   public/i18n.js formatNumber/formatTime/formatDateTime, copied so this file stays self-contained;
   `lang` defaults to the page language, English in the Node tests and without Intl. */
var APP_FMT = {};
function appLang() {
  var M = typeof window !== "undefined" && window.MemglowI18n;
  return M && typeof M.lang === "function" ? M.lang() : "en";
}
function appIntl(kind, lang, opts, key) {
  var k = kind + "|" + lang + "|" + key;
  if (!Object.prototype.hasOwnProperty.call(APP_FMT, k)) {
    var f = null;
    try { if (typeof Intl !== "undefined" && Intl[kind]) f = new Intl[kind](lang, opts); } catch (e) { f = null; }
    APP_FMT[k] = f || (lang !== "en" ? appIntl(kind, "en", opts, key) : null);
  }
  return APP_FMT[k];
}
function deux(n) { return (n < 10 ? "0" : "") + n; }
/** 1234 → "1,234" (en), "1 234" (fr), "1.234" (de)… */
function appNum(n, lang) {
  n = Math.round(Number(n) || 0);
  var f = appIntl("NumberFormat", lang || appLang(), { maximumFractionDigits: 0 }, "n");
  return f ? f.format(n) : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** Clock of a journal line (local time): "02:05:09 PM" (en), "14:05:09" (fr)… */
function appTime(ms, lang) {
  var d = new Date(ms);
  if (!isFinite(d.getTime())) return "";
  var f = appIntl("DateTimeFormat", lang || appLang(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }, "time");
  return f ? f.format(d) : deux(d.getHours()) + ":" + deux(d.getMinutes()) + ":" + deux(d.getSeconds());
}
/** Day, short month and time (local): "Sep 30, 02:05:09 PM" (en), "30 sept., 14:05:09" (fr)… */
function appDateTime(ms, lang) {
  var d = new Date(ms);
  if (!isFinite(d.getTime())) return "";
  var f = appIntl("DateTimeFormat", lang || appLang(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }, "datetime");
  return f ? f.format(d) : d.toISOString().slice(0, 19).replace("T", " ");
}

/* Activity journal line: ACTION · GROUP · NOTE · MACHINE · CHANNEL · TOOL ("Write · Projects ·
   Smart home · laptop · hook · Claude Code"), for an activity as for "Note changed / New note /
   Note removed" (channel "file": seen on disk, no machine or tool). The group is the top-level
   theme, spelled out (`names`: { themeId: label }). The colour of the dot (the action's colour
   for an activity on a single note) is decided elsewhere and does not change.
   Backward compatible: `machine` and `channel` are optional — an activity sent before v0.4 (or by
   a sender that does not know about them) has neither, and the line reads exactly as it used to:
   ACTION · GROUP · NOTE · TOOL. o: { type, theme, label, more, source, machine, channel }.
   T defaults to the page language (defaultT); tests pass the 2-argument form and get English.
   Pure otherwise. */
var JOURNAL_ACTION_KEYS = {
  read: "journal.actionRead", search: "journal.actionSearch", write: "journal.actionWrite",
  added: "journal.actionAdded", changed: "journal.actionChanged", removed: "journal.actionRemoved"
};
var SOURCE_TRANSLATED_KEYS = { agent: "journal.sourceAgent", demo: "journal.sourceDemo", file: "journal.sourceFile" };
// Product names: never translated (CLAUDE.md: "garde les noms de produits... tels quels").
var SOURCE_LABELS = {
  claude: "Claude Code", "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor",
  copilot: "Copilot", windsurf: "Windsurf", cline: "Cline", mcp: "MCP"
};
// "channel": how the event reached memglow (see docs/api.md). Unknown values are shown as sent.
// "hook", "MCP proxy" and "API" are technical names, the same in every language; "file" and "demo"
// are words, translated (CHANNEL_TRANSLATED_KEYS, English in CHANNEL_LABELS for reference).
var CHANNEL_LABELS = {
  hook: "hook", "mcp-proxy": "MCP proxy", file: "file", api: "API", demo: "demo"
};
var CHANNEL_TRANSLATED_KEYS = { file: "journal.channelFile", demo: "journal.channelDemo" };
function formatJournalLine(o, names, T) {
  T = T || defaultT;
  o = o || {};
  names = names || {};
  var theme = typeof o.theme === "string" && o.theme ? o.theme : "other";
  var group = Object.prototype.hasOwnProperty.call(names, theme) && names[theme] ? String(names[theme])
    : theme === "index" ? T("theme.index") : T("theme.other");
  var more = Math.max(0, Math.floor(Number(o.more) || 0));
  var src = typeof o.source === "string" ? o.source : "";
  var mach = typeof o.machine === "string" ? o.machine : "";
  var chan = typeof o.channel === "string" ? o.channel : "";
  var p = {
    action: Object.prototype.hasOwnProperty.call(JOURNAL_ACTION_KEYS, o.type) ? T(JOURNAL_ACTION_KEYS[o.type]) : T("journal.actionGeneric"),
    theme: theme,
    group: group,
    note: String(o.label == null ? "" : o.label) + (more ? " +" + more : ""),
    machine: mach,
    channel: Object.prototype.hasOwnProperty.call(CHANNEL_TRANSLATED_KEYS, chan) ? T(CHANNEL_TRANSLATED_KEYS[chan])
      : Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, chan) ? CHANNEL_LABELS[chan] : chan,
    source: Object.prototype.hasOwnProperty.call(SOURCE_LABELS, src) ? SOURCE_LABELS[src]
      : Object.prototype.hasOwnProperty.call(SOURCE_TRANSLATED_KEYS, src) ? T(SOURCE_TRANSLATED_KEYS[src]) : src
  };
  p.text = [p.action, p.group, p.note, p.machine, p.channel, p.source].filter(function(x) { return x; }).join(" · ");
  return p;
}

/* Saved view (GET/PUT /api/view, lib/view.js): one per memglow instance, the same on every device.
   The page keeps its settings as strings under French keys (the localStorage form, which stays a
   cache: "1"/"0", numbers as text, hidden themes as JSON); the server keeps them TYPED under English
   keys. VIEW_SETTINGS maps one to the other: local key → [api key, type, bounds or values
   (local value → api value)]. Must match SETTINGS in lib/view.js (checked by a test). */
var VIEW_SETTINGS = {
  ecart: ["spread", "number", 1, 30],
  gravite: ["gravity", "number", 0, 10],
  marge: ["spacing", "number", 0, 20],
  facteurTaille: ["bubbleSize", "number", 0.5, 3],
  vitesse: ["signalSpeed", "number", 0.3, 2],
  distNoms: ["nameDistance", "number", 1, 20],
  lueur: ["glow", "number", 0, 2],
  taille: ["sizeBy", "choice", { liens: "links", jetons: "tokens" }],
  fond: ["background", "choice", { profond: "deep", uni: "plain", nuit: "night", clair: "light" }],
  liens: ["linksAtRest", "choice", { masques: "hidden", discrets: "subtle", visibles: "visible" }],
  noms: ["names", "choice", { aucun: "none", actifs: "active", tous: "all" }],
  rotation: ["autoRotate", "bool"],
  influx: ["ambientFlow", "bool"],
  grouper: ["groupByTheme", "bool"],
  sousCats: ["subThemes", "bool"],
  fixer: ["keepDragged", "bool"],
  suivre: ["followActivity", "bool"],
  masquesThemes: ["hiddenThemes", "themes"],
  langue: ["language", "choice", { en: "en", fr: "fr", de: "de", es: "es", "pt-BR": "pt-BR", ja: "ja", ko: "ko", "zh-CN": "zh-CN" }]
};
/** Typed settings (server) → { localKey: string } (localStorage form). Unknown keys ignored. */
function settingsToLocal(s) {
  var out = {};
  if (!s || typeof s !== "object") return out;
  Object.keys(VIEW_SETTINGS).forEach(function(k) {
    var d = VIEW_SETTINGS[k], api = d[0];
    if (!Object.prototype.hasOwnProperty.call(s, api)) return;
    var v = s[api];
    if (d[1] === "number" && typeof v === "number" && isFinite(v)) out[k] = String(v);
    else if (d[1] === "choice" && typeof v === "string") {
      Object.keys(d[2]).forEach(function(local) { if (d[2][local] === v) out[k] = local; });
    } else if (d[1] === "bool" && typeof v === "boolean") out[k] = v ? "1" : "0";
    else if (d[1] === "themes" && Array.isArray(v)) {
      var m = {};
      v.forEach(function(x) { if (typeof x === "string") m[x] = true; });
      out[k] = JSON.stringify(m);
    }
  });
  return out;
}
/** read(localKey) → string or null; returns the typed settings to send (unset keys left out). */
function settingsFromLocal(read) {
  var out = {};
  Object.keys(VIEW_SETTINGS).forEach(function(k) {
    var s = read(k);
    if (s === null || s === undefined) return;
    var d = VIEW_SETTINGS[k], api = d[0];
    if (d[1] === "number") {
      var n = parseFloat(s);
      if (isFinite(n) && n >= d[2] && n <= d[3]) out[api] = n;
    } else if (d[1] === "choice") {
      if (Object.prototype.hasOwnProperty.call(d[2], s)) out[api] = d[2][s];
    } else if (d[1] === "bool") out[api] = s === "1";
    else if (d[1] === "themes") {
      try {
        var m = JSON.parse(s) || {};
        out[api] = Object.keys(m).filter(function(x) { return m[x] === true; });
      } catch (e) { /* unreadable: left out */ }
    }
  });
  return out;
}

/* Saved layout → graph nodes, BEFORE they go to the simulation.
   - a node with a saved position takes it back (zero speed); if it was pinned, fx/fy/fz too;
   - a node without one (a note added since) is put near near(n) — its sub-theme bubble, or the
     centre of its group — shifted by a small offset derived from its id (deterministic, never two
     new notes on the same point). near(n) may use nodes already restored: saved positions are set
     first, in one pass, then the others.
   Returns { restored, placed }. Pure (no three.js), testable. */
function offsetFor(id, radius) {
  var h = 2166136261;
  for (var i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  var u = (h % 1000) / 1000, w = ((h >>> 10) % 1000) / 1000;
  var th = u * Math.PI * 2, ph = Math.acos(2 * w - 1);
  return { x: radius * Math.sin(ph) * Math.cos(th), y: radius * Math.sin(ph) * Math.sin(th), z: radius * Math.cos(ph) };
}
function seedPositions(nodes, layout, near, radius) {
  var pos = (layout && layout.positions) || {}, pinned = {}, restored = 0, placed = 0;
  ((layout && layout.pinned) || []).forEach(function(id) { pinned[id] = true; });
  var without = [];
  (nodes || []).forEach(function(n) {
    var p = Object.prototype.hasOwnProperty.call(pos, n.id) ? pos[n.id] : null;
    if (p && p.length === 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2])) {
      n.x = p[0]; n.y = p[1]; n.z = p[2]; n.vx = n.vy = n.vz = 0;
      if (pinned[n.id]) { n.fx = p[0]; n.fy = p[1]; n.fz = p[2]; }
      restored++;
    } else if (typeof n.x !== "number" || !isFinite(n.x)) without.push(n);
  });
  if (!restored) return { restored: 0, placed: 0 }; // nothing saved: the simulation starts from scratch
  without.forEach(function(n) {
    var c = near ? near(n) : null;
    if (!c || !isFinite(c.x) || !isFinite(c.y) || !isFinite(c.z)) return;
    var e = offsetFor(String(n.id), radius || 12);
    n.x = c.x + e.x; n.y = c.y + e.y; n.z = c.z + e.z; n.vx = n.vy = n.vz = 0;
    placed++;
  });
  return { restored: restored, placed: placed };
}
/* Current layout to save: rounded positions (0.01) of placed nodes, pinned ones (fx set), at most
   `max` (the server keeps 2000). Pure. */
function layoutOf(nodes, max) {
  var positions = {}, pinned = [], n = 0, lim = max || 2000;
  function r(x) { return Math.round(x * 100) / 100; }
  for (var i = 0; i < (nodes || []).length && n < lim; i++) {
    var o = nodes[i];
    if (!o || typeof o.id !== "string" || !isFinite(o.x) || !isFinite(o.y) || !isFinite(o.z)) continue;
    positions[o.id] = [r(o.x), r(o.y), r(o.z)];
    if (o.fx != null && isFinite(o.fx)) pinned.push(o.id);
    n++;
  }
  return { positions: positions, pinned: pinned };
}

if (typeof module !== "undefined" && module.exports) module.exports = {
  creerSuiviCamera, creerEnveloppe, creerCometes, hauteurPanneau, creerCible, CIBLE_COULEUR,
  COMPACT_QUERY, setupSheet, setupLegendFold, setupSearchFold,
  CIBLE_COULEUR_CLAIR, COULEUR_CLAIR_INDEX,
  rayonNote, rayonRelais, facteurTaille, plancherRayon, dureeComete, niveauLien, creerCollision,
  margeEffective, FONDS, fondValide, luminanceRelative, teinteLisible, opaciteNom, masquesValides, RAYON_INDEX,
  JOURNAL_ACTION_KEYS, SOURCE_LABELS, SOURCE_TRANSLATED_KEYS, CHANNEL_LABELS, CHANNEL_TRANSLATED_KEYS, formatJournalLine, VIEW_SETTINGS, settingsToLocal, settingsFromLocal,
  offsetFor, seedPositions, layoutOf, EN_APP, resolveTextApp, defaultT, appNum, appTime, appDateTime
};
(function() {
  "use strict";
  if (typeof document === "undefined") return;
  var T = defaultT; // live page language: reads window.MemglowI18n at call time, English otherwise
  var el = document.getElementById("mem-graphe");
  if (!el) return;
  var etat = document.getElementById("mem-etat");
  function dire(t) {
    if (etat) {
      etat.textContent = t;
      etat.hidden = !t;
    }
  }
  if (!window.MemglowGraph) {
    dire(T("error.libraryFailed"));
    return;
  }
  // ---- Saved view of this instance, server side (GET/PUT /api/view) ----
  // Read BEFORE settings and graph are set up: every browser and device that opens this instance
  // gets the same view (settings, bubble layout, pinned bubbles, camera). localStorage stays a
  // cache: fallback when the server does not answer within 2.5 s, and a local copy of each setting.
  var URL_VUE = el.getAttribute("data-vue");
  var CLE_DISPO = "memglow.view"; // local cache of the layout (positions, pinned, camera)
  function lireLocal(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function ecrireLocal(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (e) {
    }
  }
  function dispoLocale() {
    try {
      var d = JSON.parse(lireLocal(CLE_DISPO) || "null");
      return d && typeof d === "object" ? d : null;
    } catch (e) {
      return null;
    }
  }
  function chargerVue(suite) {
    var fini = false;
    function finir(v) {
      if (fini) return;
      fini = true;
      suite(v);
    }
    if (!URL_VUE || !window.fetch) return finir(null);
    var ctrl = window.AbortController ? new AbortController() : null;
    setTimeout(function() {
      if (ctrl) ctrl.abort();
      finir(null);
    }, 2500);
    fetch(URL_VUE, { credentials: "same-origin", signal: ctrl ? ctrl.signal : void 0 }).then(function(r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(finir).catch(function() {
      finir(null);
    });
  }
  chargerVue(demarrer);

  // The rest of the page, once the saved view is known (not re-indented, to keep history readable).
  function demarrer(vueServeur) {
  var serveurOk = !!(vueServeur && typeof vueServeur === "object");
  // Settings: the instance's (server) win and fill the local cache; without an answer from the
  // server, the local cache alone (offline, slow server: the page works anyway).
  var reglagesVue = serveurOk ? settingsToLocal(vueServeur.settings) : null;
  if (reglagesVue) Object.keys(reglagesVue).forEach(function(k) { ecrireLocal("memglow." + k, reglagesVue[k]); });
  // The saved language, if any, wins over whatever i18n.js already started loading (its own
  // detect() only had the local cache and navigator.languages to go on, synchronously, before this
  // fetch resolved).
  if (reglagesVue && reglagesVue.langue && window.MemglowI18n && window.MemglowI18n.lang() !== reglagesVue.langue) {
    window.MemglowI18n.setLanguage(reglagesVue.langue);
  }
  // First visit of an instance with nothing saved yet: this browser's local settings go up.
  var migrerReglages = serveurOk && !Object.keys(reglagesVue || {}).length;
  // Layout: the instance's if it has one, otherwise the local cache (server unreachable only).
  var dispoDepart = null;
  if (serveurOk && vueServeur.positions && Object.keys(vueServeur.positions).length) {
    dispoDepart = { positions: vueServeur.positions, pinned: vueServeur.pinned || [], camera: vueServeur.camera || null };
    ecrireLocal(CLE_DISPO, JSON.stringify(dispoDepart));
  } else if (!serveurOk) dispoDepart = dispoLocale();
  else if (vueServeur.camera) dispoDepart = { positions: {}, pinned: [], camera: vueServeur.camera };

  function lireReglage(cle, defaut) {
    if (reglagesVue && Object.prototype.hasOwnProperty.call(reglagesVue, cle)) return reglagesVue[cle];
    var v = lireLocal("memglow." + cle);
    return v === null ? defaut : v;
  }
  function lireReglageBrut(cle) {
    return lireReglage(cle, null);
  }
  var minuterieReglages = null, reglagesSales = false;
  function garderReglage(cle, v) {
    ecrireLocal("memglow." + cle, String(v));
    if (reglagesVue) reglagesVue[cle] = String(v);
    reglagesSales = true;
    clearTimeout(minuterieReglages);
    minuterieReglages = setTimeout(envoyerReglages, 500); // a slider being dragged = one request
  }
  // PUT with memglow's own header (the server refuses a write without it: CSRF guard).
  function envoyerVue(corps, garder) {
    if (!URL_VUE || !window.fetch) return;
    try {
      fetch(URL_VUE, {
        method: "PUT", credentials: "same-origin", keepalive: !!garder,
        headers: { "Content-Type": "application/json", "X-Memglow": "1" },
        body: JSON.stringify(corps)
      }).catch(function() {
      });
    } catch (e) {
      // offline: the local cache keeps the view
    }
  }
  function envoyerReglages(garder) {
    clearTimeout(minuterieReglages);
    if (!reglagesSales) return;
    reglagesSales = false;
    envoyerVue({ settings: settingsFromLocal(lireReglageBrut) }, garder);
  }
  if (migrerReglages && Object.keys(settingsFromLocal(lireReglageBrut)).length) {
    reglagesSales = true;
    setTimeout(envoyerReglages, 1500);
  }
  var modeNoms = lireReglage("noms", "aucun");
  if (["aucun", "actifs", "tous"].indexOf(modeNoms) < 0) modeNoms = "aucun";
  // Size by (links / token cost), bubble size factor (0.5-3), signal speed (0.3-2, 1 = 1.8 s per
  // link), background preset, name distance (in link lengths; 20 = always).
  var modeTaille = lireReglage("taille", "liens");
  if (["liens", "jetons"].indexOf(modeTaille) < 0) modeTaille = "liens";
  var facteur = facteurTaille(parseFloat(lireReglage("facteurTaille", "1")));
  var vitesse = parseFloat(lireReglage("vitesse", "1"));
  if (!(vitesse >= VITESSE_MIN && vitesse <= VITESSE_MAX)) vitesse = 1;
  var modeFond = fondValide(lireReglage("fond", "profond"));
  var distNoms = parseFloat(lireReglage("distNoms", "20"));
  if (!(distNoms >= 1 && distNoms <= 20)) distNoms = 20;
  var CFG = {};
  try {
    CFG = JSON.parse(document.getElementById("memglow-config").textContent || "{}");
  } catch (e) {
    CFG = {};
  }
  var MG = window.MemglowGraph;
  var THREE = MG.THREE;
  var reduit = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var avecCorps = CFG.showBodies !== false;
  var URL_NOTE = el.getAttribute("data-note");
  // "Light" background: every colour read from COULEUR below is darkened first (same hue, see
  // teinteLisible), and the index note gets a proper dark gold instead of its usual pale warm
  // white (too pale to scale down and stay warm). CIBLE_COULEUR_ACTIVE does the same for the
  // read/search/write highlight colour (comets, target rings, dots).
  var estClair = !!FONDS[modeFond].clair;
  var CIBLE_COULEUR_ACTIVE = estClair ? CIBLE_COULEUR_CLAIR : CIBLE_COULEUR;
  var COULEUR = { index: "#FFFFFF", autre: "#A9C9BF", other: "#A9C9BF" };
  var NOM_THEME = { index: T("theme.index"), autre: T("theme.note"), other: T("theme.other") };
  var ORDRE_THEMES = [];
  (CFG.themes || []).forEach(function(t) {
    COULEUR[t.id] = t.color;
    NOM_THEME[t.id] = t.label;
    ORDRE_THEMES.push(t.id);
  });
  if (estClair) {
    Object.keys(COULEUR).forEach(function(k) { COULEUR[k] = teinteLisible(COULEUR[k], true); });
    COULEUR.index = COULEUR_CLAIR_INDEX;
  }
  var NOM_SOUS_THEME = CFG.subthemeLabels || {};
  function nomSousTheme(id) {
    if (NOM_SOUS_THEME[id]) return NOM_SOUS_THEME[id];
    var t = String(id || "").replace(/-/g, " ");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function themeDe(n) {
    return n && n.theme || "other";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function eclat(n) {
    var jours = (Date.now() - (n.mtime || 0)) / 864e5;
    if (jours < 1) return 1;
    if (jours < 3) return 0.85;
    if (jours < 10) return 0.65;
    if (jours < 30) return 0.5;
    return 0.34;
  }
  var degre = {};
  function recompterDegres(data) {
    degre = {};
    data.links.forEach(function(l) {
      var s = typeof l.source === "object" ? l.source.id : l.source;
      var t = typeof l.target === "object" ? l.target.id : l.target;
      degre[s] = (degre[s] || 0) + 1;
      degre[t] = (degre[t] || 0) + 1;
    });
  }
  var geo = new THREE.SphereGeometry(1, 20, 14);
  var BLANC = new THREE.Color("#FFFFFF");
  var geoRelais = new THREE.SphereGeometry(1, 12, 8);
  function objetNoeud(n) {
    if (n.__relais) return objetRelais(n);
    var estIndex = themeDe(n) === "index";
    var c = new THREE.Color(COULEUR[themeDe(n)] || COULEUR.autre);
    var e = estIndex ? 1 : eclat(n);
    // The index, "sun" of the graph: warm white above 1 (the glow pass renders in float), so it is
    // always above the glow threshold, however old its last write. On "Light" the glow itself is
    // cut (see appliquerLueur below), so the index just keeps its already-darkened COULEUR.index
    // (COULEUR_CLAIR_INDEX) instead of being pushed brighter — pushing it would wash out on white.
    if (estIndex) { if (!estClair) c.set("#FFF3D6").multiplyScalar(1.15); }
    else c.multiplyScalar(0.25 + 0.95 * e);
    // On "Light" a translucent bubble blends toward the (near-white) background, so the opacity
    // floor is raised: otherwise a recent note, which already has the lowest floor, would nearly
    // vanish into it.
    var opaciteBase = estClair ? 0.78 : 0.55, opaciteGamme = estClair ? 0.22 : 0.45;
    var m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c.clone(), transparent: true, opacity: opaciteBase + opaciteGamme * e }));
    var r = rayonNote({ estIndex, mode: modeTaille, degre: degre[n.id], jetons: n.tokens, facteur });
    m.scale.setScalar(r);
    m.userData.rayon = r;
    m.userData.base = c;
    m.userData.opacite = opaciteBase + opaciteGamme * e;
    m.userData.minPx = estIndex ? 7 : 2.4;
    if (n.__phase === void 0) n.__phase = Math.random() * Math.PI * 2;
    n.__mesh = m;
    n.__nom = null;
    n.__halo = null;
    var g = new THREE.Group();
    g.add(m);
    if (estIndex) {
      // Corona: a soft additive halo that breathes slowly (see vivre()); never hovered or clicked.
      var halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: textureHalo(),
        color: new THREE.Color("#FFE7B8"),
        transparent: true,
        depthWrite: false,
        blending: ADDITIF,
        opacity: 0.4
      }));
      halo.scale.setScalar(r * 4.5);
      halo.renderOrder = -1;
      halo.raycast = function() {
      };
      g.add(halo);
      n.__halo = halo;
    }
    if (modeNoms === "aucun") return estIndex ? g : m;
    var s = spriteNom(n.label);
    s.position.y = r + 3.5;
    s.visible = modeNoms === "tous";
    g.add(s);
    n.__nom = s;
    return g;
  }
  function objetRelais(n) {
    var c = new THREE.Color(COULEUR[n.theme] || COULEUR.autre);
    var base = c.clone().multiplyScalar(0.8);
    var m = new THREE.Mesh(geoRelais, new THREE.MeshBasicMaterial({ color: base.clone(), wireframe: true, transparent: true, opacity: 0.55 }));
    var r = rayonRelais(facteur);
    m.scale.setScalar(r);
    m.userData.rayon = r;
    m.userData.base = base;
    m.userData.opacite = 0.55;
    m.userData.minPx = 1.6;
    if (n.__phase === void 0) n.__phase = Math.random() * Math.PI * 2;
    n.__mesh = m;
    var g = new THREE.Group();
    g.add(m);
    var s = spriteTexte(n.label, COULEUR[n.theme] || COULEUR.autre, 30, 700, 4.4);
    s.position.y = r + 3.6;
    g.add(s);
    n.__nomRelais = s;
    return g;
  }
  var ADDITIF = 2; // THREE.AdditiveBlending (the constant is not exported by the bundle)
  var texHalo = null;
  function textureHalo() {
    if (texHalo) return texHalo;
    var c = document.createElement("canvas");
    c.width = c.height = 128;
    var ctx = c.getContext("2d");
    var gr = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255,255,255,0.9)");
    gr.addColorStop(0.18, "rgba(255,255,255,0.45)");
    gr.addColorStop(0.45, "rgba(255,255,255,0.12)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 128, 128);
    texHalo = new THREE.CanvasTexture(c);
    texHalo.colorSpace = "srgb";
    texHalo.minFilter = THREE.LinearFilter;
    return texHalo;
  }
  // Bubble size changed: radii updated in place (no rebuild); the collision reads userData.rayon,
  // so enlarged bubbles do not overlap.
  function redimensionnerBulles() {
    var tous = donnees.nodes.concat(listeRelais);
    for (var i = 0; i < tous.length; i++) {
      var n = tous[i], m = n.__mesh;
      if (!m) continue;
      var r = n.__relais ? rayonRelais(facteur) : rayonNote({ estIndex: themeDe(n) === "index", mode: modeTaille, degre: degre[n.id], jetons: n.tokens, facteur });
      m.userData.rayon = r;
      m.scale.setScalar(r);
      if (n.__halo) n.__halo.scale.setScalar(r * 4.5);
      if (n.__nom) n.__nom.position.y = r + 3.5;
      if (n.__nomRelais) n.__nomRelais.position.y = r + 3.6;
    }
  }
  function spriteNom(texte) {
    // Note names float above their bubble as plain text (no COULEUR tinting): near-white on the
    // dark presets, dark ink on "Light".
    return spriteTexte(texte, estClair ? "#1E2A26" : "#EAF4F0", 40, 600, 4.2);
  }
  function spriteTexte(texte, couleur, px, graisse, h) {
    var c = document.createElement("canvas");
    var ctx = c.getContext("2d");
    var police = graisse + " " + px + "px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.font = police;
    var t = String(texte || "").slice(0, 48);
    c.width = Math.ceil(ctx.measureText(t).width) + 24;
    c.height = px + 20;
    ctx.font = police;
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = couleur;
    ctx.fillText(t, 12, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    s.scale.set(h * c.width / c.height, h, 1);
    return s;
  }
  var enveloppe = creerEnveloppe();
  var MAINTIEN_NOTE = 4e3, MAINTIEN_VOISIN = 2e3;
  function activer(id, force, maintien) {
    var n = parId[id];
    if (!n) return;
    var t = performance.now(), m = maintien || MAINTIEN_NOTE;
    enveloppe.activer(n, Math.min(1.2, force), m, t);
    var r = relaisDe(n);
    if (r) enveloppe.activer(r, Math.min(0.7, force * 0.45), m, t);
  }
  var cible = creerCible();
  var couleursCible = {};
  Object.keys(CIBLE_COULEUR).forEach(function(k) {
    couleursCible[k] = new THREE.Color(CIBLE_COULEUR_ACTIVE[k]);
  });
  var texAnneau = null;
  function textureAnneau() {
    if (texAnneau) return texAnneau;
    var c = document.createElement("canvas");
    c.width = c.height = 128;
    var ctx = c.getContext("2d");
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 6;
    ctx.shadowColor = "rgba(255,255,255,0.85)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.stroke();
    texAnneau = new THREE.CanvasTexture(c);
    texAnneau.minFilter = THREE.LinearFilter;
    return texAnneau;
  }
  var ciblees = [];
  var minuterieReduite = null;
  function objetsCible(n, type) {
    var hex = CIBLE_COULEUR_ACTIVE[type];
    var o = n.__cibleObj;
    if (o && o.type === type) return o;
    if (o) {
      graphe.scene().remove(o.nom);
      o.nom.material.map.dispose();
      o.nom.material.dispose();
    }
    var nom = spriteTexte(n.label, hex, 46, 700, 5.8);
    nom.material.depthTest = false;
    nom.renderOrder = 21;
    graphe.scene().add(nom);
    if (!o) {
      var anneau = new THREE.Sprite(new THREE.SpriteMaterial({ map: textureAnneau(), transparent: true, depthWrite: false, depthTest: false }));
      anneau.renderOrder = 20;
      graphe.scene().add(anneau);
      o = n.__cibleObj = { anneau };
      ciblees.push(n);
    }
    o.anneau.material.color.set(hex);
    o.nom = nom;
    o.type = type;
    return o;
  }
  function retirerCible(n) {
    var o = n.__cibleObj;
    if (o) {
      graphe.scene().remove(o.anneau);
      graphe.scene().remove(o.nom);
      o.anneau.material.dispose();
      o.nom.material.map.dispose();
      o.nom.material.dispose();
    }
    n.__cibleObj = null;
    n.__cible = null;
    if (n.__mesh) n.__mesh.material.color.copy(n.__mesh.userData.base);
  }
  function cibler(id, type) {
    var n = parId[id];
    if (!n || themeDe(n) === "index" || !CIBLE_COULEUR_ACTIVE[type]) return;
    var t = performance.now();
    cible.activer(n, type, t);
    objetsCible(n, type);
    if (!reduit) activer(id, 1.2, cible.CLIGNOTEMENT_MS + MAINTIEN_NOTE);
    majCibles(t);
    if (reduit && !minuterieReduite) {
      minuterieReduite = setInterval(function() {
        majCibles(performance.now());
        if (!ciblees.length) {
          clearInterval(minuterieReduite);
          minuterieReduite = null;
        }
      }, 250);
    }
  }
  function colorerCible(n, st) {
    var m = n.__mesh;
    if (!m) return;
    if (!st.allume) {
      m.material.color.copy(couleursCible[st.type]).multiplyScalar(0.25);
      m.material.opacity = 0.35;
    } else {
      m.material.color.copy(m.userData.base).lerp(couleursCible[st.type], Math.min(1, 0.4 + 0.6 * st.force));
      m.material.opacity = Math.max(m.material.opacity, 0.7 + 0.3 * st.force);
    }
    m.scale.setScalar(Math.max(m.scale.x, m.userData.rayon * (1.6 + 0.9 * st.force)));
  }
  function majCibles(t) {
    for (var i = ciblees.length - 1; i >= 0; i--) {
      var n = ciblees[i], o = n.__cibleObj;
      var st = o && cible.etat(n, t, reduit);
      if (!st) {
        retirerCible(n);
        ciblees.splice(i, 1);
        continue;
      }
      var vu = typeof n.x === "number" && visible(themeDe(n));
      o.anneau.visible = o.nom.visible = vu;
      if (!vu) continue;
      if (reduit) colorerCible(n, st);
      var r = n.__mesh && n.__mesh.userData.rayon || 2;
      o.anneau.position.set(n.x, n.y, n.z);
      o.anneau.scale.setScalar(r * (4.6 + 4.4 * st.anneau));
      o.anneau.material.opacity = (0.95 - 0.4 * st.anneau) * st.force;
      o.nom.position.set(n.x, n.y + r * 2.4 + 6, n.z);
      o.nom.material.opacity = st.nom;
    }
  }
  var dernierPas = performance.now();
  var suivi = null;
  var cometes = null;
  function vivre(t) {
    var dt = Math.min(100, t - dernierPas);
    dernierPas = t;
    if (!document.hidden) {
      var tous = sousCats ? donnees.nodes.concat(listeRelais) : donnees.nodes;
      // Minimum on-screen size and name fading: camera → bubble distance, no allocation.
      var cp = camera && camera.position, H = el.clientHeight || 600;
      var tanDemi = camera ? Math.tan((camera.fov || 50) * Math.PI / 360) : 0;
      var seuilNoms = distNoms >= 20 ? Infinity : distNoms * 18 * ecart;
      for (var i = 0; i < tous.length; i++) {
        var n = tous[i], m = n.__mesh;
        if (!m) continue;
        var act = n.__env ? enveloppe.niveau(n, t) : 0;
        if (act > 0 && enveloppe.phase(n, t) === "maintien") act *= 1 + 0.08 * Math.sin(t * 6e-3 + n.__phase);
        if (n.__env && enveloppe.finie(n, t)) n.__env = null;
        n.__act = act;
        var souffle = 1 + 0.07 * Math.sin(t * 11e-4 + n.__phase);
        var dist = cp && n.x != null ? Math.hypot(n.x - cp.x, n.y - cp.y, n.z - cp.z) : 0;
        var pl = plancherRayon(m.userData.rayon, dist, tanDemi, H, m.userData.minPx || 2);
        m.scale.setScalar(pl.rayon * (souffle + 1.6 * act));
        var mat = m.material;
        // From afar, a bubble enlarged by the floor gets a little lighter to stay readable.
        var blanc = Math.min(0.85, act * 0.8 + pl.lointain * 0.3);
        if (blanc > 0) mat.color.copy(m.userData.base).lerp(BLANC, blanc);
        else if (!mat.color.equals(m.userData.base)) mat.color.copy(m.userData.base);
        mat.opacity = Math.min(1, m.userData.opacite + act * 0.5 + pl.lointain * 0.3);
        if (n.__cible) {
          var stc = cible.etat(n, t, false);
          if (stc) colorerCible(n, stc);
        }
        if (n.__halo) n.__halo.material.opacity = 0.36 + 0.06 * Math.sin(t * 7e-4) + 0.2 * act;
        if (n.__nom && modeNoms === "actifs") n.__nom.visible = act > 0.06;
        var nom = n.__nom || n.__nomRelais;
        if (nom && nom.visible) {
          var op = opaciteNom(dist, seuilNoms);
          if (nom.material.opacity !== op) nom.material.opacity = op;
        }
      }
    }
    if (!document.hidden) {
      majLiens(t);
      majCibles(t);
    }
    if (cometes && !document.hidden) {
      influxTic(t, dt);
      cometes.tic();
    }
    if (suivi) suivi.tic(dt);
    requestAnimationFrame(vivre);
  }
  function liensDe(id) {
    return donnees.links.filter(function(l) {
      var s = typeof l.source === "object" ? l.source.id : l.source;
      var c = typeof l.target === "object" ? l.target.id : l.target;
      return s === id || c === id;
    });
  }
  function voisinsDe(id) {
    return liensDe(id).map(function(l) {
      var s = typeof l.source === "object" ? l.source.id : l.source;
      var c = typeof l.target === "object" ? l.target.id : l.target;
      return s === id ? c : s;
    });
  }
  // Additive trail fading to black (= transparent in additive blending): it fades the same way on
  // every background preset.
  var FOND_RVB = [0, 0, 0];
  var couleursComete = {};
  function couleurComete(n) {
    var th = themeDe(n);
    if (!couleursComete[th]) {
      var c = new THREE.Color(COULEUR[th] || COULEUR.autre);
      // Lightened 45% towards white — except on "Light", where COULEUR is already the darkened
      // (readable) version of the theme colour, and lightening it further would only wash it out.
      if (!estClair) c.lerp(BLANC, 0.45);
      couleursComete[th] = [c.r, c.g, c.b];
    }
    return couleursComete[th];
  }
  function noeudDe(x) {
    return typeof x === "object" ? x : parId[x];
  }
  function montre(n) {
    return n && n.x != null && n.__mesh && n.__mesh.parent && visible(themeDe(n));
  }
  // Bigger, brighter comet head: whitened and pushed above 1 so the glow makes it the brightest
  // point of the trip.
  var TETE = 2.4;
  function fabriqueComete(groupe) {
    return function() {
      var geo2 = new THREE.BufferGeometry();
      var posA = new THREE.BufferAttribute(new Float32Array(14 * 3), 3);
      var colA = new THREE.BufferAttribute(new Float32Array(14 * 3), 3);
      geo2.setAttribute("position", posA);
      geo2.setAttribute("color", colA);
      var ligne = new THREE.Line(geo2, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: ADDITIF }));
      ligne.frustumCulled = false;
      ligne.renderOrder = 5;
      var tete = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: ADDITIF }));
      tete.frustumCulled = false;
      tete.renderOrder = 6;
      ligne.visible = tete.visible = false;
      groupe.add(ligne);
      groupe.add(tete);
      var couleurTete = new THREE.Color();
      return {
        montrer: function(oui) {
          ligne.visible = tete.visible = !!oui;
        },
        trainee: function(pos, col, n) {
          posA.array.set(pos);
          colA.array.set(col);
          posA.needsUpdate = true;
          colA.needsUpdate = true;
          geo2.setDrawRange(0, n);
          couleurTete.setRGB(col[3 * (n - 1)], col[3 * (n - 1) + 1], col[3 * (n - 1) + 2]);
          // Whitened and pushed above 1 so the comet head is the brightest point of the trip — on
          // "Light" that would wash it out against the pale background, so it is darkened instead.
          if (estClair) couleurTete.multiplyScalar(0.8); else couleurTete.lerp(BLANC, 0.55).multiplyScalar(1.5);
          tete.material.color.copy(couleurTete);
        },
        tete: function(x, y, z, echelle, opacite) {
          tete.position.set(x, y, z);
          tete.scale.setScalar(TETE * echelle);
          tete.material.opacity = Math.max(0, Math.min(1, opacite));
        },
        liberer: function() {
          groupe.remove(ligne);
          groupe.remove(tete);
          geo2.dispose();
          ligne.material.dispose();
          tete.geometry.dispose();
          tete.material.dispose();
        }
      };
    };
  }
  // Comet in flight on a link: the link stays at its resting level until arrival (niveauLien),
  // then keeps a trace that fades out (envelope set at arrival time).
  function voler(l, t, duree, trace) {
    l.__volFin = Math.max(l.__volFin || 0, t + duree);
    enveloppe.activer(l, trace, 250, t + duree);
  }
  function salve(id, eclatSalve) {
    if (!cometes || reduit) return;
    var n = parId[id];
    if (!montre(n) || themeDe(n) === "index") return;
    liensDe(id).forEach(function(l) {
      var a = noeudDe(l.source), b = noeudDe(l.target);
      var vers = a && a.id === id ? b : a;
      if (!montre(vers)) return;
      var t = performance.now(), duree = dureeComete(vitesse) * (0.95 + Math.random() * 0.1);
      voler(l, t, duree, 0.35 * (eclatSalve || 1));
      cometes.lancer(n, vers, couleurComete(n), { duree, eclat: eclatSalve || 1, longueur: 0.38 });
    });
  }
  var REPOS_LIENS = {
    // Hidden = really nothing at rest (no stubs around the relay bubbles).
    masques: { intra: 0, inter: 0, relais: 0 },
    discrets: { intra: 0.07, inter: 0.025, relais: 0.14 },
    visibles: { intra: 0.3, inter: 0.15, relais: 0.2 }
  };
  var modeLiens = lireReglage("liens", "discrets");
  if (!REPOS_LIENS[modeLiens]) modeLiens = "discrets";
  var GRIS_LIEN = new THREE.Color(teinteLisible("#A9C9BF", estClair));
  function materiauLien(l) {
    if (!l.__mat) l.__mat = new THREE.LineBasicMaterial({ color: GRIS_LIEN.clone(), transparent: true, opacity: 0.1, depthWrite: false });
    return l.__mat;
  }
  function allumerLiens(id, force, maintien) {
    var t = performance.now();
    liensDe(id).forEach(function(l) {
      enveloppe.activer(l, force, maintien, t);
    });
  }
  var couleurLien = new THREE.Color();
  function majLiens(t) {
    var repos2 = REPOS_LIENS[modeLiens];
    var liste = sousCats ? donnees.links.concat(liensRelaisVue) : donnees.links;
    for (var i = 0; i < liste.length; i++) {
      var l = liste[i], mat = l.__mat, obj = l.__lineObj;
      if (!mat || !obj) continue;
      var a = noeudDe(l.source), b = noeudDe(l.target);
      if (!a || !b) continue;
      var base = l.__relais ? repos2.relais : themeDe(a) === themeDe(b) ? repos2.intra : repos2.inter;
      var propre = l.__env ? enveloppe.niveau(l, t) : 0;
      if (l.__env && enveloppe.finie(l, t)) l.__env = null;
      var enVol = l.__volFin > t;
      if (l.__volFin && !enVol) l.__volFin = 0;
      var niv = niveauLien({ propre, actA: a.__act, actB: b.__act, relais: l.__relais, enVol });
      if (niv < 2e-3 && l.__repos === base) continue;
      l.__repos = niv < 2e-3 ? base : -1;
      var source = (a.__act || 0) >= (b.__act || 0) ? a : b;
      var c = couleurComete(source);
      couleurLien.setRGB(c[0], c[1], c[2]);
      mat.color.copy(GRIS_LIEN).lerp(couleurLien, niv);
      mat.opacity = base + (0.95 - base) * niv;
      mat.visible = mat.opacity > 4e-3;
    }
  }
  // ---- Phone: portrait under 640 px AND landscape phone (little height, whatever the width). Same
  // query as the COMPACT block of app.css: change one, change the other. Above that, nothing below
  // changes anything visible (the chip, magnifier and sheet parts stay hidden by CSS).
  var mqlCompact = window.matchMedia ? window.matchMedia(COMPACT_QUERY) : null;
  function compact() { return !!(mqlCompact && mqlCompact.matches); }
  var panneauOptions = document.getElementById("mem-options");
  var corpsOptions = document.getElementById("mem-options-corps");
  function bornerPanneau() {
    if (!panneauOptions || !corpsOptions || !panneauOptions.open) return;
    if (compact()) {
      corpsOptions.style.removeProperty("--mem-corps-max");
      return;
    }
    var scene = el.getBoundingClientRect(), haut = corpsOptions.getBoundingClientRect().top;
    corpsOptions.style.setProperty("--mem-corps-max", hauteurPanneau(scene.bottom, haut, 16, 140) + "px");
  }
  if (panneauOptions && corpsOptions && corpsOptions.addEventListener) {
    panneauOptions.addEventListener("toggle", bornerPanneau);
    if (window.addEventListener) window.addEventListener("resize", bornerPanneau);
    ["wheel", "touchstart", "touchmove", "pointerdown"].forEach(function(type) {
      corpsOptions.addEventListener(type, function(e) {
        e.stopPropagation();
      }, { passive: true });
    });
  }
  // Settings sheet (phone): opened, the focus goes to "Close settings"; closed by that button,
  // Escape, a tap on the dimmed background or a swipe down from the handle — and the focus comes
  // back to the gear (setupSheet, top of this file).
  var feuille = setupSheet({
    details: panneauOptions,
    closeButton: document.getElementById("mem-options-fermer"),
    scrim: document.getElementById("mem-options-scrim"),
    handle: document.getElementById("mem-options-poignee"),
    compact: compact,
  });
  // Escape: closes the Settings sheet first, else the note card.
  document.addEventListener("keydown", function(e) {
    if (e.key !== "Escape" && e.key !== "Esc") return;
    if (feuille && feuille.isOpen()) { feuille.close(); return; }
    if (panneau && !panneau.hidden) panneau.hidden = true;
  });
  var choixLiens = document.getElementById("mem-liens");
  if (choixLiens) {
    choixLiens.value = modeLiens;
    choixLiens.addEventListener("change", function() {
      modeLiens = REPOS_LIENS[choixLiens.value] ? choixLiens.value : "discrets";
      garderReglage("liens", modeLiens);
      donnees.links.concat(liensRelaisVue).forEach(function(l) {
        l.__repos = -1;
      });
    });
  }
  var influxActif = false;
  function influxTic(t, dt) {
    if (!influxActif || reduit) return;
    var liens = donnees.links, proba = dt / 9e3;
    for (var i = 0; i < liens.length; i++) {
      if (Math.random() > proba) continue;
      var l = liens[i], a = noeudDe(l.source), b = noeudDe(l.target);
      if (!montre(a) || !montre(b)) continue;
      var cle = a.id + "\n" + b.id;
      if (cometes.enCours(cle)) continue;
      var sens = Math.random() < 0.5;
      var duree = dureeComete(vitesse, true);
      voler(l, t, duree, 0.15);
      cometes.lancer(
        sens ? a : b,
        sens ? b : a,
        couleurComete(sens ? a : b),
        { duree, eclat: 0.5, taille: 0.7, lent: true, cle, longueur: 0.38 }
      );
    }
  }
  var sousCats = lireReglage("sousCats", "1") === "1";
  var relais = {};
  var listeRelais = [];
  function cleRelais(n) {
    var t = themeDe(n);
    if (ORDRE_THEMES.indexOf(t) < 0) return null;
    return t + "/" + (n.subtheme || "general");
  }
  var degreVue = {};
  function idDe(x) {
    return typeof x === "object" ? x.id : x;
  }
  function compterDegresVue(liens) {
    degreVue = {};
    liens.forEach(function(l) {
      var a = idDe(l.source), b = idDe(l.target);
      degreVue[a] = (degreVue[a] || 0) + 1;
      degreVue[b] = (degreVue[b] || 0) + 1;
    });
  }
  function relaisDe(n) {
    var k = n && cleRelais(n);
    return k ? relais[k] || null : null;
  }
  var liensRelaisVue = [];
  function remplacerFils(nouveaux) {
    var anciens = liensRelaisVue;
    liensRelaisVue = nouveaux;
    setTimeout(function() {
      anciens.forEach(function(l) {
        if (l.__mat) {
          l.__mat.dispose();
          l.__mat = null;
        }
      });
    }, 2e3);
  }
  function vue() {
    if (!sousCats) {
      listeRelais = [];
      remplacerFils([]);
      compterDegresVue(donnees.links);
      return donnees;
    }
    var vus = {}, liensRelais = [];
    donnees.nodes.forEach(function(n) {
      var k = cleRelais(n);
      if (!k) return;
      var r = relais[k];
      if (!r) {
        r = relais[k] = {
          id: "~" + k,
          __relais: true,
          theme: themeDe(n),
          sousTheme: n.subtheme || "general",
          label: nomSousTheme(n.subtheme || "general"),
          nb: 0
        };
      }
      if (!vus[k]) {
        vus[k] = true;
        r.nb = 0;
      }
      r.nb++;
      liensRelais.push({ source: r.id, target: n.id, __relais: true });
    });
    listeRelais = Object.keys(vus).map(function(k) {
      return relais[k];
    });
    remplacerFils(liensRelais);
    var liens = donnees.links.concat(liensRelais);
    compterDegresVue(liens);
    return { nodes: donnees.nodes.concat(listeRelais), links: liens };
  }
  function parRelaisId(id) {
    for (var i = 0; i < listeRelais.length; i++) if (listeRelais[i].id === id) return listeRelais[i];
    return null;
  }
  function viserRelais(r) {
    if (typeof r.x === "number") {
      if (suivi) suivi.interaction();
      var d = 120, ray = Math.hypot(r.x, r.y, r.z) || 1, k = 1 + d / ray;
      graphe.cameraPosition({ x: r.x * k, y: r.y * k, z: r.z * k }, r, 1200);
      if (controles) controles.autoRotate = false;
      planifierCamera();
    }
    enveloppe.activer(r, 0.7, MAINTIEN_NOTE, performance.now());
    notesDuRelais(r).forEach(function(n, i) {
      setTimeout(function() {
        activer(n.id, 0.6);
      }, 60 * i);
    });
  }
  function notesDuRelais(r) {
    return donnees.nodes.filter(function(n) {
      return cleRelais(n) === r.theme + "/" + r.sousTheme;
    });
  }
  var fixer = lireReglage("fixer", "1") === "1";
  var masques = {};
  try {
    masques = JSON.parse(lireReglage("masquesThemes", "{}")) || {};
  } catch (e) {
    masques = {};
  }
  masques = masquesValides(masques, ORDRE_THEMES);
  function visible(theme) {
    return !masques[theme || "other"];
  }
  function garderMasques() {
    garderReglage("masquesThemes", JSON.stringify(masques));
  }
  var dernierClic = { id: null, t: 0 }, dernierClicFond = 0;
  // Bubble under the pointer (null = empty background): only used by the background double-click;
  // hovering lights nothing up.
  var survol = null, dernierRecentrage = 0;
  function recentrerDepuisFond() {
    var t = Date.now();
    if (t - dernierRecentrage < 600) return; // native dblclick + own detection: once only
    dernierRecentrage = t;
    dernierClicFond = 0;
    recentrer();
  }
  var tics = 0;
  function liberer(n) {
    n.fx = n.fy = n.fz = void 0;
    if (graphe) graphe.d3ReheatSimulation();
  }
  var graphe;
  try {
    graphe = MG.ForceGraph3D({ controlType: "orbit" })(el).backgroundColor("#04120F").showNavInfo(false).nodeId("id").nodeThreeObject(objetNoeud).nodeLabel(function(n) {
      if (n.__relais) {
        return '<div class="mem-bulle"><strong>' + esc(n.label) + "</strong><br>" + esc(NOM_THEME[n.theme] || "") + " · " + esc(appNum(n.nb)) + " " + esc(T("stats.notesWord", { n: n.nb })) + "</div>";
      }
      var nJ = Math.round(n.tokens);
      var jetons = typeof n.tokens === "number" && isFinite(n.tokens) ? "<br><small>" + esc(T("panel.tokens", { n: nJ, show: appNum(nJ) })) + "</small>" : "";
      return '<div class="mem-bulle"><strong>' + esc(n.label) + "</strong>" + (n.description ? "<br>" + esc(n.description) : "") + jetons + "</div>";
    }).linkWidth(0).linkMaterial(materiauLien).linkDirectionalParticles(0).linkDirectionalParticleWidth(1.5).linkDirectionalParticleSpeed(55e-4).linkDirectionalParticleResolution(6).linkDirectionalParticleColor(function() {
      return "#CFFFEA";
    }).nodeVisibility(function(n) {
      return visible(themeDe(n));
    }).linkVisibility(function(l) {
      var s = typeof l.source === "object" ? l.source : parId[l.source];
      var t = typeof l.target === "object" ? l.target : parId[l.target];
      if (!s && typeof l.source === "string") s = parRelaisId(l.source);
      return !!(s && t && visible(themeDe(s)) && visible(themeDe(t)));
    }).onNodeDragEnd(function(n) {
      if (fixer) {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z;
      } else {
        n.fx = n.fy = n.fz = void 0;
      }
      placerNomsThemes();
      planifierDisposition(); // saved view: the bubble stays where it was put, on every device
    }).onEngineTick(function() {
      if (++tics % 8 === 0) placerNomsThemes();
    }).onEngineStop(function() {
      placerNomsThemes();
      if (reduit) majLiens(performance.now());
      finSimulation();
    }).onNodeHover(function(n) {
      survol = n || null;
    }).onNodeClick(function(n) {
      if (n.__relais) {
        viserRelais(n);
        return;
      }
      var t = Date.now();
      if (dernierClic.id === n.id && t - dernierClic.t < 380) {
        liberer(n);
        dernierClic = { id: null, t: 0 };
        return;
      }
      dernierClic = { id: n.id, t };
      dernierClicFond = 0;
      allumerLiens(n.id, 0.9, MAINTIEN_NOTE);
      ouvrir(n.id, true);
    }).onBackgroundClick(function() {
      // Double-click on empty background: back to the overview (like "Recenter"). Two paths: the
      // native `dblclick` event (wired below; follows the system double-click speed and tolerates a
      // slight trackpad movement), and this own detection (500 ms) for touch screens.
      var t = Date.now();
      if (dernierClicFond && t - dernierClicFond < 500) {
        recentrerDepuisFond();
        return;
      }
      dernierClicFond = t;
    }).showPointerCursor(function(d) {
      return !!d;
    });
  } catch (e) {
    dire(T("error.webgl"));
    return;
  }
  var curseur = document.getElementById("mem-ecart");
  function reglageDefaut(cle, ancien, nouveau) {
    var v = parseFloat(lireReglage(cle, String(nouveau)));
    return isNaN(v) || v === ancien ? nouveau : v;
  }
  var ecart = reglageDefaut("ecart", 4, 7) || 7;
  var gravite = reglageDefaut("gravite", 5, 6);
  if (!(gravite >= 0 && gravite <= 10)) gravite = 6;
  var marge = reglageDefaut("marge", 4, 8);
  if (!(marge >= 0 && marge <= 20)) marge = 8;
  function ecarter(k) {
    ecart = k;
    graphe.d3Force("charge").strength(-30 * k);
    graphe.d3Force("link").distance(function(l) {
      return l.__relais ? 9 * k : 18 * k;
    }).strength(function(l) {
      if (l.__relais) return 0.06 * gravite;
      return 1 / Math.max(1, Math.min(degreVue[idDe(l.source)] || 1, degreVue[idDe(l.target)] || 1));
    });
    graphe.d3ReheatSimulation();
  }
  if (curseur) {
    curseur.value = ecart;
    curseur.addEventListener("input", function() {
      var k = parseFloat(curseur.value) || 7;
      garderReglage("ecart", k);
      ecarter(k);
    });
  }
  var grouper = lireReglage("grouper", "1") === "1";
  function centreDe(theme) {
    if (theme === "index") return { x: 0, y: 0, z: 0 };
    var i = ORDRE_THEMES.indexOf(theme);
    if (i < 0) return null;
    var N = ORDRE_THEMES.length, R = 38 * ecart * (1.5 - 0.1 * gravite);
    var y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
    return { x: R * r * Math.cos(a), y: R * y * 0.8, z: R * r * Math.sin(a) };
  }
  var noeudsForce = [];
  function forceThemes(alpha) {
    if (!grouper) return;
    var g = gravite / 5;
    for (var i = 0; i < noeudsForce.length; i++) {
      var n = noeudsForce[i], c = centreDe(themeDe(n));
      if (!c) continue;
      var k = (themeDe(n) === "index" ? 0.3 : (n.__relais ? 0.12 : 0.07) * g) * alpha;
      n.vx += (c.x - n.x) * k;
      n.vy += (c.y - n.y) * k;
      n.vz += (c.z - n.z) * k;
    }
  }
  forceThemes.initialize = function(nodes) {
    noeudsForce = nodes || [];
  };
  graphe.d3Force("themes", forceThemes);
  // Collision (creerCollision, top of file): margin relative to the spread, firm correction, two
  // passes. It reads the scaled radius (userData.rayon), so enlarged bubbles do not overlap. The
  // simulation stops by itself at rest: no cost when nothing moves.
  function rayonDe(n) {
    var m = n.__mesh;
    if (m && m.userData && m.userData.rayon) return m.userData.rayon;
    return n.__relais ? rayonRelais(facteur) : themeDe(n) === "index" ? RAYON_INDEX * facteur : 2 * facteur;
  }
  graphe.d3Force("collision", creerCollision(rayonDe, function() {
    return margeEffective(marge, ecart);
  }));
  function brancherCurseur(id, cle, lire2, appliquer2) {
    var c = document.getElementById(id);
    if (!c) return;
    c.value = lire2();
    c.addEventListener("input", function() {
      var v = parseFloat(c.value);
      if (!isFinite(v)) return;
      garderReglage(cle, v);
      appliquer2(v);
      ecarter(ecart);
    });
  }
  brancherCurseur("mem-gravite", "gravite", function() {
    return gravite;
  }, function(v) {
    gravite = Math.min(10, Math.max(0, v));
  });
  brancherCurseur("mem-marge", "marge", function() {
    return marge;
  }, function(v) {
    marge = Math.min(20, Math.max(0, v));
  });
  brancherCurseur("mem-facteur", "facteurTaille", function() {
    return facteur;
  }, function(v) {
    facteur = facteurTaille(v);
    redimensionnerBulles();
  });
  ecarter(ecart);
  var nomsThemes = {};
  function spriteTheme(texte, couleur) {
    var c = document.createElement("canvas");
    var ctx = c.getContext("2d");
    var px = 44;
    ctx.font = "700 " + px + "px system-ui, -apple-system, Segoe UI, sans-serif";
    c.width = Math.ceil(ctx.measureText(texte).width) + 28;
    c.height = px + 22;
    ctx.font = "700 " + px + "px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.95)";
    ctx.shadowBlur = 10;
    ctx.fillStyle = couleur;
    ctx.globalAlpha = 0.9;
    ctx.fillText(texte, 14, c.height / 2);
    var tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    var h = 7;
    s.scale.set(h * c.width / c.height, h, 1);
    return s;
  }
  ORDRE_THEMES.forEach(function(t) {
    var s = spriteTheme(NOM_THEME[t], COULEUR[t]);
    s.visible = false;
    graphe.scene().add(s);
    nomsThemes[t] = s;
  });
  function placerNomsThemes() {
    var somme = {};
    for (var i = 0; i < donnees.nodes.length; i++) {
      var n = donnees.nodes[i], t = themeDe(n);
      if (!nomsThemes[t] || typeof n.x !== "number") continue;
      var a = somme[t] || (somme[t] = { x: 0, y: 0, z: 0, haut: -Infinity, nb: 0 });
      a.x += n.x;
      a.y += n.y;
      a.z += n.z;
      a.nb++;
      if (n.y > a.haut) a.haut = n.y;
    }
    ORDRE_THEMES.forEach(function(t2) {
      var s = nomsThemes[t2], a2 = somme[t2];
      s.visible = false;
      if (s.visible) s.position.set(a2.x / a2.nb, Math.max(a2.y / a2.nb + 14, a2.haut + 8), a2.z / a2.nb);
    });
  }
  var caseGrouper = document.getElementById("mem-grouper");
  if (caseGrouper) {
    caseGrouper.checked = grouper;
    caseGrouper.addEventListener("change", function() {
      grouper = caseGrouper.checked;
      garderReglage("grouper", grouper ? "1" : "0");
      graphe.d3ReheatSimulation();
      placerNomsThemes();
    });
  }
  var caseSousCats = document.getElementById("mem-souscats");
  if (caseSousCats) {
    caseSousCats.checked = sousCats;
    caseSousCats.addEventListener("change", function() {
      sousCats = caseSousCats.checked;
      garderReglage("sousCats", sousCats ? "1" : "0");
      graphe.graphData(vue());
    });
  }
  var caseInflux = document.getElementById("mem-influx");
  function influx(oui) {
    influxActif = !!oui && !reduit;
  }
  if (caseInflux) {
    caseInflux.checked = lireReglage("influx", "0") === "1";
    caseInflux.disabled = reduit;
    caseInflux.addEventListener("change", function() {
      garderReglage("influx", caseInflux.checked ? "1" : "0");
      influx(caseInflux.checked);
    });
    influx(caseInflux.checked);
  }
  if (!reduit) {
    var groupeCometes = new THREE.Group();
    graphe.scene().add(groupeCometes);
    cometes = creerCometes({
      fabrique: fabriqueComete(groupeCometes),
      maintenant: function() {
        return performance.now();
      },
      fond: FOND_RVB,
      points: 14,
      max: 220,
      garder: 60
    });
  }
  // ---- Scene background ("Background" setting, FONDS presets at the top of the file) ----
  // Deep / night blue: a canvas the size of the stage (radial gradient + vignette, light dithering
  // against gradient banding, fixed star dust drawn from a seed: the same sky every time), redrawn
  // only when the size or the preset changes. Always a SCENE background — a plain colour, or a
  // texture declared sRGB — never only the renderer's clear colour (see the note below).
  var texFond = null, cleFond = "", minuterieFond = null;
  function dessinerFond() {
    var sc = graphe.scene(), p = FONDS[modeFond];
    el.style.backgroundColor = p.uni;
    graphe.backgroundColor(p.uni);
    if (!p.centre) {
      if (texFond) {
        texFond.dispose();
        texFond = null;
      }
      cleFond = modeFond;
      sc.background = new THREE.Color(p.uni);
      return;
    }
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(64, Math.round((el.clientWidth || 800) * dpr)), h = Math.max(64, Math.round((el.clientHeight || 600) * dpr));
    var k = Math.min(1, 2048 / Math.max(w, h));
    w = Math.round(w * k);
    h = Math.round(h * k);
    var cle = modeFond + ":" + w + "x" + h;
    if (cle === cleFond && texFond) return;
    cleFond = cle;
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    var ctx = c.getContext("2d");
    var cx = w * 0.5, cy = h * 0.46, R = Math.hypot(w, h) * 0.6;
    var gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    gr.addColorStop(0, p.centre);
    gr.addColorStop(0.42, p.milieu);
    gr.addColorStop(1, p.bord);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h), d = img.data, graine = 12345;
    function alea() {
      graine = graine * 1664525 + 1013904223 >>> 0;
      return graine / 4294967296;
    }
    for (var i = 0; i < d.length; i += 4) {
      var bruit = alea() < 0.5 ? -1 : 1;
      if (alea() < 0.5) {
        d[i] += bruit;
        d[i + 1] += bruit;
        d[i + 2] += bruit;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Star dust: rare, tiny, pale; denser towards the edges (the vignette keeps the centre clear).
    var nb = Math.round(w * h / (dpr * dpr) / 5200 * p.etoiles), te = p.teinteEtoile;
    for (var s = 0; s < nb; s++) {
      var x = alea() * w, y = alea() * h;
      var bord = Math.min(1, Math.hypot(x - cx, y - cy) / (R * 0.8));
      var a = (0.05 + 0.22 * alea() * alea()) * (0.45 + 0.55 * bord);
      var r = (0.35 + 0.6 * alea() * alea()) * dpr;
      if (alea() < 0.03) {
        a = Math.min(0.5, a * 2.2);
        r *= 1.6;
      }
      ctx.fillStyle = "rgba(" + te[0] + "," + te[1] + "," + te[2] + "," + a.toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = "srgb";
    tex.minFilter = THREE.LinearFilter;
    sc.background = tex;
    if (texFond) texFond.dispose();
    texFond = tex;
  }
  function planifierFond() {
    clearTimeout(minuterieFond);
    minuterieFond = setTimeout(function() {
      try {
        dessinerFond();
      } catch (e) {
      }
    }, 250);
  }
  var choixFond = document.getElementById("mem-fond");
  if (choixFond) {
    choixFond.value = modeFond;
    choixFond.addEventListener("change", function() {
      // Note, link and comet colours are picked once per page load from `estClair` (the mode at
      // load time): switching to or from "Light" here updates the scene gradient and the glow at
      // once, and the rest catches up on the next load (same preset either way, since the view is
      // saved on the instance). Re-deriving every colour live would need touching every mesh.
      modeFond = fondValide(choixFond.value);
      garderReglage("fond", modeFond);
      try {
        dessinerFond();
      } catch (e) {
      }
      appliquerLueur();
    });
  }
  try {
    dessinerFond();
  } catch (e) {
    graphe.scene().background = new THREE.Color("#04120F");
  }
  var bloom = null;
  try {
    var composer = graphe.postProcessingComposer();
    [composer.renderTarget1, composer.renderTarget2].forEach(function(rt) {
      if (rt && "samples" in rt) {
        rt.samples = 4;
        rt.dispose();
      }
    });
    // Background as a scene colour, not only the renderer's clear colour. With a bloom pass the
    // scene is drawn into the composer's linear render target, but RenderPass clears it with the
    // clear colour cached by the previous frame's final pass (which ran on the screen, so it was
    // stored as sRGB); the output pass then encodes it to sRGB a second time and the background
    // came out washed-out teal (#224B45 instead of #04120F). A scene background is converted for
    // whichever target is current, so it is right both through the composer and without it.
    // (dessinerFond, just above, sets it: a colour, or a texture declared sRGB.)
    bloom = new MG.UnrealBloomPass(new THREE.Vector2(el.clientWidth, el.clientHeight), 0.8, 0.28, 0.58);
    composer.addPass(bloom);
  } catch (e) {
    bloom = null;
  }
  var curseurLueur = document.getElementById("mem-lueur");
  var lueur = parseFloat(lireReglage("lueur", "0.9"));
  if (!(lueur >= 0 && lueur <= 2)) lueur = 0.9;
  // On "Light" the background itself is near-white (up to ≈0.93 relative luminance): left at the
  // base threshold (0.58) it would bloom, washing the whole scene out. FONDS.clair instead raises
  // the threshold above it and cuts the strength to a trace (seuilLueur, coefLueur) — reapplied
  // here and on every change of Background or of the Glow slider, so it always matches the CURRENT
  // preset (unlike note/link colours, this needs no mesh to be touched).
  function appliquerLueur() {
    if (!bloom) return;
    var p = FONDS[modeFond] || FONDS.profond;
    bloom.threshold = typeof p.seuilLueur === "number" ? p.seuilLueur : 0.58;
    bloom.strength = lueur * (typeof p.coefLueur === "number" ? p.coefLueur : 1);
  }
  appliquerLueur();
  if (curseurLueur) {
    curseurLueur.value = lueur;
    curseurLueur.disabled = !bloom;
    curseurLueur.addEventListener("input", function() {
      var v = parseFloat(curseurLueur.value);
      if (!(v >= 0 && v <= 2)) return;
      garderReglage("lueur", v);
      lueur = v;
      appliquerLueur();
    });
  }
  var controles = graphe.controls();
  var caseRotation = document.getElementById("mem-rotation");
  var tourner = lireReglage("rotation", "1") === "1";
  function appliquerRotation() {
    if (controles) {
      controles.autoRotate = tourner && !reduit;
      controles.autoRotateSpeed = 0.45;
    }
  }
  appliquerRotation();
  if (caseRotation) {
    caseRotation.checked = tourner;
    caseRotation.disabled = reduit;
    caseRotation.addEventListener("change", function() {
      tourner = caseRotation.checked;
      garderReglage("rotation", tourner ? "1" : "0");
      appliquerRotation();
    });
  }
  // Native double-click: empty background only (a bubble under the pointer has its own
  // double-click, which releases it).
  el.addEventListener("dblclick", function() {
    if (!survol) recentrerDepuisFond();
  });
  var repos;
  el.addEventListener("pointerdown", function() {
    if (suivi) suivi.interaction();
    if (!controles || reduit || !tourner) return;
    controles.autoRotate = false;
    clearTimeout(repos);
    repos = setTimeout(appliquerRotation, 12e3);
  });
  var caseSuivre = document.getElementById("mem-suivre");
  var suivre = lireReglage("suivre", "1") === "1";
  var camera = graphe.camera ? graphe.camera() : null;
  suivi = camera && controles && controles.target ? creerSuiviCamera({
    reduit,
    maintenant: function() {
      return performance.now();
    },
    fov: function() {
      return camera.fov;
    },
    aspect: function() {
      return camera.aspect;
    },
    lireCamera: function() {
      return { pos: camera.position, cible: controles.target };
    },
    ecrireCamera: function(p, c) {
      camera.position.set(p.x, p.y, p.z);
      controles.target.set(c.x, c.y, c.z);
      camera.lookAt(c.x, c.y, c.z);
    },
    tousLesPoints: function() {
      return donnees.nodes.filter(function(n) {
        return visible(themeDe(n));
      });
    },
    pauseRotation: function() {
      if (controles) controles.autoRotate = false;
    },
    reprendreRotation: appliquerRotation
  }) : null;
  if (suivi) suivi.activer(suivre);
  if (controles && controles.addEventListener) controles.addEventListener("start", function() {
    if (suivi) suivi.interaction();
  });
  if (caseSuivre) {
    caseSuivre.checked = suivre;
    caseSuivre.disabled = reduit;
    caseSuivre.addEventListener("change", function() {
      suivre = caseSuivre.checked;
      garderReglage("suivre", suivre ? "1" : "0");
      if (suivi) suivi.activer(suivre);
      if (!suivre) appliquerRotation();
    });
  }
  function noeudsPour(ids) {
    var notes = ids.map(function(id) {
      return parId[id];
    }).filter(function(n) {
      return n && visible(themeDe(n));
    });
    var parNote = notes.length === 1 ? 6 : 1, vus = {}, out = [];
    notes.forEach(function(n) {
      vus[n.id] = 1;
      out.push(n);
    });
    notes.forEach(function(n) {
      if (typeof n.x !== "number") return;
      voisinsDe(n.id).map(function(id) {
        return parId[id];
      }).filter(function(v) {
        return v && !vus[v.id] && typeof v.x === "number" && visible(themeDe(v));
      }).sort(function(a, b) {
        return Math.hypot(a.x - n.x, a.y - n.y, a.z - n.z) - Math.hypot(b.x - n.x, b.y - n.y, b.z - n.z);
      }).slice(0, parNote).forEach(function(v) {
        vus[v.id] = 1;
        out.push(v);
      });
    });
    return out.slice(0, 60);
  }
  var choixNoms = document.getElementById("mem-noms");
  if (choixNoms) {
    choixNoms.value = modeNoms;
    choixNoms.addEventListener("change", function() {
      var v = choixNoms.value;
      if (["aucun", "actifs", "tous"].indexOf(v) < 0) return;
      modeNoms = v;
      garderReglage("noms", v);
      graphe.nodeThreeObject(objetNoeud);
    });
  }
  var choixTaille = document.getElementById("mem-taille");
  if (choixTaille) {
    choixTaille.value = modeTaille;
    choixTaille.addEventListener("change", function() {
      var v = choixTaille.value;
      if (["liens", "jetons"].indexOf(v) < 0) return;
      modeTaille = v;
      garderReglage("taille", v);
      redimensionnerBulles();
      graphe.d3ReheatSimulation();
    });
  }
  // Language: i18n.js owns detection/loading; here it is just another saved setting (VIEW_SETTINGS
  // "langue"), kept in sync with the page's actual language (i18n.js may have picked a different
  // one than the saved value if the browser's language changed, or on first visit).
  var choixLangue = document.getElementById("mem-langue");
  if (choixLangue) {
    var I18N = window.MemglowI18n;
    choixLangue.value = I18N ? I18N.lang() : lireReglage("langue", "en");
    choixLangue.addEventListener("change", function() {
      garderReglage("langue", choixLangue.value);
      if (I18N) I18N.setLanguage(choixLangue.value);
    });
    document.addEventListener("memglow:language", function(e) {
      var lang = e.detail && e.detail.lang;
      if (lang && choixLangue.value !== lang) choixLangue.value = lang;
    });
  }
  // Sliders that do not touch the simulation: signal speed, name distance (applied by vivre()).
  function brancherSimple(id, cle, valeur, appliquer2) {
    var c = document.getElementById(id);
    if (!c) return;
    c.value = valeur;
    c.addEventListener("input", function() {
      var v = parseFloat(c.value);
      if (!isFinite(v)) return;
      garderReglage(cle, v);
      appliquer2(v);
    });
  }
  brancherSimple("mem-vitesse", "vitesse", vitesse, function(v) {
    vitesse = Math.min(VITESSE_MAX, Math.max(VITESSE_MIN, v));
  });
  brancherSimple("mem-dist-noms", "distNoms", distNoms, function(v) {
    distNoms = Math.min(20, Math.max(1, v));
  });
  var caseFixer = document.getElementById("mem-fixer");
  function libererTout() {
    donnees.nodes.concat(listeRelais).forEach(function(n) {
      n.fx = n.fy = n.fz = void 0;
    });
    graphe.d3ReheatSimulation();
  }
  if (caseFixer) {
    caseFixer.checked = fixer;
    caseFixer.addEventListener("change", function() {
      fixer = caseFixer.checked;
      garderReglage("fixer", fixer ? "1" : "0");
      if (!fixer) libererTout();
    });
  }
  var boutonLiberer = document.getElementById("mem-liberer");
  if (boutonLiberer) boutonLiberer.addEventListener("click", libererTout);
  var boutonRecentrer = document.getElementById("mem-recentrer");
  function recentrer() {
    if (suivi) suivi.interaction();
    graphe.zoomToFit(reduit ? 0 : 900, 40);
    planifierCamera();
  }
  if (boutonRecentrer) boutonRecentrer.addEventListener("click", recentrer);

  // ---- Saved layout and camera (the instance's view, see chargerVue) ----
  // Restore: positions set on the nodes BEFORE the simulation (seedPositions, top of file), pinned
  // bubbles pinned again, new notes put near their sub-theme bubble or their group's centre; the
  // simulation restarts "warm" (fast decay) so the view holds. Reduced motion: computed without
  // animation (no intermediate frames), camera set at once.
  // Save: end of the simulation, a bubble dragged, the end of a camera gesture (grouped, 2 s); and
  // when the page is closed or hidden (keepalive request).
  var DECROISSANCE_ALPHA = 0.0228; // d3 default: ≈ 300 steps
  var restaurationEnCours = false, apresReorganiser = false;
  var minuterieDispo = null, minuterieCamera = null, dispoSale = false, derniereCamera = "";
  function tripletOk(t) {
    return Array.isArray(t) && t.length === 3 && t.every(function(x) { return typeof x === "number" && isFinite(x); });
  }
  function repliPosition(n) {
    var r = !n.__relais && relaisDe(n);
    if (r && typeof r.x === "number" && isFinite(r.x)) return r;
    return grouper ? centreDe(themeDe(n)) : null;
  }
  function restaurerDisposition(noeuds) {
    if (!dispoDepart || !dispoDepart.positions || typeof dispoDepart.positions !== "object") return;
    var r = seedPositions(noeuds, dispoDepart, repliPosition, 3 * ecart);
    if (!r.restored) return;
    restaurationEnCours = true;
    if (reduit) graphe.warmupTicks(60).cooldownTicks(0); // computed at once, nothing animated
    else graphe.d3AlphaDecay(0.1); // ≈ 65 steps instead of 300: the view holds
  }
  function cleCamera() {
    if (!camera || !controles || !controles.target) return "";
    var p = camera.position, t = controles.target;
    return [p.x, p.y, p.z, t.x, t.y, t.z].map(function(x) { return Math.round(x * 10) / 10; }).join(",");
  }
  function restaurerCamera() {
    var c = dispoDepart && dispoDepart.camera;
    if (!c || !tripletOk(c.position) || !tripletOk(c.target) || !camera || !controles || !controles.target) return;
    // After the library's first update (which moves the camera back according to the number of
    // notes if it has not moved); no transition: the view is found again as it was.
    setTimeout(function() {
      camera.position.set(c.position[0], c.position[1], c.position[2]);
      controles.target.set(c.target[0], c.target[1], c.target[2]);
      camera.lookAt(c.target[0], c.target[1], c.target[2]);
      if (controles.update) controles.update();
      derniereCamera = cleCamera();
    }, 60);
  }
  function corpsDisposition() {
    var d = layoutOf(listeRelais.concat(donnees.nodes), 2000), cam = null;
    if (camera && controles && controles.target) {
      var p = camera.position, t = controles.target, r = function(x) { return Math.round(x * 100) / 100; };
      cam = { position: [r(p.x), r(p.y), r(p.z)], target: [r(t.x), r(t.y), r(t.z)] };
    }
    return { positions: d.positions, pinned: d.pinned, camera: cam };
  }
  function envoyerDisposition(garder) {
    clearTimeout(minuterieDispo);
    clearTimeout(minuterieCamera);
    if (!donnees.nodes.length || restaurationEnCours) return;
    if (!dispoSale && cleCamera() === derniereCamera) return;
    var corps = corpsDisposition();
    if (!Object.keys(corps.positions).length) return;
    dispoSale = false;
    derniereCamera = cleCamera();
    var texte = JSON.stringify(corps);
    ecrireLocal(CLE_DISPO, texte);
    // keepalive caps the body at 64 KB: above that (a huge memory), a normal request.
    envoyerVue(corps, garder === true && texte.length < 60000);
  }
  function planifierDisposition() {
    dispoSale = true;
    clearTimeout(minuterieDispo);
    minuterieDispo = setTimeout(envoyerDisposition, 2000);
  }
  function planifierCamera() {
    clearTimeout(minuterieCamera);
    minuterieCamera = setTimeout(envoyerDisposition, 2000);
  }
  // Called by onEngineStop (see where the graph is created).
  function finSimulation() {
    if (restaurationEnCours) {
      restaurationEnCours = false;
      graphe.d3AlphaDecay(DECROISSANCE_ALPHA).warmupTicks(0).cooldownTicks(Infinity);
    }
    if (apresReorganiser) {
      apresReorganiser = false;
      graphe.zoomToFit(reduit ? 0 : 900, 40);
    }
    planifierDisposition();
  }
  // "Rearrange": layout and pinned bubbles cleared (instance + local cache), simulation restarted
  // from scratch; settings stay. The new layout is saved when the simulation ends.
  function reorganiser() {
    donnees.nodes.concat(listeRelais).forEach(function(n) {
      n.x = n.y = n.z = NaN; // d3 places nodes without a position (NaN) as on the first day
      n.vx = n.vy = n.vz = 0;
      n.fx = n.fy = n.fz = void 0;
    });
    ecrireLocal(CLE_DISPO, null);
    clearTimeout(minuterieDispo);
    clearTimeout(minuterieCamera);
    dispoSale = false;
    envoyerVue({ reset: true });
    restaurationEnCours = false;
    graphe.d3AlphaDecay(DECROISSANCE_ALPHA).warmupTicks(0).cooldownTicks(Infinity);
    apresReorganiser = true;
    if (suivi) suivi.interaction();
    graphe.graphData(vue());
  }
  var boutonReorganiser = document.getElementById("mem-reorganiser");
  if (boutonReorganiser) boutonReorganiser.addEventListener("click", reorganiser);
  // End of a camera gesture (drag, wheel, pinch): saved 2 s later.
  if (controles && controles.addEventListener) controles.addEventListener("end", planifierCamera);
  // Page closed or sent to the background (phone): a last request, which outlives the page.
  function toutEnvoyer() {
    envoyerReglages(true);
    envoyerDisposition(true);
  }
  if (window.addEventListener) window.addEventListener("pagehide", toutEnvoyer);
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) toutEnvoyer();
  });
  var filtres = document.querySelectorAll(".mem-filtre");
  function majFiltres() {
    Array.prototype.forEach.call(filtres, function(b) {
      b.setAttribute("aria-pressed", visible(b.getAttribute("data-theme")) ? "true" : "false");
    });
  }
  Array.prototype.forEach.call(filtres, function(b) {
    b.addEventListener("click", function() {
      var d = b.getAttribute("data-theme");
      if (masques[d]) delete masques[d];
      else masques[d] = true;
      garderMasques();
      majFiltres();
      placerNomsThemes();
      graphe.nodeVisibility(graphe.nodeVisibility()).linkVisibility(graphe.linkVisibility());
    });
  });
  majFiltres();
  // Legend behind the "Themes" chip on a phone (setupLegendFold, top of this file).
  var plierLegende = setupLegendFold({
    details: document.getElementById("mem-legende-dd"), compact: compact,
    read: lireLocal, write: ecrireLocal,
  });
  if (plierLegende) {
    if (mqlCompact && mqlCompact.addEventListener) mqlCompact.addEventListener("change", plierLegende);
    else if (window.addEventListener) window.addEventListener("resize", plierLegende);
  }
  var formCherche = document.getElementById("mem-cherche");
  var champCherche = document.getElementById("mem-cherche-champ");
  // Search behind the magnifier on a phone (setupSearchFold); folded again after a choice.
  var plierCherche = setupSearchFold({
    button: document.getElementById("mem-cherche-ouvrir"), form: formCherche, field: champCherche, compact: compact,
    later: function(fn, ms) { return setTimeout(fn, ms); },
    active: function() { return document.activeElement; },
  });
  function remplirListe() {
    var dl = document.getElementById("mem-cherche-liste");
    if (!dl) return;
    dl.textContent = "";
    donnees.nodes.map(function(n) {
      return n.label;
    }).sort().forEach(function(l) {
      var o = document.createElement("option");
      o.value = l;
      dl.appendChild(o);
    });
  }
  function trouver(q) {
    q = String(q || "").trim().toLowerCase();
    if (!q) return null;
    var exact = null, partiel = null;
    donnees.nodes.forEach(function(n) {
      var a = String(n.label).toLowerCase(), b = String(n.id).toLowerCase();
      if (a === q || b === q) exact = exact || n;
      else if (!partiel && (a.indexOf(q) >= 0 || b.indexOf(q) >= 0)) partiel = n;
    });
    return exact || partiel;
  }
  if (formCherche && champCherche) {
    formCherche.addEventListener("submit", function(e) {
      e.preventDefault();
      var n = trouver(champCherche.value);
      if (!n) {
        champCherche.setCustomValidity(T("search.noMatch"));
        champCherche.reportValidity();
        return;
      }
      champCherche.setCustomValidity("");
      if (!visible(themeDe(n))) {
        delete masques[themeDe(n)];
        garderMasques();
        majFiltres();
        graphe.nodeVisibility(graphe.nodeVisibility()).linkVisibility(graphe.linkVisibility());
      }
      activer(n.id, 1);
      ouvrir(n.id, true);
      if (plierCherche && compact()) plierCherche.close(false);
    });
    champCherche.addEventListener("input", function() {
      champCherche.setCustomValidity("");
    });
  }
  function dimensionner() {
    graphe.width(el.clientWidth).height(el.clientHeight);
    planifierFond();
  }
  dimensionner();
  if (window.ResizeObserver) new ResizeObserver(dimensionner).observe(el);
  var donnees = { nodes: [], links: [] };
  var parId = {};
  fetch(el.getAttribute("data-graphe"), { credentials: "same-origin" }).then(function(r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function(g) {
    donnees = { nodes: g.nodes, links: g.links };
    g.nodes.forEach(function(n) {
      parId[n.id] = n;
    });
    recompterDegres(donnees);
    var d = vue();
    restaurerDisposition(d.nodes);
    graphe.graphData(d);
    restaurerCamera();
    compter();
    remplirListe();
    historique(g.activities);
    dire(g.nodes.length ? "" : T("status.noNotes"));
    if (!reduit) requestAnimationFrame(vivre);
    ecouter();
    try {
      document.dispatchEvent(new CustomEvent("memglow:pret"));
    } catch (e) {
    }
  }).catch(function() {
    dire(T("error.loadFailed"));
  });
  function compter() {
    var a = document.getElementById("mem-nb-notes"), b = document.getElementById("mem-nb-liens");
    var wa = document.getElementById("mem-mot-notes"), wb = document.getElementById("mem-mot-liens");
    if (a) a.textContent = appNum(donnees.nodes.length);
    if (b) b.textContent = appNum(donnees.links.length);
    if (wa) wa.textContent = T("stats.notesWord", { n: donnees.nodes.length });
    if (wb) wb.textContent = T("stats.linksWord", { n: donnees.links.length });
  }
  function eclore(id) {
    var n = parId[id];
    if (!n) return;
    n.mtime = Date.now();
    var ancien = n.__mesh;
    graphe.nodeThreeObject(objetNoeud);
    if (reduit) return;
    setTimeout(function() {
      activer(id, 1.2);
      salve(id, 1);
    }, ancien ? 30 : 400);
  }
  function lire(id) {
    activer(id, 1);
    if (themeDe(parId[id]) === "index") return;
    salve(id, 1);
    setTimeout(function() {
      voisinsDe(id).forEach(function(v) {
        activer(v, 0.45, MAINTIEN_VOISIN);
      });
    }, dureeComete(vitesse));
  }
  function chercher(ids) {
    ids.forEach(function(id, i) {
      setTimeout(function() {
        activer(id, 0.85);
        salve(id, 0.8);
      }, i * 70);
    });
  }
  // Journal labels: formatJournalLine (top of file). Removed notes: their theme and title are kept,
  // so the "Note removed" line still shows its group.
  var retirees = {};
  var journalListe = document.getElementById("mem-journal");
  var lignesParDiff = {};
  var ecrituresRecentes = [];
  var FENETRE_LIEN = 15e3;
  function remplirLigne(li, ligne) {
    li.textContent = "";
    var heure = document.createElement("span");
    heure.className = "mem-journal__h";
    heure.textContent = appTime(ligne.t || Date.now());
    var dot = document.createElement("span");
    dot.className = ligne.cible ? "mem-dot mem-dot--cible-" + ligne.cible : "mem-dot mem-dot--" + (ligne.theme || "autre");
    // ACTION · GROUP · NOTE · MACHINE · CHANNEL · TOOL (formatJournalLine); the group is a small
    // tag tinted with its colour (.mem-grp--<theme>, generated with the theme colours). Machine and
    // channel are only present on activity sent by an updated hook/proxy — absent, they are simply
    // skipped (same backward compatibility as formatJournalLine itself). Everything in textContent.
    var f = ligne.format || formatJournalLine({}, NOM_THEME);
    var txt = document.createElement("span");
    txt.className = "mem-journal__txt";
    [f.action, f.group, f.note, f.machine, f.channel, f.source].forEach(function(m, i) {
      if (!m) return;
      if (i > 0) {
        var sep = document.createElement("span");
        sep.className = "mem-journal__sep";
        sep.textContent = " · ";
        txt.appendChild(sep);
      }
      var s = document.createElement("span");
      if (i === 1) s.className = "mem-journal__groupe mem-grp--" + f.theme;
      s.textContent = m;
      txt.appendChild(s);
    });
    txt.setAttribute("title", f.text);
    li.appendChild(heure);
    li.appendChild(dot);
    li.appendChild(txt);
    if (ligne.id && parId[ligne.id]) {
      li.tabIndex = 0;
      li.className = "mem-journal__cliquable";
      li.setAttribute("data-note", ligne.id);
    }
    if (ligne.diff) attacherDiff(li, ligne.diff);
  }
  function attacherDiff(li, diffId) {
    if (!avecCorps || !diffId || !li.getAttribute("data-note")) return;
    li.setAttribute("data-diff", diffId);
    li.classList.add("mem-journal__diff");
    if (!li.querySelector(".mem-journal__badge")) {
      var b = document.createElement("span");
      b.className = "mem-journal__badge";
      b.textContent = T("journal.diffBadge");
      li.appendChild(b);
    }
    lignesParDiff[diffId] = li;
  }
  function journal(ligne) {
    if (!journalListe) return null;
    var vide = journalListe.querySelector(".mem-journal__vide");
    if (vide) vide.remove();
    var li = document.createElement("li");
    remplirLigne(li, ligne);
    journalListe.insertBefore(li, journalListe.firstChild);
    while (journalListe.children.length > 14) journalListe.removeChild(journalListe.lastChild);
    return li;
  }
  function ouvrirDepuisLigne(li) {
    if (li && li.getAttribute("data-note")) ouvrir(li.getAttribute("data-note"), true, li.getAttribute("data-diff"));
  }
  if (journalListe) {
    journalListe.addEventListener("click", function(e) {
      ouvrirDepuisLigne(e.target.closest && e.target.closest("li[data-note]"));
    });
    journalListe.addEventListener("keydown", function(e) {
      if (e.key === "Enter") ouvrirDepuisLigne(e.target.closest && e.target.closest("li[data-note]"));
    });
  }
  function journalChangement(evt) {
    if (evt.diff && evt.type !== "removed") {
      var maintenant = Date.now();
      for (var k = ecrituresRecentes.length - 1; k >= 0; k--) {
        var r = ecrituresRecentes[k];
        if (r.id === evt.id && maintenant - r.t <= FENETRE_LIEN && r.li.isConnected) {
          attacherDiff(r.li, evt.diff);
          ecrituresRecentes.splice(k, 1);
          return;
        }
      }
    }
    // A removed note has no node in the event: its theme is the one we knew.
    var connu = evt.node || parId[evt.id] || retirees[evt.id];
    var theme = connu ? themeDe(connu) : "other";
    journal({
      id: evt.type === "removed" ? null : evt.id,
      theme: theme,
      diff: evt.diff,
      format: formatJournalLine({
        type: evt.type === "added" || evt.type === "removed" ? evt.type : "changed",
        theme: theme, label: connu && connu.label || evt.id, channel: "file"
      }, NOM_THEME)
    });
  }
  function historique(liste) {
    (liste || []).forEach(function(evt) {
      recevoirActivite(evt, true);
    });
  }
  function recevoirActivite(evt, sansAnimation) {
    var ids = (evt.ids || []).filter(function(id) {
      return parId[id];
    });
    if (!ids.length) return;
    if (!reduit && !sansAnimation) {
      if (evt.type === "read") ids.forEach(lire);
      else if (evt.type === "search") chercher(ids);
      else if (evt.type === "write") ids.forEach(eclore);
      if (suivi) suivi.viser(noeudsPour(ids));
    }
    var seule = ids.length === 1 && themeDe(parId[ids[0]]) !== "index" && CIBLE_COULEUR_ACTIVE[evt.type];
    if (seule && !sansAnimation) cibler(ids[0], evt.type);
    var premier = parId[ids[0]];
    var ligne = {
      id: ids[0],
      t: evt.t,
      theme: themeDe(premier),
      cible: seule ? evt.type : null,
      diff: evt.type === "write" ? evt.diff : null,
      format: formatJournalLine({
        type: evt.type, theme: themeDe(premier), label: premier.label, more: ids.length - 1,
        source: evt.source, machine: evt.machine, channel: evt.channel
      }, NOM_THEME)
    };
    var deja = ligne.diff && lignesParDiff[ligne.diff];
    if (deja && deja.isConnected) {
      remplirLigne(deja, ligne);
      return;
    }
    var li = journal(ligne);
    if (li && evt.type === "write" && !ligne.diff && !sansAnimation) {
      ecrituresRecentes.push({ id: ids[0], t: Date.now(), li });
      if (ecrituresRecentes.length > 20) ecrituresRecentes.shift();
    }
  }
  function appliquer(evt) {
    if (evt.type === "removed") {
      donnees.nodes = donnees.nodes.filter(function(n2) {
        return n2.id !== evt.id;
      });
      donnees.links = donnees.links.filter(function(l) {
        var s = typeof l.source === "object" ? l.source.id : l.source;
        var t = typeof l.target === "object" ? l.target.id : l.target;
        return s !== evt.id && t !== evt.id;
      });
      if (parId[evt.id]) retirees[evt.id] = { label: parId[evt.id].label, theme: parId[evt.id].theme };
      delete parId[evt.id];
    } else if (evt.node) {
      var n = parId[evt.id];
      if (n) {
        n.label = evt.node.label;
        n.description = evt.node.description;
        n.theme = evt.node.theme;
        n.subtheme = evt.node.subtheme;
        n.tokens = evt.node.tokens;
      } else {
        n = evt.node;
        parId[n.id] = n;
        donnees.nodes.push(n);
        // A new note is put near its sub-theme bubble (or its group's centre) rather than at the
        // centre of the scene, so the saved view is not shaken.
        var c = repliPosition(n);
        if (c && isFinite(c.x)) {
          var e = offsetFor(String(n.id), 3 * ecart);
          n.x = c.x + e.x; n.y = c.y + e.y; n.z = c.z + e.z;
        }
      }
      donnees.links = donnees.links.filter(function(l) {
        var s = typeof l.source === "object" ? l.source.id : l.source;
        return s !== evt.id;
      });
      (evt.links || []).forEach(function(l) {
        if (parId[l.target]) donnees.links.push({ source: l.source, target: l.target });
      });
    }
    recompterDegres(donnees);
    graphe.graphData(vue());
    compter();
    remplirListe();
    journalChangement(evt);
    if (evt.type !== "removed") {
      eclore(evt.id);
      if (suivi && !reduit) setTimeout(function() {
        suivi.viser(noeudsPour([evt.id]));
      }, 450);
    }
  }
  function ecouter() {
    if (!window.EventSource) return;
    var src = new EventSource(el.getAttribute("data-flux"));
    src.addEventListener("change", function(m) {
      try {
        appliquer(JSON.parse(m.data));
      } catch (e) {
      }
      // A note changed on disk counts as a write (server counters): Memory cost refreshes too.
      try {
        document.dispatchEvent(new CustomEvent("memglow:changement"));
      } catch (e) {
      }
    });
    src.addEventListener("activity", function(m) {
      try {
        recevoirActivite(JSON.parse(m.data));
      } catch (e) {
      }
      try {
        document.dispatchEvent(new CustomEvent("memglow:activite"));
      } catch (e) {
      }
    });
  }
  document.addEventListener("memglow:ouvrir", function(e) {
    if (e.detail && parId[e.detail]) ouvrir(e.detail, true);
  });
  // Language switched in Settings (or the saved one arrived from another device, see chargerVue
  // above): refresh what app.js itself renders from JS, not data-i18n (i18n.js already re-applies
  // every data-i18n element, incl. the legend). Already-written journal lines and the open panel
  // keep the words they were written with, like a log — only what is redrawn after this point uses
  // the new language.
  document.addEventListener("memglow:language", function() {
    NOM_THEME.index = T("theme.index");
    NOM_THEME.autre = T("theme.note");
    NOM_THEME.other = T("theme.other");
    compter();
  });
  window.__memglowDemo = {
    activite: recevoirActivite,
    noeuds: function() {
      return donnees.nodes;
    },
    relais: function() {
      return listeRelais;
    }
  };
  var panneau = document.getElementById("mem-panneau");
  document.getElementById("mem-fermer").addEventListener("click", function() {
    panneau.hidden = true;
  });
  function ouvrir(id, viser, diffId) {
    var n = parId[id];
    montrerDiff(avecCorps ? diffId : null);
    if (n && viser && typeof n.x === "number") {
      if (suivi) suivi.interaction();
      var d = 90, r = Math.hypot(n.x, n.y, n.z) || 1, k = 1 + d / r;
      graphe.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, n, 1200);
      planifierCamera();
      if (controles) controles.autoRotate = false;
    }
    fetch(URL_NOTE + encodeURIComponent(id), { credentials: "same-origin" }).then(function(r2) {
      if (!r2.ok) throw new Error(r2.status);
      return r2.json();
    }).then(remplir).catch(function() {
    });
  }
  var URL_DIFF = el.getAttribute("data-diff");
  var diffDemande = null;
  function montrerDiff(diffId) {
    var zone = document.getElementById("mem-p-diff");
    if (!zone) return;
    diffDemande = diffId || null;
    zone.hidden = true;
    if (!diffId || !URL_DIFF) return;
    fetch(URL_DIFF + encodeURIComponent(diffId), { credentials: "same-origin" }).then(function(r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function(d) {
      if (diffDemande !== diffId) return;
      document.getElementById("mem-p-diff-meta").textContent = "+" + appNum(d.plus) + " / −" + appNum(d.moins) + " " + T("diff.lineWord", { n: d.plus + d.moins }) + " · " + appDateTime(d.t);
      var ol = document.getElementById("mem-p-diff-lignes");
      ol.textContent = "";
      d.lignes.forEach(function(l) {
        var li = document.createElement("li");
        li.className = "mem-diff__l mem-diff__l--" + ({ "+": "plus", "-": "moins", "@": "sep" }[l[0]] || "ctx");
        li.textContent = (l[0] === "@" ? "" : l[0] === " " ? "  " : l[0] + " ") + l[1];
        ol.appendChild(li);
      });
      zone.hidden = false;
    }).catch(function() {
      if (diffDemande !== diffId) return;
      document.getElementById("mem-p-diff-meta").textContent = T("diff.notFound");
      document.getElementById("mem-p-diff-lignes").textContent = "";
      zone.hidden = false;
    });
  }
  function remplir(f) {
    document.getElementById("mem-p-dossier").textContent = NOM_THEME[themeDe(f)] || T("theme.note");
    document.getElementById("mem-p-titre").textContent = f.label;
    document.getElementById("mem-p-desc").textContent = f.description || "";
    var jours = Math.floor((Date.now() - f.mtime) / 864e5);
    var quand = jours < 1 ? T("common.today") : jours === 1 ? T("common.yesterday") : T("common.daysAgo", { n: jours });
    var nJetons = Math.round(f.tokens);
    var jetons = typeof f.tokens === "number" ? T("panel.tokens", { n: nJetons, show: appNum(nJetons) }) + " · " : "";
    document.getElementById("mem-p-meta").textContent = T("panel.written", { when: quand }) + " · " + jetons +
      T("panel.outgoingLinks", { n: f.outgoing.length }) + ", " + T("panel.incoming", { n: f.incoming.length });
    var zone = document.getElementById("mem-p-liens");
    zone.textContent = "";
    var voisins = f.outgoing.concat(f.incoming.filter(function(x) {
      return f.outgoing.indexOf(x) < 0;
    }));
    voisins.slice(0, 24).forEach(function(id) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mem-lien";
      b.textContent = parId[id] && parId[id].label || id;
      b.addEventListener("click", function() {
        ouvrir(id, true);
      });
      zone.appendChild(b);
    });
    var corps = document.getElementById("mem-p-corps");
    if (avecCorps && typeof f.body === "string") {
      corps.textContent = f.body;
      corps.hidden = false;
    } else {
      corps.textContent = "";
      corps.hidden = true;
    }
    panneau.hidden = false;
    panneau.scrollTop = 0;
  }
  } // end of demarrer()
})();
