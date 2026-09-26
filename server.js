const WebSocket = require("ws");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 15;
const MAX_AI = 15;
const MATCH_QUEUE_WAIT_MS = 5000;
const httpServer = http.createServer((request, response) => {
    if (request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
    }
    response.writeHead(404);
    response.end("Not found");
});
const server = new WebSocket.Server({ server: httpServer });
const clients = new Map();
const accounts = new Map();
const parties = new Map();
const matches = new Map();
const accountFile = path.join(process.env.DATA_DIR || __dirname, "accounts.json");
let queueTimer = null;

try {
    const savedAccounts = JSON.parse(fs.readFileSync(accountFile, "utf8"));
    savedAccounts.forEach(account => accounts.set(account.id, account));
} catch {}

function send(socket, payload) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function saveAccounts() {
    try {
        fs.mkdirSync(path.dirname(accountFile), { recursive: true });
        fs.writeFileSync(accountFile, JSON.stringify([...accounts.values()], null, 2));
    } catch (error) {
        console.error("Account persistence failed:", error.message);
    }
}

function clientById(id) {
    return [...clients.values()].find(client => client.id === id);
}

function broadcastOnlineCount() {
    const onlineUsers = new Set([...clients.values()].map(client => client.id)).size;
    for (const client of clients.values()) send(client.socket, { type: "online_count", count: onlineUsers });
}

function seededRandom(seed) {
    let value = seed >>> 0;
    return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}

function makeBuildings() {
    const random = seededRandom(271828);
    const buildings = [];
    for (let i = 0; i < 18; i += 1) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const w = 140 + Math.floor(random() * 75), h = 105 + Math.floor(random() * 60);
            const building = { x: 100 + random() * (4200 - w - 200), y: 100 + random() * (2800 - h - 200), w, h };
            if (!buildings.some(other => building.x < other.x + other.w + 90 && building.x + w + 90 > other.x && building.y < other.y + other.h + 90 && building.y + h + 90 > other.y)) {
                buildings.push(building);
                break;
            }
        }
    }
    return buildings;
}

const buildings = makeBuildings();
function makeProps() {
    const random = seededRandom(771903), props = [];
    for (let index = 0; index < 110; index += 1) {
        const kind = ["tree", "bush", "rock", "crate"][index % 4];
        const radius = kind === "tree" ? 23 : kind === "bush" ? 19 : kind === "rock" ? 17 : 15;
        let prop;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            prop = { kind, x: 80 + random() * 4040, y: 80 + random() * 2640, r: radius };
            const nearBuilding = buildings.some(b => prop.x > b.x - 30 && prop.x < b.x + b.w + 30 && prop.y > b.y - 30 && prop.y < b.y + b.h + 30);
            const nearProp = props.some(other => Math.hypot(prop.x - other.x, prop.y - other.y) < radius + other.r + 16);
            if (!nearBuilding && !nearProp) break;
        }
        props.push(prop);
    }
    return props;
}
const props = makeProps();
function spawnPoint(used = []) {
    for (let attempt = 0; attempt < 4000; attempt += 1) {
        const point = { x: 70 + Math.random() * 4060, y: 70 + Math.random() * 2660 };
        const blockedBuilding = buildings.some(b => point.x > b.x - 38 && point.x < b.x + b.w + 38 && point.y > b.y - 38 && point.y < b.y + b.h + 38);
        const blockedProp = props.some(p => Math.hypot(point.x - p.x, point.y - p.y) < p.r + 40 || (p.kind === "crate" && Math.abs(point.x - p.x) < 48 && Math.abs(point.y - p.y) < 48));
        const tooClose = used.some(other => Math.hypot(point.x - other.x, point.y - other.y) < 320);
        if (!blockedBuilding && !blockedProp && !tooClose) return point;
    }
    return { x: 2100, y: 1400 };
}

function partySnapshot(code) {
    const party = parties.get(code);
    if (!party) return;
    const members = [...party.members].map(id => {
        const player = clientById(id);
        return { id, name: player?.name || accounts.get(id)?.name || "ANONYMOUS", online: Boolean(player), team: party.teams.get(id) || 0 };
    });
    members.forEach(member => send(clientById(member.id)?.socket, {
        type: "party_state", code, host: party.host, clientId: member.id, rounds: party.rounds, members
    }));
}

