 // addon.js — SKTorrent Stremio addon (verzia 1.3.0)
// Zjednotený stream handler pre IMDb a TMDB s pokročilými fallbackmi
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const parseTorrent = require("parse-torrent-file");
const bencode = require("bncode");
const crypto = require("crypto");

// Prihlasovacie údaje na SKTorrent
const SKT_UID = process.env.SKT_UID;
const SKT_PASS = process.env.SKT_PASS;
const TMDB_API_KEY = process.env.TMDB_API_KEY;


const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.0.0",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (filmy aj seriály s multi-episode podporou + TMDB/IMDb unified handler)",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt", "tmdb:"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

const validExtensions = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".mpeg", ".mpg", ".ts", ".flv"];

// ----------------------------
// Helpers
// ----------------------------
function removeDiacritics(str) {
    return str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : str;
}
function shortenTitle(title, wordCount = 3) {
    return title ? title.split(/\s+/).slice(0, wordCount).join(" ") : title;
}
function normalizeTitle(str) {
    return str ? str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s:']/g, "").toLowerCase() : str;
}
function isMultiSeason(title) {
    return /(S\d{2}E\d{2}-\d{2}|Complete|All Episodes|Season \d+(-\d+)?)/i.test(title);
}

// ----------------------------
// IMDb / TMDB Title Fetchers
// ----------------------------
async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        const $ = cheerio.load(res.data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = title;
        if (ldJson) {
            const json = JSON.parse(ldJson);
            if (json && (json.name || json.alternateName)) originalTitle = decode((json.name || json.alternateName).trim());
        }
        console.log(`[DEBUG] 🌝 IMDb názov: ${title} / originálny: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] IMDb scraping zlyhal:", err.message);
        return null;
    }
}

async function getEpisodeTitleFromIMDb(imdbId, season, episode) {
    try {
        const url = `https://www.imdb.com/title/${imdbId}/episodes?season=${season}`;
        const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const $ = cheerio.load(res.data);
        let title = null;

        // IMDb markup sa môže líšiť — skúsiť populárne selektory
        // Nový markup: div.list_item or div.ipc-episode-listing
        // Fallback approach: h3/strong a, alebo .episode-title a
        $(".list_item, .ipc-episode").each((i, el) => {
            const $el = $(el);
            // pokus o získanie čísla epizódy
            const epNumAttr = $el.find("[data-episode-number]").attr("data-episode-number");
            const epNum = epNumAttr ? parseInt(epNumAttr) : null;
            if (epNum === episode) {
                const titleText = $el.find("strong a, .eplist-episode-title, .episode-title, .title a").first().text().trim();
                if (titleText) {
                    title = titleText;
                    return false;
                }
            }
        });

        if (title) console.log(`[DEBUG] 🎬 IMDb episode title: "${title}"`);
        return title;
    } catch (err) {
        console.warn(`[WARN] Nepodarilo sa získať názov epizódy z IMDb: ${err.message}`);
        return null;
    }
}

async function getTitleFromTMDB(tmdbId, type) {
    try {
        const endpoint = type === "series" ? "tv" : "movie";
        const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const res = await axios.get(url);
        const data = res.data;
        const title = data.title || data.name || "";
        const originalTitle = data.original_title || data.original_name || title;
        console.log(`[DEBUG] 🌍 TMDB názov: ${title} / originálny: ${originalTitle}`);
        return { title, originalTitle };
    } catch (err) {
        console.error("[ERROR] TMDB lookup zlyhal:", err.message);
        return null;
    }
}

