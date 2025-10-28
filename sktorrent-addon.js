// addon.js — SKTorrent Stremio Addon (v1.3.0)
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const parseTorrent = require("parse-torrent-file");
const bencode = require("bncode");
const crypto = require("crypto");

// Prihlasovacie údaje na SKTorrent
const SKT_UID = "";
const SKT_PASS = "";

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

// TMDB API kľúč
const TMDB_API_KEY = "";

// Inicializácia addon buildera
const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.0.3",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt", "tmdb:"]
});

// Kódy jazykov -> vlajky
const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

const validExtensions = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".mpeg", ".mpg", ".ts", ".flv"];

// ===============================
// Pomocné funkcie
// ===============================
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

// ===============================
// IMDb / TMDB názvy
// ===============================
async function getTitleFromIMDb(imdbId) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/`, { headers: { "User-Agent": "Mozilla/5.0" } });
        const $ = cheerio.load(res.data);
        const titleRaw = $('title').text().split(' - ')[0].trim();
        const title = decode(titleRaw);
        const ldJson = $('script[type="application/ld+json"]').html();
        let originalTitle = title;
        if (ldJson) {
            const json = JSON.parse(ldJson);
            if (json && (json.name || json.alternateName)) originalTitle = decode((json.name || json.alternateName).trim());
        }
        return { title, originalTitle };
    } catch {
        return null;
    }
}

async function getEpisodeTitleFromIMDb(imdbId, season, episode) {
    try {
        const res = await axios.get(`https://www.imdb.com/title/${imdbId}/episodes?season=${season}`, { headers: { "User-Agent": "Mozilla/5.0" } });
        const $ = cheerio.load(res.data);
        let title = null;
        $(".list_item, .ipc-episode").each((_, el) => {
            const epNumAttr = $(el).find("[data-episode-number]").attr("data-episode-number");
            const epNum = epNumAttr ? parseInt(epNumAttr) : null;
            if (epNum === episode) {
                const t = $(el).find("strong a, .episode-title, .title a").first().text().trim();
                if (t) { title = t; return false; }
            }
        });
        return title;
    } catch {
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
        return { title, originalTitle };
    } catch {
        return null;
    }
}

async function getEpisodeTitleFromTMDB(tmdbId, season, episode) {
    try {
        const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}&language=en-US`;
        const res = await axios.get(url);
        const data = res.data;
        return data?.name || data?.title || null;
    } catch {
        return null;
    }
}

// ===============================
// Vyhľadávanie torrentov na SKTorrent
// ===============================
async function searchTorrents(query) {
    try {
        console.log(`🔎 Hľadám '${query}' na SKTorrent...`);
        const session = axios.create({ headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}` } });
        const res = await session.get(SEARCH_URL, { params: { search: query.replace(/\./g, ' '), category: 0 } });
        const $ = cheerio.load(res.data);
        const results = [];

        $('a[href^="details.php"] img').each((_, img) => {
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

            if (!category.toLowerCase().match(/film|seri|tv po\u0159ad|dokument|sport/)) return;
            results.push({
                name: tooltip,
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });
        return results;
    } catch {
        return [];
    }
}