function leaveParty(socket, notify = true) {
    const client = clients.get(socket);
    if (!client?.party) return;
    const code = client.party, party = parties.get(code);
    client.party = null;
    if (party) {
        party.members.delete(client.id);
        party.teams.delete(client.id);
        if (party.host === client.id) party.host = party.members.values().next().value;
        if (!party.host) parties.delete(code);
        else partySnapshot(code);
    }
    if (notify) send(socket, { type: "party_left" });
}

function groupFor(client) {
    const party = client.party && parties.get(client.party);
    return party ? [...party.members].map(clientById).filter(Boolean) : [client];
}

function broadcastMatch(match, payload) {
    match.members.forEach(id => send(clientById(id)?.socket, payload));
}

function startMatch(selected, partyOnly = false) {
    const id = Math.random().toString(36).slice(2, 10);
    const party = partyOnly && selected[0].party ? parties.get(selected[0].party) : null;
    const usedSpawns = [];
    const players = selected.map((client) => {
        const spawn = spawnPoint(usedSpawns); usedSpawns.push(spawn);
        return {
        id: client.id, name: client.name,
        team: client.party && parties.has(client.party) ? `${client.party}:${parties.get(client.party).teams.get(client.id) || 0}` : client.id,
        ...spawn
    }; });
    const aiCount = partyOnly ? 0 : Math.min(MAX_AI, MAX_PLAYERS - selected.length);
    const ai = Array.from({ length: aiCount }, (_, index) => { const spawn=spawnPoint(usedSpawns); usedSpawns.push(spawn); return {
        id: `ai-${index}`, name: `AI // ${String(index + 1).padStart(2, "0")}`, team: `ai-${index}`,
        hp: 100, shield: 0, weapon: "pistol", ammo: 24, ...spawn
    }; });
    const match = {
        id, hostId: selected[0].id, mode: partyOnly ? "party" : "public", rounds: party?.rounds || 1,
        round: 1, scores: new Map(), members: new Set(selected.map(client => client.id)),
        players: new Map(players.map(player => [player.id, { ...player, hp: 100, shield: 0, weapon: "pistol", ammo: 24 }])),
        ai, claimedLoot: new Set(), finished: false
    };
    matches.set(id, match);
    const packet = { type: "match_start", matchId: id, mode: match.mode, hostId: match.hostId, rounds: match.rounds, players, aiCount, ai };
    selected.forEach(client => { client.queueing = false; client.match = id; send(client.socket, packet); });
}

function matchmake(force = false) {
    queueTimer = null;
    const waiting = [...clients.values()].filter(client => client.queueing && !client.match);
    const selected = [], seen = new Set();
    for (const client of waiting) {
        if (seen.has(client.id)) continue;
        const group = groupFor(client);
        if (selected.length + group.length > MAX_PLAYERS) continue;
        group.forEach(player => { seen.add(player.id); selected.push(player); });
    }
    if (!selected.length) return;
    if (force || selected.length === MAX_PLAYERS) startMatch(selected);
    else if (!queueTimer) queueTimer = setTimeout(() => matchmake(true), MATCH_QUEUE_WAIT_MS);
}

function finishMatch(match) {
    if (match.finished) return;
    const alivePlayers = [...match.players.values()].filter(player => player.hp > 0);
    const aliveAI = match.ai.filter(enemy => enemy.hp > 0);
    const alive = alivePlayers.map(player => player.team)
        .concat(aliveAI.map(enemy => enemy.team || enemy.id));
    const teams = [...new Set(alive)];
    if (teams.length > 1) return;
    if (match.round < match.rounds && teams.length === 1) {
        match.scores.set(teams[0], (match.scores.get(teams[0]) || 0) + 1);
        match.round += 1;
        const usedSpawns = [];
        for (const player of match.players.values()) { const spawn=spawnPoint(usedSpawns); usedSpawns.push(spawn); Object.assign(player, spawn, { hp: 100, shield: 0 }); }
        match.ai = match.ai.map(enemy => { const spawn=spawnPoint(usedSpawns); usedSpawns.push(spawn); return { ...enemy, ...spawn, hp: 100, shield: 0 }; });
        broadcastMatch(match, { type: "match_round_start", round: match.round, rounds: match.rounds, players: [...match.players.values()], ai: match.ai, scores: Object.fromEntries(match.scores) });
        return;
    }
    match.finished = true;
    const winner = teams[0];
    const winnerPlayer = winner === undefined ? null : alivePlayers.find(player => player.team === winner);
    const winnerAI = winner === undefined ? null : aliveAI.find(enemy => (enemy.team || enemy.id) === winner);
    broadcastMatch(match, {
        type: "match_complete",
        winner: winner ?? null,
        winnerTeam: winner ?? null,
        winnerPlayerId: winnerPlayer?.id || null,
        winnerName: winnerPlayer?.name || winnerAI?.name || null,
        winnerIsAI: Boolean(winnerAI),
        draw: teams.length === 0,
        scores: Object.fromEntries(match.scores)
    });
}

