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
var CIBLE_COULEUR = { read: "#4DEBFF", write: "#FF4D2E", search: "#C9A6FF" };
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
if (typeof module !== "undefined" && module.exports) module.exports = { creerSuiviCamera, creerEnveloppe, creerCometes, hauteurPanneau, creerCible, CIBLE_COULEUR };
(function() {
  "use strict";
  if (typeof document === "undefined") return;
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
    dire("The graph library could not load.");
    return;
  }
  function lireReglage(cle, defaut) {
    try {
      var v = localStorage.getItem("memglow." + cle);
      return v === null ? defaut : v;
    } catch (e) {
      return defaut;
    }
  }
  function garderReglage(cle, v) {
    try {
      localStorage.setItem("memglow." + cle, String(v));
    } catch (e) {
    }
  }
  var modeNoms = lireReglage("noms", "aucun");
  if (["aucun", "actifs", "tous"].indexOf(modeNoms) < 0) modeNoms = "aucun";
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
  var COULEUR = { index: "#FFFFFF", autre: "#A9C9BF", other: "#A9C9BF" };
  var NOM_THEME = { index: "Index", autre: "Note", other: "Other" };
  var ORDRE_THEMES = [];
  (CFG.themes || []).forEach(function(t) {
    COULEUR[t.id] = t.color;
    NOM_THEME[t.id] = t.label;
    ORDRE_THEMES.push(t.id);
  });
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
    var c = new THREE.Color(COULEUR[themeDe(n)] || COULEUR.autre);
    var e = eclat(n);
    c.multiplyScalar(0.25 + 0.95 * e);
    var m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c.clone(), transparent: true, opacity: 0.55 + 0.45 * e }));
    var r = themeDe(n) === "index" ? 6 : 1.6 + Math.sqrt(degre[n.id] || 0) * 0.9;
    m.scale.setScalar(r);
    m.userData.rayon = r;
    m.userData.base = c;
    m.userData.opacite = 0.55 + 0.45 * e;
    if (n.__phase === void 0) n.__phase = Math.random() * Math.PI * 2;
    n.__mesh = m;
    n.__nom = null;
    if (modeNoms === "aucun") return m;
    var g = new THREE.Group();
    g.add(m);
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
    var r = 3.4;
    m.scale.setScalar(r);
    m.userData.rayon = r;
    m.userData.base = base;
    m.userData.opacite = 0.55;
    if (n.__phase === void 0) n.__phase = Math.random() * Math.PI * 2;
    n.__mesh = m;
    var g = new THREE.Group();
    g.add(m);
    var s = spriteTexte(n.label, COULEUR[n.theme] || COULEUR.autre, 30, 700, 4.4);
    s.position.y = r + 3.6;
    g.add(s);
    return g;
  }
  function spriteNom(texte) {
    return spriteTexte(texte, "#EAF4F0", 40, 600, 4.2);
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
    couleursCible[k] = new THREE.Color(CIBLE_COULEUR[k]);
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
    var hex = CIBLE_COULEUR[type];
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
    if (!n || themeDe(n) === "index" || !CIBLE_COULEUR[type]) return;
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
      for (var i = 0; i < tous.length; i++) {
        var n = tous[i], m = n.__mesh;
        if (!m) continue;
        var act = n.__env ? enveloppe.niveau(n, t) : 0;
        if (act > 0 && enveloppe.phase(n, t) === "maintien") act *= 1 + 0.08 * Math.sin(t * 6e-3 + n.__phase);
        if (n.__env && enveloppe.finie(n, t)) n.__env = null;
        n.__act = act;
        var souffle = 1 + 0.07 * Math.sin(t * 11e-4 + n.__phase);
        m.scale.setScalar(m.userData.rayon * (souffle + 1.6 * act));
        var mat = m.material;
        if (act) mat.color.copy(m.userData.base).lerp(BLANC, Math.min(0.85, act * 0.8));
        else if (!mat.color.equals(m.userData.base)) mat.color.copy(m.userData.base);
        mat.opacity = Math.min(1, m.userData.opacite + act * 0.5);
        if (n.__cible) {
          var stc = cible.etat(n, t, false);
          if (stc) colorerCible(n, stc);
        }
        if (n.__nom && modeNoms === "actifs") n.__nom.visible = act > 0.06;
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
  var FOND_RVB = [4 / 255, 18 / 255, 15 / 255];
  var couleursComete = {};
  function couleurComete(n) {
    var th = themeDe(n);
    if (!couleursComete[th]) {
      var c = new THREE.Color(COULEUR[th] || COULEUR.autre).lerp(BLANC, 0.45);
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
  var TETE = 1.6;
  function fabriqueComete(groupe) {
    return function() {
      var geo2 = new THREE.BufferGeometry();
      var posA = new THREE.BufferAttribute(new Float32Array(14 * 3), 3);
      var colA = new THREE.BufferAttribute(new Float32Array(14 * 3), 3);
      geo2.setAttribute("position", posA);
      geo2.setAttribute("color", colA);
      var ligne = new THREE.Line(geo2, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      ligne.frustumCulled = false;
      var tete = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      tete.frustumCulled = false;
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
          couleurTete.setRGB(col[3 * (n - 1)], col[3 * (n - 1) + 1], col[3 * (n - 1) + 2]).lerp(BLANC, 0.35);
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
  function salve(id, eclatSalve) {
    if (!cometes || reduit) return;
    var n = parId[id];
    if (!montre(n) || themeDe(n) === "index") return;
    liensDe(id).forEach(function(l) {
      var a = noeudDe(l.source), b = noeudDe(l.target);
      var vers = a && a.id === id ? b : a;
      if (!montre(vers)) return;
      enveloppe.activer(l, eclatSalve || 1, 1200, performance.now());
      cometes.lancer(n, vers, couleurComete(n), { duree: 950 + Math.random() * 150, eclat: eclatSalve || 1 });
    });
  }
  var REPOS_LIENS = {
    masques: { intra: 0, inter: 0, relais: 0.12 },
    discrets: { intra: 0.07, inter: 0.025, relais: 0.14 },
    visibles: { intra: 0.3, inter: 0.15, relais: 0.2 }
  };
  var modeLiens = lireReglage("liens", "discrets");
  if (!REPOS_LIENS[modeLiens]) modeLiens = "discrets";
  var GRIS_LIEN = new THREE.Color("#A9C9BF");
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
      var bouts = Math.max(a.__act || 0, b.__act || 0) * (l.__relais ? 0.45 : 0.85);
      var niv = Math.min(1, Math.max(propre, bouts));
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
  var panneauOptions = document.getElementById("mem-options");
  var corpsOptions = document.getElementById("mem-options-corps");
  function bornerPanneau() {
    if (!panneauOptions || !corpsOptions || !panneauOptions.open) return;
    if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
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
      enveloppe.activer(l, 0.35, 2600, t);
      cometes.lancer(
        sens ? a : b,
        sens ? b : a,
        couleurComete(sens ? a : b),
        { duree: 2600, eclat: 0.5, taille: 0.7, lent: true, cle }
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
      return cleRelais(n) === r.theme + "/" + r.subtheme;
    });
  }
  var fixer = lireReglage("fixer", "1") === "1";
  var masques = {};
  try {
    masques = JSON.parse(lireReglage("masquesThemes", "{}")) || {};
  } catch (e) {
    masques = {};
  }
  Object.keys(masques).forEach(function(k) {
    if (["famille", "pro", "maison", "tech", "archives", "index", "autre"].indexOf(k) < 0) delete masques[k];
  });
  function visible(theme) {
    return !masques[theme || "autre"];
  }
  function garderMasques() {
    garderReglage("masquesThemes", JSON.stringify(masques));
  }
  var dernierClic = { id: null, t: 0 };
  var tics = 0;
  function liberer(n) {
    n.fx = n.fy = n.fz = void 0;
    if (graphe) graphe.d3ReheatSimulation();
  }
  var graphe;
  try {
    graphe = MG.ForceGraph3D({ controlType: "orbit" })(el).backgroundColor("#04120F").showNavInfo(false).nodeId("id").nodeThreeObject(objetNoeud).nodeLabel(function(n) {
      if (n.__relais) {
        return '<div class="mem-bulle"><strong>' + esc(n.label) + "</strong><br>" + esc(NOM_THEME[n.theme] || "") + " · " + n.nb + " note" + (n.nb > 1 ? "s" : "") + "</div>";
      }
      return '<div class="mem-bulle"><strong>' + esc(n.label) + "</strong>" + (n.description ? "<br>" + esc(n.description) : "") + "</div>";
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
    }).onEngineTick(function() {
      if (++tics % 8 === 0) placerNomsThemes();
    }).onEngineStop(function() {
      placerNomsThemes();
      if (reduit) majLiens(performance.now());
    }).onNodeHover(function() {
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
      allumerLiens(n.id, 0.9, MAINTIEN_NOTE);
      ouvrir(n.id, true);
    });
  } catch (e) {
    dire("Your browser cannot display 3D here (WebGL unavailable).");
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
  var noeudsCollision = [];
  function rayonDe(n) {
    var m = n.__mesh;
    if (m && m.userData && m.userData.rayon) return m.userData.rayon;
    return n.__relais ? 3.4 : themeDe(n) === "index" ? 6 : 2;
  }
  function forceCollision() {
    var nb = noeudsCollision.length;
    for (var i = 0; i < nb; i++) {
      var a = noeudsCollision[i], ra = rayonDe(a);
      var ax = a.x + a.vx, ay = a.y + a.vy, az = a.z + a.vz;
      for (var j = i + 1; j < nb; j++) {
        var b = noeudsCollision[j];
        var dx = b.x + b.vx - ax, dy = b.y + b.vy - ay, dz = b.z + b.vz - az;
        var min = ra + rayonDe(b) + marge;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= min * min) continue;
        if (d2 === 0) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dz = Math.random() - 0.5;
          d2 = dx * dx + dy * dy + dz * dz;
        }
        var d = Math.sqrt(d2), p = (min - d) / d * 0.35;
        dx *= p;
        dy *= p;
        dz *= p;
        a.vx -= dx;
        a.vy -= dy;
        a.vz -= dz;
        b.vx += dx;
        b.vy += dy;
        b.vz += dz;
      }
    }
  }
  forceCollision.initialize = function(nodes) {
    noeudsCollision = nodes || [];
  };
  graphe.d3Force("collision", forceCollision);
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
    graphe.scene().background = new THREE.Color("#04120F");
    bloom = new MG.UnrealBloomPass(new THREE.Vector2(el.clientWidth, el.clientHeight), 0.8, 0.28, 0.58);
    composer.addPass(bloom);
  } catch (e) {
    bloom = null;
  }
  var curseurLueur = document.getElementById("mem-lueur");
  var lueur = parseFloat(lireReglage("lueur", "0.9"));
  if (!(lueur >= 0 && lueur <= 2)) lueur = 0.9;
  if (bloom) bloom.strength = lueur;
  if (curseurLueur) {
    curseurLueur.value = lueur;
    curseurLueur.disabled = !bloom;
    curseurLueur.addEventListener("input", function() {
      var v = parseFloat(curseurLueur.value);
      if (!(v >= 0 && v <= 2)) return;
      garderReglage("lueur", v);
      if (bloom) bloom.strength = v;
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
  if (boutonRecentrer) boutonRecentrer.addEventListener("click", function() {
    if (suivi) suivi.interaction();
    graphe.zoomToFit(reduit ? 0 : 900, 40);
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
  var formCherche = document.getElementById("mem-cherche");
  var champCherche = document.getElementById("mem-cherche-champ");
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
        champCherche.setCustomValidity("No matching note.");
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
    });
    champCherche.addEventListener("input", function() {
      champCherche.setCustomValidity("");
    });
  }
  function dimensionner() {
    graphe.width(el.clientWidth).height(el.clientHeight);
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
    graphe.graphData(vue());
    compter();
    remplirListe();
    historique(g.activities);
    dire(g.nodes.length ? "" : "No notes yet.");
    if (!reduit) requestAnimationFrame(vivre);
    ecouter();
    try {
      document.dispatchEvent(new CustomEvent("memglow:pret"));
    } catch (e) {
    }
  }).catch(function() {
    dire("Could not load the memory. Reload the page.");
  });
  function compter() {
    var a = document.getElementById("mem-nb-notes"), b = document.getElementById("mem-nb-liens");
    if (a) a.textContent = donnees.nodes.length;
    if (b) b.textContent = donnees.links.length;
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
    }, 950);
  }
  function chercher(ids) {
    ids.forEach(function(id, i) {
      setTimeout(function() {
        activer(id, 0.85);
        salve(id, 0.8);
      }, i * 70);
    });
  }
  var LIBELLE_ACTIVITE = { read: "Read", search: "Search", write: "Write" };
  var LIBELLE_SOURCE = {};
  var journalListe = document.getElementById("mem-journal");
  var lignesParDiff = {};
  var ecrituresRecentes = [];
  var FENETRE_LIEN = 15e3;
  function remplirLigne(li, ligne) {
    li.textContent = "";
    var heure = document.createElement("span");
    heure.className = "mem-journal__h";
    heure.textContent = new Date(ligne.t || Date.now()).toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var dot = document.createElement("span");
    dot.className = ligne.cible ? "mem-dot mem-dot--cible-" + ligne.cible : "mem-dot mem-dot--" + (ligne.theme || "autre");
    var txt = document.createElement("span");
    txt.textContent = ligne.texte;
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
      b.textContent = "± voir";
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
    var quoi = evt.type === "added" ? "New note" : evt.type === "removed" ? "Note removed" : "Note changed";
    journal({
      id: evt.type === "removed" ? null : evt.id,
      theme: evt.node && themeDe(evt.node),
      diff: evt.diff,
      texte: quoi + " · " + (evt.node && evt.node.label || evt.id)
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
    var seule = ids.length === 1 && themeDe(parId[ids[0]]) !== "index" && CIBLE_COULEUR[evt.type];
    if (seule && !sansAnimation) cibler(ids[0], evt.type);
    var premier = parId[ids[0]];
    var qui = premier.label + (ids.length > 1 ? " +" + (ids.length - 1) : "");
    var ligne = {
      id: ids[0],
      t: evt.t,
      theme: themeDe(premier),
      cible: seule ? evt.type : null,
      diff: evt.type === "write" ? evt.diff : null,
      texte: (LIBELLE_ACTIVITE[evt.type] || "Activity") + " · " + qui + " · " + (LIBELLE_SOURCE[evt.source] || evt.source || "")
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
      delete parId[evt.id];
    } else if (evt.node) {
      var n = parId[evt.id];
      if (n) {
        n.label = evt.node.label;
        n.description = evt.node.description;
        n.theme = evt.node.theme;
        n.subtheme = evt.node.subtheme;
      } else {
        n = evt.node;
        parId[n.id] = n;
        donnees.nodes.push(n);
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
      document.getElementById("mem-p-diff-meta").textContent = "+" + d.plus + " / −" + d.moins + " line" + (d.plus + d.moins > 1 ? "s" : "") + " · " + new Date(d.t).toLocaleString(void 0, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
      document.getElementById("mem-p-diff-meta").textContent = "Change not found.";
      document.getElementById("mem-p-diff-lignes").textContent = "";
      zone.hidden = false;
    });
  }
  function remplir(f) {
    document.getElementById("mem-p-dossier").textContent = NOM_THEME[themeDe(f)] || "Note";
    document.getElementById("mem-p-titre").textContent = f.label;
    document.getElementById("mem-p-desc").textContent = f.description || "";
    var jours = Math.floor((Date.now() - f.mtime) / 864e5);
    document.getElementById("mem-p-meta").textContent = "Written " + (jours < 1 ? "today" : jours === 1 ? "yesterday" : jours + " days ago") + " · " + f.outgoing.length + " outgoing link" + (f.outgoing.length > 1 ? "s" : "") + ", " + f.incoming.length + " incoming";
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
})();