// ===============================
// InfoHash z .torrent súboru
// ===============================
async function getInfoHashFromTorrent(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`, Referer: BASE_URL }
        });
        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        return crypto.createHash("sha1").update(info).digest("hex");
    } catch {
        return null;
    }
}

// ===============================
// Stream konverzia pre filmy
// ===============================
async function toStreamMovie(t) {
    if (isMultiSeason(t.name)) return null;
    const infoHash = await getInfoHashFromTorrent(t.downloadUrl);
    if (!infoHash) return null;

    const flags = (t.name.match(/\b([A-Z]{2})\b/g) || [])
        .map(c => langToFlag[c.toUpperCase()])
        .filter(Boolean)
        .join(" / ");

    let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
    const categoryPrefix = t.category.trim().toLowerCase();
    if (cleanedTitle.toLowerCase().startsWith(categoryPrefix))
        cleanedTitle = cleanedTitle.slice(t.category.length).trim();

    return {
        title: `${cleanedTitle}\n👤 ${t.seeds}  📀 ${t.size}${flags ? `\n${flags}` : ""}`,
        name: `SKTorrent\n${t.category}`,
        behaviorHints: { bingeGroup: cleanedTitle },
        infoHash
    };
}

// ===============================
// Stream konverzia pre seriály
// ===============================
async function toStreamSeries(t, season, episode) {
    try {
        const res = await axios.get(t.downloadUrl, {
            responseType: "arraybuffer",
            headers: { Cookie: `uid=${SKT_UID}; pass=${SKT_PASS}`, Referer: BASE_URL }
        });

        let infoHash;
        try {
            const torrentDec = bencode.decode(res.data);
            const info = bencode.encode(torrentDec.info);
            infoHash = crypto.createHash("sha1").update(info).digest("hex");
        } catch {
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
        const flags = (t.name.match(/\b([A-Z]{2})\b/g) || [])
            .map(c => langToFlag[c.toUpperCase()])
            .filter(Boolean)
            .join(" / ");

        const streams = videoFiles.map(vf => {
            const fileIdx = files.indexOf(vf);
            const matchEp = vf.name.match(/S?0?(\d+)[ ._\-xX]?E?0?(\d+)/i);
            const epLabel = matchEp ? matchEp[0].toUpperCase() : "";
            return {
                title: `${cleanedTitle} ${epLabel}\n🎞️ ${vf.name}\n👤 ${t.seeds}  💽 ${t.size}${flags ? `\n${flags}` : ""}`,
                name: `SKTorrent\n${t.category}`,
                behaviorHints: { bingeGroup: cleanedTitle },
                infoHash: infoHash || torrentInfo.infoHash,
                fileIdx
            };
        });

        if (season && episode) {
            const epNum = String(episode);
            const seasonTag = `S${String(season).padStart(2, '0')}`;
            const regexes = [
                new RegExp(`${seasonTag}E${String(episode).padStart(2, '0')}`, "i"),
                new RegExp(`S?0?${season}[ ._\\-xX]?E?0?${episode}`, "i"),
                new RegExp(`\\bEp?\\.?\\s*0?${episode}\\b`, "i")
            ];
            for (const rx of regexes) {
                const found = streams.find(s => rx.test(s.title));
                if (found) return found;
            }
            return streams[0];
        }
        return streams;
    } catch {
        return null;
    }
}

// ===============================
// Hlavný stream handler
// ===============================
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`🎮 Požiadavka: ${type} → ${id}`);

    const parts = id.split(":");
    let imdbId = null, tmdbId = null, season, episode;

    if (parts[0].startsWith("tt")) {
        imdbId = parts[0];
        season = parseInt(parts[1]);
        episode = parseInt(parts[2]);
    } else if (parts[0] === "tmdb") {
        tmdbId = parts[1];
        season = parseInt(parts[2]);
        episode = parseInt(parts[3]);
    } else if ((parts[0] === "movie" || parts[0] === "series") && parts[1] === "tmdb") {
        tmdbId = parts[2];
        season = parseInt(parts[3]);
        episode = parseInt(parts[4]);
    } else if (parts[1] && parts[1].startsWith("tt")) {
        imdbId = parts[1];
        season = parseInt(parts[2]);
        episode = parseInt(parts[3]);
    } else return { streams: [] };

    let titles = null, episodeTitle = null;
    if (tmdbId) {
        titles = await getTitleFromTMDB(tmdbId, type);
        if (type === 'series' && season && episode) episodeTitle = await getEpisodeTitleFromTMDB(tmdbId, season, episode);
    } else if (imdbId) {
        titles = await getTitleFromIMDb(imdbId);
        if (type === 'series' && season && episode) episodeTitle = await getEpisodeTitleFromIMDb(imdbId, season, episode);
    }
    if (!titles) return { streams: [] };

    const { title, originalTitle } = titles;
    const queries = new Set();

    const clean = t => t ? t.replace(/\(.*?\)/g, '').trim() : t;
    const baseTitles = [clean(title), clean(originalTitle)].filter(Boolean);

    if (type === 'movie') {
        for (const base of baseTitles) {
            const noDia = removeDiacritics(base);
            queries.add(base);
            queries.add(noDia);
            queries.add(base.replace(/\s+/g, "."));
        }
    } else if (type === 'series' && season && episode) {
        for (const base of baseTitles) {
            const noDia = removeDiacritics(base);
            const short = shortenTitle(noDia);
            const epNum = String(episode);
            const seasonTag = `S${String(season).padStart(2, '0')}`;
            const epTag = `${seasonTag}E${String(episode).padStart(2, '0')}`;
            const variants = [
                `${base} ${epTag}`, `${base} E${epNum}`, `${base} ${season}x${epNum}`,
                `${short} ${epTag}`, `${noDia} ${epTag}`
            ];
            if (episodeTitle) variants.push(`${base} ${episodeTitle}`, `${noDia} ${episodeTitle}`);
            for (const v of variants) {
                queries.add(v);
                queries.add(v.replace(/\s+/g, "."));
            }
        }
    }

    let torrents = [];
    for (const q of queries) {
        torrents = await searchTorrents(q);
        if (torrents.length > 0) break;
    }
    if (torrents.length === 0) return { streams: [] };

    if (type === 'movie') {
        const streams = (await Promise.all(torrents.map(toStreamMovie))).filter(Boolean);
        streams.sort((a, b) => (parseInt(b.title.match(/👤\s*(\d+)/)?.[1]) || 0) - (parseInt(a.title.match(/👤\s*(\d+)/)?.[1]) || 0));
        return { streams };
    }

    let allStreams = [];
    for (const t of torrents) {
        const res = await toStreamSeries(t, season, episode);
        if (Array.isArray(res)) allStreams.push(...res);
        else if (res) allStreams.push(res);
    }

    const unique = {};
    const streams = allStreams.filter(Boolean).filter(s => {
        const key = `${s.infoHash}:${s.fileIdx}`;
        if (unique[key]) return false;
        unique[key] = true;
        return true;
    }).sort((a, b) => (parseInt(b.title.match(/👤\s*(\d+)/)?.[1]) || 0) - (parseInt(a.title.match(/👤\s*(\d+)/)?.[1]) || 0));

    return { streams };
});

// Aktivácia v Stremiu
builder.defineCatalogHandler(() => ({ metas: [] }));

serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