async function getEpisodeTitleFromTMDB(tmdbId, season, episode) {
    try {
        // TMDB: /tv/{tv_id}/season/{season_number}/episode/{episode_number}
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}&language=en-US`;
        const res = await axios.get(url);
        const data = res.data;
        const title = data && (data.name || data.title) ? (data.name || data.title) : null;
        if (title) console.log(`[DEBUG] 🎬 TMDB episode title: "${title}"`);
        return title;
    } catch (err) {
        console.warn(`[WARN] Nepodarilo sa získať názov epizódy z TMDB: ${err.message}`);
        return null;
    }
}

// ----------------------------
// SKTorrent search
// ----------------------------
async function searchTorrents(query) {
    try {
        console.log(`[INFO] 🔎 Hľadám '${query}' na SKTorrent...`);
        const session = axios.create({ headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}` } });
        const qForSearch = typeof query === "string" ? query.replace(/\./g, ' ') : query;
        const res = await session.get(SEARCH_URL, { params: { search: qForSearch, category: 0 } });
        const $ = cheerio.load(res.data);
        const results = [];

        $('a[href^="details.php"] img').each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, ' ').trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? seedMatch[1] : "0";
            const lowerCat = category.toLowerCase();

            if (!lowerCat.match(/film|seri|tv po\u0159ad|dokument|sport/)) return;

            results.push({
                name: tooltip,
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });

        console.log(`[INFO] 📦 Nájdených torrentov: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", err.message);
        return [];
    }
}

// ----------------------------
// InfoHash získanie a konverzie
// ----------------------------
async function getInfoHashFromTorrent(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`,
                Referer: BASE_URL
            }
        });
        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");
        return infoHash;
    } catch (err) {
        console.error("[ERROR] ⛔️ Chyba pri spracovaní .torrent:", err.message);
        return null;
    }
}

// ----------------------------
// movie stream konvertor
// ----------------------------
async function toStreamMovie(t) {
    try {
        if (isMultiSeason(t.name)) {
            console.log(`[DEBUG] ❌ Preskakujem multi-season balík pre film/nevhodné: '${t.name}'`);
            return null;
        }

        const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
        if (!infoHash) return null;

        const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

        let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
        const categoryPrefix = t.category.trim().toLowerCase();
        if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) {
            cleanedTitle = cleanedTitle.slice(t.category.length).trim();
        }

        return {
            title: `${cleanedTitle}\n👤 ${t.seeds}  📀 ${t.size}  🩲 sktorrent.eu${flagsText}`,
            name: `SKTorrent\n${t.category}`,
            behaviorHints: { bingeGroup: cleanedTitle },
            infoHash
        };
    } catch (err) {
        console.error("[ERROR] toStreamMovie zlyhal:", err.message);
        return null;
    }
}

