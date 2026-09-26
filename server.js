const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const server = new WebSocket.Server({ port: PORT });
const parties = new Map();
const clients = new Map();
const matches = new Map();
const MAX_PLAYERS = 30;
const MAX_AI = 8;
const houses = Array.from({ length: 14 }, (_, i) => ({ x: 260 + (i * 347) % 2600, y: 180 + (i * 193) % 1700, w: 150, h: 105 }));

function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function makeCode() {
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000));
    while (parties.has(code));
    return code;
}

function partyState(code) {
    const party = parties.get(code);
    if (!party) return;
    const members = [...party.members].map((id) => {
        const member = [...clients.values()].find((client) => client.id === id);
        return { id, name: member?.name || "OPERATOR" };
    });
    members.forEach((member) => send([...clients.values()].find((client) => client.id === member.id)?.socket, {
        type: "party_state", code, host: party.host, clientId: member.id, members
    }));
}

function removeFromParty(socket) {
    const client = clients.get(socket);
    if (!client?.party) return;
    const code = client.party;
    const party = parties.get(code);
    client.party = null;
    if (!party) return;
    party.members.delete(client.id);
    if (party.host === client.id) {
        party.host = party.members.values().next().value;
        if (!party.host) return parties.delete(code);
    }
    partyState(code);
}

function joinParty(socket, code) {
    const client = clients.get(socket);
    const party = parties.get(code);
    if (!party) return send(socket, { type: "party_error", message: "Party not found." });
    if (party.members.size >= 30) return send(socket, { type: "party_error", message: "Party is full." });
    removeFromParty(socket);
    party.members.add(client.id);
    client.party = code;
    partyState(code);
}

function groupFor(client) {
    if (!client.party) return [client];
    const party = parties.get(client.party);
    return party ? [...party.members].map((id) => [...clients.values()].find((member) => member.id === id)).filter(Boolean) : [client];
}

function spawnPoint(index, total) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const angle = (Math.PI * 2 * (index + attempt * 0.37)) / Math.max(1, total);
        const x = 1600 + Math.cos(angle) * (980 + attempt * 8);
        const y = 1100 + Math.sin(angle) * (700 + attempt * 6);
        const blocked = houses.some((house) => x > house.x - 34 && x < house.x + house.w + 34 && y > house.y - 34 && y < house.y + house.h + 34);
        if (!blocked && x > 50 && x < 3150 && y > 50 && y < 2150) return { x, y };
    }
    return { x: 1600, y: 1100 };
}

function startMatch(selected, partyOnly = false) {
    const matchId = Math.random().toString(36).slice(2, 10);
    const players = selected.map((client, index) => ({ id: client.id, name: client.name, ...spawnPoint(index, selected.length) }));
    const aiCount = partyOnly ? 0 : Math.min(MAX_AI, MAX_PLAYERS - selected.length);
    const ai = Array.from({ length: aiCount }, (_, index) => ({ id: `ai-${index}`, name: `AI // ${String(index + 1).padStart(2, "0")}`, ...spawnPoint(selected.length + index, selected.length + aiCount) }));
    const payload = { type: "match_start", matchId, mode: partyOnly ? "party" : "public", hostId: selected[0].id, players, aiCount, ai };
    matches.set(matchId, { members: new Set(selected.map((client) => client.id)), ai });
    selected.forEach((client) => {
        client.queueing = false;
        client.match = matchId;
        send(client.socket, payload);
    });
}

function tryStartMatch() {
    const queued = [...clients.values()].filter((client) => client.queueing && !client.match);
    const selected = [];
    const seen = new Set();
    for (const client of queued) {
        if (seen.has(client.id)) continue;
        const group = groupFor(client);
        if (selected.length + group.length > MAX_PLAYERS) continue;
        group.forEach((member) => { seen.add(member.id); selected.push(member); });
    }
    if (!selected.length) return;
    startMatch(selected);
}

function broadcastMatch(client, payload) {
    if (!client.match || !matches.has(client.match)) return;
    matches.get(client.match).members.forEach((id) => {
        const target = [...clients.values()].find((member) => member.id === id);
        if (target && target.id !== client.id) send(target.socket, payload);
    });
}