server.on("connection", socket => {
    const client = { id: Math.random().toString(36).slice(2, 10), socket, name: "ANONYMOUS", friends: [], friendRequests: [], party: null, match: null, queueing: false };
    clients.set(socket, client);
    send(socket, { type: "welcome", id: client.id });
    socket.on("message", raw => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: "party_error", message: "Invalid message." }); }
        if (message.type === "hello") {
            const requestedId = String(message.accountId || "");
            if (/^[a-zA-Z0-9_-]{16,64}$/.test(requestedId)) client.id = requestedId;
            const saved = accounts.get(client.id) || { id: client.id, name: "ANONYMOUS", friends: [], friendRequests: [], stats: { matches: 0, kills: 0, wins: 0 } };
            client.name = String(message.name || saved.name || "ANONYMOUS").slice(0, 14).toUpperCase();
            client.friends = saved.friends || [];
            client.friendRequests = saved.friendRequests || [];
            client.stats = saved.stats;
            accounts.set(client.id, { ...saved, id: client.id, name: client.name });
            send(socket, { type: "account_state", ...accounts.get(client.id) });
            broadcastOnlineCount();
        }
        if (message.type === "party_create") {
            leaveParty(socket, false);
            const code = String(Math.floor(100000 + Math.random() * 900000));
            parties.set(code, { host: client.id, members: new Set([client.id]), teams: new Map([[client.id, 0]]), rounds: 1 });
            client.party = code;
            partySnapshot(code);
        }
        if (message.type === "party_join") {
            const party = parties.get(String(message.code || ""));
            if (!party) send(socket, { type: "party_error", message: "Party not found." });
            else if (party.members.size >= MAX_PLAYERS) send(socket, { type: "party_error", message: "Party is full." });
            else { leaveParty(socket, false); party.members.add(client.id); client.party = String(message.code); party.teams.set(client.id, 0); partySnapshot(client.party); }
        }
        if (message.type === "party_leave") leaveParty(socket);
        if (message.type === "party_kick") {
            const party = client.party && parties.get(client.party), target = clientById(String(message.id || ""));
            if (party?.host === client.id && target && target.id !== client.id) { leaveParty(target.socket); send(target.socket, { type: "party_kicked" }); }
        }
        if (message.type === "party_settings" && client.party) {
            const party = parties.get(client.party);
            if (party?.host === client.id && [1, 3, 5].includes(Number(message.rounds))) {
                party.rounds = Number(message.rounds);
                for (const id of party.members) party.teams.set(id, Number(message.teams?.[id]) === 1 ? 1 : 0);
                partySnapshot(client.party);
            }
        }
        if (message.type === "match_find") {
            const party = client.party && parties.get(client.party), group = groupFor(client), partyOnly = message.mode === "party";
            if (party && party.host !== client.id) send(socket, { type: "match_error", message: "Only the party host can find a match." });
            else if (partyOnly && !party) send(socket, { type: "match_error", message: "Create a party first." });
            else if (partyOnly) startMatch(group, true);
            else { group.forEach(player => { player.queueing = true; }); send(socket, { type: "match_queue", players: group.length }); matchmake(); }
        }
        if (message.type === "match_leave" && client.match) {
            const match = matches.get(client.match); match?.members.delete(client.id); match?.players.delete(client.id);
            if (match?.hostId === client.id) match.hostId = match.members.values().next().value || null;
            client.match = null; send(socket, { type: "match_left" });
        }
        const match = client.match && matches.get(client.match);
        if (message.type === "match_update" && match) {
            const player = match.players.get(client.id);
            if (player) { player.x = Number(message.x) || player.x; player.y = Number(message.y) || player.y; player.angle = Number(message.angle) || 0; player.weapon = ["pistol", "rifle", "shotgun"].includes(message.weapon) ? message.weapon : player.weapon; player.ammo = Math.max(0, Number(message.ammo) || 0); }
            if (player) broadcastMatch(match, { type: "match_update", player: { ...player, name: client.name } });
        }
        if (message.type === "match_damage" && match) {
            const attacker = match.players.get(client.id), target = match.players.get(String(message.targetId || "")), damage = Math.max(0, Math.min(100, Number(message.damage) || 0));
            if (!attacker || !target || target.hp <= 0 || attacker.team === target.team || !damage) return;
            const absorbed = Math.min(target.shield, damage); target.shield -= absorbed; target.hp = Math.max(0, target.hp - damage + absorbed);
            broadcastMatch(match, { type: "match_health", id: target.id, hp: target.hp, shield: target.shield, damage, by: client.id });
            if (!target.hp) { send(target.socket, { type: "match_eliminated", by: client.name, killerId: client.id }); broadcastMatch(match, { type: "kill_log", killer: client.name, victim: target.name }); finishMatch(match); }
        }
        if (message.type === "match_ai_update" && match?.hostId === client.id) {
            match.ai = (message.ai || []).slice(0, MAX_AI).map((enemy, index) => ({ ...enemy, id: `ai-${index}`, hp: Math.max(0, Number(enemy.hp) || 0) }));
            broadcastMatch(match, { type: "match_ai_update", ai: match.ai }); finishMatch(match);
        }
        if (message.type === "match_ai_damage" && match?.hostId === client.id) {
            if (message.contact !== true) return;
            const target = match.players.get(String(message.targetId || "")); if (!target || target.hp <= 0) return;
            const damage = Math.max(0, Math.min(100, Number(message.damage) || 0)), absorbed = Math.min(target.shield, damage);
            target.shield -= absorbed; target.hp = Math.max(0, target.hp - damage + absorbed);
            broadcastMatch(match, { type: "match_health", id: target.id, hp: target.hp, shield: target.shield, damage, by: message.aiName || "AI" });
            if (!target.hp) { send(target.socket, { type: "match_eliminated", by: message.aiName || "AI", killerId: String(message.aiId || "ai"), killerIsAI: true }); broadcastMatch(match, { type: "kill_log", killer: message.aiName || "AI", victim: target.name }); finishMatch(match); }
        }
        if (message.type === "match_shot" && match) broadcastMatch(match, { type: "match_shot", shot: { ...message, id: client.id, team: match.players.get(client.id)?.team } });
        if (message.type === "match_ai_shot" && match?.hostId === client.id) broadcastMatch(match, { type: "match_ai_shot", shot: message.shot });
        if (message.type === "match_loot_state" && match?.hostId === client.id) broadcastMatch(match, { type: "match_loot_state", loot: message.loot || [] });
        if (message.type === "match_loot_take" && match) {
            const player = match.players.get(client.id), lootId = String(message.id || "");
            if (player && lootId && !match.claimedLoot.has(lootId) && Math.hypot(player.x - Number(message.x), player.y - Number(message.y)) < 80) { match.claimedLoot.add(lootId); broadcastMatch(match, { type: "match_loot_taken", id: lootId, by: client.id }); }
        }
        if (message.type === "match_vitals_pickup" && match) {
            const player = match.players.get(client.id); if (!player) return;
            if (message.kind === "medkit") player.hp = Math.min(100, player.hp + 25); else if (message.kind === "shield") player.shield = Math.min(100, player.shield + 25); else return;
            broadcastMatch(match, { type: "match_health", id: client.id, hp: player.hp, shield: player.shield, damage: 0, pickup: message.kind });
        }
        if (message.type === "party_chat" && client.party) for (const id of parties.get(client.party)?.members || []) send(clientById(id)?.socket, { type: "party_chat", from: client.name, text: String(message.text || "").slice(0, 160) });
    });
    socket.on("close", () => { const client = clients.get(socket); if (client) { leaveParty(socket, false); if (client.match) { const match = matches.get(client.match); match?.members.delete(client.id); match?.players.delete(client.id); if (match) finishMatch(match); } clients.delete(socket); broadcastOnlineCount(); } });
});

httpServer.listen(PORT, "0.0.0.0", () => console.log(`Dropzone server listening on ${PORT}`));