// ----------------------------
// series stream konvertor (vráti array alebo single podľa požiadavky)
// ----------------------------
async function toStreamSeries(t, season, episode) {
    try {
        const res = await axios.get(t.downloadUrl, {
            responseType: "arraybuffer",
            headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`, Referer: BASE_URL }
        });

        // získať infoHash manuálne
        let infoHash = null;
        try {
            const torrentDec = bencode.decode(res.data);
            const info = bencode.encode(torrentDec.info);
            infoHash = crypto.createHash("sha1").update(info).digest("hex");
        } catch (e) {
            infoHash = null;
        }

        const torrentInfo = parseTorrent(res.data);
        const files = torrentInfo.files || [];
        const videoFiles = files.filter(f =>
            validExtensions.some(ext => f.name.toLowerCase().endsWith(ext)) &&
            f.length > 20 * 1024 * 1024
        );
        if (videoFiles.length === 0) return null;

        const cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
        const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
        const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
        const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

        const streams = videoFiles.map(vf => {
            const fileIdx = files.indexOf(vf);
            // pokus o extrakciu epizódnych tagov z názvu súboru
            const simpleName = vf.name;
            const matchEp = simpleName.match(/S?0?(\d+)[ ._\-xX]?E?0?(\d+)/i) ||
                            simpleName.match(/\b(\d{3,4})\b/) ||
                            simpleName.match(/\bE0?(\d+)\b/i);
            const epLabel = matchEp ? (matchEp[0].toUpperCase()) : null;

            return {
                title: `${cleanedTitle}${epLabel ? " " + epLabel : ""}\n🎞️ ${vf.name}\n👤 ${t.seeds}  💽 ${t.size}${flagsText}`,
                name: `SKTorrent\n${t.category}`,
                behaviorHints: { bingeGroup: cleanedTitle },
                infoHash: infoHash || torrentInfo.infoHash,
                fileIdx
            };
        });

        if (season && episode) {
            const epNum = String(episode);
            const seasonTag = `S${String(season).padStart(2, '0')}`;
            const variantsRegex = [
                new RegExp(`${seasonTag}E${String(episode).padStart(2, '0')}`, "i"),
                new RegExp(`S?0?${season}[ ._\\-xX]?E?0?${episode}`, "i"),
                new RegExp(`\\bEp?\\.?\\s*0?${episode}\\b`, "i"),
                new RegExp(`\\b\\s${episode}\\b`,"i"),
                new RegExp(`\\b${episode}\\b`,"i")
            ];
            for (const rx of variantsRegex) {
                const found = streams.find(s => rx.test(s.title) || rx.test(s.name));
                if (found) return found;
            }
            return streams[0];
        }

        return streams;
    } catch (err) {
        console.error("[ERROR] toStreamSeries zlyhal:", err.message);
        return null;
    }
}

// ----------------------------
// Unified defineStreamHandler (IMDb + TMDB use same fallback logic)
// ----------------------------
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type='${type}', id='${id}' ======`);

    // Parse various ID formats:
    // - tt1234567
    // - tt1234567:1:2
    // - tmdb:12345
    // - tmdb:12345:1:2
    // - movie:tmdb:12345 or series:tmdb:12345:1:2
    const parts = id.split(":");
    let imdbId = null;
    let tmdbId = null;
    let season, episode;

    if (parts[0].startsWith("tt")) {
        // tt1234567 or tt1234567:S:E
        imdbId = parts[0];
        season = parts[1] ? parseInt(parts[1]) : undefined;
        episode = parts[2] ? parseInt(parts[2]) : undefined;
    } else if (parts[0] === "tmdb") {
        // tmdb:12345[:S[:E]]
        tmdbId = parts[1];
        season = parts[2] ? parseInt(parts[2]) : undefined;
        episode = parts[3] ? parseInt(parts[3]) : undefined;
    } else if ((parts[0] === "movie" || parts[0] === "series") && parts[1] === "tmdb") {
        // movie:tmdb:12345 or series:tmdb:12345:1:2
        tmdbId = parts[2];
        season = parts[3] ? parseInt(parts[3]) : undefined;
        episode = parts[4] ? parseInt(parts[4]) : undefined;
    } else {
        // fallback: maybe format "movie:tt1234567" or "series:tt1234567:1:2"
        if (parts[1] && parts[1].startsWith("tt")) {
            imdbId = parts[1];
            season = parts[2] ? parseInt(parts[2]) : undefined;
            episode = parts[3] ? parseInt(parts[3]) : undefined;
        } else {
            console.warn("⚠️ Neznámy ID formát:", id);
            return { streams: [] };
        }
    }

    console.log(`Parsed IDs => imdbId: ${imdbId}, tmdbId: ${tmdbId}, season: ${season}, episode: ${episode}`);

    // Získať titul a originálny titul z príslušného zdroja
    let titles = null;
    let episodeTitle = null;
    if (tmdbId) {
        titles = await getTitleFromTMDB(tmdbId, type);
        if (!titles) return { streams: [] };
        if (type === 'series' && season && episode) {
            episodeTitle = await getEpisodeTitleFromTMDB(tmdbId, season, episode);
        }
    } else if (imdbId) {
        titles = await getTitleFromIMDb(imdbId);
        if (!titles) return { streams: [] };
        if (type === 'series' && season && episode) {
            episodeTitle = await getEpisodeTitleFromIMDb(imdbId, season, episode);
        }
    } else {
        return { streams: [] };
    }

    const { title, originalTitle } = titles;

    // ---- Unified fallback query generation ----
    const queries = new Set();
    const clean = t => t ? t.replace(/\(.*?\)/g, '').replace(/TV (Mini )?Series/gi, '').trim() : t;
    const baseTitles = [clean(title), clean(originalTitle)].filter(Boolean);

    if (type === 'series' && season && episode) {
        // detect daily/episode numbering (e.g., Ulice)
        const isDailyNumbering = (season === 1 && episode > 100) || (episode > 1000);

        for (const base of baseTitles) {
            const noDia = removeDiacritics(base);
            const short = shortenTitle(noDia);

            const epNum = String(episode);
            const seasonTag = `S${String(season).padStart(2, '0')}`;
            const epTag = `${seasonTag}E${String(episode).padStart(2, '0')}`;

            const variants = [];

            if (isDailyNumbering) {
                variants.push(`${base} ${epNum}`, `${base} ep${epNum}`, `${base} e${epNum}`, `${noDia} ${epNum}`, `${short} ${epNum}`);
            } else {
                variants.push(`${base} ${epTag}`);
                variants.push(`${base} E${epNum}`);
                variants.push(`${base} Ep${epNum}`);
                variants.push(`${base} ${season}x${epNum}`);
                variants.push(`${base} ${season}.${epNum}`);
                variants.push(`${noDia} ${epTag}`);
                variants.push(`${normalizeTitle(base)}${epTag}`);
                variants.push(`${noDia} E${epNum}`);
                variants.push(`${short} E${epNum}`);
            }

            if (episodeTitle) {
                variants.push(`${base} ${episodeTitle}`);
                variants.push(`${noDia} ${episodeTitle}`);
                variants.push(`${short} ${episodeTitle}`);
            }

            for (const v of variants) {
                queries.add(v);
                queries.add(v.replace(/[\':]/g, ""));
                queries.add(v.replace(/\s+/g, "."));
            }
        }

        // season/complete fallbacks
        for (const base of baseTitles) {
            const s1 = `${base} S${String(season).padStart(2,'0')}`;
            const s2 = `${base} Season ${season}`;
            const s3 = `${base} Season ${season} Complete`;
            const s4 = `${base} Complete`;
            const s5 = `${base} All Episodes`;
            [s1, s2, s3, s4, s5].forEach(s => {
                queries.add(s);
                queries.add(s.replace(/\s+/g, "."));
            });
        }
    } else if (type === 'series') {
        for (const base of baseTitles) {
            const noDia = removeDiacritics(base);
            queries.add(`${base} Complete`);
            queries.add(`${base} All Episodes`);
            queries.add(`${base} Season`);
            queries.add(`${noDia} Season`);
            queries.add(base.replace(/\s+/g, "."));
        }
    } else if (type === 'movie') {
        for (const base of baseTitles) {
            const noDia = removeDiacritics(base);
            queries.add(base);
            queries.add(noDia);
            queries.add(base.replace(/\s+/g, "."));
        }
    }

    // Spusti search cez queries
    let torrents = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hľadám '${q}'`);
        torrents = await searchTorrents(q);
        if (torrents.length > 0) {
            console.log(`[DEBUG] ✅ Našiel som ${torrents.length} výsledkov pre '${q}'`);
            break;
        }
    }

    if (torrents.length === 0) {
        console.log("[INFO] ❌ Žiadne torrenty sa nenašli.");
        return { streams: [] };
    }

    // Movie: single-stream-per-torrent behavior
    if (type === 'movie') {
        const streams = (await Promise.all(torrents.map(toStreamMovie))).filter(Boolean);
        streams.sort((a, b) => {
            const sa = parseInt(a.title.match(/👤\s*(\d+)/)?.[1] || 0);
            const sb = parseInt(b.title.match(/👤\s*(\d+)/)?.[1] || 0);
            return sb - sa;
        });
        console.log(`[INFO] ✅ Odosielam ${streams.length} streamov pre film`);
        return { streams };
    }

    // Series: multi-episode parsing
    let allStreams = [];
    for (const t of torrents) {
        const res = await toStreamSeries(t, season, episode);
        if (Array.isArray(res)) allStreams.push(...res);
        else if (res) allStreams.push(res);
    }

    // Deduplicate (infoHash + fileIdx) & sort by seeds
    const streams = allStreams.filter(Boolean).reduce((acc, s) => {
        const key = `${s.infoHash}:${s.fileIdx}`;
        if (!acc.keys.has(key)) {
            acc.keys.add(key);
            acc.items.push(s);
        }
        return acc;
    }, { keys: new Set(), items: [] }).items;

    // Sort by seeds (descending)
    streams.sort((a, b) => {
        const sa = parseInt(a.title.match(/👤\s*(\d+)/)?.[1] || 0);
        const sb = parseInt(b.title.match(/👤\s*(\d+)/)?.[1] || 0);
        return sb - sa;
    });

    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov pre seriál`);
    return { streams };
});

builder.defineCatalogHandler(({ type, id }) => {
    console.log(`[DEBUG] 📚 Katalóg požiadavka pre typ='${type}' id='${id}'`);
    return { metas: [] }; // aktivuje prepojenie
});

console.log("📎 Manifest debug výpis:", builder.getInterface().manifest);
serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