function broadcastParty(client, payload) {
    if (!client.party || !parties.has(client.party)) return;
    parties.get(client.party).members.forEach((id) => {
        const target = [...clients.values()].find((member) => member.id === id);
        if (target) send(target.socket, payload);
    });
}

server.on("connection", (socket) => {
    const id = Math.random().toString(36).slice(2, 10);
    clients.set(socket, { id, socket, name: "ANONYMOUS", party: null, queueing: false, match: null });
    send(socket, { type: "welcome", id, message: "Connected to multiplayer!" });
    socket.on("message", (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: "party_error", message: "Invalid message." }); }
        const client = clients.get(socket);
        if (message.type === "hello") {
            client.name = String(message.name || "OPERATOR").slice(0, 14).toUpperCase();
            if (client.party) partyState(client.party);
        }
        if (message.type === "party_create") {
            removeFromParty(socket);
            const code = makeCode();
            parties.set(code, { host: client.id, members: new Set([client.id]) });
            client.party = code;
            partyState(code);
        }
        if (message.type === "party_join") joinParty(socket, String(message.code || ""));
        if (message.type === "party_leave") {
            const code = client.party;
            removeFromParty(socket);
            if (code && parties.has(code)) send(socket, { type: "party_left" });
        }
        if (message.type === "match_find") {
            const group = groupFor(client);
            const partyOnly = message.mode === "party";
            if (client.party && parties.get(client.party)?.host !== client.id) {
                send(socket, { type: "match_error", message: "Only the party leader can find a match." });
            } else if (group.length > MAX_PLAYERS) {
                send(socket, { type: "match_error", message: "Your party is over the 30-player match cap." });
            } else if (partyOnly && !client.party) {
                send(socket, { type: "match_error", message: "Create or join a party before hosting a party-only match." });
            } else if (partyOnly) {
                startMatch(group, true);
            } else {
                group.forEach((member) => { member.queueing = true; });
                send(socket, { type: "match_queue", players: group.length });
                tryStartMatch();
            }
        }
        if (message.type === "match_leave" && client.match) {
            const match = matches.get(client.match);
            if (match) match.members.delete(client.id);
            client.match = null;
            send(socket, { type: "match_left" });
        }
        if (message.type === "match_update") {
            broadcastMatch(client, {
                type: "match_update",
                player: {
                    id: client.id,
                    name: client.name,
                    x: Number(message.x) || 0,
                    y: Number(message.y) || 0,
                    hp: Math.max(0, Math.min(100, Number(message.hp) || 0)),
                    angle: Number(message.angle) || 0
                }
            });
        }
        if (message.type === "match_shot") {
            broadcastMatch(client, {
                type: "match_shot",
                shot: {
                    id: client.id,
                    x: Number(message.x) || 0,
                    y: Number(message.y) || 0,
                    vx: Number(message.vx) || 0,
                    vy: Number(message.vy) || 0,
                    damage: Number(message.damage) || 0,
                    color: String(message.color || "#f5ce61").slice(0, 12)
                }
            });
        }
        if (message.type === "match_ai_health") {
            broadcastMatch(client, {
                type: "match_ai_health",
                index: Number(message.index),
                hp: Math.max(0, Math.min(100, Number(message.hp) || 0))
            });
        }
        if (message.type === "match_ai_update") {
            broadcastMatch(client, {
                type: "match_ai_update",
                ai: Array.isArray(message.ai) ? message.ai.slice(0, MAX_AI) : []
            });
        }
        if (message.type === "party_chat") {
            const text = String(message.text || "").trim().slice(0, 160);
            if (text) broadcastParty(client, { type: "party_chat", from: client.name, text });
        }
    });
    socket.on("close", () => {
        const client = clients.get(socket);
        if (client?.match && matches.has(client.match)) matches.get(client.match).members.delete(client.id);
        removeFromParty(socket);
        clients.delete(socket);
    });
});

console.log(`Server running on port ${PORT}`);
