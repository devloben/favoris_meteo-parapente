// Exporte et importe les favoris contenu dans le State du Localstoroge

const statusEl = document.getElementById("status");
const btnExport = document.getElementById("btnExport");
const btnImport = document.getElementById("btnImport");
const fileImport = document.getElementById("fileImport");
const selSortImport = document.getElementById("selSortImport");

// Affiche les messages
function setStatus(html) {
  statusEl.innerHTML = html;
}

// Règle unique de sécurité : accepter meteo-parapente.com et www.meteo-parapente.com
function isMeteoParapenteHost(hostname) {
  return (
    typeof hostname === "string" && /\.?meteo-parapente\.com$/.test(hostname)
  );
}

// Récupère l'url de l'onglet actif
async function getActiveMeteoTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return null;

  const url = new URL(tab.url);
  if (!isMeteoParapenteHost(url.hostname)) return null;

  return tab;
}

// Attend la fin réelle du téléchargement (complete / interrupted)
function waitForDownloadEnd(downloadId) {
  return new Promise((resolve, reject) => {
    function onChanged(delta) {
      if (delta.id !== downloadId) return;

      // Terminé
      if (delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ ok: true });
        return;
      }

      // Interrompu (annulation, erreur, etc.)
      if (delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged);

        chrome.downloads.search({ id: downloadId }, (items) => {
          const item = items?.[0];
          const reason = item?.error || "UNKNOWN";

          if (reason === "USER_CANCELED") {
            resolve({ ok: false, canceled: true, reason });
          } else {
            reject(new Error("Download interrupted: " + reason));
          }
        });
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// Export du State du Localstorage en omettant auth
function readLocalStorageInPageSanitized() {
  const out = {};

  function sanitizeState(stateStr) {
    if (typeof stateStr !== "string" || stateStr.trim() === "") return stateStr;
    try {
      const obj = JSON.parse(stateStr);
      if (obj && typeof obj === "object" && "auth" in obj) {
        delete obj.auth;
        return JSON.stringify(obj);
      }
      return stateStr;
    } catch {
      return stateStr;
    }
  }

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;

    // 1) Ne jamais exporter la clé auth
    if (k === "auth") continue;

    let v = localStorage.getItem(k);

    // 2) Si state => supprimer state.auth
    if (k === "state") v = sanitizeState(v);

    out[k] = v;
  }

  return {
    hostname: location.hostname, // ✅ cohérent
    exportedAt: new Date().toISOString(),
    kind: "meteo-parapente-localstorage-no-auth",
    localStorage: out,
  };
}

// Import du State du Localstorage sans auth
// On conserve auth si existant sur l'appareil avec Merge
function writeLocalStorageInPageSanitized(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Payload invalide." };
    }
    if (!payload.localStorage || typeof payload.localStorage !== "object") {
      return { ok: false, error: "Champ localStorage manquant/invalide." };
    }

    const entries = Object.entries(payload.localStorage);

    let written = 0;
    let skippedSensitive = 0;
    let stateMerged = false;

    for (const [k, v] of entries) {
      // Ne jamais écrire auth (sécurité)
      if (k === "auth") {
        skippedSensitive++;
        continue;
      }

      // state => MERGE sans toucher à auth existant
      if (k === "state" && typeof v === "string") {
        try {
          const incoming = JSON.parse(v); // state du fichier (sans auth)
          const currentStr = localStorage.getItem("state");
          const current = currentStr ? JSON.parse(currentStr) : {};

          const merged = { ...current, ...incoming };
          localStorage.setItem("state", JSON.stringify(merged));

          written++;
          stateMerged = true;
          continue;
        } catch {
          return {
            ok: false,
            error:
              "Impossible de parser 'state' (JSON invalide). Import interrompu pour éviter d’écraser auth.",
          };
        }
      }

      // Autres clés : on écrit tel quel
      if (typeof v === "string" || v === null) {
        localStorage.setItem(k, v);
      } else {
        localStorage.setItem(k, JSON.stringify(v));
      }
      written++;
    }

    return {
      ok: true,
      keysWritten: written,
      keysSkippedSensitive: skippedSensitive,
      stateMerged,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Export des favoris
async function exportJson() {
  const tab = await getActiveMeteoTab();
  if (!tab) {
    setStatus(
      `❌ Ouvre un onglet sur <a href="https://meteo-parapente.com" target="_blank" rel="noopener noreferrer">https://meteo-parapente.com</a> puis réessaie.`,
    );
    return;
  }

  setStatus("Lecture du localStorage (sans auth)…");

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readLocalStorageInPageSanitized,
  });

  const result = injected?.[0]?.result;
  if (!result) {
    setStatus(
      "❌ Impossible de lire le stockage. Recharge la page et réessaie.",
    );
    return;
  }

  const jsonStr = JSON.stringify(result, null, 2);
  const ts = result.exportedAt.replace(/[:.]/g, "-");
  const filename = `favoris-meteo-parapente-${ts}.json`;

  const blob = new Blob([jsonStr], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: true,
    });

    const end = await waitForDownloadEnd(downloadId);

    // Annulation utilisateur => rien affiché
    if (!end.ok && end.canceled) {
      setStatus("");
      return;
    }

    setStatus(`✅ Export OK <br>Fichier: ${filename}`);
  } catch (e) {
    setStatus("❌ Téléchargement échoué: " + String(e));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Fonction de tri de A à Z à l'import
function sortFavoritesInStateString(stateStr, direction = "asc") {
  if (typeof stateStr !== "string" || stateStr.trim() === "") return stateStr;

  const stateObj = JSON.parse(stateStr);

  const list = stateObj?.favorites?.list;
  if (!Array.isArray(list)) return stateStr;

  const collator = new Intl.Collator("fr", { sensitivity: "base" });

  stateObj.favorites.list = [...list].sort((a, b) => {
    const an = (a?.name ?? "").toString();
    const bn = (b?.name ?? "").toString();
    const cmp = collator.compare(an, bn);
    return direction === "desc" ? -cmp : cmp;
  });

  return JSON.stringify(stateObj);
}

// Fonction de tri d'Ouest en Est à l'import
function sortFavoritesWestToEastInStateString(stateStr) {
  if (typeof stateStr !== "string" || stateStr.trim() === "") return stateStr;

  const stateObj = JSON.parse(stateStr);
  const list = stateObj?.favorites?.list;
  if (!Array.isArray(list)) return stateStr;

  stateObj.favorites.list = [...list].sort((a, b) => {
    const lonA = Number(a?.state?.center?.lon);
    const lonB = Number(b?.state?.center?.lon);

    const aOk = Number.isFinite(lonA);
    const bOk = Number.isFinite(lonB);

    // Si un favori n'a pas de lon, on le pousse à la fin
    if (!aOk && !bOk) return 0;
    if (!aOk) return 1;
    if (!bOk) return -1;

    return lonA - lonB; // Ouest -> Est
  });

  return JSON.stringify(stateObj);
}

// Import des favoris
async function importJson() {
  const tab = await getActiveMeteoTab();
  if (!tab) {
    setStatus(
      "❌ Ouvre un onglet sur https://meteo-parapente.com puis réessaie.",
    );
    return;
  }

  const file = fileImport.files?.[0];
  if (!file) {
    setStatus("❌ Choisis un fichier JSON d’export d’abord.");
    return;
  }

  setStatus("Lecture du fichier…");

  const text = await file.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    setStatus("❌ JSON invalide.");
    return;
  }

  if (!payload || typeof payload !== "object") {
    setStatus("❌ Fichier invalide.");
    return;
  }

  if (!payload.hostname || typeof payload.hostname !== "string") {
    setStatus("❌ Fichier invalide : hostname manquant.");
    return;
  }

  if (!isMeteoParapenteHost(payload.hostname)) {
    setStatus(
      `❌ Ce fichier provient de : ${payload.hostname}<br>` +
        `Seuls les exports meteo-parapente.com sont acceptés.`,
    );
    return;
  }

  if (!payload.localStorage || typeof payload.localStorage !== "object") {
    setStatus("❌ Fichier invalide : champ localStorage manquant.");
    return;
  }

  setStatus("Écriture dans le localStorage (sans auth)…");

  // Tri à l'import
  const mode = selSortImport?.value ?? "none";

  try {
    const stateStr = payload?.localStorage?.state;
    if (typeof stateStr === "string") {
      if (mode === "az")
        payload.localStorage.state = sortFavoritesInStateString(
          stateStr,
          "asc",
        );
      if (mode === "w2e")
        payload.localStorage.state =
          sortFavoritesWestToEastInStateString(stateStr);
    }
  } catch {
    // si erreur => import tel quel
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: writeLocalStorageInPageSanitized,
    args: [payload],
  });

  const result = injected?.[0]?.result;

  if (!result?.ok) {
    setStatus(`❌ Import échoué: ${result?.error ?? "Erreur inconnue"}`);
    return;
  }

  await chrome.tabs.reload(tab.id);

  const label =
    mode === "az" ? "A → Z" : mode === "w2e" ? "Ouest → Est" : "désactivé";

  setStatus(`✅ Import OK<br>` + `Tri: ${label}<br>`);
}

btnExport.addEventListener("click", () => {
  exportJson().catch((e) => setStatus("❌ Erreur export: " + String(e)));
});

btnImport.addEventListener("click", () => {
  importJson().catch((e) => setStatus("❌ Erreur import: " + String(e)));
});
